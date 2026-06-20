// Apollo Lucky Spin — server
// Stores all config in Postgres (Neon) when DATABASE_URL is set, else a local data.json.
// Spin outcome is decided here so odds can't be tampered with from the browser.

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- defaults ---------------- */
function defaultState() {
  return {
    user: process.env.ADMIN_USER || "admin",
    salt: "",
    passHash: "",
    secret: crypto.randomBytes(32).toString("hex"),
    nearMiss: true,
    nearChance: 35,
    sound: true,
    spinDuration: 5,
    segments: [
      { id: "s1", label: "Better Luck", emoji: "😅", weight: 35,   color: "#5b5891", jackpot: false },
      { id: "s2", label: "₹1000",       emoji: "🏆", weight: 0.2,  color: "#f5c451", jackpot: true  },
      { id: "s3", label: "Chocolate",   emoji: "🍫", weight: 50,   color: "#8a5a3b", jackpot: false },
      { id: "s4", label: "Rose",        emoji: "🌹", weight: 30,   color: "#e23a5e", jackpot: false },
      { id: "s5", label: "₹100",        emoji: "💰", weight: 13.3, color: "#3ddc97", jackpot: false },
      { id: "s6", label: "Mystery Box", emoji: "🎁", weight: 20,   color: "#5d8bff", jackpot: false },
      { id: "s7", label: "₹500",        emoji: "💵", weight: 2.5,  color: "#b06bff", jackpot: false },
      { id: "s8", label: "Try Again",   emoji: "🔄", weight: 25,   color: "#3aa0c2", jackpot: false }
    ],
    queue: [],
    stats: {}
  };
}

/* ---------------- storage (Postgres or file) ---------------- */
const usePg = !!process.env.DATABASE_URL;
let pool = null;
const FILE = path.join(__dirname, "data.json");

async function initStore() {
  if (usePg) {
    const { default: pg } = await import("pg");
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    await pool.query("create table if not exists kv (key text primary key, value jsonb not null)");
  }
}
async function readState() {
  if (usePg) {
    const r = await pool.query("select value from kv where key=$1", ["state"]);
    return r.rows[0]?.value || null;
  }
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return null; }
}
async function writeState(s) {
  if (usePg) {
    await pool.query(
      "insert into kv(key,value) values($1,$2) on conflict (key) do update set value=$2",
      ["state", s]
    );
  } else {
    fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
  }
}

/* ---------------- auth helpers ---------------- */
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString("hex"); }
function setPassword(s, pw) {
  s.salt = crypto.randomBytes(16).toString("hex");
  s.passHash = hashPw(pw, s.salt);
}
function checkPw(s, pw) {
  if (!s.passHash) return false;
  const h = hashPw(pw, s.salt);
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(s.passHash));
}
function signToken(s, username) {
  const body = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + 8 * 3600 * 1000 })).toString("base64url");
  const mac = crypto.createHmac("sha256", s.secret).update(body).digest("base64url");
  return body + "." + mac;
}
function verifyToken(s, tok) {
  try {
    const [body, mac] = String(tok).split(".");
    const exp = crypto.createHmac("sha256", s.secret).update(body).digest("base64url");
    if (mac !== exp) return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

/* ---------------- in-memory state ---------------- */
let state = null;
async function loadOrSeed() {
  state = await readState();
  if (!state) {
    state = defaultState();
    setPassword(state, process.env.ADMIN_PASS || "apollo");
    await writeState(state);
    console.log("Seeded default state.");
  } else {
    // make sure newer fields exist for older saved data
    const d = defaultState();
    for (const k of ["nearMiss", "nearChance", "sound", "spinDuration", "queue", "stats"]) {
      if (state[k] === undefined) state[k] = d[k];
    }
    if (!state.secret) state.secret = d.secret;
    if (!state.passHash) setPassword(state, process.env.ADMIN_PASS || "apollo");
  }
}
function requireAuth(req, res, next) {
  const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!verifyToken(state, tok)) return res.status(401).json({ error: "unauthorized" });
  next();
}

/* ---------------- spin engine ---------------- */
function totalWeight() { return state.segments.reduce((a, s) => a + Math.max(0, +s.weight || 0), 0); }
function weightedPick() {
  const t = totalWeight(); if (t <= 0) return 0;
  let r = Math.random() * t;
  for (let i = 0; i < state.segments.length; i++) { r -= Math.max(0, +state.segments[i].weight || 0); if (r <= 0) return i; }
  return state.segments.length - 1;
}
function jackpotIndex() { return state.segments.findIndex(s => s.jackpot); }
function neighbors(i) { const n = state.segments.length; return [(i - 1 + n) % n, (i + 1) % n]; }

/* ---------------- public API ---------------- */
// what the wheel needs to draw itself (no weights, no secrets)
app.get("/api/config", (req, res) => {
  const ji = jackpotIndex();
  res.json({
    segments: state.segments.map(s => ({ label: s.label, emoji: s.emoji, color: s.color })),
    spinDuration: state.spinDuration,
    sound: state.sound,
    totalSpins: state.stats.__total || 0,
    grandLabel: ji >= 0 ? state.segments[ji].label : "—"
  });
});

// the actual draw — decided here
app.post("/api/spin", async (req, res) => {
  if (!state.segments.length) return res.status(400).json({ error: "no segments" });
  let idx = null, near = false;

  while (state.queue.length && idx === null) {
    const q = state.queue.shift();
    if (q >= 0 && q < state.segments.length) idx = q;
  }
  if (idx === null) {
    idx = weightedPick();
    const ji = jackpotIndex();
    if (state.nearMiss && ji >= 0 && idx !== ji && Math.random() * 100 < state.nearChance) {
      const nb = neighbors(ji); idx = nb[Math.random() < 0.5 ? 0 : 1]; near = true;
    }
  }

  const s = state.segments[idx];
  const noPrize = /try again|better luck/i.test(s.label);
  let kind = "prize";
  if (s.jackpot) kind = "jackpot";
  else if (noPrize) kind = "none";
  else if (near) kind = "near";

  state.stats[s.label] = (state.stats[s.label] || 0) + 1;
  state.stats.__total = (state.stats.__total || 0) + 1;
  await writeState(state);

  res.json({ index: idx, kind, label: s.label, emoji: s.emoji });
});

/* ---------------- admin API ---------------- */
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === state.user && checkPw(state, password)) {
    return res.json({ token: signToken(state, username) });
  }
  res.status(401).json({ error: "bad credentials" });
});

