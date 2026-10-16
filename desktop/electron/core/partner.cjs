// Partner Pokémon, one by one (2026-10-01 decision, "Pokémon GO style"):
//   1. every Pokémon you get is one individual in the box (several of the same species are fine)
//   2. a folder's partner is one individual; an individual is the partner of one folder at most
//   3. new ones: your first partner (one of 3 starters, once, while the box is empty), then wild
//      catches (more often in folders without a partner — wild.cjs); eggs from the shop later (P3)
//   4. the level and evolution belong to the individual (they move with it) — Lv 5~100, +2 a finished
//      task (+1 after its last form), evolving as in the games (#74, PKM-21): at its level, or Lv 30
//      for a stone / anything else, after 20 finishes together (friendship), or on the first finish
//      after moving to another folder (trade). The old EXP still counts up for folders.json (PKM-17)
// A folder without a partner shows an empty state (2026-10-02 decision).
// box.json holds the individuals; folders.json keeps a mirror (id, shiny, xp …, uid) so the
// Neovim CVIM still shows and levels the partner (it can't change partners any more).
// Sprites come from PokéAPI (pokeapi.cjs; local cache only).
const fs = require("node:fs");
const path = require("node:path");
const { CACHE, readJson, writeJson, updateJson } = require("./paths.cjs");
const pokeapi = require("./pokeapi.cjs");

const FOLDERS = path.join(CACHE, "folders.json");
const DEX = path.join(CACHE, "pokedex.json");
const SPRITES = path.join(CACHE, "pokemon");
const EVOLVE_EVERY = 8; // the old pace (before levels, #74) — only for folders.json's mirror
const BOX = path.join(CACHE, "box.json"); // { next, mons: [{ uid, id, shiny, xp, lv, mile, friend, traded, last_folder, final, how, at, folder }] }
const START_LV = 5, MAX_LV = 100, ALT_LV = 30, FRIEND_N = 20; // PKM-21
const STARTER = path.join(CACHE, "starters.json"); // { set: [{ id, shiny }] } — the first partner's choice
const CHOICES = 3;
const RECENT_HOURS = 24; // the dex "새로 잡은" row

const spriteBase = (id, shiny) => path.join(SPRITES, `${id}${shiny ? "s" : ""}`);

// pokeapi.cjs commands: a cached JSON path / next id / "" (offline)
const fetchPy = (args) => pokeapi.run(args);

function loadSprite(id, shiny) {
  const base = spriteBase(id, shiny);
  const data = readJson(base + ".json", null);
  if (!data) return null;
  return { id: data.id, shiny: !!data.shiny, name: data.name_ko || data.name_en, types: data.types || [],
    captureRate: data.capture_rate ?? 45, legendary: !!data.legendary,
    gif: fs.existsSync(base + ".gif") ? base + ".gif" : null };
}

// Pokédex record, same shape as v1's record_dex (shiny only when true).
// `caught: false` = seen in the wild but not caught; no field (older records, partners) = caught.
// Only caught ones can become a partner, and ✨ counts only when a shiny one was caught.
function recordDex(sprite, caught = true) {
  updateJson(DEX, (t) => {
    const e = t[sprite.id] || { first: Math.floor(Date.now() / 1000), count: 0, ...(caught ? {} : { caught: false }) };
    e.name = sprite.name;
    e.count = (e.count || 0) + 1;
    e.last = Math.floor(Date.now() / 1000);
    if (caught) {
      delete e.caught;
      if (sprite.shiny) e.shiny = true;
    }
    e.types = sprite.types;
    t[sprite.id] = e;
  });
}
const recordSeen = (sprite) => recordDex(sprite, false);

// caught one: count stays (it was counted when seen). true = the first of its species ever caught
// (seen before, never caught) — 🪙 +₽30 (#72)
function recordCaught(sprite) {
  let fresh = false;
  updateJson(DEX, (t) => {
    const e = t[sprite.id];
    if (!e) return;
    fresh = e.caught === false;
    delete e.caught;
    if (sprite.shiny) e.shiny = true;
  });
  return fresh;
}

// ── the box ─────────────────────────────────────────────────────────────────
const now = () => Math.floor(Date.now() / 1000);
const readBox = () => readJson(BOX, { next: 1, mons: [] });
function updateBox(fn) {
  let out;
  updateJson(BOX, (b) => { b.next ??= 1; b.mons ??= []; out = fn(b); });
  return out;
}

