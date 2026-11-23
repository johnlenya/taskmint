/* TaskMint prototype — points ledger, tasks, referrals, cash-out.
   All state lives in localStorage. No money moves; see README for the server contract. */

const POINTS_PER_USD = 1000;
const MIN_WITHDRAW_POINTS = 5000;
const CHECKIN_POINTS = 25;
const STREAK_BONUS_POINTS = 250;
const REFERRAL_BONUS_POINTS = 500;
const STORE_KEY = "taskmint:v1";
const VERIFY_MS = 5000;

const TASKS = [
  {
    id: "survey-spending",
    icon: "📊",
    type: "Survey",
    title: "Consumer spending survey",
    detail: "8 min · 14 questions · BitLabs",
    points: 750,
    revenue: 1.15,
  },
  {
    id: "video-sponsor",
    icon: "▶",
    type: "Sponsor clip",
    title: "Watch a 30-second sponsor clip",
    detail: "1 min · served by our offer partner",
    points: 40,
    revenue: 0.06,
  },
  {
    id: "install-puzzle",
    icon: "🎮",
    type: "App install",
    title: "Install & open Puzzle Quest",
    detail: "3 min · open once within 24 h · AdGem",
    points: 1400,
    revenue: 2.1,
  },
  {
    id: "survey-streaming",
    icon: "🎬",
    type: "Survey",
    title: "Streaming services survey",
    detail: "10 min · 18 questions · BitLabs",
    points: 900,
    revenue: 1.35,
  },
  {
    id: "signup-budget",
    icon: "🧾",
    type: "Signup",
    title: "Free budget app signup",
    detail: "4 min · email only, no card · AdGem",
    points: 600,
    revenue: 0.95,
  },
  {
    id: "survey-gaming",
    icon: "🕹",
    type: "Survey",
    title: "Gaming habits survey",
    detail: "6 min · 11 questions · BitLabs",
    points: 520,
    revenue: 0.8,
  },
];

let state = load();
let activeFilter = "all";
let MODE = "demo";
let API_BASE = "";
let SANDBOX = false;
let pollTimer = null;

/* ---------------- server mode ---------------- */

async function api(path, body) {
  const token = localStorage.getItem("taskmint:token");
  const res = await fetch(API_BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: Object.assign(
      { "content-type": "application/json" },
      token ? { authorization: "Bearer " + token } : {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "request_failed");
    err.code = data.error;
    throw err;
  }
  return data;
}

function adaptServerState(s) {
  return {
    v: 1,
    profile: { handle: s.handle, code: referralCode(s.handle) },
    balance: s.balance,
    streak: s.streak || { count: 0, last: null },
    tasks: s.tasks || {},
    ledger: s.ledger || [],
    withdrawals: s.withdrawals || [],
    referrals: s.referrals || [],
  };
}

async function refreshFromServer() {
  const { state: s } = await api("/api/state");
  state = adaptServerState(s);
  renderAll();
}

function startPolling() {
  if (MODE !== "server" || pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      await refreshFromServer();
    } catch (err) {
      /* transient network error — keep polling */
    }
    const pending = Object.values(state.tasks).some((t) => t.status === "pending");
    if (!pending) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 1800);
}

/* ---------------- persistence ---------------- */

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === 1) return parsed;
    }
  } catch (err) {
    console.warn("Could not read saved state", err);
  }
  return {
    v: 1,
    profile: null,
    balance: 0,
    streak: { count: 0, last: null },
    tasks: {},
    ledger: [],
    withdrawals: [],
    referrals: [],
  };
}

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

/* ---------------- helpers ---------------- */

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function pts(n) {
  return Math.round(n).toLocaleString("en-US");
}

function usd(n) {
  return "$" + (n / POINTS_PER_USD).toFixed(2);
}

function usdFmt(n) {
  return "$" + Number(n).toFixed(2);
}

function dayKey(d) {
  const x = d || new Date();
  return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
}

function yesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dayKey(d);
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function referralCode(handle) {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  return "TM" + h.toString(36).toUpperCase().slice(0, 5).padEnd(5, "0");
}

function credit(points, reason, meta) {
  state.balance += points;
  state.ledger.unshift({
    id: uid(),
    ts: Date.now(),
    type: "credit",
    points,
    reason,
    status: (meta && meta.status) || "settled",
  });
  save();
}

function debit(points, reason) {
  state.balance -= points;
  state.ledger.unshift({ id: uid(), ts: Date.now(), type: "debit", points, reason, status: "settled" });
  save();
}

/* ---------------- toast ---------------- */

function toast(message, kind) {
  let stack = document.querySelector(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  const el = document.createElement("div");
  el.className = "toast" + (kind === "error" ? " error" : "");
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

/* ---------------- onboarding ---------------- */

let onboardBound = false;

function bindOnboard() {
  if (onboardBound) return;
  const modal = document.getElementById("onboard");
  const input = document.getElementById("handleInput");
  const go = document.getElementById("handleGo");
  if (!modal || !input || !go) return;
  onboardBound = true;
  const submit = async () => {
    const raw = input.value.trim().replace(/\s+/g, "").toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(raw)) {
      input.setAttribute("aria-invalid", "true");
      toast("Handle must be 3–20 letters, numbers or underscores.", "error");
      return;
    }
    input.removeAttribute("aria-invalid");
    if (MODE === "server") {
      try {
        const res = await api("/api/signup", { handle: raw });
        localStorage.setItem("taskmint:token", res.token);
        state = adaptServerState(res.state);
        modal.classList.remove("open");
        renderAll();
        toast(SANDBOX ? "Welcome, @" + raw + ". Sandbox ledger ready — offers here are simulated." : "Welcome, @" + raw + ". Your ledger is live.");
      } catch (err) {
        toast(err.code === "handle_taken" ? "That handle is taken — try another." : "Could not create the account.", "error");
      }
      return;
    }
    state.profile = {
      handle: raw,
      code: referralCode(raw),
      joinedAt: Date.now(),
    };
    save();
    modal.classList.remove("open");
    renderAll();
    toast("Welcome, @" + raw + ". Your daily check-in is waiting.");
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

function ensureProfile() {
  if (state.profile) return true;
  const modal = document.getElementById("onboard");
  if (!modal) return false;
  bindOnboard();
  modal.classList.add("open");
  return false;
}

/* ---------------- check-in ---------------- */

async function checkIn() {
  if (MODE === "server") {
    try {
      const { state: s } = await api("/api/checkin", {});
      state = adaptServerState(s);
      renderAll();
      toast("Checked in — balance updated on the server.");
    } catch (err) {
      toast(err.code === "already_checked_in" ? "Already checked in today — come back tomorrow." : "Check-in failed. Try again.", "error");
    }
    return;
  }
  const today = dayKey();
  if (state.streak.last === today) {
    toast("Already checked in today — come back tomorrow.", "error");
    return;
  }
  const continued = state.streak.last === yesterdayKey();
  state.streak.count = continued ? state.streak.count + 1 : 1;
  state.streak.last = today;
  credit(CHECKIN_POINTS, "Daily check-in · day " + state.streak.count);
  let bonusGiven = false;
  if (state.streak.count % 7 === 0) {
    credit(STREAK_BONUS_POINTS, "7-day streak bonus");
    bonusGiven = true;
  }
  save();
  renderAll();
  toast(
    bonusGiven
      ? "+" + pts(CHECKIN_POINTS + STREAK_BONUS_POINTS) + " pts — 7-day streak bonus unlocked."
      : "+" + pts(CHECKIN_POINTS) + " pts checked in."
  );
}

/* ---------------- tasks ---------------- */

async function startTask(id) {
  const task = TASKS.find((t) => t.id === id);
  if (!task) return;
  const entry = state.tasks[id];
  if (entry && (entry.status === "pending" || entry.status === "completed")) return;

  if (MODE === "server") {
    try {
      const { state: s } = await api("/api/offers/start", { offerId: id });
      state = adaptServerState(s);
      renderAll();
      toast("Verifying with the offer partner…");
      startPolling();
    } catch (err) {
      toast(err.code === "already_started" ? "This offer is already in progress." : "Could not start the offer.", "error");
    }
    return;
  }

  state.tasks[id] = { status: "pending", startedAt: Date.now(), readyAt: Date.now() + VERIFY_MS };
  save();
  renderAll();
  toast("Verifying with " + task.detail.split("·").pop().trim() + "…");

  setTimeout(() => settleTask(id), VERIFY_MS + 400);
}

function settleTask(id) {
  const entry = state.tasks[id];
  const task = TASKS.find((t) => t.id === id);
  if (!entry || entry.status !== "pending" || !task) return;
  entry.status = "completed";
  entry.completedAt = Date.now();
  credit(task.points, "Offer completed · " + task.title);
  const firstOffer = Object.values(state.tasks).filter((t) => t.status === "completed").length === 1;
  if (firstOffer) settleReferralsIfEligible();
  save();
  renderAll();
  toast("+" + pts(task.points) + " pts · " + task.title);
}

function resumePending() {
  Object.entries(state.tasks).forEach(([id, entry]) => {
    if (entry.status === "pending") {
      const wait = Math.max(0, entry.readyAt - Date.now());
      setTimeout(() => settleTask(id), wait + 200);
    }
  });
}

/* ---------------- referrals ---------------- */

function simulateReferral() {
  if (MODE === "server") {
    toast("Referral bonuses are credited by the backend when a referred friend's first offer is confirmed.");
    return;
  }
  const names = ["mwikali", "kev_254", "amara", "gichuru", "wanjiku", "oseni"];
  const used = new Set(state.referrals.map((r) => r.handle));
  const name = names.find((n) => !used.has(n)) || "friend" + (state.referrals.length + 1);
  state.referrals.push({ id: uid(), handle: name, status: "pending", joinedAt: Date.now() });
  save();
  renderAll();
  toast("@" + name + " joined with your code. Bonus lands after their first completed offer.");
  setTimeout(() => {
    const ref = state.referrals.find((r) => r.handle === name);
    if (!ref || ref.status === "paid") return;
    ref.status = "paid";
    ref.paidAt = Date.now();
    credit(REFERRAL_BONUS_POINTS, "Referral bonus · @" + name + " completed first offer");
    save();
    renderAll();
    toast("+" + pts(REFERRAL_BONUS_POINTS) + " pts referral bonus from @" + name);
  }, VERIFY_MS + 900);
}

function settleReferralsIfEligible() {
  state.referrals.forEach((ref) => {
    if (ref.status === "pending") {
      ref.status = "paid";
      ref.paidAt = Date.now();
      credit(REFERRAL_BONUS_POINTS, "Referral bonus · @" + ref.handle + " completed first offer");
    }
  });
}

/* ---------------- cash out ---------------- */

async function withdraw(ev) {
  ev.preventDefault();
  const amountInput = document.getElementById("withdrawUsd");
  const method = document.getElementById("withdrawMethod");
  const raw = Number(amountInput.value);
  const points = Math.round(raw * POINTS_PER_USD);

  if (!Number.isFinite(raw) || raw <= 0) {
    toast("Enter an amount to cash out.", "error");
    return;
  }

  if (MODE === "server") {
    try {
      const { state: s } = await api("/api/withdraw", { usd: raw, method: method.value });
      state = adaptServerState(s);
      renderAll();
      toast(
        SANDBOX
          ? "Sandbox request recorded: " + usdFmt(raw) + " — no money is sent."
          : "Cash-out queued: " + usdFmt(raw) + " to " + method.value + "."
      );
    } catch (err) {
      if (err.code === "below_minimum") toast("Minimum cash-out is " + usdFmt(MIN_WITHDRAW_POINTS / POINTS_PER_USD) + ".", "error");
      else if (err.code === "insufficient_points") toast("Not enough points for that amount.", "error");
      else toast("Cash-out failed. Try again.", "error");
    }
    return;
  }

  if (points < MIN_WITHDRAW_POINTS) {
    toast("Minimum cash-out is " + usdFmt(MIN_WITHDRAW_POINTS / POINTS_PER_USD) + ".", "error");
    return;
  }
  if (points > state.balance) {
    toast("You only have " + pts(state.balance) + " pts available.", "error");
    return;
  }

  state.withdrawals.unshift({
    id: uid(),
    ts: Date.now(),
    points,
    usd: points / POINTS_PER_USD,
    method: method.value,
    status: "queued",
  });
  debit(points, "Cash-out request · " + method.value);
  save();
  renderAll();
  toast("Cash-out queued: " + usdFmt(points / POINTS_PER_USD) + " to " + method.value + ".");
}

/* ---------------- rendering ---------------- */

function renderAll() {
  if (!state.profile) {
    renderLocked();
    return;
  }
  document.querySelectorAll("[data-handle]").forEach((el) => (el.textContent = "@" + state.profile.handle));
  document.querySelectorAll("[data-avatar]").forEach((el) => (el.textContent = state.profile.handle.slice(0, 2).toUpperCase()));
  document.querySelectorAll("[data-balance]").forEach((el) => (el.textContent = pts(state.balance)));
  document.querySelectorAll("[data-balance-usd]").forEach((el) => (el.textContent = usd(state.balance)));
  document.querySelectorAll("[data-code]").forEach((el) => (el.textContent = state.profile.code));

  renderProgress();
  renderStreak();
  renderTasks();
  renderLedger();
  renderReferrals();
  renderWallet();
  renderPayoutSummary();
}

function renderLocked() {
  document.querySelectorAll("[data-balance]").forEach((el) => (el.textContent = "0"));
  document.querySelectorAll("[data-balance-usd]").forEach((el) => (el.textContent = "$0.00"));
}

function renderProgress() {
  const bar = document.getElementById("progressBar");
  const label = document.getElementById("progressLabel");
  if (!bar) return;
  const target = Math.max(MIN_WITHDRAW_POINTS, state.balance);
  const pct = Math.min(100, (state.balance / target) * 100);
  bar.style.width = pct.toFixed(1) + "%";
  const until = Math.max(0, MIN_WITHDRAW_POINTS - state.balance);
  if (label) {
    label.textContent =
      until > 0
        ? pts(state.balance) + " pts · " + pts(until) + " to cash out (" + usdFmt(until / POINTS_PER_USD) + ")"
        : pts(state.balance) + " pts · cash-out unlocked";
  }
}

function renderStreak() {
  const host = document.getElementById("streakDots");
  const text = document.getElementById("streakText");
  const btn = document.getElementById("checkinBtn");
  if (!host) return;
  const today = dayKey();
  const doneToday = state.streak.last === today;
  const count = state.streak.count || 0;
  host.innerHTML = "";
  const cycleDay = count === 0 ? 1 : ((count - 1) % 7) + 1;
  for (let i = 1; i <= 7; i++) {
    const dot = document.createElement("span");
    dot.className = "streak-dot";
    dot.textContent = i;
    if (i < cycleDay || (doneToday && i <= cycleDay)) dot.classList.add("done");
    if (i === cycleDay && !doneToday) dot.classList.add("today");
    host.appendChild(dot);
  }
  if (text) {
    text.textContent = doneToday
      ? "Checked in today · " + count + "-day streak. Day 7 pays a " + pts(STREAK_BONUS_POINTS) + " pt bonus."
      : count > 0
        ? count + "-day streak · day " + (count + 1) + " pays " + pts(CHECKIN_POINTS) + " pts."
        : "Start a streak — day 7 pays a " + pts(STREAK_BONUS_POINTS) + " pt bonus.";
  }
  if (btn) {
    btn.disabled = doneToday;
    btn.textContent = doneToday ? "Checked in" : "Check in · +" + pts(CHECKIN_POINTS);
  }
  const cycle = document.getElementById("cycleBonus");
  if (cycle) cycle.textContent = pts(STREAK_BONUS_POINTS);
}

function renderTasks() {
  const hosts = document.querySelectorAll("[data-task-host]");
  if (!hosts.length) return;
  hosts.forEach((host) => {
    const filter = host.dataset.filter || activeFilter;
    const limit = Number(host.dataset.limit || 0);
    host.innerHTML = "";
    const list = TASKS.filter((t) => filter === "all" || t.type.toLowerCase().includes(filter)).slice(0, limit || TASKS.length);
    if (!list.length) {
      host.innerHTML = '<div class="empty">Nothing in this category right now.</div>';
      return;
    }
    list.forEach((task) => {
      const entry = state.tasks[task.id] || { status: "available" };
      const row = document.createElement("div");
      row.className = "task-row";

      const icon = document.createElement("div");
      icon.className = "task-ico";
      icon.textContent = task.icon;

      const body = document.createElement("div");
      body.className = "task-body";
      const h = document.createElement("h4");
      h.textContent = task.title;
      const p = document.createElement("p");
      p.textContent = task.detail;
      body.append(h, p);

      const pay = document.createElement("div");
      pay.className = "task-pay";
      const ptsEl = document.createElement("div");
      ptsEl.className = "pts";
      ptsEl.textContent = "+" + pts(task.points);
      const usdEl = document.createElement("div");
      usdEl.className = "usd";
      usdEl.textContent = usd(task.points);
      pay.append(ptsEl, usdEl);

      const action = document.createElement("button");
      action.className = "btn btn-sm " + (entry.status === "available" ? "btn-primary" : "");
      if (entry.status === "pending") {
        action.textContent = "Verifying…";
        action.disabled = true;
      } else if (entry.status === "completed") {
        action.textContent = "Paid ✓";
        action.disabled = true;
        action.classList.add("btn-ghost");
      } else {
        action.textContent = "Start";
        action.addEventListener("click", () => startTask(task.id));
      }

      row.append(icon, body, pay, action);
      host.appendChild(row);
    });
  });
}

function renderLedger() {
  const host = document.getElementById("ledgerList");
  if (!host) return;
  if (!state.ledger.length) {
    host.innerHTML = '<div class="empty">No entries yet. Check in or complete an offer to start your ledger.</div>';
    return;
  }
  host.innerHTML = "";
  state.ledger.slice(0, 25).forEach((row) => {
    const el = document.createElement("div");
    el.className = "ledger-row";
    const sign = document.createElement("span");
    sign.className = "ledger-amt " + row.type;
    sign.textContent = (row.type === "credit" ? "+" : "−") + pts(row.points);
    const reason = document.createElement("span");
    reason.textContent = row.reason;
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = timeAgo(row.ts);
    el.append(sign, reason, when);
    host.appendChild(el);
  });
}

function renderReferrals() {
  const host = document.getElementById("referralList");
  const count = document.getElementById("referralCount");
  const earned = document.getElementById("referralEarned");
  if (count) count.textContent = String(state.referrals.filter((r) => r.status === "paid").length);
  if (earned) {
    const total = state.referrals.filter((r) => r.status === "paid").length * REFERRAL_BONUS_POINTS;
    earned.textContent = pts(total) + " pts";
  }
  if (!host) return;
  if (!state.referrals.length) {
    host.innerHTML = '<div class="empty">No referrals yet. Share your code — you earn once, when a friend completes their first offer.</div>';
    return;
  }
  host.innerHTML = "";
  state.referrals.forEach((ref) => {
    const el = document.createElement("div");
    el.className = "ledger-row";
    const handle = document.createElement("span");
    handle.textContent = "@" + ref.handle;
    const status = document.createElement("span");
    status.className = "pill " + (ref.status === "paid" ? "pill-mint" : "pill-amber");
    status.textContent = ref.status === "paid" ? "Bonus paid" : "Waiting on first offer";
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = ref.status === "paid" ? "+" + pts(REFERRAL_BONUS_POINTS) + " pts" : timeAgo(ref.joinedAt);
    el.append(handle, status, when);
    host.appendChild(el);
  });
}

function renderWallet() {
  const host = document.getElementById("withdrawList");
  const avail = document.getElementById("availableUsd");
  const minNote = document.getElementById("minNote");
  if (avail) avail.textContent = usd(state.balance);
  if (minNote) minNote.textContent = "Minimum " + usdFmt(MIN_WITHDRAW_POINTS / POINTS_PER_USD) + " · 1,000 pts = $1";
  if (!host) return;
  if (!state.withdrawals.length) {
    host.innerHTML = '<div class="empty">No cash-outs yet.</div>';
    return;
  }
  host.innerHTML = "";
  state.withdrawals.forEach((w) => {
    const el = document.createElement("div");
    el.className = "ledger-row";
    const amount = document.createElement("span");
    amount.className = "ledger-amt debit";
    amount.textContent = "−" + pts(w.points);
    const reason = document.createElement("span");
    reason.textContent = usdFmt(w.usd) + " → " + w.method;
    const status = document.createElement("span");
    status.className = "pill pill-amber";
    status.textContent = w.status === "queued" ? "Queued" : w.status;
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = timeAgo(w.ts);
    el.append(amount, reason, status, when);
    host.appendChild(el);
  });
}

function renderPayoutSummary() {
  const host = document.getElementById("payoutSummary");
  if (!host) return;
  const rows = [
    { label: "Pending cash-outs", value: state.withdrawals.filter((w) => w.status === "queued").length },
    { label: "Lifetime earned", value: pts(state.ledger.filter((l) => l.type === "credit").reduce((a, b) => a + b.points, 0)) + " pts" },
    { label: "Offers completed", value: Object.values(state.tasks).filter((t) => t.status === "completed").length },
  ];
  host.innerHTML = "";
  rows.forEach((r) => {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const k = document.createElement("div");
    k.className = "k";
    k.textContent = r.label;
    const v = document.createElement("div");
    v.className = "v";
    v.textContent = r.value;
    tile.append(k, v);
    host.appendChild(tile);
  });
}

/* ---------------- routing ---------------- */

function showPanel(name) {
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + name));
  document.querySelectorAll(".nav-item[data-panel]").forEach((b) => {
    const mine = b.dataset.panel === name;
    b.setAttribute("aria-current", mine ? "true" : "false");
  });
  const titles = {
    dashboard: "Dashboard",
    tasks: "Earn",
    referrals: "Referrals",
    wallet: "Wallet",
  };
  const h = document.getElementById("panelTitle");
  if (h) h.textContent = titles[name] || "Dashboard";
  if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
}

// Backend lives at the deployment root on a Node host and under the Sites
// Function prefix on Qoder hosting; probe both and keep whichever answers.
async function detectBackend() {
  for (const base of ["", "/functions/v1/app"]) {
    try {
      const res = await fetch(base + "/api/health", { cache: "no-store" });
      if (!res.ok) continue;
      const body = await res.json();
      if (body && body.ok) {
        API_BASE = base;
        return body;
      }
    } catch (err) {
      /* try the next candidate */
    }
  }
  return null;
}

function setServerChrome(health) {
  const sandbox = health && health.mode === "sandbox";
  const pill = document.querySelector(".topbar > .pill");
  if (pill) pill.textContent = sandbox ? "Sandbox ledger" : "Live ledger";
  const note = document.getElementById("modeNote");
  if (note) {
    note.textContent = sandbox
      ? "Balances are stored on the server. Sandbox: offers settle from simulated partner confirmation and cash-outs are not paid."
      : "Balances are stored on the server. Payouts are queued for the weekly run.";
  }
  const sim = document.getElementById("simulateReferral");
  if (sim) sim.style.display = "none";
  const payoutNote = document.getElementById("payoutNote");
  if (payoutNote) {
    payoutNote.textContent = sandbox
      ? "Sandbox: requests are recorded and points are debited, but no money is sent."
      : "Points are debited immediately; payouts are sent manually after the weekly run.";
  }
  const onboardNote = document.getElementById("onboardNote");
  if (onboardNote) {
    onboardNote.textContent = sandbox
      ? "This sandbox stores your handle and balance on the server. Offers are simulated — nothing here pays cash."
      : "Your handle and balance are stored on this deployment. No email or payment details needed yet.";
  }
  const reset = document.getElementById("resetDemo");
  if (reset) reset.textContent = "Sign out";
}

function showOnboard() {
  bindOnboard();
  const modal = document.getElementById("onboard");
  if (modal) modal.classList.add("open");
  const input = document.getElementById("handleInput");
  if (input) input.focus();
}

/* ---------------- boot ---------------- */

document.addEventListener("DOMContentLoaded", async () => {
  if (!document.getElementById("appRoot")) return;

  document.querySelectorAll("[data-panel]").forEach((btn) => {
    btn.addEventListener("click", () => showPanel(btn.dataset.panel));
  });

  const checkin = document.getElementById("checkinBtn");
  if (checkin) checkin.addEventListener("click", checkIn);

  const simref = document.getElementById("simulateReferral");
  if (simref) simref.addEventListener("click", simulateReferral);

  const copy = document.getElementById("copyCode");
  if (copy) {
    copy.addEventListener("click", async () => {
      const code = state.profile ? state.profile.code : "";
      try {
        await navigator.clipboard.writeText(code);
        toast("Referral code copied.");
      } catch (err) {
        toast("Copy failed — select the code manually.", "error");
      }
    });
  }

  const form = document.getElementById("withdrawForm");
  if (form) form.addEventListener("submit", withdraw);

  const filters = document.getElementById("taskFilters");
  if (filters) {
    filters.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-filter]");
      if (!btn) return;
      filters.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-selected", b === btn ? "true" : "false"));
      activeFilter = btn.dataset.filter;
      document.querySelectorAll("[data-task-host]").forEach((h) => (h.dataset.filter = activeFilter));
      renderTasks();
    });
  }

  const reset = document.getElementById("resetDemo");
  if (reset) {
    reset.addEventListener("click", () => {
      if (MODE === "server") {
        if (!confirm("Sign out of this demo account?")) return;
        localStorage.removeItem("taskmint:token");
        location.reload();
        return;
      }
      if (!confirm("Reset the demo profile, points and history?")) return;
      localStorage.removeItem(STORE_KEY);
      location.reload();
    });
  }

  const startPanel = (location.hash || "#dashboard").slice(1);
  showPanel(["dashboard", "tasks", "referrals", "wallet"].includes(startPanel) ? startPanel : "dashboard");

  const health = await detectBackend();
  MODE = health ? "server" : "demo";
  SANDBOX = MODE === "server" && health.mode === "sandbox";

  if (MODE === "server") {
    setServerChrome(health);
    if (localStorage.getItem("taskmint:token")) {
      try {
        await refreshFromServer();
        if (Object.values(state.tasks).some((t) => t.status === "pending")) startPolling();
      } catch (err) {
        localStorage.removeItem("taskmint:token");
        showOnboard();
      }
    } else {
      showOnboard();
    }
    return;
  }

  if (ensureProfile()) {
    renderAll();
    resumePending();
  }
});
