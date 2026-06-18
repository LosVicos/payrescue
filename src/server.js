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
import {
  upsertFailure, markRecovered, logEvent, stats, getSettings, saveSettings,
  getPlan, usageThisMonth, invoiceDunnedThisMonth, listRecoveries, PLANS,
} from "./db.js";
import { sendDunning, notifyMerchant, money, templateDefaults, STEP_COUNT } from "./email.js";

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

      // Plan enforcement: a "rescue" = one at-risk invoice we dun this month.
      // Retries on an already-counted invoice always pass; brand-new invoices
      // are blocked once the monthly quota is hit, with a one-time heads-up.
      const plan = getPlan();
      const counted = invoiceDunnedThisMonth(inv.id);
      const used = usageThisMonth();
      if (!counted && used >= plan.limit) {
        logEvent(inv.id, "limit_reached", `${plan.name}: ${used}/${plan.limit}`);
        await slack(`:no_entry: Monatslimit erreicht (${plan.name}: ${plan.limit} Rettungen). `
          + `Neue fehlgeschlagene Zahlung ${money(inv.amount_due, inv.currency)} (${inv.customer_email}) NICHT angemahnt. Upgrade nötig.`);
        await notifyMerchant({
          to: settings.notifyEmail, kind: "limit",
          amount: inv.amount_due, currency: inv.currency,
          customerEmail: inv.customer_email, plan: plan.name, limit: plan.limit,
        });
        return res.json({ received: true, skipped: "monthly_limit" });
      }

      // Custom dunning texts are a Growth+ feature; Starter always uses defaults.
      const templates = plan.key === "starter" ? [] : settings.templates;
      const sent = await sendDunning({
        to: inv.customer_email,
        attempt: rec.attempts,
        amount: inv.amount_due,
        currency: inv.currency,
        recoverUrl: url,
        businessName,
        replyTo: settings.replyTo || merchant.supportEmail,
        templates,
      });
      logEvent(inv.id, "email_sent", sent.subject);

      await slack(`:money_with_wings: Zahlung fehlgeschlagen – ${money(inv.amount_due, inv.currency)} `
        + `(${inv.customer_email}). Dunning-Mail #${rec.attempts} raus.`);
      // Optional heads-up to the merchant by email (for those who don't use Slack).
      await notifyMerchant({
        to: settings.notifyEmail,
        kind: "failed",
        amount: inv.amount_due,
        currency: inv.currency,
        customerEmail: inv.customer_email,
        attempt: rec.attempts,
      });
    }

    if (event.type === "invoice.payment_succeeded" || event.type === "invoice.paid") {
      const inv = event.data.object;
      markRecovered(inv.id);
      logEvent(inv.id, "recovered", money(inv.amount_due, inv.currency));
      await slack(`:white_check_mark: Zahlung gerettet – ${money(inv.amount_due, inv.currency)} (${inv.customer_email}).`);
      const settings = getSettings();
      await notifyMerchant({
        to: settings.notifyEmail,
        kind: "recovered",
        amount: inv.amount_due,
        currency: inv.currency,
        customerEmail: inv.customer_email,
      });
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

// --- Legal pages (Pflichtangaben nach deutschem Recht) ---
function sendStatic(res, name) {
  const file = path.join(__dirname, "..", name);
  if (fs.existsSync(file)) return res.sendFile(file);
  return res.status(404).send("Seite nicht gefunden.");
}
app.get("/impressum", (_, res) => sendStatic(res, "impressum.html"));
app.get("/datenschutz", (_, res) => sendStatic(res, "datenschutz.html"));
app.get("/agb", (_, res) => sendStatic(res, "agb.html"));

// --- Dashboard: value (recovered €) + plan usage + a detailed recovery list ---
app.get("/dashboard", (req, res) => {
  const s = stats();
  const cur = "EUR";
  const plan = getPlan();
  const used = usageThisMonth();
  const limitTxt = plan.limit === Infinity ? "∞" : String(plan.limit);
  const pct = plan.limit === Infinity ? 0 : Math.min(100, Math.round((used / plan.limit) * 100));
  const barColor = pct >= 90 ? "#dc2626" : pct >= 70 ? "#d97706" : "#16a34a";
  const month = new Date().toLocaleDateString("de-DE", { month: "long", year: "numeric" });

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("de-DE",
    { day: "2-digit", month: "2-digit", year: "2-digit" }) : "–";
  const badge = (st) => st === "recovered"
    ? `<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:999px;font-size:12px">gerettet</span>`
    : `<span style="background:#fef9c3;color:#854d0e;padding:2px 8px;border-radius:999px;font-size:12px">offen</span>`;
  const rows = listRecoveries(50).map((r) => `<tr style="border-top:1px solid #f0f0f0">
      <td style="padding:10px 8px">${esc(r.customerEmail || "–")}</td>
      <td style="padding:10px 8px;text-align:right;white-space:nowrap">${money(r.amountDue, r.currency || cur)}</td>
      <td style="padding:10px 8px;text-align:center">${r.attempts || 0}</td>
      <td style="padding:10px 8px;text-align:center">${badge(r.status)}</td>
      <td style="padding:10px 8px;color:#888;white-space:nowrap">${fmtDate(r.recoveredAt || r.createdAt)}</td>
    </tr>`).join("") || `<tr><td colspan="5" style="padding:18px 8px;color:#999;text-align:center">Noch keine Vorgänge.</td></tr>`;

  res.send(`<!doctype html><meta charset="utf-8">
  <title>PayRescue</title>
  <body style="font-family:system-ui;max-width:760px;margin:60px auto;color:#111;padding:0 16px">
    <h1 style="margin-bottom:2px">PayRescue</h1>
    <p style="color:#555;margin-top:0">Wiederhergestellte Einnahmen, automatisch. · <a href="/settings" style="color:#2563eb;text-decoration:none">Einstellungen</a></p>
    <div style="display:flex;gap:16px;margin-top:24px;flex-wrap:wrap">
      <div style="flex:1;min-width:200px;padding:20px;border:1px solid #eee;border-radius:12px">
        <div style="font-size:13px;color:#888">Gerettet</div>
        <div style="font-size:28px;font-weight:700">${money(s.recovered_cents, cur)}</div>
        <div style="font-size:13px;color:#888">${s.recovered_count} Zahlungen</div>
      </div>
      <div style="flex:1;min-width:200px;padding:20px;border:1px solid #eee;border-radius:12px">
        <div style="font-size:13px;color:#888">Offen</div>
        <div style="font-size:28px;font-weight:700">${money(s.open_cents, cur)}</div>
        <div style="font-size:13px;color:#888">${s.open_count} in Bearbeitung</div>
      </div>
    </div>

    <div style="margin-top:16px;padding:20px;border:1px solid #eee;border-radius:12px">
      <div style="display:flex;justify-content:space-between;font-size:13px;color:#888">
        <span>Rettungen im ${esc(month)} · Plan <b style="color:#111">${esc(plan.name)}</b></span>
        <span>${used} / ${limitTxt}</span>
      </div>
      <div style="height:8px;background:#f0f0f0;border-radius:999px;margin-top:8px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${barColor}"></div>
      </div>
      ${plan.limit !== Infinity && used >= plan.limit
        ? `<p style="color:#dc2626;font-size:13px;margin:10px 0 0">Monatslimit erreicht – neue Zahlungen werden erst nach einem <a href="/settings" style="color:#dc2626">Upgrade</a> wieder angemahnt.</p>`
        : ``}
    </div>

    <h2 style="font-size:17px;margin:32px 0 8px">Vorgänge</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="text-align:left;color:#888;font-size:12px">
        <th style="padding:0 8px 6px">Kunde</th>
        <th style="padding:0 8px 6px;text-align:right">Betrag</th>
        <th style="padding:0 8px 6px;text-align:center">Mahnungen</th>
        <th style="padding:0 8px 6px;text-align:center">Status</th>
        <th style="padding:0 8px 6px">Datum</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
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
  const plan = getPlan();
  const customAllowed = plan.key !== "starter";

  // Plan picker cards.
  const planCards = Object.values(PLANS).map((p) => {
    const lim = p.limit === Infinity ? "Unbegrenzte Rettungen" : `Bis ${p.limit} Rettungen/Monat`;
    const checked = s.plan === p.key ? "checked" : "";
    return `<label style="display:flex;gap:10px;align-items:flex-start;padding:14px;border:1px solid ${s.plan === p.key ? "#111" : "#e5e5e5"};border-radius:12px;margin-bottom:10px;cursor:pointer">
        <input type="radio" name="plan" value="${p.key}" ${checked} style="margin-top:4px">
        <span><b>${esc(p.name)}</b> · ${p.price} €/Monat<br>
        <span style="color:#666;font-size:14px">${lim}${p.key !== "starter" ? " · eigene Mail-Texte" : ""}</span></span>
      </label>`;
  }).join("");

  // Custom dunning-text editor (one block per step), pre-filled with the
  // merchant's saved override or empty (placeholder shows the default copy).
  const defs = templateDefaults();
  const tpl = Array.isArray(s.templates) ? s.templates : [];
  const field = (i, key, label, def, big) => {
    const val = esc((tpl[i] && tpl[i][key]) || "");
    const ph = esc(def);
    return big
      ? `<label style="display:block;font-size:13px;color:#555;margin:8px 0 4px">${label}</label>
         <textarea name="tpl_${i}_${key}" rows="4" placeholder="${ph}" ${customAllowed ? "" : "disabled"}
           style="width:100%;padding:9px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;resize:vertical">${val}</textarea>`
      : `<label style="display:block;font-size:13px;color:#555;margin:8px 0 4px">${label}</label>
         <input name="tpl_${i}_${key}" value="${val}" placeholder="${ph}" ${customAllowed ? "" : "disabled"}
           style="width:100%;padding:9px;border:1px solid #ddd;border-radius:8px;font-size:14px">`;
  };
  const stepNames = ["1 · Freundlicher Hinweis", "2 · Erinnerung", "3 · Letzte Mahnung"];
  const tplBlocks = defs.map((d, i) => `<details style="border:1px solid #e5e5e5;border-radius:12px;padding:8px 14px;margin-bottom:10px">
      <summary style="cursor:pointer;font-weight:600;padding:6px 0">Stufe ${stepNames[i] || (i + 1)}</summary>
      ${field(i, "subject", "Betreff", d.subject, false)}
      ${field(i, "cta", "Button-Text", d.cta, false)}
      ${field(i, "intro", "Einleitung (vor dem Button)", d.intro, true)}
      ${field(i, "outro", "Schluss (nach dem Button)", d.outro, true)}
    </details>`).join("");

  res.send(`<!doctype html><meta charset="utf-8">
  <title>PayRescue – Einstellungen</title>
  <body style="font-family:system-ui;max-width:560px;margin:48px auto;color:#111;line-height:1.5;padding:0 16px">
    <p style="margin:0 0 24px"><a href="/dashboard" style="color:#2563eb;text-decoration:none">← Dashboard</a></p>

    <h1 style="margin-bottom:4px">Dein Plan</h1>
    <p style="color:#555;margin-top:0">Bestimmt, wie viele Rettungen pro Monat möglich sind.</p>
    <form method="post" action="/settings" style="margin-top:16px">
      ${tokenField}
      ${planCards}

      <h2 style="margin:32px 0 4px;font-size:19px">Absender deiner Zahlungs-E-Mails</h2>
      <p style="color:#555;margin-top:0">So erscheint der Absender deiner Mahn-E-Mails bei deinen Kunden.</p>
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
      <p style="color:#888;font-size:13px;margin:0 0 18px">Leer lassen, um die in Stripe hinterlegte Support-Adresse zu nutzen.</p>

      <label style="display:block;font-weight:600;margin-bottom:6px">Benachrichtigungs-E-Mail (an dich)</label>
      <input name="notifyEmail" type="email" value="${esc(s.notifyEmail)}" placeholder="${esc(m.supportEmail || "du@deinefirma.de")}"
        style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;margin-bottom:8px;font-size:15px">
      <p style="color:#888;font-size:13px;margin:0 0 18px">Du bekommst eine kurze E-Mail bei jeder fehlgeschlagenen und jeder geretteten Zahlung. Leer lassen zum Abschalten. (Slack bleibt unabhängig davon aktiv, falls eingerichtet.)</p>

      <h2 style="margin:32px 0 4px;font-size:19px">Eigene Mail-Texte</h2>
      <p style="color:#555;margin-top:0">Passe die drei Mahnstufen an deine Tonalität an. Platzhalter: <code>{firma}</code>, <code>{betrag}</code>. Leere Felder nutzen automatisch den Standardtext.</p>
      ${customAllowed ? "" : `<p style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;padding:10px 12px;border-radius:10px;font-size:14px">Eigene Mail-Texte sind ab dem <b>Growth</b>-Plan verfügbar. Wähle oben Growth oder Scale, um sie zu bearbeiten.</p>`}
      ${tplBlocks}

      <button type="submit" style="margin-top:16px;background:#111;color:#fff;border:0;padding:12px 20px;border-radius:10px;font-size:15px;cursor:pointer">Speichern</button>
    </form>
  </body>`);
});

app.post("/settings", express.urlencoded({ extended: true }), (req, res) => {
  if (!settingsAllowed(req)) return res.status(401).send("Nicht autorisiert.");
  const planKey = PLANS[req.body.plan] ? req.body.plan : "starter";
  // Collect per-step template overrides from tpl_<i>_<key> fields.
  const templates = [];
  for (let i = 0; i < STEP_COUNT; i++) {
    templates.push({
      subject: (req.body[`tpl_${i}_subject`] || "").trim(),
      cta: (req.body[`tpl_${i}_cta`] || "").trim(),
      intro: (req.body[`tpl_${i}_intro`] || "").trim(),
      outro: (req.body[`tpl_${i}_outro`] || "").trim(),
    });
  }
  saveSettings({
    plan: planKey,
    nameMode: req.body.nameMode === "custom" ? "custom" : "stripe",
    customName: (req.body.customName || "").trim(),
    replyTo: (req.body.replyTo || "").trim(),
    notifyEmail: (req.body.notifyEmail || "").trim(),
    templates,
  });
  const token = process.env.ADMIN_TOKEN ? `?token=${encodeURIComponent(req.body.token || "")}` : "";
  res.redirect(`/settings${token}`);
});

app.get("/health", (_, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`PayRescue läuft auf :${port}`));
