// PayRescue — webhook-driven Stripe failed-payment recovery.
//
// The whole product is this one file's logic:
//   Stripe event  ->  store + escalate dunning email + Slack ping  ->  mark recovered
//
// No cron, no queue, no server to babysit. Stripe re-fires the failed event on
// each of its own smart retries, which is exactly when we want to escalate.
import "dotenv/config";
import express from "express";
import Stripe from "stripe";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { upsertFailure, markRecovered, logEvent, stats, getSettings, saveSettings } from "./db.js";
import { sendDunning, money } from "./email.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// Merchant identity, pulled live from Stripe and cached. This is what makes the
// dunning mail look trustworthy: it goes out in the name of the provider the
// customer already pays, with the merchant's real support address as reply-to.
let _merchant = null;
async function merchantInfo() {
  if (_merchant) return _merchant;
  try {
    const a = await stripe.accounts.retrieve();
    _merchant = {
      name: a.business_profile?.name
        || a.settings?.dashboard?.display_name
        || process.env.BUSINESS_NAME || process.env.FROM_NAME || "",
      supportEmail: a.business_profile?.support_email || process.env.REPLY_TO || "",
    };
  } catch {
    _merchant = {
      name: process.env.BUSINESS_NAME || process.env.FROM_NAME || "",
      supportEmail: process.env.REPLY_TO || "",
    };
  }
  return _merchant;
}

async function slack(text) {
  if (!process.env.SLACK_WEBHOOK_URL) return;
  try {
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) { console.error("slack error", e.message); }
}

// Build a self-serve recovery link. Stripe's Billing Customer Portal lets the
// customer update their card with zero work from us.
async function recoveryUrl(customerId) {
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: process.env.APP_BASE_URL || "https://example.com",
    });
    return session.url;
  } catch {
    return `${process.env.APP_BASE_URL || ""}/recover`; // fallback page
  }
}

// --- Stripe webhook (raw body required for signature verification) ---
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("⚠️  signature check failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "invoice.payment_failed") {
      const inv = event.data.object;
      const rec = upsertFailure({
        invoiceId: inv.id,
        customerId: inv.customer,
        email: inv.customer_email,
        amount: inv.amount_due,
        currency: inv.currency,
      });
      logEvent(inv.id, "failed", `attempt ${rec.attempts}`);

      const url = await recoveryUrl(inv.customer);
      const merchant = await merchantInfo();
      const settings = getSettings();
      // The merchant chooses the sender identity on /settings:
      //   "stripe" -> live brand name from Stripe (per-invoice, supports Connect)
      //   "custom" -> the name they typed in themselves
      const stripeName = inv.account_name || merchant.name;
      const businessName = settings.nameMode === "custom" && settings.customName
        ? settings.customName
        : stripeName;
      const sent = await sendDunning({
        to: inv.customer_email,
        attempt: rec.attempts,
        amount: inv.amount_due,
        currency: inv.currency,
        recoverUrl: url,
        businessName,
        replyTo: settings.replyTo || merchant.supportEmail,
      });
      logEvent(inv.id, "email_sent", sent.subject);

      await slack(`:money_with_wings: Zahlung fehlgeschlagen – ${money(inv.amount_due, inv.currency)} `
        + `(${inv.customer_email}). Dunning-Mail #${rec.attempts} raus.`);
    }

    if (event.type === "invoice.payment_succeeded" || event.type === "invoice.paid") {
      const inv = event.data.object;
      markRecovered(inv.id);
      logEvent(inv.id, "recovered", money(inv.amount_due, inv.currency));
      await slack(`:white_check_mark: Zahlung gerettet – ${money(inv.amount_due, inv.currency)} (${inv.customer_email}).`);
    }
  } catch (e) {
    console.error("handler error:", e.message);
    // Return 200 anyway so Stripe doesn't retry-storm us on a transient bug.
  }

  res.json({ received: true });
});

// --- Public landing page at the domain root ---
app.get("/", (req, res) => {
  const file = path.join(__dirname, "..", "landing.html");
  if (fs.existsSync(file)) return res.sendFile(file);
  res.redirect("/dashboard");
});

