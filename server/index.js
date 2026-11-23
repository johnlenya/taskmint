/* TaskMint server — zero dependencies.
   Holds the authoritative points ledger; the client never writes balances itself.

   Run:  node server/index.js            (dev, auto-settles offers)
         SIMULATE_PARTNER=0 node ...     (production: only signed postbacks credit)

   Env:
     PORT=8080
     PORTAL_SECRET=...        signs session tokens
     OFFERWALL_SECRET=...     signs partner postbacks
     SIMULATE_PARTNER=1       dev only: settle offers 5s after start
     POINTS_PER_USD=1000
     MIN_WITHDRAW_USD=5
*/

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const PORT = Number(process.env.PORT || 8080);
const DATABASE_URL = process.env.DATABASE_URL || "";
const SECRET = process.env.PORTAL_SECRET || "dev-only-portal-secret";
const PARTNER_SECRET = process.env.OFFERWALL_SECRET || "dev-only-offerwall-secret";
const SIMULATE = process.env.SIMULATE_PARTNER !== "0";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const POINTS_PER_USD = Number(process.env.POINTS_PER_USD || 1000);
const MIN_WITHDRAW_POINTS = Number(process.env.MIN_WITHDRAW_USD || 5) * POINTS_PER_USD;
const CHECKIN_POINTS = 25;
const STREAK_BONUS = 250;
const REFERRAL_BONUS = 500;
const SIMULATE_MS = 5000;

const OFFERS = {
  "survey-spending": { title: "Consumer spending survey", points: 750 },
  "video-sponsor": { title: "Watch a 30-second sponsor clip", points: 40 },
  "install-puzzle": { title: "Install & open Puzzle Quest", points: 1400 },
  "survey-streaming": { title: "Streaming services survey", points: 900 },
  "signup-budget": { title: "Free budget app signup", points: 600 },
  "survey-gaming": { title: "Gaming habits survey", points: 520 },
};

/* ---------------- storage ---------------- */

let db = { users: {}, creditedTx: [] };
let pool = null;

function dbRead() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return { users: {}, creditedTx: [] };
  }
}

async function initStorage() {
  if (!DATABASE_URL) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = dbRead();
    return;
  }
  const { default: pg } = await import("pg");
  pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: true, max: 2 });
  await pool.query(
    "CREATE TABLE IF NOT EXISTS taskmint_state (id integer PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())"
  );
  const found = await pool.query("SELECT data FROM taskmint_state WHERE id = 1");
  if (found.rowCount) {
    db = found.rows[0].data;
  } else {
    await pool.query(
      "INSERT INTO taskmint_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING",
      [JSON.stringify(db)]
    );
  }
}

let writeTimer = null;
let writing = false;
let dirty = false;

function dbFlush() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (pool) void persistPg();
    else {
      const tmp = DB_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_FILE);
    }
  }, 150);
}

async function persistPg() {
  if (writing) {
    dirty = true;
    return;
  }
  writing = true;
  try {
    do {
      dirty = false;
      await pool.query(
        "UPDATE taskmint_state SET data = $1::jsonb, updated_at = now() WHERE id = 1",
        [JSON.stringify(db)]
      );
    } while (dirty);
  } catch (err) {
    console.error("ledger persist failed:", err.message);
  } finally {
    writing = false;
  }
}

