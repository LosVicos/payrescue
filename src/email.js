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

export async function sendDunning({ to, attempt, amount, currency, recoverUrl, businessName, replyTo }) {
  const step = SEQUENCE[Math.min(attempt - 1, SEQUENCE.length - 1)];
  // Merchant name drives the whole tone. Fall back sensibly so we never send
  // an anonymous "Billing" mail if Stripe didn't return a name.
  const business = businessName || process.env.BUSINESS_NAME || process.env.FROM_NAME || "Kundenservice";
  const ctx = { amount, currency, recoverUrl, business };
  const subject = step.subject(ctx);
  const intro = step.intro(ctx);
  const outro = step.outro(ctx);
  // Plain-text fallback: the URL is shown inline (clients without HTML need it).
  const text = `${intro}\n\n${recoverUrl}\n\n${outro}`;
  const html = renderHtml({ intro, cta: step.cta, outro, recoverUrl });

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

export { money };
