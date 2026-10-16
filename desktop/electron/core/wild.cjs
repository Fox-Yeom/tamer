// Wild Pokémon (docs/PLAN.md 3.6): a finished task sometimes brings a wild Pokémon. Throw Poké
// Balls to catch it — catch odds from the species' catch rate, like the games. Caught ones go to
// the Pokédex and can become a folder's partner. One encounter at a time, app-wide.
const crypto = require("node:crypto");
const path = require("node:path");
const { CACHE, readJson, updateJson } = require("./paths.cjs");
const partner = require("./partner.cjs");
const economy = require("./economy.cjs"); // 빛나는부적 (#93)

const FILE = path.join(CACHE, "wild.json"); // { enabled, last (epoch s), next: { id, shiny }, big: { id, shiny, misses, seen } }
const envNum = (k, d) => (process.env[k] != null && Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);
const CHANCE = envNum("CVIM_WILD_CHANCE", 0.15); // per finished task
const COOLDOWN = envNum("CVIM_WILD_COOLDOWN", 600) * 1000; // between encounters
// a folder without a partner: more often (wild catches are how new Pokémon come)
const CHANCE_EMPTY = envNum("CVIM_WILD_CHANCE_EMPTY", 0.3);
const COOLDOWN_EMPTY = envNum("CVIM_WILD_COOLDOWN_EMPTY", 300) * 1000;
const STAY = envNum("CVIM_WILD_STAY", 30) * 1000; // it leaves if you don't throw
const FLEE = 0.1; // after a failed throw (legendary: 0.25)
// the balls (#76, PKM-23 rule 1): the formula's "ball" factor — Poké Ball free and endless, the rest
// bought in the shop; a Master Ball always catches
const BALLS = { poke: 1, great: 1.5, ultra: 2, master: Infinity };
const ANIM = 4000; // a throw's animation: the timer waits for it
// ⭐ 대발견 (#82, PKM-24) · ✦ 리서치 (#86, PKM-27): an encounter that stays until caught (no timer, no
// fleeing, back after a restart) and each miss makes the next throw ×1.2 easier. Which legends are open:
// legends.cjs (전설의 길)
const PITY = 1.2;

let current = null; // the encounter on screen
let rng = Math.random;
let prefetching = null;
let onEnd = () => {};

const state = () => readJson(FILE, {});
const enabled = () => state().enabled !== false;
const view = (c) => c && {
  token: c.token, id: c.id, name: c.name, shiny: c.shiny, types: c.types, gif: c.gif, ws: c.ws,
  until: c.until, throws: c.throws, ...(c.big ? { big: true, pity: Math.round(PITY ** c.misses * 100) / 100, ...(c.research ? { research: true } : {}) } : {}),
};

// the next wild Pokémon is picked and downloaded ahead of time (PokéAPI takes ~10 s), so an
// encounter shows up the moment a task finishes
function prefetch() {
  const nx = state().next;
  if (nx && partner.loadSprite(nx.id, nx.shiny)?.gif) { partner.fetchEvo(nx.id); return Promise.resolve(nx); } // its level when caught (#74)
  if (!prefetching) {
    prefetching = partner.fetchPy(["wild", ...(economy.charmOn() ? ["charm"] : [])]).then((p) => {
      const data = p && readJson(p, null);
      if (!data) return null;
      const next = { id: data.id, shiny: !!data.shiny };
      updateJson(FILE, (t) => { t.next = next; });
      partner.fetchEvo(next.id); // a caught evolved form starts at the level it is reached at (#74, PKM-21 rule 1)
      return next;
    }).finally(() => { prefetching = null; });
  }
  return prefetching;
}

function end(reason) {
  if (!current) return;
  const c = current;
  clearTimeout(c.timer);
  current = null;
  onEnd({ token: c.token, reason, name: c.name });
}

function arm(c, ms) {
  clearTimeout(c.timer);
  c.until = Date.now() + ms;
  c.timer = setTimeout(() => end("left"), ms);
}

// a task finished in workspace `ws`: maybe a wild Pokémon appears (returns it, or null).
// empty: that folder has no partner (higher chance, shorter wait)
// incense: 향 burning (#76, PKM-23 rule 3) — twice the chance, half the wait
function onDone(ws, { empty = false, folder = null, agent = null, incense = false } = {}) {
  if (!enabled() || current) return null;
  const st = state();
  if (st.big) return null; // a breakthrough waiting to be caught: one encounter at a time
  if (Date.now() - (st.last || 0) * 1000 < (empty ? COOLDOWN_EMPTY : COOLDOWN) / (incense ? 2 : 1)) return null;
  if (rng() >= Math.min(1, (empty ? CHANCE_EMPTY : CHANCE) * (incense ? 2 : 1))) return null;
  const sprite = st.next && partner.loadSprite(st.next.id, st.next.shiny);
  if (!sprite?.gif) { prefetch(); return null; } // not downloaded yet: skip this one
  updateJson(FILE, (t) => { t.last = Math.floor(Date.now() / 1000); delete t.next; });
  current = { ...sprite, ws, caughtIn: folder, caughtBy: agent, token: crypto.randomBytes(8).toString("hex"), throws: 0 };
  arm(current, STAY);
  partner.recordSeen(sprite);
  prefetch();
  return view(current);
}

