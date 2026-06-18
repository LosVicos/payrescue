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
  ownerId, getOrCreateAccount, createLoginToken, consumeLoginToken,
  createSession, getSessionAccount, destroySession,
  getBilling, setBilling, findAccountByCustomer,
} from "./db.js";
import { sendDunning, notifyMerchant, money, templateDefaults, STEP_COUNT, sendLoginLink } from "./email.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// --- PayRescue's own subscription billing (Stripe Checkout/Portal) --------
// Each plan maps to a recurring Stripe Price the merchant creates once in their
// Stripe dashboard and pastes here as an env var. Until set, checkout shows a
// friendly "coming soon" page instead of erroring.
const PLAN_PRICE = {
  starter: process.env.PR_PRICE_STARTER || "",
  growth: process.env.PR_PRICE_GROWTH || "",
  scale: process.env.PR_PRICE_SCALE || "",
};
// Reverse map (priceId -> planKey) for subscription webhook events.
const PRICE_PLAN = Object.fromEntries(
  Object.entries(PLAN_PRICE).filter(([, v]) => v).map(([k, v]) => [v, k])
);
const billingConfigured = (plan) => Boolean(PLAN_PRICE[plan]);
const APP_BASE = () =>
  process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
// 5-day free trial, matching the landing-page promise.
const TRIAL_DAYS = Number(process.env.PR_TRIAL_DAYS || 5);

// --- Shared dark theme, matching the public landing page ------------------
const THEME = `
  :root{--bg:#0b0f17;--card:#121826;--line:#222c3e;--text:#e8edf6;
    --muted:#94a3b8;--brand:#34d399;--brand2:#10b981;--accent:#38bdf8}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
    background:var(--bg);color:var(--text);line-height:1.55;-webkit-font-smoothing:antialiased}
  a{color:inherit}
  .wrap{max-width:880px;margin:0 auto;padding:0 24px}
  .narrow{max-width:440px}
  nav{display:flex;justify-content:space-between;align-items:center;padding:20px 0;border-bottom:1px solid var(--line)}
  .logo{font-weight:800;font-size:20px;letter-spacing:-.02em;text-decoration:none}
  .logo span{color:var(--brand)}
  .navlinks{display:flex;gap:16px;align-items:center;font-size:14px;color:var(--muted)}
  .navlinks a{text-decoration:none}
  .navlinks a.active{color:var(--text)}
  .btn{display:inline-block;background:linear-gradient(180deg,var(--brand),var(--brand2));
    color:#04231a;font-weight:700;padding:12px 22px;border-radius:12px;text-decoration:none;
    border:none;cursor:pointer;font-size:15px;transition:transform .08s}
  .btn:hover{transform:translateY(-1px)}
  .btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line);font-weight:600}
  .btn.full{width:100%;text-align:center}
  h1{font-size:30px;letter-spacing:-.02em;margin-bottom:6px}
  h2{font-size:20px;letter-spacing:-.01em;margin-bottom:4px}
  .muted{color:var(--muted)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px}
  .stat .lbl{font-size:13px;color:var(--muted)}
  .stat .big{font-size:30px;font-weight:800;letter-spacing:-.02em;margin:2px 0}
  input,textarea,select{width:100%;padding:12px;border:1px solid var(--line);background:#0e1422;
    color:var(--text);border-radius:10px;font-size:15px;font-family:inherit;resize:vertical}
  input::placeholder,textarea::placeholder{color:#5b6b82}
  input:focus,textarea:focus{outline:none;border-color:var(--brand)}
  .flabel{display:block;font-size:14px;color:var(--muted);margin:14px 0 6px;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th{text-align:left;color:var(--muted);font-size:12px;font-weight:600;padding:0 10px 10px}
  td{padding:12px 10px;border-top:1px solid var(--line)}
  .badge{padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}
  .badge.ok{background:#0e2a20;color:var(--brand)}
  .badge.open{background:#2a2410;color:#fbbf24}
  .radio{display:flex;gap:12px;align-items:flex-start;padding:14px;border:1px solid var(--line);
    border-radius:12px;margin-bottom:12px;cursor:pointer;background:var(--card)}
  .radio.sel{border-color:var(--brand);box-shadow:0 0 0 1px var(--brand)}
  details{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px 16px;margin-bottom:10px}
  summary{cursor:pointer;font-weight:600;padding:10px 0}
  .notice{padding:14px 16px;border-radius:12px;font-size:14px}
  .notice.warn{background:#1f1a0e;border:1px solid #3a320e;color:#fbbf24}
  .notice.info{background:#0e1f2a;border:1px solid #14323a;color:var(--accent)}
  .notice.ok{background:#0e2a20;border:1px solid #143a2c;color:var(--brand)}
  .notice.err{background:#2a1010;border:1px solid #3a1414;color:#f87171}
  code{background:#0e1422;border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:13px}
  .bar{height:8px;background:#0e1422;border-radius:999px;margin-top:10px;overflow:hidden}
`;

