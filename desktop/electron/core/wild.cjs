// Wild Pokémon (docs/PLAN.md 3.6): a finished task sometimes brings a wild Pokémon. Throw Poké
// Balls to catch it — catch odds from the species' catch rate, like the games. Caught ones go to
// the Pokédex and can become a folder's partner. One encounter at a time, app-wide.
const crypto = require("node:crypto");
const path = require("node:path");
const { CACHE, readJson, updateJson } = require("./paths.cjs");
const partner = require("./partner.cjs");

const FILE = path.join(CACHE, "wild.json"); // { enabled, last (epoch s), next: { id, shiny } }
const envNum = (k, d) => (process.env[k] != null && Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);
const CHANCE = envNum("CVIM_WILD_CHANCE", 0.15); // per finished task
const COOLDOWN = envNum("CVIM_WILD_COOLDOWN", 600) * 1000; // between encounters
// a folder without a partner: more often (wild catches are how new Pokémon come)
const CHANCE_EMPTY = envNum("CVIM_WILD_CHANCE_EMPTY", 0.3);
const COOLDOWN_EMPTY = envNum("CVIM_WILD_COOLDOWN_EMPTY", 300) * 1000;
const STAY = envNum("CVIM_WILD_STAY", 30) * 1000; // it leaves if you don't throw
const FLEE = 0.1; // after a failed throw (legendary: 0.25)
const BALL = 1; // Poké Ball (Great / Ultra Balls come with the Bag, PLAN 3.3)
const ANIM = 4000; // a throw's animation: the timer waits for it

let current = null; // the encounter on screen
let rng = Math.random;
let prefetching = null;
let onEnd = () => {};

const state = () => readJson(FILE, {});
const enabled = () => state().enabled !== false;
const view = (c) => c && {
  token: c.token, id: c.id, name: c.name, shiny: c.shiny, types: c.types, gif: c.gif, ws: c.ws,
  until: c.until, throws: c.throws,
};

// the next wild Pokémon is picked and downloaded ahead of time (PokéAPI takes ~10 s), so an
// encounter shows up the moment a task finishes
function prefetch() {
  const nx = state().next;
  if (nx && partner.loadSprite(nx.id, nx.shiny)?.gif) return Promise.resolve(nx);
  if (!prefetching) {
    prefetching = partner.fetchPy(["wild"]).then((p) => {
      const data = p && readJson(p, null);
      if (!data) return null;
      const next = { id: data.id, shiny: !!data.shiny };
      updateJson(FILE, (t) => { t.next = next; });
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
function onDone(ws, { empty = false } = {}) {
  if (!enabled() || current) return null;
  const st = state();
  if (Date.now() - (st.last || 0) * 1000 < (empty ? COOLDOWN_EMPTY : COOLDOWN)) return null;
  if (rng() >= (empty ? CHANCE_EMPTY : CHANCE)) return null;
  const sprite = st.next && partner.loadSprite(st.next.id, st.next.shiny);
  if (!sprite?.gif) { prefetch(); return null; } // not downloaded yet: skip this one
  updateJson(FILE, (t) => { t.last = Math.floor(Date.now() / 1000); delete t.next; });
  current = { ...sprite, ws, token: crypto.randomBytes(8).toString("hex"), throws: 0 };
  arm(current, STAY);
  partner.recordSeen(sprite);
  prefetch();
  return view(current);
}

// Catch odds, games' formula (Gen III–VI): a = catchRate × ball × (3·maxHP − 2·HP) / (3·maxHP),
// with the wild one at half HP (your partner fought it: factor 2/3). Four shake checks, each
// passing with (a/255)^(3/16); all four = caught. E.g. catch rate 45 (starters) ≈ 20 % a throw,
// 255 (Caterpie) ≈ 74 %, 3 (legendaries) ≈ 3 %.
function catchOdds(captureRate) {
  const a = Math.max(1, Math.floor(captureRate * BALL * 2 / 3));
  return a >= 255 ? 1 : Math.pow(a / 255, 3 / 16);
}

// ⚾ returns { result: caught | broke | fled | busy (previous ball still shaking) | gone, shakes 0–3 }
function throwBall(token) {
  const c = current;
  if (!c || c.token !== token) return { result: "gone", shakes: 0 };
  if (c.busy) return { result: "busy", shakes: 0 };
  c.throws++;
  const p = catchOdds(c.captureRate);
  let checks = 0;
  while (checks < 4 && rng() < p) checks++;
  const shakes = Math.min(3, checks);
  let result = "broke";
  if (checks === 4) { result = "caught"; partner.addCaught(c); }
  else if (rng() < (c.legendary ? FLEE * 2.5 : FLEE)) result = "fled";
  // the animation (src/wild.js play: 800 ms + 600 ms a shake + 300 ms) plays out before the
  // next ball; caught / fled end after it
  c.busy = true;
  arm(c, ANIM + (result === "broke" ? Math.max(8000, c.until - Date.now()) : 0));
  setTimeout(() => { c.busy = false; }, 1100 + shakes * 600);
  if (result !== "broke") setTimeout(() => end(result), ANIM - 500);
  return { result, shakes, token, name: c.name, id: c.id, shiny: c.shiny, until: c.until };
}

function setEnabled(on) {
  updateJson(FILE, (t) => { t.enabled = !!on; });
  if (!on) end("off");
  else prefetch();
  return !!on;
}

module.exports = {
  onDone, throwBall, prefetch, enabled, setEnabled, catchOdds,
  current: () => view(current),
  setOnEnd: (fn) => { onEnd = fn; },
  setRng: (fn) => { rng = fn; }, // tests
};
