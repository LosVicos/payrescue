// Dependency-free JSON store. Zero native builds, nothing to maintain (wartungsarm).
// Now MULTI-TENANT: data lives under accounts[accountId]. Each account has its
// own settings, recoveries and event log. Swap this layer for Postgres later —
// the exported function signatures (all take accountId first) stay the same.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR -> auf Railway ein persistentes Volume (z.B. /data), damit die
// Daten einen Redeploy/Restart ueberleben. Fallback: App-Root (ephemer).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, "payrescue.json");

// The owner account is bound to the global Stripe key/webhook (single-tenant
// era). Magic-link login for this email gets the migrated historic data.
const OWNER_ID = "owner";
const OWNER_EMAIL = (process.env.OWNER_EMAIL || "victoriagallerach@gmail.com").toLowerCase();

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

function blankAccount(id, email) {
  return {
    id, email: (email || "").toLowerCase(),
    createdAt: new Date().toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    recoveries: {},
    events: [],
    stripe: { connected: false, connectedAccountId: null },
  };
}

// Read + migrate. Old single-tenant files had top-level recoveries/events/
// settings; we fold those into the owner account exactly once.
function load() {
  let db;
  try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { db = {}; }

  db.accounts = db.accounts || {};
  db.sessions = db.sessions || {};
  db.loginTokens = db.loginTokens || {};

  const isLegacy = db.recoveries || db.events || db.settings;
  if (isLegacy && !db.accounts[OWNER_ID]) {
    const owner = blankAccount(OWNER_ID, OWNER_EMAIL);
    owner.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
    owner.recoveries = db.recoveries || {};
    owner.events = db.events || [];
    owner.stripe.connected = true; // bound to the existing global Stripe key
    db.accounts[OWNER_ID] = owner;
    delete db.recoveries; delete db.events; delete db.settings;
  }
  // Ensure the owner account always exists (fresh installs too).
  if (!db.accounts[OWNER_ID]) {
    const owner = blankAccount(OWNER_ID, OWNER_EMAIL);
    owner.stripe.connected = true;
    db.accounts[OWNER_ID] = owner;
  }
  return db;
}
function save(db) { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); }

function acct(db, accountId) {
  return db.accounts[accountId] || db.accounts[OWNER_ID];
}

// --- Accounts -------------------------------------------------------------
export const ownerId = OWNER_ID;

export function getOwnerAccount() {
  const db = load();
  return db.accounts[OWNER_ID];
}

export function getAccount(accountId) {
  const db = load();
  return db.accounts[accountId] || null;
}

export function getAccountByEmail(email) {
  const db = load();
  const e = (email || "").toLowerCase();
  return Object.values(db.accounts).find((a) => a.email === e) || null;
}

// Find an account by email or create a fresh one. Returns the account.
export function getOrCreateAccount(email) {
  const db = load();
  const e = (email || "").toLowerCase();
  let a = Object.values(db.accounts).find((x) => x.email === e);
  if (!a) {
    const id = e === OWNER_EMAIL ? OWNER_ID : crypto.randomBytes(8).toString("hex");
    a = blankAccount(id, e);
    if (id === OWNER_ID) a.stripe.connected = true;
    db.accounts[id] = a;
    save(db);
  }
  return a;
}

export function setStripeConnected(accountId, connectedAccountId) {
  const db = load();
  const a = db.accounts[accountId];
  if (a) {
    a.stripe = { connected: true, connectedAccountId: connectedAccountId || null };
    save(db);
  }
}

// --- Magic-link login tokens (short-lived, single-use) --------------------
export function createLoginToken(email, ttlMinutes = 20) {
  const db = load();
  const token = crypto.randomBytes(24).toString("hex");
  db.loginTokens[token] = {
    email: (email || "").toLowerCase(),
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMinutes * 60_000,
  };
  // Opportunistic cleanup of expired tokens.
  for (const [t, v] of Object.entries(db.loginTokens)) {
    if (v.expiresAt < Date.now()) delete db.loginTokens[t];
  }
  save(db);
  return token;
}

