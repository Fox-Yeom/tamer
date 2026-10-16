// 포켓코인 (P3 E1, #72, docs/spec PKM-18, POL-FUT-01): finishing tasks earns ₽, nothing else does —
// no reward for tokens, long turns or streaks. Only the main process writes here (POL-SEC-02).
//   economy/ledger.jsonl  one line per day and kind: {"day","kind","n","amount"} — no times, folders,
//                         agents or text (POL-DATA-02 rule 6). The balance is its sum.
//   economy/wallet.json   { balance } — a cache, rebuilt from the ledger when missing or different
//   economy/today.json    { day, seen: [turn start ms] } — the same finish counted once; today only
//   economy/state.json    { startSeen, incenseUntil, stampsSince, legend } — the 시작 코인 band was closed ·
//                         향 burns until (ms) · stamps count from this day · 전설의 향 set on this species (#82)
// 🛒 the shop and 👜 the bag (E3, #76, PKM-22·23): a purchase is a ledger line {day, kind: "buy",
// item, n, amount: −price × n}, using one {day, kind: "use", item, n, amount: 0} — the bag is buys − uses
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

let rows = null; // Map "day|kind[|item]" → { day, kind, item?, n, amount }, in file order
const key = (day, kind, item) => `${day}|${kind}${item ? `|${item}` : ""}`;
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
    const ok = r && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && typeof r.kind === "string" && Number.isInteger(r.n) && Number.isInteger(r.amount) && (r.item == null || typeof r.item === "string");
    if (!ok) { bad = true; continue; }
    const k = key(r.day, r.kind, r.item), had = rows.get(k);
    rows.set(k, had ? { ...had, n: had.n + r.n, amount: had.amount + r.amount } : { day: r.day, kind: r.kind, ...(r.item ? { item: r.item } : {}), n: r.n, amount: r.amount });
  }
  if (bad) { keepCorrupt(LEDGER); save(); } // a copy before the unreadable lines go (POL-DATA-05)
}
function save() {
  mkdirPrivate(DIR);
  writeFile(LEDGER, [...rows.values()].map((r) => JSON.stringify(r)).join("\n") + (rows.size ? "\n" : ""));
  writeJson(WALLET, { balance: balance() });
}
function add(kind, n, amt, item = null) {
  const d = today(), k = key(d, kind, item), r = rows.get(k) || { day: d, kind, ...(item ? { item } : {}), n: 0, amount: 0 };
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
    writeJson(STATE, { ...readJson(STATE, {}), startSeen: !rows.get(key(today(), "start")).amount }); // ₽0: no band — the rest of the state kept
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
  const earned = [...rows.values()].filter((r) => r.day === d && EARN.has(r.kind)).reduce((s, r) => s + r.amount, 0);
  const capLeft = Math.max(0, CAP - amount(d, "done") - amount(d, "fast"));
  const st = [...rows.values()].find((r) => r.kind === "start");
  const show = readJson(STATE, {}).startSeen === false; // written so on the first launch only — a lost state file never shows it again
  return { balance: balance(), bagN: Object.values(bag()).reduce((s, n) => s + n, 0), incenseUntil: incenseUntil(), stamps: stamps(), legend: legendSet(), today: { earned, capLeft, cap: CAP }, start: st && show && st.amount > 0 ? { amount: st.amount, n: st.n } : null };
}
function dismissStart() { writeJson(STATE, { ...readJson(STATE, {}), startSeen: true }); return summary(); }
const EARN = new Set(["done", "fast", "first", "evolve", "newdex", "level", "big", "legend"]); // what "오늘 번 코인" counts