// ── levels (#74, PKM-21) ──────────────────────────────────────────────────────
// how a species evolves (pokeapi.cjs "evo": { reach, next: [{ to, kind, level }] }), null until fetched
const evoOf = (id) => readJson(path.join(SPRITES, `${id}.evo.json`), null);
const evoAsked = new Set();
function fetchEvo(id) { // in the background, once a session per species (the cards show it next time)
  if (evoOf(id) || evoAsked.has(id)) return;
  evoAsked.add(id);
  fetchPy(["evo", String(id)]).then((f) => { if (!f) evoAsked.delete(id); });
}
// the lowest level a form can have: the level it is reached at (Lv 30 for any other way), 5 for a first form
const floorOf = (id) => { const r = evoOf(id)?.reach; return !r ? START_LV : r.kind === "level" ? r.level : ALT_LV; };
const lvOf = (m) => m.lv ?? START_LV;
// its last form: marked so, or its facts say there's no next stage (Vaporeon, Corsola …)
const isFinal = (m) => !!m.final || evoOf(m.id)?.next?.length === 0;
// is this next stage open now? (a stone is Lv 30 until stones come, PKM-28)
const open = (o, m, trade) => (o.kind === "level" ? lvOf(m) >= o.level : o.kind === "friend" ? (m.friend || 0) >= FRIEND_N : o.kind === "trade" ? trade : lvOf(m) >= ALT_LV);
// what the cards say comes next: the nearest level, else friendship, trade, a stone, anything else
function nextView(m) {
  if (isFinal(m)) return null;
  const e = evoOf(m.id);
  if (!e) { fetchEvo(m.id); return null; }
  const by = (k) => e.next.filter((o) => o.kind === k);
  const lv = by("level").map((o) => o.level).sort((a, b) => a - b)[0];
  if (lv) return { kind: "level", level: lv };
  if (by("friend").length) return { kind: "friend", friend: Math.min(FRIEND_N, m.friend || 0), of: FRIEND_N };
  if (by("trade").length) return { kind: "trade" };
  if (by("stone").length) return { kind: "stone", level: ALT_LV };
  return e.next.length ? { kind: "other", level: ALT_LV } : null;
}
const lvView = (m) => ({ lv: lvOf(m), final: isFinal(m), next: nextView(m) });

function addMon(b, sprite, how, folder = null) {
  // a new one starts at Lv 5 — a caught evolved form at the level its form is reached (PKM-21 rule 1)
  const lv = Math.max(START_LV, floorOf(sprite.id));
  const m = { uid: b.next++, id: sprite.id, shiny: !!sprite.shiny, xp: 0, since_evo: 0, lv, mile: Math.floor(lv / 10) * 10, friend: 0, how, at: now(), folder };
  if (folder) m.last_folder = folder;
  b.mons.push(m);
  return m;
}

// once: EXP → levels (PKM-21 rule 8) — Lv = 5 + 2 × EXP, at least the level its form is reached at
// (when that's known yet), at most 100; the milestones up to it count as passed (no ₽ for the past).
// box.json is copied aside first (POL-DATA-05)
function migrateLevels() {
  const b = readBox();
  if (!b.mons.some((m) => m.lv == null)) return 0;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(CACHE, "backup", `box-levels-${stamp}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(BOX, path.join(dir, "box.json"));
  fs.chmodSync(path.join(dir, "box.json"), 0o600);
  let n = 0;
  updateBox((x) => {
    for (const m of x.mons) {
      if (m.lv != null) continue;
      m.lv = Math.min(MAX_LV, Math.max(START_LV + 2 * (m.xp || 0), floorOf(m.id)));
      m.mile = Math.floor(m.lv / 10) * 10;
      m.friend = 0;
      if (m.folder) m.last_folder = m.folder;
      n++;
    }
  });
  return n;
}

// first run: everything you have becomes individuals ("전부 인정") — one per caught species in the
// Pokédex, plus each folder's partner (with its EXP). The old files are copied aside first.
function migrateBox() {
  if (fs.existsSync(BOX)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(CACHE, "backup", `box-migration-${stamp}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of [FOLDERS, DEX]) {
    if (!fs.existsSync(f)) continue;
    const to = path.join(dir, path.basename(f));
    fs.copyFileSync(f, to);
    fs.chmodSync(to, 0o600);
  }
  const folders = readJson(FOLDERS, {});
  const b = { next: 1, mons: [] };
  for (const [cwd, rec] of Object.entries(folders)) {
    if (!rec?.id) continue;
    const m = addMon(b, rec, "legacy", cwd);
    Object.assign(m, { xp: rec.xp || 0, since_evo: rec.since_evo || 0, ...(rec.final ? { final: true } : {}) });
    delete m.lv; delete m.mile; // its level comes from its EXP (migrateLevels, right after)
    rec.uid = m.uid;
    rec.pinned = true;
  }
  for (const [id, e] of Object.entries(readJson(DEX, {}))) {
    if (e.caught === false) continue;
    const m = addMon(b, { id: Number(id), shiny: !!e.shiny }, "legacy");
    delete m.lv; delete m.mile;
  }
  writeJson(BOX, b);
  writeJson(FOLDERS, folders);
}
const migrate = () => { migrateBox(); migrateLevels(); };

