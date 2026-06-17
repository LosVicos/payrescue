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
  catch { return { recoveries: {}, events: [] }; }
}
function save(db) { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); }

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