// ── 🛒 the shop (E3, #76, PKM-22): only what this phase has (later items appear with their phase —
// no "coming soon" cards). Prices and limits never go up (POL-FUT-01 rule 10) ───────────────────
const SHOP = [
  { id: "great", group: "ball", name: "슈퍼볼", price: 40, effect: "잡을 확률 ×1.5", many: true },
  { id: "ultra", group: "ball", name: "하이퍼볼", price: 100, effect: "잡을 확률 ×2", many: true },
  { id: "master", group: "ball", name: "마스터볼", price: 1500, effect: "반드시 잡혀요", weekly: 1 },
  { id: "candy", group: "grow", name: "이상한사탕", price: 30, effect: "레벨 +1", many: true },
  { id: "incense", group: "explore", name: "향", price: 80, effect: "1시간 야생 ×2", many: true },
  { id: "legend", group: "explore", name: "전설의 향", price: 800, effect: "다음 대발견 전설 고르기" }, // E4 (#82)
];
const CONFIRM_AT = 1000; // a price this high asks for a second press (the screen; the main process doesn't need it)
const INCENSE_MS = 60 * 60 * 1000;
const MAX_N = 99;
// the week starts on Monday 0:00, this Mac's time
const weekStart = () => { const t = TEST && process.env.CVIM_TEST_TODAY ? new Date(`${process.env.CVIM_TEST_TODAY}T12:00`) : new Date(); t.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return stats.dayOf(t); };
// the bag: bought − used, per item
function bag() {
  load();
  const out = {};
  for (const r of rows.values()) if (r.item && (r.kind === "buy" || r.kind === "use")) out[r.item] = (out[r.item] || 0) + (r.kind === "buy" ? r.n : -r.n);
  for (const k of Object.keys(out)) if (out[k] <= 0) delete out[k];
  return out;
}
const boughtSince = (item, day) => [...rows.values()].filter((r) => r.kind === "buy" && r.item === item && r.day >= day).reduce((s, r) => s + r.n, 0);
const incenseUntil = () => { const u = Number(readJson(STATE, {}).incenseUntil) || 0; return u > Date.now() ? u : 0; };
function shopState() {
  load();
  const have = bag(), ws = weekStart();
  return { balance: balance(), confirmAt: CONFIRM_AT, bag: have, incenseUntil: incenseUntil(),
    items: SHOP.map((i) => ({ ...i, have: have[i.id] || 0, ...(i.weekly ? { left: Math.max(0, i.weekly - boughtSince(i.id, ws)) } : {}) })) };
}
// a purchase — checked here, whatever the screen showed (POL-SEC-02): the item is on sale, the count,
// the weekly limit, the balance. No undo.
function buy(id, n = 1) {
  load();
  const it = SHOP.find((i) => i.id === id);
  n = Number(n);
  if (!it) return { ok: false, why: "unknown" };
  if (!Number.isInteger(n) || n < 1 || n > (it.many ? MAX_N : 1)) return { ok: false, why: "count" };
  if (it.weekly && boughtSince(id, weekStart()) + n > it.weekly) return { ok: false, why: "weekly" };
  const cost = it.price * n;
  if (cost > balance()) return { ok: false, why: "coins" };
  add("buy", n, -cost, id);
  save();
  return { ok: true, ...shopState() };
}
// one of an item from the bag (a ball thrown, a candy given …): false if there's none
function use(id, n = 1) {
  load();
  if ((bag()[id] || 0) < n) return false;
  add("use", n, 0, id);
  save();
  return true;
}
// 향: an hour of wild ×2, another one adds an hour (PKM-23 rule 3)
function burnIncense() {
  if (!use("incense")) return null;
  const until = Math.max(Date.now(), incenseUntil()) + INCENSE_MS;
  writeJson(STATE, { ...readJson(STATE, {}), incenseUntil: until });
  return until;
}

// ── 연구 스탬프 · 주간 대발견 (E4, #82, PKM-24) ─────────────────────────────────────────────
// a stamp = a day with a finish since stampsSince (stats.json — nothing new is kept). The first
// stampsSince is the day this first ran (old days don't trigger one at once); after a breakthrough
// it is the next day
const STAMPS = (TEST && Number(process.env.CVIM_STAMPS)) || 7;
const nextDay = (d) => { const t = new Date(`${d}T12:00`); t.setDate(t.getDate() + 1); return stats.dayOf(t); };
function stamps() {
  const st = readJson(STATE, {});
  if (!st.stampsSince) { st.stampsSince = today(); writeJson(STATE, st); }
  const days = stats.doneDays().filter((d) => d >= st.stampsSince);
  return { n: Math.min(STAMPS, days.length), need: STAMPS, days: days.slice(0, STAMPS) };
}
// the 7th stamp: +100 coins, and the stamps start again tomorrow
function breakthrough() {
  load();
  writeJson(STATE, { ...readJson(STATE, {}), stampsSince: nextDay(today()) });
  add("big", 1, 100);
  save();
  return 100;
}
// all the open legends already with you: 200 coins instead of the encounter (PKM-24 rule 3)
function legendCoins() { load(); add("legend", 1, 200); save(); return 200; }
// 전설의 향: which species the next breakthrough brings — set from the bag, used up then
const legendSet = () => readJson(STATE, {}).legend || null;
function setLegend(id) {
  if (!(bag().legend > 0)) return false;
  writeJson(STATE, { ...readJson(STATE, {}), legend: Number(id) });
  return true;
}
function takeLegend() {
  const id = legendSet();
  if (!id || !use("legend")) return null;
  const st = readJson(STATE, {});
  delete st.legend;
  writeJson(STATE, st);
  return id;
}

module.exports = { init, onDone, onEvolve, onNewDex, onMilestone, summary, shopState, buy, use, bag, burnIncense, incenseUntil, stamps, breakthrough, legendCoins, legendSet, setLegend, takeLegend, dismissStart, CAP, PAY, _reset: () => { rows = null; } };