// Catch odds, games' formula (Gen III–VI): a = catchRate × ball × (3·maxHP − 2·HP) / (3·maxHP),
// with the wild one at half HP (your partner fought it: factor 2/3). Four shake checks, each
// passing with (a/255)^(3/16); all four = caught. E.g. catch rate 45 (starters) ≈ 20 % a throw,
// 255 (Caterpie) ≈ 74 %, 3 (legendaries) ≈ 3 %. The folder's partner helps: a × (1 + 0.3 × Lv/100)
// — ×1.3 at Lv 100 (#74, PKM-21 rule 6)
function catchOdds(captureRate, partnerLv = 0, ball = "poke", pity = 1) {
  if (BALLS[ball] === Infinity) return 1;
  const a = Math.max(1, Math.floor(captureRate * (BALLS[ball] || 1) * 2 / 3 * (1 + 0.3 * Math.min(100, partnerLv) / 100) * pity));
  return a >= 255 ? 1 : Math.pow(a / 255, 3 / 16);
}

// ⚾ returns { result: caught | broke | fled | busy (previous ball still shaking) | gone | noball, shakes 0–3 }
// ball: "poke" (free) or one from the bag — pay(ball) takes it from the bag only once the throw goes ahead
function throwBall(token, ball = "poke", pay = () => true) {
  const c = current;
  if (!c || c.token !== token) return { result: "gone", shakes: 0 };
  if (c.busy) return { result: "busy", shakes: 0 };
  if (!(ball in BALLS)) ball = "poke";
  if (ball !== "poke" && !pay(ball)) return { result: "noball", shakes: 0, ball };
  c.throws++;
  const p = catchOdds(c.captureRate, partner.levelAt(c.caughtIn), ball, c.big ? PITY ** c.misses : 1);
  let checks = 0;
  while (checks < 4 && rng() < p) checks++;
  const shakes = Math.min(3, checks);
  let result = "broke", newdex = false;
  if (checks === 4) { result = "caught"; newdex = partner.addCaught(c); if (c.big) updateJson(FILE, (t) => { delete t.big; }); }
  else if (!c.big && rng() < (c.legendary ? FLEE * 2.5 : FLEE)) result = "fled";
  else if (c.big) { c.misses++; updateJson(FILE, (t) => { if (t.big) t.big.misses = c.misses; }); } // it stays — and gets easier
  // the animation (src/wild.js play: 1100 ms + 600 ms a shake) plays out before the next ball,
  // and the clock stops while it plays: after a miss it goes on from where it was (at least 8 s
  // left), so the card never shows the outcome early (#11). Caught / fled end after it.
  const anim = 1100 + shakes * 600;
  const left = c.big ? 0 : Math.max(8000, c.until - Date.now());
  c.busy = true;
  if (!c.big) arm(c, result === "broke" ? anim + left : ANIM);
  setTimeout(() => { c.busy = false; }, anim);
  if (result !== "broke") setTimeout(() => end(result), ANIM - 500);
  return { result, shakes, token, name: c.name, id: c.id, shiny: c.shiny, left: result === "broke" ? left : 0, newdex, ball, ...(c.big ? { big: true, pity: Math.round(PITY ** c.misses * 100) / 100 } : {}) };
}

// ⭐ a breakthrough's legend: kept in wild.json until caught, shown once nothing else is on screen
// (its picture fetched first — offline it waits for the next finish)
const bigPending = () => !!state().big;
function startBig(id, shiny, kind = "big") { updateJson(FILE, (t) => { t.big = { id: Number(id), shiny: !!shiny, misses: 0, ...(kind === "research" ? { research: true } : {}) }; }); }

async function showBig() {
  const b = state().big;
  if (!b || current || !enabled()) return null;
  let sp = partner.loadSprite(b.id, b.shiny);
  if (!sp?.gif) { await partner.fetchPy([String(b.id), ...(b.shiny ? ["shiny"] : [])]); sp = partner.loadSprite(b.id, b.shiny); }
  if (!sp?.gif || current) return null;
  current = { ...sp, ws: null, big: true, research: !!b.research, misses: b.misses || 0, token: crypto.randomBytes(8).toString("hex"), throws: 0 };
  if (!b.seen) { partner.recordSeen(sp); updateJson(FILE, (t) => { if (t.big) t.big.seen = true; }); }
  return view(current);
}

function setEnabled(on) {
  updateJson(FILE, (t) => { t.enabled = !!on; });
  if (!on) end("off");
  else prefetch();
  return !!on;
}

module.exports = {
  onDone, throwBall, prefetch, enabled, setEnabled, catchOdds, bigPending, startBig, showBig,
  current: () => view(current),
  setOnEnd: (fn) => { onEnd = fn; },
  setRng: (fn) => { rng = fn; }, // tests
};