const monOf = (b, uid) => b.mons.find((m) => m.uid === uid);
// (an individual whose sprite isn't downloaded yet still shows: name from the Pokédex, no picture)
const monView = (m) => {
  const sp = loadSprite(m.id, m.shiny) || { id: m.id, shiny: !!m.shiny, name: readJson(DEX, {})[m.id]?.name || `#${m.id}`, types: [], gif: null };
  return { ...sp, uid: m.uid, xp: m.xp || 0, folder: m.folder || null, ...lvView(m) };
};

// folders.json mirror of the folder's individual (the Neovim CVIM reads / levels this)
function mirror(cwd, m) {
  updateJson(FOLDERS, (t) => {
    if (!m) { if (t[cwd]) { delete t[cwd].id; delete t[cwd].uid; delete t[cwd].xp; delete t[cwd].since_evo; delete t[cwd].final; } return; }
    t[cwd] = { ...(t[cwd] || {}), id: m.id, shiny: !!m.shiny, xp: m.xp || 0, since_evo: m.since_evo || 0, pinned: true, uid: m.uid,
      ...(m.final ? { final: true } : {}) };
    if (!m.final) delete t[cwd].final;
  });
}

// the Neovim CVIM may have levelled / evolved the partner since: take its progress
function reconcile(cwd) {
  const rec = readJson(FOLDERS, {})[cwd];
  if (!rec?.uid) return;
  updateBox((b) => {
    const m = monOf(b, rec.uid);
    if (!m || m.folder !== cwd) return;
    if ((rec.xp || 0) > (m.xp || 0) || (rec.id && rec.id !== m.id)) {
      Object.assign(m, { id: rec.id, xp: rec.xp || 0, since_evo: rec.since_evo || 0 });
      if (rec.final) m.final = true;
    }
  });
}

// the folder's partner, or { choose: true } when it has none (new folder / given away)
async function assign(cwd) {
  migrate();
  reconcile(cwd);
  const b = readBox();
  const m = b.mons.find((x) => x.folder === cwd);
  if (!m) return { choose: true };
  if (!loadSprite(m.id, m.shiny)) await fetchPy([String(m.id), ...(m.shiny ? ["shiny"] : [])]);
  if (!loadSprite(m.id, m.shiny)) return null; // offline and not cached: no partner this time
  fetchEvo(m.id); // how it evolves, ahead of its first finish here (#74)
  const v = monView(m);
  recordDex(v);
  return v;
}

function progress(cwd) {
  const m = readBox().mons.find((x) => x.folder === cwd);
  return m ? { xp: m.xp || 0, uid: m.uid, ...lvView(m) } : { xp: 0, lv: null, final: false, next: null };
}
// the level of a folder's partner (catch bonus, PKM-21 rule 6), 0 without one
const levelAt = (cwd) => { const m = cwd && readBox().mons.find((x) => x.folder === cwd); return m ? lvOf(m) : 0; };

