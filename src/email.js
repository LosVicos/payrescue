// Dunning email sequence. Tone matters more than design — short, human, 1 CTA.
// The "attempt" number drives escalation (gentle -> urgent).
//
// Trust: the mail is sent in the NAME OF THE MERCHANT the customer already pays
// (businessName, pulled live from Stripe), with a real reply-to. The customer
// recognises the sender, so it reads like a normal payment notice — not spam.
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function money(cents, currency = "eur") {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: currency.toUpperCase() })
    .format((cents || 0) / 100);
}

// One template per escalation step. Add more steps without code changes.
// `b.business` is the merchant name; it appears in subject, body and sign-off
// so the message clearly comes from the provider the customer signed up with.
const SEQUENCE = [
  {
    subject: (b) => `${b.business}: Deine Zahlung konnte nicht abgebucht werden`,
    body: (b) => `Hallo,

bei ${b.business} konnten wir deine letzte Zahlung über ${money(b.amount, b.currency)} leider nicht einziehen. In den meisten Fällen liegt das einfach an einer abgelaufenen oder geänderten Karte – kein Grund zur Sorge.

Du kannst deine Zahlungsdaten in unter einer Minute sicher aktualisieren:
${b.recoverUrl}

Sobald das erledigt ist, läuft alles wie gewohnt weiter. Wenn du Fragen hast, antworte einfach auf diese E-Mail – wir helfen dir gern.

Viele Grüße
Dein Team von ${b.business}`,
  },
  {
    subject: (b) => `Erinnerung: Zahlung bei ${b.business} noch offen`,
    body: (b) => `Hallo,

wir konnten deine Zahlung über ${money(b.amount, b.currency)} bei ${b.business} weiterhin nicht abbuchen. Damit dein Zugang ohne Unterbrechung aktiv bleibt, aktualisiere bitte kurz deine Zahlungsdaten:

${b.recoverUrl}

Das dauert nur einen Moment. Falls die Karte zwischenzeitlich wieder funktioniert, kannst du diese Nachricht ignorieren.

Bei Fragen sind wir jederzeit für dich da – antworte einfach auf diese E-Mail.

Viele Grüße
Dein Team von ${b.business}`,
  },
  {
    subject: (b) => `Letzte Erinnerung: Dein Zugang bei ${b.business} wird bald pausiert`,
    body: (b) => `Hallo,

trotz mehrerer Versuche konnten wir deine Zahlung über ${money(b.amount, b.currency)} bei ${b.business} nicht einziehen. Ohne eine Aktualisierung deiner Zahlungsdaten wird dein Zugang in den nächsten Tagen pausiert.

Du kannst das ganz einfach verhindern:
${b.recoverUrl}

Wenn etwas unklar ist oder du Unterstützung brauchst, antworte gern direkt auf diese E-Mail – wir finden gemeinsam eine Lösung.

Viele Grüße
Dein Team von ${b.business}`,
  },
];

export async function sendDunning({ to, attempt, amount, currency, recoverUrl, businessName, replyTo }) {
  const step = SEQUENCE[Math.min(attempt - 1, SEQUENCE.length - 1)];
  // Merchant name drives the whole tone. Fall back sensibly so we never send
  // an anonymous "Billing" mail if Stripe didn't return a name.
  const business = businessName || process.env.BUSINESS_NAME || process.env.FROM_NAME || "Kundenservice";
  const ctx = { amount, currency, recoverUrl, business };
  const subject = step.subject(ctx);
  const text = step.body(ctx);

  if (!resend) {
    console.log(`[email:DRY-RUN] -> ${to} | ${subject}\n${text}\n`);
    return { dryRun: true, subject };
  }

  const payload = {
    from: `${business} <${process.env.FROM_EMAIL}>`,
    to,
    subject,
    text,
  };
  const rt = replyTo || process.env.REPLY_TO;
  if (rt) payload.replyTo = rt;

  await resend.emails.send(payload);
  return { dryRun: false, subject };
}

export { money };