async function shutdown() {
  clearTimeout(writeTimer);
  writeTimer = null;
  try {
    if (pool) {
      await persistPg();
      await pool.end();
    } else {
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    }
  } catch (err) {
    console.error("shutdown flush failed:", err.message);
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

/* ---------------- helpers ---------------- */

const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (payload, secret) => crypto.createHmac("sha256", secret).update(payload).digest("base64url");
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const id = () => crypto.randomUUID();

function issueToken(handle) {
  const payload = b64(JSON.stringify({ h: handle, t: Date.now() }));
  return payload + "." + sign(payload, SECRET);
}

function readToken(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (sign(payload, SECRET) !== sig) return null;
  try {
    const { h } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return db.users[h] ? h : null;
  } catch {
    return null;
  }
}

function credit(user, points, reason) {
  user.balance += points;
  user.ledger.unshift({ id: id(), ts: Date.now(), type: "credit", points, reason, status: "settled" });
  dbFlush();
}

function debit(user, points, reason) {
  user.balance -= points;
  user.ledger.unshift({ id: id(), ts: Date.now(), type: "debit", points, reason, status: "settled" });
  dbFlush();
}

function publicState(user) {
  return {
    handle: user.handle,
    balance: user.balance,
    streak: user.streak,
    tasks: user.tasks,
    ledger: user.ledger.slice(0, 60),
    withdrawals: user.withdrawals,
    referrals: user.referrals,
    pointsPerUsd: POINTS_PER_USD,
    minWithdrawPoints: MIN_WITHDRAW_POINTS,
    simulate: SIMULATE,
  };
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(SITE_DIR, rel);
  const publicFile =
    /^[a-z0-9_-]+\.html$/.test(rel) ||
    /^assets\/[a-z0-9_.-]+\.(css|js|png|svg|ico|webp)$/i.test(rel);
  if (!file.startsWith(SITE_DIR + path.sep) || !publicFile) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  });
}

function settleOffer(handle, offerId, source) {
  const user = db.users[handle];
  const offer = OFFERS[offerId];
  if (!user || !offer) return false;
  const task = user.tasks[offerId];
  if (!task || task.status !== "pending") return false;
  task.status = "completed";
  task.completedAt = Date.now();
  credit(user, offer.points, "Offer completed · " + offer.title + (source === "postback" ? "" : " (dev simulation)"));
  const completed = Object.values(user.tasks).filter((t) => t.status === "completed").length;
  if (completed === 1) {
    for (const ref of user.referrals) {
      if (ref.status === "pending") {
        ref.status = "paid";
        ref.paidAt = Date.now();
        credit(user, REFERRAL_BONUS, "Referral bonus · @" + ref.handle + " completed first offer");
      }
    }
  }
  dbFlush();
  return true;
}

/* ---------------- routes ---------------- */

