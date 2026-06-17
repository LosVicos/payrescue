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
import { upsertFailure, markRecovered, logEvent, stats } from "./db.js";
import { sendDunning, money } from "./email.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

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
      const sent = await sendDunning({
        to: inv.customer_email,
        attempt: rec.attempts,
        amount: inv.amount_due,
        currency: inv.currency,
        recoverUrl: url,
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
  const file = path.join(__dirname, "landing.html");
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

app.get("/health", (_, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`PayRescue läuft auf :${port}`));
