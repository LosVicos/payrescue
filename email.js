// Dunning email sequence. Tone matters more than design — short, human, 1 CTA.
// The "attempt" number drives escalation (gentle -> urgent).
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function money(cents, currency = "eur") {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: currency.toUpperCase() })
    .format((cents || 0) / 100);
}

// One template per escalation step. Add more steps without code changes.
const SEQUENCE = [
  {
    subject: (b) => `Kurzer Hinweis: deine letzte Zahlung ist fehlgeschlagen`,
    body: (b) => `Hi,

deine Zahlung über ${money(b.amount, b.currency)} ist leider nicht durchgegangen –
meistens liegt es nur an einer abgelaufenen Karte.

Du kannst sie hier in 30 Sekunden aktualisieren:
${b.recoverUrl}

Danke!
${b.fromName}`,
  },
  {
    subject: (b) => `Erinnerung: Zahlung noch offen (${money(b.amount, b.currency)})`,
    body: (b) => `Hi,

wir konnten deine Zahlung weiterhin nicht einziehen. Damit dein Zugang
aktiv bleibt, aktualisiere bitte kurz deine Zahlungsdaten:

${b.recoverUrl}

Bei Fragen einfach auf diese Mail antworten.
${b.fromName}`,
  },
  {
    subject: (b) => `Letzte Erinnerung: dein Zugang wird bald pausiert`,
    body: (b) => `Hi,

das ist die letzte Erinnerung – ohne Aktualisierung deiner Zahlung
wird dein Zugang in Kürze pausiert. Hier kannst du das verhindern:

${b.recoverUrl}

${b.fromName}`,
  },
];

export async function sendDunning({ to, attempt, amount, currency, recoverUrl }) {
  const step = SEQUENCE[Math.min(attempt - 1, SEQUENCE.length - 1)];
  const fromName = process.env.FROM_NAME || "Billing";
  const ctx = { amount, currency, recoverUrl, fromName };
  const subject = step.subject(ctx);
  const text = step.body(ctx);

  if (!resend) {
    console.log(`[email:DRY-RUN] -> ${to} | ${subject}\n${text}\n`);
    return { dryRun: true, subject };
  }
  await resend.emails.send({
    from: `${fromName} <${process.env.FROM_EMAIL}>`,
    to,
    subject,
    text,
  });
  return { dryRun: false, subject };
}

export { money };
