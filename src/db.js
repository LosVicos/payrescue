// Dependency-free JSON store. Zero native builds, nothing to maintain (wartungsarm).
// Fine for a single-tenant MVP / first paying customer. Swap the 4 exported
// functions for Supabase/Postgres later — the rest of the app never changes.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR -> auf Railway ein persistentes Volume (z.B. /data), damit die
// Daten einen Redeploy/Restart ueberleben. Fallback: App-Root (ephemer).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, "payrescue.json");

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { return { recoveries: {}, events: [], settings: {} }; }
}
function save(db) { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); }

// Merchant-configurable sender settings. The customer (the merchant who uses
// PayRescue) chooses whether the dunning mail goes out under their Stripe brand
// name or a custom name they type in. Persisted on the volume like everything else.
// `plan` gates the monthly rescue volume (see PLANS). `templates` lets Growth+
// merchants override the built-in dunning texts (empty = use defaults).
const DEFAULT_SETTINGS = {
  nameMode: "stripe", customName: "", replyTo: "", notifyEmail: "",
  plan: "starter", templates: [],
};

// The three published plans. `limit` = max rescues (= at-risk invoices entered
// into dunning) per calendar month. Scale is effectively unlimited.
export const PLANS = {
  starter: { key: "starter", name: "Starter", price: 29, limit: 50 },
  growth: { key: "growth", name: "Growth", price: 49, limit: 250 },
  scale: { key: "scale", name: "Scale", price: 99, limit: Infinity },
};

export function getSettings() {
  const db = load();
  return { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
}

export function getPlan() {
  return PLANS[getSettings().plan] || PLANS.starter;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

// A "rescue" is one at-risk invoice we sent at least one dunning mail for this
// month. Counting distinct invoiceIds means retries on the same invoice don't
// burn extra quota. Derived from the event log — no extra storage needed.
export function usageThisMonth(month = currentMonth()) {
  const db = load();
  const ids = new Set();
  for (const e of db.events || []) {
    if (e.type === "email_sent" && (e.createdAt || "").slice(0, 7) === month) {
      ids.add(e.invoiceId);
    }
  }
  return ids.size;
}

// True if this invoice already counts toward this month's quota (so a Stripe
// retry on it must still be allowed through even when we're at the limit).
export function invoiceDunnedThisMonth(invoiceId, month = currentMonth()) {
  const db = load();
  return (db.events || []).some(
    (e) => e.type === "email_sent" && e.invoiceId === invoiceId
      && (e.createdAt || "").slice(0, 7) === month
  );
}

export function saveSettings(patch) {
  const db = load();
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}), ...patch };
  save(db);
  return db.settings;
}

export function upsertFailure({ invoiceId, customerId, email, amount, currency }) {
  const db = load();
  const ex = db.recoveries[invoiceId];
  if (ex) {
    ex.attempts += 1;
    save(db);
    return { ...ex, isNew: false };
  }
  const rec = {
    invoiceId, customerId, customerEmail: email,
    amountDue: amount, currency, attempts: 1,
    status: "open", createdAt: new Date().toISOString(), recoveredAt: null,
  };
  db.recoveries[invoiceId] = rec;
  save(db);
  return { ...rec, isNew: true };
}

export function markRecovered(invoiceId) {
  const db = load();
  const rec = db.recoveries[invoiceId];
  if (rec && rec.status !== "recovered") {
    rec.status = "recovered";
    rec.recoveredAt = new Date().toISOString();
    save(db);
  }
}

export function logEvent(invoiceId, type, detail = "") {
  const db = load();
  db.events.push({ invoiceId, type, detail, createdAt: new Date().toISOString() });
  save(db);
}

export function stats() {
  const db = load();
  const recs = Object.values(db.recoveries);
  const sum = (arr) => arr.reduce((n, r) => n + (r.amountDue || 0), 0);
  const open = recs.filter((r) => r.status === "open");
  const recovered = recs.filter((r) => r.status === "recovered");
  return {
    open_count: open.length, open_cents: sum(open),
    recovered_count: recovered.length, recovered_cents: sum(recovered),
  };
}

// Recent recoveries for the dashboard detail list, newest activity first.
export function listRecoveries(limit = 50) {
  const db = load();
  return Object.values(db.recoveries)
    .sort((a, b) => (b.recoveredAt || b.createdAt || "").localeCompare(a.recoveredAt || a.createdAt || ""))
    .slice(0, limit);
}