// ── the first partner: 3 starters (different first types, unevolved, not legendary — pokeapi.cjs
// starter), offered once while the box is empty ─────────────────────────────────────────────
const boxEmpty = () => readBox().mons.length === 0;
const starterSet = () => ({ set: readJson(STARTER, {}).set || [] });
let filling = null;
// downloads what's missing, all at once (~5 s); a repeated first type is fetched again
function fillStarter(onProgress = () => {}) {
  if (!filling) {
    filling = (async () => {
      let tries = 0;
      while (boxEmpty() && starterSet().set.length < CHOICES && tries++ < 4) {
        let t = starterSet();
        const avoid = t.set.map((c) => loadSprite(c.id, c.shiny)?.types?.[0]).filter(Boolean);
        const paths = await Promise.all(Array.from({ length: CHOICES - t.set.length }, () => fetchPy(["starter", ...avoid])));
        let added = 0;
        for (const p of paths) {
          const data = p && readJson(p, null);
          if (!data) continue;
          t = starterSet();
          const type = loadSprite(data.id, data.shiny)?.types?.[0];
          if (t.set.length >= CHOICES || t.set.some((c) => c.id === data.id || loadSprite(c.id, c.shiny)?.types?.[0] === type)) continue;
          t.set.push({ id: data.id, shiny: !!data.shiny });
          writeJson(STARTER, t);
          onProgress(t.set.length);
          added++;
        }
        if (!added && paths.every((p) => !p)) break; // offline: try again later
      }
      return starterSet();
    })().finally(() => { filling = null; });
  }
  return filling;
}

// what the choose dialog shows for a folder
function options(cwd) {
  migrate();
  const b = readBox();
  const t = starterSet();
  const folders = readJson(FOLDERS, {});
  const cur = b.mons.find((m) => m.folder === cwd);
  const view = (m) => monView(m);
  return {
    // only while the box is empty (your very first partner)
    starter: b.mons.length ? null : { set: t.set.map((c) => loadSprite(c.id, c.shiny)).filter(Boolean), ready: t.set.length >= CHOICES, total: CHOICES },
    current: cur ? view(cur) : null,
    resting: b.mons.filter((m) => !m.folder).map(view).filter(Boolean),
    // partners of other folders (taking one leaves that folder without a partner)
    others: b.mons.filter((m) => m.folder && m.folder !== cwd).map((m) => {
      const v = view(m);
      return v && { ...v, folderName: path.basename(m.folder), folderGone: !folders[m.folder] };
    }).filter(Boolean),
  };
}

// take a partner for the folder: { starter: id } (first partner) or { uid } (resting / another folder's)
function take(cwd, { starter: starterId, uid }) {
  migrate();
  let taken, freed = null;
  updateBox((b) => {
    let m;
    if (starterId != null) {
      const c = starterSet().set.find((x) => x.id === Number(starterId));
      if (!c || b.mons.length) throw new Error("not a starter (only for the first partner)");
      const sp = loadSprite(c.id, c.shiny);
      if (!sp) throw new Error("not downloaded");
      m = addMon(b, sp, "starter");
    } else {
      m = monOf(b, Number(uid));
      if (!m) throw new Error("no such Pokémon");
      if (m.folder && m.folder !== cwd) freed = m.folder;
    }
    for (const x of b.mons) if (x.folder === cwd && x !== m) x.folder = null; // the old partner rests
    // moved to another folder than the last one it worked in: a trade evolution opens on its first finish here (PKM-21 rule 3)
    if (m.last_folder && m.last_folder !== cwd) m.traded = true;
    m.folder = cwd;
    m.last_folder = cwd;
    taken = m;
  });
  if (freed) mirror(freed, null);
  mirror(cwd, taken);
  if (!loadSprite(taken.id, taken.shiny)) {
    // not downloaded yet: the UI waits for partner_state (assign fetches it)
    return { partner: { ...monView(taken), pending: true }, freed };
  }
  const v = monView(taken);
  recordDex(v);
  return { partner: v, freed };
}

// a wild one caught: a new individual, resting in the box — marked new until you look at it in
// the Pokédex (#10). true = a species never caught before (#72)
function addCaught(sprite) {
  migrate();
  // the catch log (#44): the folder it showed up in and whose task it was (from now on; older ones have none)
  updateBox((b) => { Object.assign(addMon(b, sprite, "wild"), { new: true, ...(sprite.caughtIn ? { caught_in: sprite.caughtIn } : {}), ...(sprite.caughtBy ? { caught_by: sprite.caughtBy } : {}) }); });
  return recordCaught(sprite);
}

