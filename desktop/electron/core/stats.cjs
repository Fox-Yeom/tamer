// Daily counts for the Home view (P2, #44): how many tasks finished each day — nothing else (no
// folders, agents or text). ~/.cache/tamer/stats.json { days: { "2026-10-05": 12 } }, last 120 days.
const path = require("node:path");
const { CACHE, readJson, updateJson } = require("./paths.cjs");

const FILE = path.join(CACHE, "stats.json");
const KEEP_DAYS = 120;
// the local calendar day (the user's midnight, not UTC)
const dayOf = (t = new Date()) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
const daysAgo = (n, from = new Date()) => { const t = new Date(from); t.setDate(t.getDate() - n); return t; };

function recordDone(now = new Date()) {
  updateJson(FILE, (s) => {
    s.days ||= {};
    const d = dayOf(now);
    s.days[d] = (s.days[d] || 0) + 1;
    const cut = dayOf(daysAgo(KEEP_DAYS, now));
    for (const k of Object.keys(s.days)) if (k < cut) delete s.days[k];
  });
}

// today's count, the streak (days in a row with at least one; today may still be empty), the last 7 days
function summary(now = new Date()) {
  const days = readJson(FILE, {}).days || {};
  const n = (i) => days[dayOf(daysAgo(i, now))] || 0;
  let streak = 0;
  for (let i = n(0) ? 0 : 1; i < KEEP_DAYS && n(i); i++) streak++;
  const week = Array.from({ length: 7 }, (_, k) => { const i = 6 - k; return { day: dayOf(daysAgo(i, now)), n: n(i) }; });
  return { today: n(0), streak, week };
}

// every finish still on record (the last 120 days) — the 시작 코인 (#72)
const total = () => Object.values(readJson(FILE, {}).days || {}).reduce((s, n) => s + (Number.isInteger(n) ? n : 0), 0);

// the days with at least one finish, oldest first (연구 스탬프, #82)
const doneDays = () => Object.entries(readJson(FILE, {}).days || {}).filter(([, n]) => Number.isInteger(n) && n > 0).map(([d]) => d).sort();

module.exports = { recordDone, summary, dayOf, total, doneDays };