// Validate + consume a login token. Returns the email or null.
export function consumeLoginToken(token) {
  const db = load();
  const rec = db.loginTokens[token];
  if (!rec) return null;
  delete db.loginTokens[token];
  save(db);
  if (rec.expiresAt < Date.now()) return null;
  return rec.email;
}

// --- Sessions (server-side, referenced by an httpOnly cookie) -------------
export function createSession(accountId, ttlDays = 30) {
  const db = load();
  const token = crypto.randomBytes(24).toString("hex");
  db.sessions[token] = {
    accountId,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlDays * 86_400_000,
  };
  save(db);
  return token;
}

export function getSessionAccount(token) {
  if (!token) return null;
  const db = load();
  const s = db.sessions[token];
  if (!s) return null;
  if (s.expiresAt < Date.now()) { delete db.sessions[token]; save(db); return null; }
  return db.accounts[s.accountId] || null;
}

export function destroySession(token) {
  if (!token) return;
  const db = load();
  if (db.sessions[token]) { delete db.sessions[token]; save(db); }
}

// --- Per-account settings -------------------------------------------------
export function getSettings(accountId) {
  const db = load();
  return { ...DEFAULT_SETTINGS, ...(acct(db, accountId).settings || {}) };
}

export function saveSettings(accountId, patch) {
  const db = load();
  const a = acct(db, accountId);
  a.settings = { ...DEFAULT_SETTINGS, ...(a.settings || {}), ...patch };
  save(db);
  return a.settings;
}

export function getPlan(accountId) {
  return PLANS[getSettings(accountId).plan] || PLANS.starter;
}

// --- Per-account recoveries + events -------------------------------------
export function upsertFailure(accountId, { invoiceId, customerId, email, amount, currency }) {
  const db = load();
  const a = acct(db, accountId);
  const ex = a.recoveries[invoiceId];
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
  a.recoveries[invoiceId] = rec;
  save(db);
  return { ...rec, isNew: true };
}

export function markRecovered(accountId, invoiceId) {
  const db = load();
  const a = acct(db, accountId);
  const rec = a.recoveries[invoiceId];
  if (rec && rec.status !== "recovered") {
    rec.status = "recovered";
    rec.recoveredAt = new Date().toISOString();
    save(db);
  }
}

export function logEvent(accountId, invoiceId, type, detail = "") {
  const db = load();
  const a = acct(db, accountId);
  a.events.push({ invoiceId, type, detail, createdAt: new Date().toISOString() });
  save(db);
}

export function stats(accountId) {
  const db = load();
  const recs = Object.values(acct(db, accountId).recoveries);
  const sum = (arr) => arr.reduce((n, r) => n + (r.amountDue || 0), 0);
  const open = recs.filter((r) => r.status === "open");
  const recovered = recs.filter((r) => r.status === "recovered");
  return {
    open_count: open.length, open_cents: sum(open),
    recovered_count: recovered.length, recovered_cents: sum(recovered),
  };
}

export function listRecoveries(accountId, limit = 50) {
  const db = load();
  return Object.values(acct(db, accountId).recoveries)
    .sort((a, b) => (b.recoveredAt || b.createdAt || "").localeCompare(a.recoveredAt || a.createdAt || ""))
    .slice(0, limit);
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

// A "rescue" = one at-risk invoice dunned this month (distinct invoiceId, so
// Stripe retries don't burn extra quota). Derived from the account event log.
export function usageThisMonth(accountId, month = currentMonth()) {
  const db = load();
  const ids = new Set();
  for (const e of acct(db, accountId).events || []) {
    if (e.type === "email_sent" && (e.createdAt || "").slice(0, 7) === month) {
      ids.add(e.invoiceId);
    }
  }
  return ids.size;
}

export function invoiceDunnedThisMonth(accountId, invoiceId, month = currentMonth()) {
  const db = load();
  return (acct(db, accountId).events || []).some(
    (e) => e.type === "email_sent" && e.invoiceId === invoiceId
      && (e.createdAt || "").slice(0, 7) === month
  );
}