// the Pokédex showed this species: its new individuals aren't new any more
function viewed(id) {
  let n = 0;
  updateBox((b) => { for (const m of b.mons) if (m.id === Number(id) && m.new) { delete m.new; n++; } });
  return n;
}

// "내 포켓몬" (#27): every individual — in the box or a folder's partner — with its EXP and where it is
const dexName = (id) => readJson(DEX, {})[id]?.name || `#${id}`;
function boxList(cwd) {
  migrate();
  const folders = readJson(FOLDERS, {});
  return readBox().mons.map((m) => {
    const v = monView(m);
    return { uid: m.uid, id: m.id, shiny: !!m.shiny, name: v.name, gif: v.gif, types: v.types || [], xp: m.xp || 0,
      lv: v.lv, final: v.final, next: v.next, how: m.how || null, at: m.at || null, new: !!m.new,
      caughtIn: m.caught_in ? path.basename(m.caught_in) : null, caughtBy: m.caught_by || null,
      evo: (m.evo || []).map((e) => ({ from: dexName(e.from), to: dexName(e.to), at: e.at })),
      folder: !m.folder ? null : m.folder === cwd ? "here" : path.basename(m.folder), folderGone: !!m.folder && !folders[m.folder] };
  });
}

function dex() {
  migrate();
  const t = readJson(DEX, {});
  const owned = new Map(); // species -> individuals in the box
  const fresh = new Map(); // species -> new (not looked at) individuals
  const caughtAt = new Map(), partnered = new Map(); // species -> latest catch (epoch s) / partners (dex search, #21)
  const mons = readBox().mons;
  for (const m of mons) {
    owned.set(m.id, (owned.get(m.id) || 0) + 1);
    if (m.new) fresh.set(m.id, (fresh.get(m.id) || 0) + 1);
    if (m.how !== "legacy" && (m.at || 0) > (caughtAt.get(m.id) || 0)) caughtAt.set(m.id, m.at);
    if (m.folder) partnered.set(m.id, (partnered.get(m.id) || 0) + 1);
  }
  const entries = Object.entries(t).map(([id, e]) => {
    const n = Number(id);
    const gif = [e.shiny && spriteBase(n, true), spriteBase(n, false)].filter(Boolean).map((b) => b + ".gif").find((f) => fs.existsSync(f)) || null;
    return { id: n, name: e.name, count: e.count || 1, shiny: !!e.shiny, caught: e.caught !== false, first: e.first, types: e.types || [], gif,
      owned: owned.get(n) || 0, fresh: fresh.get(n) || 0, caughtAt: caughtAt.get(n) || null, partner: partnered.get(n) || 0 };
  }).sort((a, b) => a.id - b.id);
  // the "새로 잡은" row: wild catches of the last 24 hours, newest first — like Pokémon GO's blue
  // background for the day's catches; whether you've looked at them is the NEW badge, not this (#18)
  const since = now() - RECENT_HOURS * 3600;
  const recent = mons.filter((m) => m.how === "wild" && (m.at || 0) >= since).sort((a, b) => (b.at || 0) - (a.at || 0) || b.uid - a.uid).slice(0, 60)
    .map((m) => ({ uid: m.uid, id: m.id, shiny: !!m.shiny, at: m.at, new: !!m.new, folder: m.folder || null }));
  return { entries, recent, recentHours: RECENT_HOURS, total: 649, caught: entries.filter((e) => e.caught).length, shiny: entries.filter((e) => e.shiny).length };
}

// the next stages' pictures, fetched one finish early so the evolution itself is instant (~10 s)
function prefetchOpen(m, trade) {
  const e = evoOf(m.id);
  if (!e || m.final) return;
  const soon = { ...m, lv: Math.min(MAX_LV, lvOf(m) + 2), friend: (m.friend || 0) + 1 };
  for (const o of e.next) if (open(o, soon, trade) && !loadSprite(o.to, m.shiny)) fetchPy([String(o.to), ...(m.shiny ? ["shiny"] : [])]);
}

