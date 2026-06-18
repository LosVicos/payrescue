// Dunning email sequence. Tone matters more than design — short, human, 1 CTA.
// The "attempt" number drives escalation (gentle -> urgent).
//
// Trust: the mail is sent in the NAME OF THE MERCHANT the customer already pays
// (businessName, pulled live from Stripe), with a real reply-to. The customer
// recognises the sender, so it reads like a normal payment notice — not spam.
//
// We send BOTH a clean HTML version (with a single button as the CTA, so the
// long Stripe portal URL never shows) and a plain-text fallback for clients
// that don't render HTML.
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function money(cents, currency = "eur") {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: currency.toUpperCase() })
    .format((cents || 0) / 100);
}

function esc(s = "") {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// One template per escalation step. Add more steps without code changes.
// Each step is split into `intro` (text before the button) and `outro` (after),
// plus a `cta` button label. `b.business` is the merchant name; it appears in
// subject, body and sign-off so the message clearly comes from the provider the
// customer signed up with.
const SEQUENCE = [
  {
    subject: (b) => `${b.business}: Deine Zahlung konnte nicht abgebucht werden`,
    cta: "Zahlungsdaten aktualisieren",
    intro: (b) => `Hallo,

bei ${b.business} konnten wir deine letzte Zahlung über ${money(b.amount, b.currency)} leider nicht einziehen. In den meisten Fällen liegt das einfach an einer abgelaufenen oder geänderten Karte – kein Grund zur Sorge.

Du kannst deine Zahlungsdaten in unter einer Minute sicher aktualisieren:`,
    outro: (b) => `Sobald das erledigt ist, läuft alles wie gewohnt weiter. Wenn du Fragen hast, antworte einfach auf diese E-Mail – wir helfen dir gern.

Viele Grüße
Dein Team von ${b.business}`,
  },
  {
    subject: (b) => `Erinnerung: Zahlung bei ${b.business} noch offen`,
    cta: "Jetzt Zahlungsdaten aktualisieren",
    intro: (b) => `Hallo,

wir konnten deine Zahlung über ${money(b.amount, b.currency)} bei ${b.business} weiterhin nicht abbuchen. Damit dein Zugang ohne Unterbrechung aktiv bleibt, aktualisiere bitte kurz deine Zahlungsdaten:`,
    outro: (b) => `Das dauert nur einen Moment. Falls die Karte zwischenzeitlich wieder funktioniert, kannst du diese Nachricht ignorieren.

Bei Fragen sind wir jederzeit für dich da – antworte einfach auf diese E-Mail.

Viele Grüße
Dein Team von ${b.business}`,
  },
  {
    subject: (b) => `Letzte Erinnerung: Dein Zugang bei ${b.business} wird bald pausiert`,
    cta: "Zugang jetzt sichern",
    intro: (b) => `Hallo,

trotz mehrerer Versuche konnten wir deine Zahlung über ${money(b.amount, b.currency)} bei ${b.business} nicht einziehen. Ohne eine Aktualisierung deiner Zahlungsdaten wird dein Zugang in den nächsten Tagen pausiert.

Du kannst das ganz einfach verhindern:`,
    outro: (b) => `Wenn etwas unklar ist oder du Unterstützung brauchst, antworte gern direkt auf diese E-Mail – wir finden gemeinsam eine Lösung.

Viele Grüße
Dein Team von ${b.business}`,
  },
];

export const STEP_COUNT = SEQUENCE.length;

// The built-in texts as editable strings, with {firma}/{betrag} placeholders.
// Used to pre-fill the /settings editor so merchants start from the real copy.
export function templateDefaults() {
  const zero = money(0, "eur");
  const ctx = { business: "{firma}", amount: 0, currency: "eur" };
  const ph = (s) => String(s).split(zero).join("{betrag}");
  return SEQUENCE.map((step) => ({
    subject: ph(step.subject(ctx)),
    cta: step.cta,
    intro: ph(step.intro(ctx)),
    outro: ph(step.outro(ctx)),
  }));
}

// Merchants on Growth+ may override any step's text on /settings. Placeholders
// {firma} and {betrag} are filled in here so they don't have to hardcode values.
function fill(s, ctx) {
  return String(s || "")
    .replace(/\{firma\}/g, ctx.business)
    .replace(/\{betrag\}/g, money(ctx.amount, ctx.currency))
    .replace(/\{business\}/g, ctx.business)
    .replace(/\{amount\}/g, money(ctx.amount, ctx.currency));
}

// Merge a built-in step with an optional per-step override. Empty override
// fields fall back to the default, so a merchant can tweak just the subject.
function resolveStep(step, override, ctx) {
  const o = override || {};
  const has = (v) => typeof v === "string" && v.trim() !== "";
  return {
    subject: has(o.subject) ? fill(o.subject, ctx) : step.subject(ctx),
    cta: has(o.cta) ? fill(o.cta, ctx) : step.cta,
    intro: has(o.intro) ? fill(o.intro, ctx) : step.intro(ctx),
    outro: has(o.outro) ? fill(o.outro, ctx) : step.outro(ctx),
  };
}

// Turn a multi-paragraph text block (separated by blank lines) into HTML <p>s.
function paras(text) {
  return text
    .split("\n\n")
    .map((p) => `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function renderHtml({ intro, cta, outro, recoverUrl }) {
  const button = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px">
      <tr><td style="border-radius:8px;background:#111">
        <a href="${esc(recoverUrl)}" style="display:inline-block;padding:13px 24px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;border-radius:8px">${esc(cta)}</a>
      </td></tr></table>`;
  const fallback = `<p style="margin:0 0 20px;font-size:12px;color:#999">Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br><a href="${esc(recoverUrl)}" style="color:#2563eb;word-break:break-all">${esc(recoverUrl)}</a></p>`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f5">
    <div style="max-width:520px;margin:0 auto;padding:32px 24px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111">
      ${paras(intro)}${button}${fallback}${paras(outro)}
    </div></body></html>`;
}

export async function sendDunning({ to, attempt, amount, currency, recoverUrl, businessName, replyTo, templates }) {
  const idx = Math.min(attempt - 1, SEQUENCE.length - 1);
  const step = SEQUENCE[idx];
  // Merchant name drives the whole tone. Fall back sensibly so we never send
  // an anonymous "Billing" mail if Stripe didn't return a name.
  const business = businessName || process.env.BUSINESS_NAME || process.env.FROM_NAME || "Kundenservice";
  const ctx = { amount, currency, recoverUrl, business };
  // Apply the merchant's custom override for this step, if any (Growth+).
  const override = Array.isArray(templates) ? templates[idx] : null;
  const { subject, cta, intro, outro } = resolveStep(step, override, ctx);
  // Plain-text fallback: the URL is shown inline (clients without HTML need it).
  const text = `${intro}\n\n${recoverUrl}\n\n${outro}`;
  const html = renderHtml({ intro, cta, outro, recoverUrl });

  if (!resend) {
    console.log(`[email:DRY-RUN] -> ${to} | ${subject}\n${text}\n`);
    return { dryRun: true, subject };
  }

  const payload = {
    from: `${business} <${process.env.FROM_EMAIL}>`,
    to,
    subject,
    html,
    text,
  };
  const rt = replyTo || process.env.REPLY_TO;
  if (rt) payload.replyTo = rt;

  await resend.emails.send(payload);
  return { dryRun: false, subject };
}

// --- Notification to the MERCHANT (not the end customer) ---
// A plain, internal heads-up so the merchant sees activity without needing Slack.
// Two kinds: "failed" (a payment dropped, dunning mail went out) and
// "recovered" (the money came back). Sent only if a notifyEmail is configured.
export async function notifyMerchant({ to, kind, amount, currency, customerEmail, attempt, plan, limit }) {
  if (!to) return { skipped: true };

  const amt = money(amount, currency);
  const cust = customerEmail || "unbekannt";
  let subject, line;
  if (kind === "recovered") {
    subject = `✅ Zahlung gerettet – ${amt}`;
    line = `Gute Nachricht: Die offene Zahlung über ${amt} von ${cust} wurde erfolgreich zurückgeholt.`;
  } else if (kind === "limit") {
    subject = `⚠️ Monatslimit erreicht (${plan})`;
    line = `Dein Plan ${plan} erlaubt ${limit} Rettungen pro Monat – dieses Limit ist erreicht. `
      + `Die neue fehlgeschlagene Zahlung über ${amt} von ${cust} wurde NICHT angemahnt. `
      + `Mit einem Upgrade unter /settings werden weitere Zahlungen wieder automatisch gerettet.`;
  } else {
    subject = `💸 Zahlung fehlgeschlagen – ${amt}`;
    line = `Eine Zahlung über ${amt} von ${cust} ist fehlgeschlagen. PayRescue hat automatisch eine Zahlungserinnerung (Mahnstufe ${attempt || 1}) verschickt.`;
  }

  const text = `${line}\n\nDiese Nachricht kommt automatisch von PayRescue. Du kannst die Benachrichtigungen unter /settings anpassen.`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f5">
    <div style="max-width:520px;margin:0 auto;padding:32px 24px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111">
      <p style="margin:0 0 16px">${esc(line)}</p>
      <p style="margin:0;font-size:12px;color:#999">Automatische Nachricht von PayRescue. Benachrichtigungen änderst du unter <b>/settings</b>.</p>
    </div></body></html>`;

  if (!resend) {
    console.log(`[notify:DRY-RUN] -> ${to} | ${subject}\n${text}\n`);
    return { dryRun: true, subject };
  }

  await resend.emails.send({
    from: `PayRescue <${process.env.FROM_EMAIL}>`,
    to,
    subject,
    html,
    text,
  });
  return { dryRun: false, subject };
}

// --- Magic-link login email ----------------------------------------------
// Sends a one-click sign-in link to the merchant. No password involved.
export async function sendLoginLink({ to, url }) {
  const subject = "Dein Login-Link für PayRescue";
  const text = `Hallo,

klicke auf den folgenden Link, um dich bei PayRescue anzumelden:

${url}

Der Link ist 20 Minuten gültig und kann nur einmal verwendet werden. Wenn du diese Anmeldung nicht angefordert hast, ignoriere diese E-Mail einfach.

Viele Grüße
PayRescue`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f5">
    <div style="max-width:520px;margin:0 auto;padding:32px 24px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111">
      <p style="margin:0 0 16px">Hallo,</p>
      <p style="margin:0 0 20px">klicke auf den Button, um dich bei <b>PayRescue</b> anzumelden:</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px">
        <tr><td style="border-radius:8px;background:#111">
          <a href="${esc(url)}" style="display:inline-block;padding:13px 24px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;border-radius:8px">Jetzt anmelden</a>
        </td></tr></table>
      <p style="margin:0 0 20px;font-size:12px;color:#999">Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br><a href="${esc(url)}" style="color:#2563eb;word-break:break-all">${esc(url)}</a></p>
      <p style="margin:0;font-size:12px;color:#999">Der Link ist 20 Minuten gültig und einmalig verwendbar. Nicht angefordert? Dann ignoriere diese E-Mail.</p>
    </div></body></html>`;

  if (!resend) {
    console.log(`[login:DRY-RUN] -> ${to} | ${url}`);
    return { dryRun: true };
  }
  await resend.emails.send({
    from: `PayRescue <${process.env.FROM_EMAIL}>`,
    to, subject, html, text,
  });
  return { dryRun: false };
}

export { money };
