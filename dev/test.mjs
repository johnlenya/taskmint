// Exercises the Sites Function routes against the local harness.
import crypto from "node:crypto";
const BASE = process.env.BASE || "http://127.0.0.1:8130/functions/v1/app";
const OFFERWALL = process.env.OFFERWALL_SECRET || "local-offerwall-secret";
const ADMIN = process.env.ADMIN_KEY || "local-admin-key";
const out = [];
const log = (name, ok, extra) => out.push((ok ? "PASS " : "FAIL ") + name + (extra ? " · " + JSON.stringify(extra) : ""));
const j = (r) => r.json();

const health = await j(await fetch(BASE + "/api/health"));
log("health reports sandbox", health.ok === true && health.mode === "sandbox", health);

const handle = "fx_" + Math.random().toString(36).slice(2, 7);
let res = await fetch(BASE + "/api/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle }) });
let body = await j(res);
const auth = { authorization: "Bearer " + body.token, "content-type": "application/json" };
log("signup", res.status === 200 && body.state.balance === 0, { handle, status: res.status });

res = await fetch(BASE + "/api/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle }) });
log("duplicate handle rejected", res.status === 409, { status: res.status });

res = await fetch(BASE + "/api/checkin", { method: "POST", headers: auth, body: "{}" });
body = await j(res);
log("checkin credits 25", body.state.balance === 25, { balance: body.state.balance });

res = await fetch(BASE + "/api/checkin", { method: "POST", headers: auth, body: "{}" });
log("second checkin blocked", res.status === 409, { status: res.status });

res = await fetch(BASE + "/api/offers/start", { method: "POST", headers: auth, body: JSON.stringify({ offerId: "survey-spending" }) });
body = await j(res);
log("offer pending", body.state.tasks["survey-spending"]?.status === "pending");

await new Promise((r) => setTimeout(r, 5600));
body = await j(await fetch(BASE + "/api/state", { headers: auth }));
log("offer settles on state read", body.state.balance === 775, { balance: body.state.balance, task: body.state.tasks["survey-spending"]?.status });

res = await fetch(BASE + "/api/withdraw", { method: "POST", headers: auth, body: JSON.stringify({ usd: 5, method: "PayPal" }) });
log("withdraw above balance rejected", res.status === 400, { status: res.status, code: (await j(res)).error });

res = await fetch(BASE + "/api/withdraw", { method: "POST", headers: auth, body: JSON.stringify({ usd: 1, method: "PayPal" }) });
log("below minimum rejected", res.status === 400, { status: res.status, code: (await j(res)).error });

function sign(tx, user, offer, amount, status) {
  return crypto.createHmac("sha256", OFFERWALL).update(`${tx}|${user}|${offer}|${amount}|${status}`).digest("base64url");
}
const tx = "tx-" + Date.now();
res = await fetch(BASE + "/api/postback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx, user: handle, offer: "survey-streaming", amount: "5.00", status: 1, sig: sign(tx, handle, "survey-streaming", "5.00", 1) }) });
body = await j(res);
log("signed postback credits 5000", res.status === 200 && body.credited === 5000, body);

res = await fetch(BASE + "/api/postback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx, user: handle, offer: "survey-streaming", amount: "5.00", status: 1, sig: sign(tx, handle, "survey-streaming", "5.00", 1) }) });
body = await j(res);
log("duplicate postback ignored", body.duplicate === true, body);

res = await fetch(BASE + "/api/postback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: "tx-bad", user: handle, offer: "survey-streaming", amount: "5.00", status: 1, sig: "nope" }) });
log("bad signature rejected", res.status === 403, { status: res.status });

body = await j(await fetch(BASE + "/api/state", { headers: auth }));
log("balance 5775 after postback", body.state.balance === 5775, { balance: body.state.balance });

res = await fetch(BASE + "/api/withdraw", { method: "POST", headers: auth, body: JSON.stringify({ usd: 5, method: "PayPal" }) });
body = await j(res);
const payoutId = body.state?.withdrawals?.[0]?.id;
log("valid withdraw queued", res.status === 200 && body.state.balance === 775 && body.state.withdrawals[0]?.status === "queued", { balance: body.state?.balance });

res = await fetch(BASE + "/api/state", { headers: { authorization: "Bearer forged.sig" } });
log("forged token rejected", res.status === 401, { status: res.status });

res = await fetch(BASE + "/api/admin/payouts/paid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle, payoutId }) });
log("admin route rejects missing key", res.status === 403, { status: res.status });

res = await fetch(BASE + "/api/admin/payouts/paid", { method: "POST", headers: { "content-type": "application/json", "x-admin-key": ADMIN }, body: JSON.stringify({ handle, payoutId }) });
log("admin marks payout paid", res.status === 200, { status: res.status });

const pub = await j(await fetch(BASE + "/api/public/payouts"));
log("public ledger: paid total and distinct members", pub.totalUsd >= 5 && pub.members >= 1 && pub.payouts >= 1, pub);

console.log(out.join("\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