// a task finished in this folder (#74, PKM-21): its partner gets +2 levels (+1 after its last form),
// one more finish together (friendship), a ₽20 milestone every 10 levels — then maybe evolves: any
// next stage that is open now (two or more: one at random), as often as they keep opening (a high
// level after the move from EXP). Only one call per individual evolves at a time (#12); offline (no
// facts / no picture) it keeps its level and tries again on the next finish (PKM-04 rule 6).
const evolving = new Set(); // uid
async function onDone(cwd) {
  let m, miles = [], trade = false;
  updateBox((b) => {
    m = b.mons.find((x) => x.folder === cwd);
    if (!m) return;
    m.xp = (m.xp || 0) + 1; // the old EXP (folders.json's mirror, PKM-17)
    const before = lvOf(m);
    if (!m.final && isFinal(m)) m.final = true;
    m.lv = Math.min(MAX_LV, before + (m.final ? 1 : 2));
    m.friend = (m.friend || 0) + 1;
    miles = milesOf(m, before);
    trade = !!m.traded;
    delete m.traded; // the first finish after the move only
  });
  if (!m) return { evolved: null, miles: [] };
  mirror(cwd, m);
  return { ...(await evolveNow(m.uid, trade)), miles };
}
// milestones crossed going from one level to another (each once an individual: m.mile)
function milesOf(m, before) {
  const out = [];
  for (let t = (Math.floor(before / 10) + 1) * 10; t <= lvOf(m); t += 10) if (t > (m.mile || 0)) { out.push(t); m.mile = t; }
  return out;
}
// 🍬 이상한사탕 (#76, PKM-23 rule 2): Lv +1 for any individual below Lv 100 — and it evolves if that opens
// a next stage (a level one; friendship and trades come from working together)
const candyOk = (uid) => { const m = monOf(readBox(), Number(uid)); return !!m && lvOf(m) < MAX_LV; };
async function candy(uid) {
  let m, miles = [];
  updateBox((b) => {
    m = monOf(b, Number(uid));
    if (!m || lvOf(m) >= MAX_LV) { m = null; return; }
    const before = lvOf(m);
    m.lv = before + 1;
    miles = milesOf(m, before);
  });
  if (!m) return null;
  if (m.folder) mirror(m.folder, m);
  const r = await evolveNow(m.uid, false);
  const x = monOf(readBox(), m.uid);
  return { ...r, miles, uid: m.uid, folder: x?.folder || null, ...lvView(x || m) };
}
// any next stage open now: evolve (one at random), again while they keep opening
async function evolveNow(uid, trade) {
  let m = monOf(readBox(), uid);
  if (!m || isFinal(m) || evolving.has(m.uid)) return { evolved: null };
  evolving.add(m.uid);
  const first = loadSprite(m.id, m.shiny);
  let to = null;
  try {
    for (;;) {
      if (!evoOf(m.id)) await fetchPy(["evo", String(m.id)]); // "" offline: try again next time
      const e = evoOf(m.id);
      if (!e) break;
      if (!e.next.length) { updateBox((b) => { const x = monOf(b, m.uid); if (x && x.id === m.id) x.final = true; m = x || m; }); break; }
      const ready = e.next.filter((o) => open(o, m, trade));
      if (!ready.length) { prefetchOpen(m, false); break; }
      const pick = ready[Math.floor(Math.random() * ready.length)];
      let next = loadSprite(pick.to, m.shiny);
      if (!next) { await fetchPy([String(pick.to), ...(m.shiny ? ["shiny"] : [])]); next = loadSprite(pick.to, m.shiny); }
      if (!next) break; // its picture couldn't be fetched: next finish
      let moved = false;
      updateBox((b) => {
        const x = monOf(b, m.uid);
        if (x && x.id === m.id) {
          (x.evo ||= []).push({ from: x.id, to: next.id, at: now() }); // evolution history (#44)
          x.id = next.id;
          moved = true;
        }
        m = x || m;
      });
      if (!moved) break;
      to = next;
      trade = false; // a trade opens one evolution
    }
  } finally { evolving.delete(m.uid); }
  if (m.folder) mirror(m.folder, m);
  if (!to) return { evolved: null };
  recordDex(to);
  return { evolved: to, from: first };
}

module.exports = { assign, options, take, fillStarter, addCaught, viewed, boxList, onDone, candy, candyOk, progress, levelAt, dex, fetchPy, loadSprite, recordSeen, migrate, fetchEvo, EVOLVE_EVERY, MAX_LV };