// Full HTML document with the shared theme applied.
function page(title, body, { narrow = false } = {}) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title><style>${THEME}</style></head>
  <body><div class="wrap${narrow ? " narrow" : ""}" style="padding-top:0">${body}</div></body></html>`;
}

// Top nav for the logged-in app (logo + section links + account/logout).
function topnav(account, active = "") {
  const link = (href, label) =>
    `<a href="${href}" class="${active === href ? "active" : ""}">${label}</a>`;
  return `<nav>
    <a href="/dashboard" class="logo">Pay<span>Rescue</span></a>
    <div class="navlinks">
      ${link("/dashboard", "Dashboard")}
      ${link("/settings", "Einstellungen")}
      <span style="color:#3a455a">·</span>
      <span title="${esc(account.email)}">${esc(account.email)}</span>
      <a href="/logout">Abmelden</a>
    </div>
  </nav>`;
}

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

// An invoice belongs to PayRescue's OWN subscription billing (not a merchant's
// dunning traffic) if its customer is a known billing customer or one of its
// line items uses one of our plan prices. Such invoices must never be dunned.
function isOwnBillingInvoice(inv) {
  if (!inv) return false;
  if (findAccountByCustomer(inv.customer)) return true;
  const lines = inv.lines?.data || [];
  return lines.some((l) => PRICE_PLAN[l.price?.id]);
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
    // PayRescue's own subscription invoices are handled by the checkout/
    // subscription branches below — never as merchant dunning.
    if (event.type.startsWith("invoice.") && isOwnBillingInvoice(event.data.object)) {
      return res.json({ received: true, note: "own_billing_invoice" });
    }

    if (event.type === "invoice.payment_failed") {
      const inv = event.data.object;
      const rec = upsertFailure(ownerId, {
        invoiceId: inv.id,
        customerId: inv.customer,
        email: inv.customer_email,
        amount: inv.amount_due,
        currency: inv.currency,
      });
      logEvent(ownerId, inv.id, "failed", `attempt ${rec.attempts}`);

      const url = await recoveryUrl(inv.customer);
      const merchant = await merchantInfo();
      const settings = getSettings(ownerId);
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
      const plan = getPlan(ownerId);
      const counted = invoiceDunnedThisMonth(ownerId, inv.id);
      const used = usageThisMonth(ownerId);
      if (!counted && used >= plan.limit) {
        logEvent(ownerId, inv.id, "limit_reached", `${plan.name}: ${used}/${plan.limit}`);
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
      logEvent(ownerId, inv.id, "email_sent", sent.subject);

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
      markRecovered(ownerId, inv.id);
      logEvent(ownerId, inv.id, "recovered", money(inv.amount_due, inv.currency));
      await slack(`:white_check_mark: Zahlung gerettet – ${money(inv.amount_due, inv.currency)} (${inv.customer_email}).`);
      const settings = getSettings(ownerId);
      await notifyMerchant({
        to: settings.notifyEmail,
        kind: "recovered",
        amount: inv.amount_due,
        currency: inv.currency,
        customerEmail: inv.customer_email,
      });
    }

    // --- PayRescue's own subscription lifecycle -------------------------
    // The merchant just subscribed (or restarted) via Checkout: bind the
    // Stripe customer + subscription to their account and set the plan.
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const accId = s.client_reference_id || s.metadata?.accountId;
      const planKey = s.metadata?.plan;
      if (accId) {
        setBilling(accId, {
          customerId: s.customer,
          subscriptionId: s.subscription,
          status: "active",
        });
        if (planKey && PLANS[planKey]) saveSettings(accId, { plan: planKey });
        logEvent(accId, s.id, "subscribed", planKey || "");
      }
    }

    // Plan changes (up/downgrade, trial->active) keep the account's plan in
    // sync with the live subscription's price.
    if (event.type === "customer.subscription.updated"
      || event.type === "customer.subscription.created") {
      const sub = event.data.object;
      const a = findAccountByCustomer(sub.customer);
      if (a) {
        const priceId = sub.items?.data?.[0]?.price?.id;
        const planKey = PRICE_PLAN[priceId];
        setBilling(a.id, { subscriptionId: sub.id, status: sub.status });
        if (planKey && (sub.status === "active" || sub.status === "trialing")) {
          saveSettings(a.id, { plan: planKey });
        }
      }
    }

    // Subscription ended (cancellation took effect): downgrade to entry plan.
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const a = findAccountByCustomer(sub.customer);
      if (a) {
        setBilling(a.id, { status: "canceled" });
        saveSettings(a.id, { plan: "starter" });
        logEvent(a.id, sub.id, "subscription_canceled", "");
      }
    }
  } catch (e) {
    console.error("handler error:", e.message);
    // Return 200 anyway so Stripe doesn't retry-storm us on a transient bug.
  }

  res.json({ received: true });
});

// --- Auth: magic-link login + server-side sessions (httpOnly cookie) -------
const COOKIE = "pr_session";
// Short-lived hint that remembers which plan a logged-out visitor clicked, so
// we can drop them straight into Checkout after they log in.
const INTENT = "pr_intent";

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isHttps = () => (process.env.APP_BASE_URL || "").startsWith("https");
function sessionCookieStr(token) {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Lax${isHttps() ? "; Secure" : ""}`;
}
function intentCookieStr(plan) {
  return `${INTENT}=${encodeURIComponent(plan)}; HttpOnly; Path=/; Max-Age=1800; SameSite=Lax${isHttps() ? "; Secure" : ""}`;
}
const clearIntentStr = () => `${INTENT}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", sessionCookieStr(token));
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// Resolve the logged-in account from the session cookie, or null.
function currentAccount(req) {
  const token = parseCookies(req)[COOKIE];
  return getSessionAccount(token);
}

// Gate a route behind login. Redirects to /login if no valid session.
function requireAuth(req, res, next) {
  const acct = currentAccount(req);
  if (!acct) return res.redirect("/login");
  req.account = acct;
  next();
}

function loginPage({ sent, error } = {}) {
  const msg = sent
    ? `<div class="notice ok" style="margin-bottom:16px">Link verschickt! Schau in dein Postfach (${esc(sent)}). Der Link ist 20 Minuten gültig.</div>`
    : error
    ? `<div class="notice err" style="margin-bottom:16px">${esc(error)}</div>`
    : "";
  const body = `
    <div style="padding:28px 0 40px;text-align:center">
      <a href="/" class="logo" style="font-size:24px">Pay<span>Rescue</span></a>
    </div>
    <div class="card">
      <h1>Anmelden</h1>
      <p class="muted" style="margin-bottom:18px">Gib deine E-Mail ein – wir schicken dir einen Login-Link. Kein Passwort nötig.</p>
      ${msg}
      <form method="post" action="/login">
        <input name="email" type="email" required placeholder="du@deinefirma.de" style="margin-bottom:14px">
        <button type="submit" class="btn full">Login-Link senden</button>
      </form>
    </div>
    <p class="muted" style="font-size:13px;margin-top:22px;text-align:center"><a href="/">← Zur Startseite</a></p>`;
  return page("PayRescue – Anmelden", body, { narrow: true });
}

app.get("/login", (req, res) => {
  if (currentAccount(req)) return res.redirect("/dashboard");
  res.send(loginPage());
});

app.post("/login", express.urlencoded({ extended: true }), async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return res.status(400).send(loginPage({ error: "Bitte eine gültige E-Mail-Adresse eingeben." }));
  }
  const token = createLoginToken(email);
  const base = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const url = `${base}/login/verify?token=${encodeURIComponent(token)}`;
  try {
    await sendLoginLink({ to: email, url });
  } catch (e) {
    console.error("login mail error:", e.message);
  }
  res.send(loginPage({ sent: email }));
});

app.get("/login/verify", (req, res) => {
  const email = consumeLoginToken(req.query.token);
  if (!email) {
    return res.status(400).send(loginPage({ error: "Dieser Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an." }));
  }
  const acct = getOrCreateAccount(email);
  const session = createSession(acct.id);
  // If they came in via a pricing button, continue to Checkout; else dashboard.
  const intent = parseCookies(req)[INTENT];
  const cookies = [sessionCookieStr(session)];
  let dest = "/dashboard";
  if (intent && PLANS[intent]) {
    dest = `/billing/checkout?plan=${intent}`;
    cookies.push(clearIntentStr());
  }
  res.setHeader("Set-Cookie", cookies);
  res.redirect(dest);
});

app.get("/logout", (req, res) => {
  const token = parseCookies(req)[COOKIE];
  destroySession(token);
  clearSessionCookie(res);
  res.redirect("/login");
});

// --- PayRescue subscription: Checkout + Customer Portal --------------------

// Small standalone notice page (used when checkout isn't configured yet).
function noticePage(title, html) {
  const body = `
    <div style="padding:28px 0 28px;text-align:center">
      <a href="/" class="logo" style="font-size:24px">Pay<span>Rescue</span></a>
    </div>
    <div class="card">${html}</div>
    <p class="muted" style="font-size:13px;margin-top:22px;text-align:center"><a href="/dashboard">← Zum Dashboard</a></p>`;
  return page(title, body, { narrow: true });
}

// Entry point from the public pricing buttons. Remembers the chosen plan and
// sends logged-out visitors through login first, then on to Checkout.
app.get("/billing/start", (req, res) => {
  const plan = String(req.query.plan || "");
  if (!PLANS[plan]) return res.redirect("/#start");
  if (currentAccount(req)) return res.redirect(`/billing/checkout?plan=${plan}`);
  res.setHeader("Set-Cookie", intentCookieStr(plan));
  res.redirect("/login");
});

// Create a Stripe Checkout session for the chosen plan and redirect to it.
app.get("/billing/checkout", requireAuth, async (req, res) => {
  const plan = String(req.query.plan || "");
  if (!PLANS[plan]) return res.redirect("/settings");
  if (!billingConfigured(plan)) {
    return res.status(503).send(noticePage("PayRescue – Abo",
      `<h1>Abo bald verfügbar</h1>
       <p class="muted" style="margin-top:8px">Der Checkout für den <b>${esc(PLANS[plan].name)}</b>-Plan wird gerade fertig eingerichtet
       (Stripe-Preis noch nicht hinterlegt). Sobald die Preis-ID gesetzt ist, kannst du hier direkt buchen.</p>`));
  }
  try {
    const aid = req.account.id;
    const bill = getBilling(aid);
    const params = {
      mode: "subscription",
      line_items: [{ price: PLAN_PRICE[plan], quantity: 1 }],
      client_reference_id: aid,
      metadata: { accountId: aid, plan },
      subscription_data: {
        ...(Number.isFinite(TRIAL_DAYS) && TRIAL_DAYS >= 1 ? { trial_period_days: Math.floor(TRIAL_DAYS) } : {}),
        metadata: { accountId: aid, plan },
      },
      allow_promotion_codes: true,
      success_url: `${APP_BASE()}/dashboard?abo=ok`,
      cancel_url: `${APP_BASE()}/settings?abo=abbruch`,
    };
    // Reuse the existing billing customer if we already have one; otherwise let
    // Checkout create one from the account email.
    if (bill.customerId) params.customer = bill.customerId;
    else params.customer_email = req.account.email;

    const session = await stripe.checkout.sessions.create(params);
    res.redirect(303, session.url);
  } catch (e) {
    console.error("checkout error:", e.message);
    res.status(500).send(noticePage("PayRescue – Abo",
      `<h1>Checkout fehlgeschlagen</h1>
       <p class="muted" style="margin-top:8px">Der Checkout konnte nicht gestartet werden. Bitte versuche es später erneut.</p>`));
  }
});

// Open the Stripe Customer Portal so the merchant can update payment details,
// switch plans or cancel.
app.get("/billing/portal", requireAuth, async (req, res) => {
  const bill = getBilling(req.account.id);
  if (!bill.customerId) {
    return res.status(400).send(noticePage("PayRescue – Abo",
      `<h1>Noch kein aktives Abo</h1>
       <p class="muted" style="margin-top:8px">Du hast aktuell kein laufendes Abo zum Verwalten. Wähle in den
       <a href="/settings">Einstellungen</a> einen Plan, um zu starten.</p>`));
  }
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: bill.customerId,
      return_url: `${APP_BASE()}/settings`,
    });
    res.redirect(303, portal.url);
  } catch (e) {
    console.error("portal error:", e.message);
    res.status(500).send(noticePage("PayRescue – Abo",
      `<h1>Portal nicht verfügbar</h1>
       <p class="muted" style="margin-top:8px">Das Kundenportal konnte nicht geöffnet werden. Bitte versuche es später erneut.</p>`));
  }
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
app.get("/dashboard", requireAuth, (req, res) => {
  const aid = req.account.id;
  const s = stats(aid);
  const cur = "EUR";
  const plan = getPlan(aid);
  const used = usageThisMonth(aid);
  const stripeConnected = req.account.stripe?.connected;
  const limitTxt = plan.limit === Infinity ? "∞" : String(plan.limit);
  const pct = plan.limit === Infinity ? 0 : Math.min(100, Math.round((used / plan.limit) * 100));
  const barColor = pct >= 90 ? "#dc2626" : pct >= 70 ? "#d97706" : "#16a34a";
  const month = new Date().toLocaleDateString("de-DE", { month: "long", year: "numeric" });

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("de-DE",
    { day: "2-digit", month: "2-digit", year: "2-digit" }) : "–";
  const badge = (st) => st === "recovered"
    ? `<span class="badge ok">gerettet</span>`
    : `<span class="badge open">offen</span>`;
  const rows = listRecoveries(aid, 50).map((r) => `<tr>
      <td>${esc(r.customerEmail || "–")}</td>
      <td style="text-align:right;white-space:nowrap">${money(r.amountDue, r.currency || cur)}</td>
      <td style="text-align:center">${r.attempts || 0}</td>
      <td style="text-align:center">${badge(r.status)}</td>
      <td style="color:var(--muted);white-space:nowrap">${fmtDate(r.recoveredAt || r.createdAt)}</td>
    </tr>`).join("") || `<tr><td colspan="5" style="padding:20px 10px;color:var(--muted);text-align:center">Noch keine Vorgänge.</td></tr>`;

  const body = `${topnav(req.account, "/dashboard")}
    <div style="padding:28px 0 0">
      <h1>Dashboard</h1>
      <p class="muted">Wiederhergestellte Einnahmen, automatisch.</p>
    </div>
    ${stripeConnected ? "" : `<div class="notice warn" style="margin-top:22px">
      <b>Stripe verbinden – kommt in Kürze</b><br>
      Dein Konto ist angelegt. Sobald die Stripe-Anbindung (1-Klick) freigeschaltet ist, beginnt PayRescue automatisch, deine fehlgeschlagenen Zahlungen zu retten. Du wirst per E-Mail benachrichtigt.
    </div>`}
    <div style="display:flex;gap:16px;margin-top:22px;flex-wrap:wrap">
      <div class="card stat" style="flex:1;min-width:200px">
        <div class="lbl">Gerettet</div>
        <div class="big" style="color:var(--brand)">${money(s.recovered_cents, cur)}</div>
        <div class="lbl">${s.recovered_count} Zahlungen</div>
      </div>
      <div class="card stat" style="flex:1;min-width:200px">
        <div class="lbl">Offen</div>
        <div class="big">${money(s.open_cents, cur)}</div>
        <div class="lbl">${s.open_count} in Bearbeitung</div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--muted)">
        <span>Rettungen im ${esc(month)} · Plan <b style="color:var(--text)">${esc(plan.name)}</b></span>
        <span>${used} / ${limitTxt}</span>
      </div>
      <div class="bar"><div style="height:100%;width:${pct}%;background:${barColor}"></div></div>
      ${plan.limit !== Infinity && used >= plan.limit
        ? `<p style="color:#f87171;font-size:13px;margin:10px 0 0">Monatslimit erreicht – neue Zahlungen werden erst nach einem <a href="/settings" style="color:#f87171">Upgrade</a> wieder angemahnt.</p>`
        : ``}
    </div>

    <h2 style="margin:34px 0 10px">Vorgänge</h2>
    <table>
      <thead><tr>
        <th>Kunde</th>
        <th style="text-align:right">Betrag</th>
        <th style="text-align:center">Mahnungen</th>
        <th style="text-align:center">Status</th>
        <th>Datum</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="height:50px"></div>`;
  res.send(page("PayRescue – Dashboard", body));
});

// --- Merchant settings: choose the dunning-mail sender identity ---
function esc(s = "") {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

app.get("/settings", requireAuth, async (req, res) => {
  const aid = req.account.id;
  const s = getSettings(aid);
  const m = await merchantInfo();
  const stripeName = m.name || "(in Stripe kein Firmenname hinterlegt)";
  const tokenField = "";
  const sel = (v) => (s.nameMode === v ? "checked" : "");
  const plan = getPlan(aid);
  const customAllowed = plan.key !== "starter";

  // --- PayRescue subscription status + Checkout/Portal buttons ----------
  const bill = getBilling(aid);
  const hasSub = Boolean(bill.customerId);
  const statusLabel = {
    active: "aktiv", trialing: "Testphase", past_due: "Zahlung überfällig",
    unpaid: "unbezahlt", canceled: "gekündigt",
  }[bill.status] || (hasSub ? (bill.status || "—") : "kein Abo");
  const statusOk = bill.status === "active" || bill.status === "trialing";
  const checkoutBtns = Object.values(PLANS).map((p) => {
    const isCurrent = plan.key === p.key && hasSub;
    const cls = p.key === "growth" ? "btn" : "btn ghost";
    if (isCurrent) return `<a class="btn ghost" style="opacity:.5;pointer-events:none">Aktueller Plan: ${esc(p.name)}</a>`;
    return `<a class="${cls}" href="/billing/checkout?plan=${p.key}">${esc(p.name)} buchen · ${p.price} €</a>`;
  }).join(" ");
  const billingCard = `<div class="card" style="margin-bottom:26px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <div style="font-size:15px"><b>Aktuelles Abo:</b> ${esc(plan.name)}
          <span class="badge ${statusOk ? "ok" : "open"}" style="margin-left:6px">${esc(statusLabel)}</span></div>
        ${hasSub ? `<a class="btn ghost" href="/billing/portal">Abo verwalten / kündigen</a>` : ""}
      </div>
      <p class="muted" style="font-size:13px;margin:12px 0 14px">${hasSub
        ? "Plan wechseln, Zahlungsdaten ändern oder kündigen – alles über das sichere Stripe-Kundenportal."
        : `Wähle einen Plan: ${TRIAL_DAYS} Tage kostenlos testen, danach monatlich, jederzeit kündbar.`}</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">${checkoutBtns}</div>
    </div>`;

  // Plan picker cards.
  const planCards = Object.values(PLANS).map((p) => {
    const lim = p.limit === Infinity ? "Unbegrenzte Rettungen" : `Bis ${p.limit} Rettungen/Monat`;
    const checked = s.plan === p.key ? "checked" : "";
    return `<label class="radio ${s.plan === p.key ? "sel" : ""}">
        <input type="radio" name="plan" value="${p.key}" ${checked} style="width:auto;margin-top:4px">
        <span><b>${esc(p.name)}</b> · ${p.price} €/Monat<br>
        <span class="muted" style="font-size:14px">${lim}${p.key !== "starter" ? " · eigene Mail-Texte" : ""}</span></span>
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
      ? `<label class="flabel">${label}</label>
         <textarea name="tpl_${i}_${key}" rows="4" placeholder="${ph}" ${customAllowed ? "" : "disabled"}>${val}</textarea>`
      : `<label class="flabel">${label}</label>
         <input name="tpl_${i}_${key}" value="${val}" placeholder="${ph}" ${customAllowed ? "" : "disabled"}>`;
  };
  const stepNames = ["1 · Freundlicher Hinweis", "2 · Erinnerung", "3 · Letzte Mahnung"];
  const tplBlocks = defs.map((d, i) => `<details>
      <summary>Stufe ${stepNames[i] || (i + 1)}</summary>
      ${field(i, "subject", "Betreff", d.subject, false)}
      ${field(i, "cta", "Button-Text", d.cta, false)}
      ${field(i, "intro", "Einleitung (vor dem Button)", d.intro, true)}
      ${field(i, "outro", "Schluss (nach dem Button)", d.outro, true)}
    </details>`).join("");

  const body = `${topnav(req.account, "/settings")}
    <div style="max-width:580px;padding:28px 0 60px">
    <h1>Einstellungen</h1>
    <p class="muted">Abo, Absender-Identität und deine Mahn-Texte.</p>

    <h2 style="margin:24px 0 12px">Abo &amp; Zahlung</h2>
    ${billingCard}

    <form method="post" action="/settings" style="margin-top:8px">
      ${tokenField}
      <h2 style="margin-top:8px">Plan (manuell)</h2>
      <p class="muted" style="margin-bottom:14px">Wird normalerweise durch dein Abo gesetzt. Manuelle Auswahl wirkt sofort – v.a. zum Testen.</p>
      ${planCards}

      <h2 style="margin:32px 0 4px">Absender deiner Zahlungs-E-Mails</h2>
      <p class="muted" style="margin-bottom:14px">So erscheint der Absender deiner Mahn-E-Mails bei deinen Kunden.</p>
      <label class="radio ${s.nameMode === "stripe" ? "sel" : ""}">
        <input type="radio" name="nameMode" value="stripe" ${sel("stripe")} style="width:auto;margin-top:4px">
        <span><b>Markennamen aus Stripe verwenden</b><br>
        <span class="muted" style="font-size:14px">Aktuell aus Stripe: <b style="color:var(--text)">${esc(stripeName)}</b>. Wird automatisch aktuell gehalten.</span></span>
      </label>
      <label class="radio ${s.nameMode === "custom" ? "sel" : ""}">
        <input type="radio" name="nameMode" value="custom" ${sel("custom")} style="width:auto;margin-top:4px">
        <span><b>Eigenen Namen eintragen</b><br>
        <span class="muted" style="font-size:14px">Überschreibt den Stripe-Namen.</span></span>
      </label>
      <input name="customName" value="${esc(s.customName)}" placeholder="z. B. Mustermann GmbH" style="margin-bottom:6px">

      <label class="flabel">Antwort-Adresse (Reply-To)</label>
      <input name="replyTo" type="email" value="${esc(s.replyTo)}" placeholder="support@deinefirma.de">
      <p class="muted" style="font-size:13px;margin:6px 0 0">Leer lassen, um die in Stripe hinterlegte Support-Adresse zu nutzen.</p>

      <label class="flabel">Benachrichtigungs-E-Mail (an dich)</label>
      <input name="notifyEmail" type="email" value="${esc(s.notifyEmail)}" placeholder="${esc(m.supportEmail || "du@deinefirma.de")}">
      <p class="muted" style="font-size:13px;margin:6px 0 0">Du bekommst eine kurze E-Mail bei jeder fehlgeschlagenen und jeder geretteten Zahlung. Leer lassen zum Abschalten. (Slack bleibt unabhängig davon aktiv, falls eingerichtet.)</p>

      <h2 style="margin:32px 0 4px">Eigene Mail-Texte</h2>
      <p class="muted" style="margin-bottom:14px">Passe die drei Mahnstufen an deine Tonalität an. Platzhalter: <code>{firma}</code>, <code>{betrag}</code>. Leere Felder nutzen automatisch den Standardtext.</p>
      ${customAllowed ? "" : `<div class="notice warn" style="margin-bottom:14px">Eigene Mail-Texte sind ab dem <b>Growth</b>-Plan verfügbar. Wähle oben Growth oder Scale, um sie zu bearbeiten.</div>`}
      ${tplBlocks}

      <button type="submit" class="btn" style="margin-top:20px">Speichern</button>
    </form>
    </div>`;
  res.send(page("PayRescue – Einstellungen", body));
});

