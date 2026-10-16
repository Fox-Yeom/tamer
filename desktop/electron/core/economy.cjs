// 포켓코인 (P3 E1, #72, docs/spec PKM-18, POL-FUT-01): finishing tasks earns ₽, nothing else does —
// no reward for tokens, long turns or streaks. Only the main process writes here (POL-SEC-02).
//   economy/ledger.jsonl  one line per day and kind: {"day","kind","n","amount"} — no times, folders,
//                         agents or text (POL-DATA-02 rule 6). The balance is its sum.
//   economy/wallet.json   { balance } — a cache, rebuilt from the ledger when missing or different
//   economy/today.json    { day, seen: [turn start ms] } — the same finish counted once; today only
//   economy/state.json    { startSeen } — the 시작 코인 band was closed
const fs = require("node:fs");
const path = require("node:path");
const { CACHE, readJson, writeJson, writeFile, mkdirPrivate, keepCorrupt } = require("./paths.cjs");
const stats = require("./stats.cjs");

const DIR = path.join(CACHE, "economy");
const LEDGER = path.join(DIR, "ledger.jsonl");
const WALLET = path.join(DIR, "wallet.json");
const TODAY = path.join(DIR, "today.json");
const STATE = path.join(DIR, "state.json");

const PAY = { done: 5, fast: 1, first: 20, evolve: 30, newdex: 30, level: 20 };
const CAP = 300; // finishes (+5 · +1) a day; the bonuses are outside it
const FAST_MS = 30 * 1000; // a turn shorter than this earns +1
const START_PER = 2, START_MAX = 1000; // 시작 코인: past finishes × 2, at most ₽1,000
const SEEN_MAX = 2000;

// tests: a fixed "today" (CVIM_TEST_TODAY), like the Home view's
const TEST = process.env.CVIM_DESKTOP_TEST === "1";
const today = () => stats.dayOf(TEST && process.env.CVIM_TEST_TODAY ? new Date(`${process.env.CVIM_TEST_TODAY}T12:00`) : new Date());

let rows = null; // Map "day|kind" → { day, kind, n, amount }, in file order
const key = (day, kind) => `${day}|${kind}`;
const amount = (day, kind) => rows.get(key(day, kind))?.amount || 0;
const balance = () => [...rows.values()].reduce((s, r) => s + r.amount, 0);

function load() {
  if (rows) return;
  rows = new Map();
  let text = "";
  try { text = fs.readFileSync(LEDGER, "utf8"); } catch { return; }
  let bad = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r = null;
    try { r = JSON.parse(line); } catch {}
    const ok = r && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && typeof r.kind === "string" && Number.isInteger(r.n) && Number.isInteger(r.amount);
    if (!ok) { bad = true; continue; }
    const k = key(r.day, r.kind), had = rows.get(k);
    rows.set(k, had ? { ...had, n: had.n + r.n, amount: had.amount + r.amount } : { day: r.day, kind: r.kind, n: r.n, amount: r.amount });
  }
  if (bad) { keepCorrupt(LEDGER); save(); } // a copy before the unreadable lines go (POL-DATA-05)
}
function save() {
  mkdirPrivate(DIR);
  writeFile(LEDGER, [...rows.values()].map((r) => JSON.stringify(r)).join("\n") + (rows.size ? "\n" : ""));
  writeJson(WALLET, { balance: balance() });
}
function add(kind, n, amt) {
  const d = today(), k = key(d, kind), r = rows.get(k) || { day: d, kind, n: 0, amount: 0 };
  r.n += n;
  r.amount += amt;
  rows.set(k, r);
}

// on launch: the ledger (and the 시작 코인 the first time), the wallet cache checked against it
function init() {
  const first = !fs.existsSync(LEDGER);
  load();
  if (first) {
    const n = stats.total();
    add("start", n, Math.min(n * START_PER, START_MAX));
    writeJson(STATE, { startSeen: !rows.get(key(today(), "start")).amount }); // ₽0: no band
    save();
  } else if (readJson(WALLET, {}).balance !== balance()) save();
  return summary();
}

// a finished task ({ turnAt: when the turn started, took: how long, ms }): +5, or +1 for a turn under
// 30 s, up to ₽300 a day — and +20 for the day's first. The same turn twice counts once.
function onDone({ turnAt = null, took = null } = {}) {
  load();
  const d = today();
  if (turnAt) {
    const t = readJson(TODAY, {});
    const seen = t.day === d && Array.isArray(t.seen) ? t.seen : [];
    if (seen.includes(turnAt)) return null;
    seen.push(turnAt);
    writeJson(TODAY, { day: d, seen: seen.slice(-SEEN_MAX) });
  }
  const kind = took != null && took < FAST_MS ? "fast" : "done";
  const left = Math.max(0, CAP - amount(d, "done") - amount(d, "fast"));
  const pay = Math.min(PAY[kind], left);
  add(kind, 1, pay);
  const first = rows.has(key(d, "first")) ? 0 : PAY.first;
  if (first) add("first", 1, first);
  save();
  return { gained: pay + first, pay, first, capped: pay < PAY[kind] };
}
const bonus = (kind) => () => { load(); add(kind, 1, PAY[kind]); save(); return PAY[kind]; };
const onEvolve = bonus("evolve");
const onNewDex = bonus("newdex"); // a wild one of a species never caught before
const onMilestone = bonus("level"); // every 10 levels, once an individual (#74, PKM-21 rule 7)

// what the screens show: the balance, today's (bonuses too) and how much of the ₽300 is left
function summary() {
  load();
  const d = today();
  const earned = [...rows.values()].filter((r) => r.day === d && r.kind !== "start").reduce((s, r) => s + r.amount, 0);
  const capLeft = Math.max(0, CAP - amount(d, "done") - amount(d, "fast"));
  const st = [...rows.values()].find((r) => r.kind === "start");
  const show = readJson(STATE, {}).startSeen === false; // written so on the first launch only — a lost state file never shows it again
  return { balance: balance(), today: { earned, capLeft, cap: CAP }, start: st && show && st.amount > 0 ? { amount: st.amount, n: st.n } : null };
}
function dismissStart() { writeJson(STATE, { ...readJson(STATE, {}), startSeen: true }); return summary(); }

module.exports = { init, onDone, onEvolve, onNewDex, onMilestone, summary, dismissStart, CAP, PAY, _reset: () => { rows = null; } };