async function api(req, res, url) {
  const route = url.pathname;

  if (req.method === "GET" && route === "/api/health") {
    return json(res, 200, {
      ok: true,
      mode: SIMULATE ? "sandbox" : "live",
      simulated: SIMULATE,
      offers: Object.keys(OFFERS).length,
    });
  }

  if (req.method === "POST" && route === "/api/signup") {
    const body = await readBody(req);
    const handle = String(body.handle || "").trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(handle)) return json(res, 400, { error: "invalid_handle" });
    if (db.users[handle]) return json(res, 409, { error: "handle_taken" });
    db.users[handle] = {
      handle,
      createdAt: Date.now(),
      balance: 0,
      streak: { count: 0, last: null },
      tasks: {},
      ledger: [],
      withdrawals: [],
      referrals: [],
    };
    dbFlush();
    return json(res, 200, { token: issueToken(handle), state: publicState(db.users[handle]) });
  }

  const handle = readToken(req);
  const OPEN_ROUTES = ["/api/postback", "/api/public/payouts", "/api/admin/payouts/paid"];
  if (route.startsWith("/api/") && !handle && !OPEN_ROUTES.includes(route)) {
    return json(res, 401, { error: "unauthorized" });
  }
  const user = handle ? db.users[handle] : null;

  if (req.method === "GET" && route === "/api/state") {
    return json(res, 200, { state: publicState(user) });
  }

  if (req.method === "POST" && route === "/api/checkin") {
    const day = today();
    if (user.streak.last === day) return json(res, 409, { error: "already_checked_in" });
    user.streak.count = user.streak.last === yesterday() ? user.streak.count + 1 : 1;
    user.streak.last = day;
    credit(user, CHECKIN_POINTS, "Daily check-in · day " + user.streak.count);
    if (user.streak.count % 7 === 0) credit(user, STREAK_BONUS, "7-day streak bonus");
    return json(res, 200, { state: publicState(user) });
  }

  if (req.method === "POST" && route === "/api/offers/start") {
    const body = await readBody(req);
    const offerId = String(body.offerId || "");
    if (!OFFERS[offerId]) return json(res, 404, { error: "unknown_offer" });
    const existing = user.tasks[offerId];
    if (existing && existing.status !== "available") return json(res, 409, { error: "already_started" });
    user.tasks[offerId] = { status: "pending", startedAt: Date.now(), readyAt: Date.now() + SIMULATE_MS };
    dbFlush();
    if (SIMULATE) setTimeout(() => settleOffer(user.handle, offerId, "simulation"), SIMULATE_MS + 300);
    return json(res, 200, { state: publicState(user) });
  }

  if (req.method === "POST" && route === "/api/withdraw") {
    const body = await readBody(req);
    const usd = Number(body.usd);
    const method = body.method === "Bank transfer" ? "Bank transfer" : "PayPal";
    const points = Math.round(usd * POINTS_PER_USD);
    if (!Number.isFinite(points) || points <= 0) return json(res, 400, { error: "invalid_amount" });
    if (points < MIN_WITHDRAW_POINTS) return json(res, 400, { error: "below_minimum" });
    if (points > user.balance) return json(res, 400, { error: "insufficient_points" });
    user.withdrawals.unshift({
      id: id(),
      ts: Date.now(),
      points,
      usd: points / POINTS_PER_USD,
      method,
      status: "queued",
    });
    debit(user, points, "Cash-out request · " + method);
    return json(res, 200, { state: publicState(user) });
  }

  if (req.method === "POST" && route === "/api/postback") {
    const body = await readBody(req);
    const { tx, user: handleIn, offer, amount, status, sig } = body;
    const payload = `${tx}|${handleIn}|${offer}|${amount}|${status}`;
    const expected = crypto.createHmac("sha256", PARTNER_SECRET).update(payload).digest("base64url");
    if (!sig || sig !== expected) return json(res, 403, { error: "bad_signature" });
    if (db.creditedTx.includes(tx)) return json(res, 200, { ok: true, duplicate: true });
    const points = Math.round(Number(amount) * POINTS_PER_USD);
    if (Number(status) !== 1 || !Number.isFinite(points) || points <= 0) {
      db.creditedTx.push(tx);
      dbFlush();
      return json(res, 200, { ok: true, credited: 0 });
    }
    const target = db.users[String(handleIn).toLowerCase()];
    if (!target) return json(res, 404, { error: "unknown_user" });
    if (offer && OFFERS[offer]) target.tasks[offer] = { status: "completed", completedAt: Date.now() };
    credit(target, points, "Offer confirmed · " + (OFFERS[offer]?.title || offer || tx));
    db.creditedTx.push(tx);
    dbFlush();
    return json(res, 200, { ok: true, credited: points });
  }

  if (req.method === "POST" && route === "/api/admin/payouts/paid") {
    if (!ADMIN_KEY || req.headers["x-admin-key"] !== ADMIN_KEY) return json(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const target = db.users[String(body.handle || "").toLowerCase()];
    if (!target) return json(res, 404, { error: "unknown_user" });
    const payout = target.withdrawals.find((w) => w.id === body.payoutId);
    if (!payout) return json(res, 404, { error: "unknown_payout" });
    if (payout.status === "paid") return json(res, 200, { ok: true, already: true });
    payout.status = "paid";
    payout.paidAt = Date.now();
    dbFlush();
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && route === "/api/public/payouts") {
    const rows = Object.entries(db.users).flatMap(([handle, u]) =>
      (u.withdrawals || []).map((w) => ({ handle, ...w }))
    );
    const paid = rows.filter((w) => w.status === "paid");
    const open = rows.filter((w) => w.status === "queued");
    const usd = (list) => Number((list.reduce((a, w) => a + w.points, 0) / POINTS_PER_USD).toFixed(2));
    return json(res, 200, {
      members: new Set(paid.map((w) => w.handle)).size,
      payouts: paid.length,
      totalUsd: usd(paid),
      pendingMembers: new Set(open.map((w) => w.handle)).size,
      pendingUsd: usd(open),
      simulated: SIMULATE,
    });
  }

  return json(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    api(req, res, url).catch((err) => {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: "server_error" });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

async function main() {
  await initStorage();
  server.listen(PORT, () => {
    console.log(`TaskMint on port ${PORT} · simulate=${SIMULATE} · offers=${Object.keys(OFFERS).length}`);
    console.log(pool ? "Storage: Postgres" : `Storage: ${DB_FILE}`);
  });
}

main().catch((err) => {
  console.error("startup failed:", err);
  process.exit(1);
});