app.post("/settings", requireAuth, express.urlencoded({ extended: true }), (req, res) => {
  const aid = req.account.id;
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
  saveSettings(aid, {
    plan: planKey,
    nameMode: req.body.nameMode === "custom" ? "custom" : "stripe",
    customName: (req.body.customName || "").trim(),
    replyTo: (req.body.replyTo || "").trim(),
    notifyEmail: (req.body.notifyEmail || "").trim(),
    templates,
  });
  res.redirect("/settings");
});

// --- Machine-readable metrics API for an external finance dashboard -------
app.get("/api/v1/metrics", (req, res) => {
  const token = process.env.PR_API_TOKEN;
  if (!token) return res.status(503).json({ error: "api_not_configured" });
  const auth = req.headers.authorization || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : (req.query.token || "");
  if (given !== token) return res.status(401).json({ error: "unauthorized" });

  const s = stats(ownerId);
  const records = listRecoveries(ownerId, 1000).map((r) => ({
    date: (r.recoveredAt || r.createdAt || "").slice(0, 10),
    type: "income",
    amount_cents: r.amountDue || 0,
    currency: (r.currency || "eur").toUpperCase(),
    source: "payrescue",
    category: "recovered_revenue",
    status: r.status,
    description: `Rettung – ${r.customerEmail || "unbekannt"}`,
    external_id: r.invoiceId,
  }));
  res.json({
    source: "payrescue",
    version: 1,
    generated_at: new Date().toISOString(),
    currency: "EUR",
    summary: {
      recovered_cents: s.recovered_cents,
      recovered_count: s.recovered_count,
      open_cents: s.open_cents,
      open_count: s.open_count,
    },
    records,
  });
});app.get("/health", (_, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`PayRescue läuft auf :${port}`));