// --- Tiny dashboard so the customer sees the value (= why they keep paying) ---
app.get("/dashboard", (req, res) => {
  const s = stats();
  const cur = "EUR";
  res.send(`<!doctype html><meta charset="utf-8">
  <title>PayRescue</title>
  <body style="font-family:system-ui;max-width:560px;margin:60px auto;color:#111">
    <h1>PayRescue</h1>
    <p style="color:#555">Wiederhergestellte Einnahmen, automatisch.</p>
    <div style="display:flex;gap:16px;margin-top:24px">
      <div style="flex:1;padding:20px;border:1px solid #eee;border-radius:12px">
        <div style="font-size:13px;color:#888">Gerettet</div>
        <div style="font-size:28px;font-weight:700">${money(s.recovered_cents, cur)}</div>
        <div style="font-size:13px;color:#888">${s.recovered_count} Zahlungen</div>
      </div>
      <div style="flex:1;padding:20px;border:1px solid #eee;border-radius:12px">
        <div style="font-size:13px;color:#888">Offen</div>
        <div style="font-size:28px;font-weight:700">${money(s.open_cents, cur)}</div>
        <div style="font-size:13px;color:#888">${s.open_count} in Bearbeitung</div>
      </div>
    </div>
  </body>`);
});

// --- Merchant settings: choose the dunning-mail sender identity ---
// Optional light guard: set ADMIN_TOKEN to require ?token=... on this page.
function settingsAllowed(req) {
  const need = process.env.ADMIN_TOKEN;
  return !need || req.query.token === need || req.body?.token === need;
}

function esc(s = "") {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

app.get("/settings", async (req, res) => {
  if (!settingsAllowed(req)) return res.status(401).send("Nicht autorisiert.");
  const s = getSettings();
  const m = await merchantInfo();
  const stripeName = m.name || "(in Stripe kein Firmenname hinterlegt)";
  const tokenField = process.env.ADMIN_TOKEN
    ? `<input type="hidden" name="token" value="${esc(req.query.token || "")}">` : "";
  const sel = (v) => (s.nameMode === v ? "checked" : "");
  res.send(`<!doctype html><meta charset="utf-8">
  <title>PayRescue – Einstellungen</title>
  <body style="font-family:system-ui;max-width:560px;margin:48px auto;color:#111;line-height:1.5">
    <h1 style="margin-bottom:4px">Absender deiner Zahlungs-E-Mails</h1>
    <p style="color:#555;margin-top:0">So erscheint der Absender deiner Mahn-E-Mails bei deinen Kunden.</p>
    <form method="post" action="/settings" style="margin-top:24px">
      ${tokenField}
      <label style="display:flex;gap:10px;align-items:flex-start;padding:14px;border:1px solid #e5e5e5;border-radius:12px;margin-bottom:12px;cursor:pointer">
        <input type="radio" name="nameMode" value="stripe" ${sel("stripe")} style="margin-top:4px">
        <span><b>Markennamen aus Stripe verwenden</b><br>
        <span style="color:#666;font-size:14px">Aktuell aus Stripe: <b>${esc(stripeName)}</b>. Wird automatisch aktuell gehalten.</span></span>
      </label>
      <label style="display:flex;gap:10px;align-items:flex-start;padding:14px;border:1px solid #e5e5e5;border-radius:12px;margin-bottom:12px;cursor:pointer">
        <input type="radio" name="nameMode" value="custom" ${sel("custom")} style="margin-top:4px">
        <span><b>Eigenen Namen eintragen</b><br>
        <span style="color:#666;font-size:14px">Überschreibt den Stripe-Namen.</span></span>
      </label>
      <input name="customName" value="${esc(s.customName)}" placeholder="z. B. Mustermann GmbH"
        style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;margin-bottom:18px;font-size:15px">
      <label style="display:block;font-weight:600;margin-bottom:6px">Antwort-Adresse (Reply-To)</label>
      <input name="replyTo" type="email" value="${esc(s.replyTo)}" placeholder="support@deinefirma.de"
        style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;margin-bottom:8px;font-size:15px">
      <p style="color:#888;font-size:13px;margin-top:0">Leer lassen, um die in Stripe hinterlegte Support-Adresse zu nutzen.</p>
      <button type="submit" style="margin-top:16px;background:#111;color:#fff;border:0;padding:12px 20px;border-radius:10px;font-size:15px;cursor:pointer">Speichern</button>
    </form>
  </body>`);
});

app.post("/settings", express.urlencoded({ extended: false }), (req, res) => {
  if (!settingsAllowed(req)) return res.status(401).send("Nicht autorisiert.");
  saveSettings({
    nameMode: req.body.nameMode === "custom" ? "custom" : "stripe",
    customName: (req.body.customName || "").trim(),
    replyTo: (req.body.replyTo || "").trim(),
  });
  const token = process.env.ADMIN_TOKEN ? `?token=${encodeURIComponent(req.body.token || "")}` : "";
  res.redirect(`/settings${token}`);
});

app.get("/health", (_, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`PayRescue läuft auf :${port}`));
