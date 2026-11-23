// TaskMint business routes for the Qoder Sites `app` Function.
// Dependency injection keeps this module runnable under plain Node for local tests;
// the deployed entry point (index.ts) supplies the platform database client.
export function application({ db, BackendError, secrets, sandbox }) {
  const OFFERS = {
    "survey-spending": { title: "Consumer spending survey", points: 750 },
    "video-sponsor": { title: "Watch a 30-second sponsor clip", points: 40 },
    "install-puzzle": { title: "Install & open Puzzle Quest", points: 1400 },
    "survey-streaming": { title: "Streaming services survey", points: 900 },
    "signup-budget": { title: "Free budget app signup", points: 600 },
    "survey-gaming": { title: "Gaming habits survey", points: 520 },
  };
  const POINTS_PER_USD = 1000;
  const MIN_WITHDRAW_POINTS = 5000;
  const CHECKIN_POINTS = 25;
  const STREAK_BONUS_POINTS = 250;
  const SETTLE_MS = 5000;

  const fail = (code, status) => { throw new BackendError(code, status); };
  const rows = (result) => {
    if (result.error) fail(result.error.code || "database_error", result.error.status || 503);
    return result.data || [];
  };
  const now = () => new Date();
  const iso = (d) => d.toISOString();
  const ms = (v) => (v ? Date.parse(v) : null);
  const day = (d = now()) => d.toISOString().slice(0, 10);
  const yesterday = () => day(new Date(Date.now() - 864e5));

  async function readJson(request) {
    if (!request.headers.get("content-type")?.startsWith("application/json")) fail("invalid_input", 400);
    const text = await request.text();
    if (text.length > 8192) fail("payload_too_large", 413);
    try { return JSON.parse(text); } catch { fail("invalid_input", 400); }
  }

  /* ---------------- auth ---------------- */

  const b64url = (bytes) => {
    let s = "";
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const b64urlText = (text) => b64url(new TextEncoder().encode(text));

  async function hmac(payload, secret) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  }

  async function issueToken(handle) {
    if (!secrets.portal) fail("service_not_configured", 503);
    const payload = b64urlText(JSON.stringify({ h: handle, t: Date.now() }));
    return payload + "." + (await hmac(payload, secrets.portal));
  }

  async function verifiedHandle(request) {
    if (!secrets.portal) fail("service_not_configured", 503);
    const auth = request.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    if ((await hmac(payload, secrets.portal)) !== sig) return null;
    try { return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).h || null; }
    catch { return null; }
  }

  /* ---------------- ledger primitives ---------------- */

  async function memberRow(handle) {
    const found = rows(await db.from("members").select("handle,balance,streak_count,streak_last,version").eq("handle", handle).limit(1));
    return found[0] || null;
  }

  // Compare-and-set on the member row so concurrent credits and debits cannot
  // both read the same balance and overwrite each other.
  async function addBalance(handle, delta) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const member = await memberRow(handle);
      if (!member) fail("unknown_user", 404);
      const balance = Number(member.balance);
      if (balance + delta < 0) fail("insufficient_points", 400);
      const updated = rows(await db.from("members")
        .update({ balance: balance + delta, version: Number(member.version) + 1 })
        .eq("handle", handle).eq("version", member.version)
        .select("handle"));
      if (updated.length) return balance + delta;
    }
    fail("write_conflict", 409);
  }

  async function record(handle, kind, points, reason) {
    rows(await db.from("ledger").insert({
      id: crypto.randomUUID(),
      handle,
      kind,
      points,
      reason,
      status: "settled",
      created_at: iso(now()),
    }).select("id"));
  }

  async function credit(handle, points, reason) {
    const balance = await addBalance(handle, points);
    try { await record(handle, "credit", points, reason); }
    catch (error) { await addBalance(handle, -points).catch(() => {}); throw error; }
    return balance;
  }

  /* ---------------- sandbox settlement ---------------- */

  async function settleDue(handle) {
    if (!sandbox) return;
    const pending = rows(await db.from("tasks")
      .select("id,offer,status,ready_at").eq("handle", handle).eq("status", "pending"));
    for (const task of pending) {
      if (!task.ready_at || Date.parse(task.ready_at) > Date.now()) continue;
      const won = rows(await db.from("tasks")
        .update({ status: "completed", completed_at: iso(now()) })
        .eq("id", task.id).eq("status", "pending")
        .select("id"));
      if (!won.length) continue;
      const offer = OFFERS[task.offer];
      try {
        await credit(handle, offer ? offer.points : 0, "Offer completed · " + (offer ? offer.title : task.offer) + " (sandbox simulation)");
      } catch (error) {
        rows(await db.from("tasks").update({ status: "pending", completed_at: null }).eq("id", task.id).select("id"));
        throw error;
      }
    }
  }

  /* ---------------- state ---------------- */

  async function stateFor(handle) {
    const member = await memberRow(handle);
    if (!member) fail("unknown_user", 404);
    const taskRows = rows(await db.from("tasks")
      .select("offer,status,started_at,completed_at").eq("handle", handle).order("started_at", { ascending: false }).limit(50));
    const ledgerRows = rows(await db.from("ledger")
      .select("id,created_at,kind,points,reason,status").eq("handle", handle).order("created_at", { ascending: false }).limit(40));
    const withdrawalRows = rows(await db.from("withdrawals")
      .select("id,requested_at,points,method,status").eq("handle", handle).order("requested_at", { ascending: false }).limit(50));
    const tasks = {};
    for (const task of taskRows) {
      tasks[task.offer] = { status: task.status, startedAt: ms(task.started_at), completedAt: ms(task.completed_at) };
    }
    return {
      handle,
      balance: Number(member.balance),
      streak: { count: Number(member.streak_count) || 0, last: member.streak_last || null },
      tasks,
      ledger: ledgerRows.map((entry) => ({
        id: entry.id, ts: ms(entry.created_at), type: entry.kind, points: Number(entry.points), reason: entry.reason, status: entry.status,
      })),
      withdrawals: withdrawalRows.map((w) => ({
        id: w.id, ts: ms(w.requested_at), points: Number(w.points), usd: Number(w.points) / POINTS_PER_USD, method: w.method, status: w.status,
      })),
      referrals: [],
    };
  }

  /* ---------------- handler ---------------- */

  return async (ctx) => {
    const request = ctx.request;
    const pathname = new URL(request.url).pathname;
    const match = pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
    if (!match) fail("not_found", 404);
    const path = match[1] || "/";
    const method = request.method;

    if (path === "/api/health" && method === "GET") {
      return Response.json({ ok: true, mode: sandbox ? "sandbox" : "live", simulated: sandbox, offers: Object.keys(OFFERS).length });
    }

    if (path === "/api/public/payouts" && method === "GET") {
      const rowsOut = rows(await db.from("withdrawals").select("handle,points,status").limit(5000));
      const paid = rowsOut.filter((w) => w.status === "paid");
      const queued = rowsOut.filter((w) => w.status === "queued");
      const sum = (list) => list.reduce((a, w) => a + Number(w.points), 0) / POINTS_PER_USD;
      return Response.json({
        members: new Set(paid.map((w) => w.handle)).size,
        payouts: paid.length,
        totalUsd: Number(sum(paid).toFixed(2)),
        pendingMembers: new Set(queued.map((w) => w.handle)).size,
        pendingUsd: Number(sum(queued).toFixed(2)),
        simulated: sandbox,
      });
    }

    if (path === "/api/admin/payouts/paid" && method === "POST") {
      if (!secrets.admin || request.headers.get("x-admin-key") !== secrets.admin) fail("forbidden", 403);
      const body = await readJson(request);
      const handle = String(body.handle || "").toLowerCase();
      if (!(await memberRow(handle))) fail("unknown_user", 404);
      const found = rows(await db.from("withdrawals").select("id,status").eq("id", String(body.payoutId || "")).eq("handle", handle).limit(1));
      if (!found.length) fail("unknown_payout", 404);
      if (found[0].status === "paid") return Response.json({ ok: true, already: true });
      rows(await db.from("withdrawals").update({ status: "paid", paid_at: iso(now()) }).eq("id", found[0].id).eq("handle", handle).select("id"));
      return Response.json({ ok: true });
    }

    if (path === "/api/postback" && method === "POST") {
      if (!secrets.offerwall) fail("service_not_configured", 503);
      const body = await readJson(request);
      const tx = String(body.tx || "");
      const handle = String(body.user || "").toLowerCase();
      const offer = String(body.offer || "");
      const amount = String(body.amount ?? "");
      const status = String(body.status ?? "");
      const payload = `${tx}|${handle}|${offer}|${amount}|${status}`;
      const expected = await hmac(payload, secrets.offerwall);
      if (!tx || !body.sig || body.sig !== expected) fail("bad_signature", 403);

      const reserved = rows(await db.from("credited_tx")
        .insertIfAbsent({ tx, handle, offer, points: 0, credited_at: iso(now()) }, { onConflict: "tx" })
        .select("tx"));
      if (!reserved.length) return Response.json({ ok: true, duplicate: true });

      const points = Math.round(Number(amount) * POINTS_PER_USD);
      if (Number(status) !== 1 || !Number.isFinite(points) || points <= 0) {
        return Response.json({ ok: true, credited: 0 });
      }
      if (!(await memberRow(handle))) {
        rows(await db.from("credited_tx").delete().eq("tx", tx).select("tx"));
        fail("unknown_user", 404);
      }
      try {
        await credit(handle, points, "Offer confirmed · " + (OFFERS[offer]?.title || offer || tx));
      } catch (error) {
        rows(await db.from("credited_tx").delete().eq("tx", tx).select("tx"));
        throw error;
      }
      rows(await db.from("credited_tx").update({ points }).eq("tx", tx).select("tx"));
      if (OFFERS[offer]) {
        const id = `${handle}:${offer}`;
        const updated = rows(await db.from("tasks")
          .update({ status: "completed", completed_at: iso(now()) }).eq("id", id).select("id"));
        if (!updated.length) {
          rows(await db.from("tasks").insert({
            id, handle, offer, status: "completed", completed_at: iso(now()), started_at: iso(now()),
          }).select("id"));
        }
      }
      return Response.json({ ok: true, credited: points });
    }

    if (path === "/api/signup" && method === "POST") {
      const body = await readJson(request);
      const handle = String(body.handle || "").trim().toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(handle)) fail("invalid_handle", 400);
      const created = rows(await db.from("members")
        .insertIfAbsent({ handle, balance: 0, streak_count: 0, streak_last: null, version: 0, created_at: iso(now()) }, { onConflict: "handle" })
        .select("handle"));
      if (!created.length) fail("handle_taken", 409);
      return Response.json({ token: await issueToken(handle), state: await stateFor(handle) });
    }

    const handle = await verifiedHandle(request);
    if (!handle) fail("unauthorized", 401);
    if (!(await memberRow(handle))) fail("unauthorized", 401);

    if (path === "/api/state" && method === "GET") {
      await settleDue(handle);
      return Response.json({ state: await stateFor(handle) });
    }

    if (path === "/api/checkin" && method === "POST") {
      const member = await memberRow(handle);
      const today = day();
      if (member.streak_last === today) fail("already_checked_in", 409);
      const count = member.streak_last === yesterday() ? Number(member.streak_count) + 1 : 1;
      rows(await db.from("members")
        .update({ streak_count: count, streak_last: today, version: Number(member.version) + 1 })
        .eq("handle", handle).eq("version", member.version).select("handle"));
      await credit(handle, CHECKIN_POINTS, "Daily check-in · day " + count);
      if (count % 7 === 0) await credit(handle, STREAK_BONUS_POINTS, "7-day streak bonus");
      return Response.json({ state: await stateFor(handle) });
    }

    if (path === "/api/offers/start" && method === "POST") {
      const body = await readJson(request);
      const offerId = String(body.offerId || "");
      if (!OFFERS[offerId]) fail("unknown_offer", 404);
      const id = `${handle}:${offerId}`;
      const existing = rows(await db.from("tasks").select("status").eq("id", id).limit(1));
      if (existing.length && existing[0].status !== "available") fail("already_started", 409);
      rows(await db.from("tasks").insertIfAbsent({
        id, handle, offer: offerId, status: "pending",
        started_at: iso(now()), ready_at: iso(new Date(Date.now() + SETTLE_MS)),
      }, { onConflict: "id" }).select("id"));
      return Response.json({ state: await stateFor(handle) });
    }

    if (path === "/api/withdraw" && method === "POST") {
      const body = await readJson(request);
      const usd = Number(body.usd);
      const method = body.method === "Bank transfer" ? "Bank transfer" : "PayPal";
      const points = Math.round(usd * POINTS_PER_USD);
      if (!Number.isFinite(points) || points <= 0) fail("invalid_amount", 400);
      if (points < MIN_WITHDRAW_POINTS) fail("below_minimum", 400);
      await addBalance(handle, -points);
      const payoutId = crypto.randomUUID();
      try {
        rows(await db.from("withdrawals").insert({
          id: payoutId, handle, points, method,
          status: "queued", requested_at: iso(now()),
        }).select("id"));
      } catch (error) {
        await addBalance(handle, points).catch(() => {});
        throw error;
      }
      try { await record(handle, "debit", points, "Cash-out request · " + method); }
      catch (error) {
        rows(await db.from("withdrawals").delete().eq("id", payoutId).select("id"));
        await addBalance(handle, points).catch(() => {});
        throw error;
      }
      return Response.json({ state: await stateFor(handle) });
    }

    fail("not_found", 404);
  };
}