app.get("/api/admin/state", requireAuth, (req, res) => {
  res.json({
    user: state.user,
    nearMiss: state.nearMiss,
    nearChance: state.nearChance,
    sound: state.sound,
    spinDuration: state.spinDuration,
    segments: state.segments,
    queue: state.queue,
    stats: state.stats
  });
});

app.put("/api/admin/state", requireAuth, async (req, res) => {
  const b = req.body || {};
  if (Array.isArray(b.segments)) {
    state.segments = b.segments.slice(0, 40).map((s, i) => ({
      id: String(s.id || "s" + i),
      label: String(s.label ?? "").slice(0, 40),
      emoji: String(s.emoji ?? "").slice(0, 8),
      weight: Math.max(0, Number(s.weight) || 0),
      color: /^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : "#888888",
      jackpot: !!s.jackpot
    }));
    // only one jackpot
    let seen = false;
    state.segments.forEach(s => { if (s.jackpot && !seen) seen = true; else s.jackpot = false; });
  }
  if (typeof b.nearMiss === "boolean") state.nearMiss = b.nearMiss;
  if (b.nearChance != null) state.nearChance = Math.min(80, Math.max(0, Number(b.nearChance) || 0));
  if (typeof b.sound === "boolean") state.sound = b.sound;
  if (b.spinDuration != null) state.spinDuration = Math.min(30, Math.max(2, Number(b.spinDuration) || 5));
  if (typeof b.user === "string" && b.user.trim()) state.user = b.user.trim().slice(0, 40);
  if (typeof b.newPassword === "string" && b.newPassword) setPassword(state, b.newPassword);
  await writeState(state);
  res.json({ ok: true });
});

// queue is saved instantly so other devices (the booth) pick it up
app.post("/api/admin/queue", requireAuth, async (req, res) => {
  const q = Array.isArray(req.body?.queue) ? req.body.queue : [];
  state.queue = q.filter(n => Number.isInteger(n) && n >= 0 && n < state.segments.length).slice(0, 200);
  await writeState(state);
  res.json({ ok: true, queue: state.queue });
});

app.post("/api/admin/reset-stats", requireAuth, async (req, res) => {
  state.stats = {}; await writeState(state); res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("ok"));

/* ---------------- boot ---------------- */
const PORT = process.env.PORT || 3000;
(async () => {
  await initStore();
  await loadOrSeed();
  app.listen(PORT, () => console.log(`Apollo Lucky Spin running on :${PORT} (storage: ${usePg ? "postgres" : "file"})`));
})();
