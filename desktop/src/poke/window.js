// 포켓몬 창 (PKM-09 · APP-22 rule 10, #113 P2): 🏠 홈 · 🌟 파트너 고르기 · 📕 도감 · 🎒 내 포켓몬 · ⭐ 파티 · 🛒 상점 · 👜 가방
// in a window of its own (poke.html) — it opens with no terminal window (APP-22 rule 8) and moves by macOS's title bar
// (rule 7). Was a cover over the main window (src/main.js, #29 … #107); the screens are drawn as before. "This tab" is
// the one on screen in the main window, as the main process knows it (activeWs, rule 2): its folder's name and partner
// come with poke_state / "poke-tab". The page may call only its own short list of commands (pokeCommands — POL-SEC-02).
import { invoke, listen } from "../host.js";
import { josa } from "../wild.js";
import { pkCard, lvLine } from "./card.js";
import { TYPE_ICON } from "./types.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const base = (p) => p.split("/").filter(Boolean).pop() || p;

// 테마 (APP-20): the main process sets macOS's appearance for the app (settings.theme) — follow it
const darkMedia = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => { document.documentElement.dataset.theme = darkMedia.matches ? "dark" : "light"; };
applyTheme();
darkMedia.addEventListener("change", applyTheme);

let tab = null; // this tab: { ws, folder, partner: { id, uid, name, shiny, lv } | null } — null with no tab open
let test = null; // test mode only: { ui_scenes, … }

// 알림 (PKM-09 rule 6): in this window — bought, used, burning
function toast(msg, ms = 1800) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

// the 5-hour / weekly windows (홈's limits): one still running, and the time to its reset
const live = (w) => w && (w.resets_at == null || w.resets_at * 1000 > Date.now());
function untilReset(epoch) {
  if (typeof epoch !== "number") return "";
  const s = epoch - Date.now() / 1000;
  if (s <= 0) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h >= 24) return ` ↻${Math.floor(h / 24)}d${h % 24}h`;
  return h > 0 ? ` ↻${h}h${String(m).padStart(2, "0")}m` : ` ↻${m}m`;
}

// ── choosing a partner (#29: a view of the Pokémon window — 🌟 파트너 고르기; box rules in
// electron/core/partner.cjs): the first partner's starters (once, empty box) · a resting one from the
// box · another folder's partner. Same cards, preview and button as 내 포켓몬. Opened by the user only
// (the partner pane's [파트너 고르기] · 🔄) — never by itself (#113 A8, PKM-11 rule 1)
let chooseSlow = null;
// today's starters slow to come (PokéAPI): say so after 30 s
function chooseWatch(o) {
  clearTimeout(chooseSlow);
  if (o?.starterLoading) chooseSlow = setTimeout(() => { if (dexState?.view === "choose") { dexState.chooseNote = "PokéAPI 응답이 느려요 — 박스의 포켓몬을 고르거나, 나중에 다시 열어도 돼요"; boxRender(); } }, 30000);
}
// new options while open (today's starters arriving)
function renderChoose(o) {
  if (dexState?.view !== "choose" || !o) return;
  dexState.chooseOpts = o;
  if (o.starter?.ready) dexState.chooseNote = "";
  boxRender();
  dexTitle();
}
// the cards of 🌟 파트너 고르기, in its three groups
function chooseItems(o) {
  const items = [];
  if (o.starter) {
    o.starter.set.forEach((c, i) => items.push({ ...c, kind: "starter", group: "starter", key: `s${i}`, n: i + 1 }));
    for (let i = o.starter.set.length; i < o.starter.total; i++) items.push({ kind: "loading", group: "starter" });
  }
  o.resting.forEach((m, i) => items.push({ ...m, kind: "rest", group: "rest", key: `r${i}`, folder: null }));
  o.others.forEach((m, i) => items.push({ ...m, kind: "other", group: "other", key: `o${i}`, folder: m.folderName }));
  return items;
}

// sprite data URLs, kept (the dialog redraws while today's candidates arrive)
const sprites = new Map();
function spriteUrl(gif) {
  if (!sprites.has(gif)) sprites.set(gif, invoke("sprite_b64", { path: gif }).then((b) => `data:image/gif;base64,${b}`).then(stillFrame).catch(() => null));
  return sprites.get(gif);
}
// UI scenes: the first frame only, so a capture is the same picture every run
async function stillFrame(url) {
  if (!test?.ui_scenes) return url;
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  return c.toDataURL("image/png");
}
// ── Pokédex (⌘D): every Pokémon of Gen I–V as a grid by region — caught in colour, seen as a
// silhouette, never met as "?" (no downloads for those). Like a "name them all" quiz board. ──
const REGIONS = [["관동", 1, 151], ["성도", 152, 251], ["호연", 252, 386], ["신오", 387, 493], ["하나", 494, 649]];
let dexState = null;

// "3분 전" for a catch time (epoch s)
function ago(at) {
  const s = Math.max(0, Date.now() / 1000 - (at || 0));
  return s < 60 ? "방금" : s < 3600 ? `${Math.floor(s / 60)}분 전` : s < 86400 ? `${Math.floor(s / 3600)}시간 전` : `${Math.floor(s / 86400)}일 전`;
}

// the window opens (or is asked again) on a view and a species: sel = the species to show first (a wild one just
// caught → "도감에서 보기", #9) · view: "home" | "choose" | "dex" | "box" | "party" | "shop" | "bag"; default the last
// of 도감 / 내 포켓몬. Also how the window follows this tab (APP-22 rule 2): the same view, drawn again
async function openDex(sel, view) {
  const d = await invoke("dex_list");
  const byNo = new Map(d.entries.map((e) => [e.id, e]));
  // where this tab could take each species from: resting / other folders / already its partner
  const opts = tab ? await invoke("partner_options").catch(() => null) : null;
  if (view === "choose" && !tab) view = undefined; // no tab: nothing to choose for
  // a new catch you haven't looked at comes first — in the "새로 잡은" row (zone "recent", ri = its
  // place there); otherwise the grid. The arrows move inside the zone the selection is in (#17)
  const ri = sel ? d.recent?.findIndex((m) => m.id === sel) ?? -1 : d.recent?.findIndex((m) => m.new) ?? -1;
  dexState = { ...d, byNo, opts, chooseOpts: view === "choose" ? opts : null, view: "dex", zone: ri >= 0 ? "recent" : "grid", ri: Math.max(0, ri),
    sel: sel || d.recent?.[ri]?.id || tab?.partner?.id || d.entries[0]?.id || 1 };
  coins = await invoke("economy_state").catch(() => coins);
  dexTitle();
  const nWild = (d.recent || []).filter((m) => m.how !== "egg").length, nEgg = (d.recent || []).length - nWild;
  $("#dex-regions").innerHTML = (nWild ? `<button data-a="new" class="new-tab">🆕 새로 잡은 <span class="dim">${nWild}</span></button>` : "")
    + (nEgg ? `<button data-a="hatched" class="new-tab">🥚 새로 부화한 <span class="dim">${nEgg}</span></button>` : "") // #89
    + REGIONS.map(([name, a, b]) => {
      const got = d.entries.filter((e) => e.caught && e.id >= a && e.id <= b).length;
      return `<button data-a="${a}">${name} <span class="dim">${got}/${b - a + 1}</span></button>`;
    }).join("")
    + `<span class="dex-search"><input id="dex-search" type="search" spellcheck="false" placeholder="🔍 검색 ( / )" value="${esc(dexQuery)}"
        title="${esc(DEX_SEARCH_HELP)}" /><span id="dex-found" class="dim"></span></span>`;
  const grid = $("#dex-grid");
  // the last 24 hours' catches, newest first (#10 #18): blue that fades with time (Pokémon GO);
  // yellow + NEW = not looked at yet
  const day = (d.recentHours || 24) * 3600;
  // two rows of the same kind: the day's catches, then the day's hatchlings (#89) — data-ri is the place in d.recent
  const recentCell = (m, i) => {
    const e = byNo.get(m.id);
    const fade = Math.max(0, Math.min(1, (Date.now() / 1000 - (m.at || 0)) / day)).toFixed(2);
    return `<div class="cell caught${m.new ? " new" : ""}" style="--age:${fade}" data-n="${m.id}" data-ri="${i}" title="${esc(e?.name || `#${m.id}`)} · ${ago(m.at)}${m.how === "egg" ? " · 알에서 부화" : ""}${m.folder ? " · 파트너" : ""}">`
      + (e?.gif ? `<img data-gif="${esc(e.gif)}" alt="" />` : `<span class="q"></span>`) + `<i class="no">${m.id}</i>${m.shiny ? '<i class="shiny">✨</i>' : ""}${m.new ? '<i class="pk-newb">NEW</i>' : ""}</div>`;
  };
  const rowOf = (how, id, title) => { const cells = (d.recent || []).map((m, i) => [m, i]).filter(([m]) => (m.how === "egg") === (how === "egg")); return cells.length ? `<h4 id="${id}">${title}</h4><div class="cells recent">${cells.map(([m, i]) => recentCell(m, i)).join("")}</div>` : ""; };
  const recent = rowOf("wild", "region-new", "🆕 새로 잡은 포켓몬") + rowOf("egg", "region-hatched", "🥚 새로 부화한 포켓몬");
  grid.innerHTML = recent + REGIONS.map(([name, a, b]) => {
    const cells = [];
    for (let n = a; n <= b; n++) {
      const e = byNo.get(n);
      const cls = !e ? "unknown" : e.caught ? "caught" : "seen";
      const mark = e?.owned > 1 ? `<i class="cnt">×${e.owned}</i>` : "";
      const star = e?.caught && e.shiny ? '<i class="shiny">✨</i>' : "";
      const me = tab?.partner?.id === n ? " partner" : "";
      const fresh = e?.fresh ? " new" : "";
      cells.push(`<div class="cell ${cls}${me}${fresh}" data-n="${n}" title="#${String(n).padStart(3, "0")}${e ? " " + esc(e.name) : ""}">`
        + (e?.gif ? `<img data-gif="${esc(e.gif)}" alt="" />` : `<span class="q">${e ? "" : "?"}</span>`) + `<i class="no">${n}</i>${mark}${star}${fresh ? '<i class="pk-newb">NEW</i>' : ""}</div>`);
    }
    return `<h4 id="region-${a}" data-name="${name}">${name}</h4><div class="cells" data-a="${a}">${cells.join("")}</div>`;
  }).join("") + `<div id="dex-empty" class="pk-empty" hidden></div>`;
  grid.querySelectorAll("img[data-gif]").forEach((img) => spriteUrl(img.dataset.gif).then((u) => { if (u) img.src = u; }));
  const want = view || (dexLastView === "box" && !sel ? "box" : "dex");
  if (want !== "dex") return dexView(want);
  viewChrome("dex");
  dexFilter();
  const d0 = dexState;
  if (d0.hits && !d0.hits.includes(d0.sel)) { d0.zone = "grid"; if (d0.hits.length) d0.sel = d0.hits[0]; }
  if (d0.zone === "recent") dexRecent(d0.ri); else dexSelect(d0.sel);
}

// while searching, ↑↓ go to the nearest shown cell above / below (the layout has gaps); null = none
function dexGeo(from, cells, dir) {
  const r = from.getBoundingClientRect();
  let best = null, score = Infinity;
  for (const c of cells) {
    const b = c.getBoundingClientRect();
    const dy = dir > 0 ? b.top - r.top : r.top - b.top;
    if (dy < r.height / 2) continue;
    const sc = dy * 1000 + Math.abs(b.left - r.left);
    if (sc < score) { score = sc; best = c; }
  }
  return best;
}
const shownCells = (sel) => [...document.querySelectorAll(sel)].filter((c) => !c.classList.contains("nomatch") && c.offsetParent);
// arrows while searching (only shown cells); false = not handled here
function dexKeyFiltered(k, e) {
  const d = dexState;
  const row = shownCells("#dex-grid .cells.recent .cell"), grid = shownCells("#dex-grid .cells:not(.recent) .cell");
  const cur = d.zone === "recent" ? $(`#dex-grid .cells.recent .cell[data-ri="${d.ri}"]`) : $(`#dex-grid .cells:not(.recent) .cell[data-n="${d.sel}"]`);
  const left = k === "ArrowLeft" || k === "h", right = k === "ArrowRight" || k === "l", up = k === "ArrowUp" || k === "k", down = k === "ArrowDown" || k === "j";
  if (!(left || right || up || down || k === "Home" || k === "End" || k === "Tab")) return false;
  if (d.zone === "recent" && row.length) {
    const i = Math.max(0, row.indexOf(cur));
    if (left || right) return dexRecent(Number(row[Math.max(0, Math.min(row.length - 1, i + (right ? 1 : -1)))].dataset.ri)), true;
    if (k === "Home" || k === "End") return dexRecent(Number(row[k === "Home" ? 0 : row.length - 1].dataset.ri)), true;
    const to = cur && dexGeo(cur, row, up ? -1 : 1);
    if (to) return dexRecent(Number(to.dataset.ri)), true;
    if (down) dexSelect(d.sel);
    return true;
  }
  if (!grid.length) return true;
  if (left || right || k === "Tab") return dexStep(right || (k === "Tab" && !e?.shiftKey) ? 1 : -1), true;
  if (k === "Home" || k === "End") return dexSelect(Number(grid[k === "Home" ? 0 : grid.length - 1].dataset.n)), true;
  const to = cur && dexGeo(cur, grid, up ? -1 : 1);
  if (to) dexSelect(Number(to.dataset.n));
  else if (up && row.length) { const back = row.find((c) => Number(c.dataset.ri) === d.ri) || row[0]; dexRecent(Number(back.dataset.ri)); $("#region-new")?.scrollIntoView({ block: "start" }); }
  return true;
}

// ── dex search (#21), Pokémon GO's search terms: "&" and, "," or, "!" not ─────────────────────
const DEX_SEARCH_HELP = "이름 일부 · 번호 25 · 범위 1-151 · 타입(불꽃/fire) · 지역(관동…) · new(안 본 것) · ✨/이로치 · 잡음 · 만남 · 못만남 · 파트너 · 전설 · 환상 · age0(24시간 안에 잡음)·age0-7\n& 그리고 · , 또는 · ! 제외  예) 불꽃,물&!잡음";
const TYPE_KO = { 노말: "normal", 불꽃: "fire", 물: "water", 풀: "grass", 전기: "electric", 얼음: "ice", 격투: "fighting", 독: "poison", 땅: "ground",
  비행: "flying", 에스퍼: "psychic", 벌레: "bug", 바위: "rock", 고스트: "ghost", 드래곤: "dragon", 악: "dark", 강철: "steel", 페어리: "fairy" };
let dexQuery = ""; // kept while the app runs (like GO — the main process keeps it while the window is closed), cleared with Esc in the box
const setQuery = (q) => { dexQuery = q; invoke("poke_keep", { query: q }).catch(() => {}); };
// legendary / mythical numbers #1–649 (PokéAPI is_legendary / is_mythical, 2026-10-04) — numbers only,
// so even ones never met can be found, like GO's "legendary" / "mythical" (#22)
const LEGENDARY = new Set([144, 145, 146, 150, 243, 244, 245, 249, 250, 377, 378, 379, 380, 381, 382, 383, 384, 480, 481, 482, 483, 484, 485, 486, 487, 488, 638, 639, 640, 641, 642, 643, 644, 645, 646]);
const MYTHICAL = new Set([151, 251, 385, 386, 489, 490, 491, 492, 493, 494, 647, 648, 649]);

// one term (no "!") against number n / entry e (undefined = never met)
function dexTerm(t, n, e) {
  t = t.toLowerCase();
  let m;
  if ((m = t.match(/^#?(\d+)$/))) return n === Number(m[1]);
  if ((m = t.match(/^#?(\d*)-(\d*)$/)) && (m[1] || m[2])) return n >= (Number(m[1]) || 1) && n <= (Number(m[2]) || 9999);
  if ((m = t.match(/^age(\d+)(?:-(\d*))?$/))) {
    if (!e?.caughtAt) return false;
    const age = Math.floor((Date.now() / 1000 - e.caughtAt) / 86400), lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : m[2] === "" ? Infinity : Number(m[2]);
    return age >= lo && age <= hi;
  }
  if (["new", "새", "새로"].includes(t)) return !!e?.fresh;
  if (["shiny", "✨", "이로치"].includes(t)) return !!e?.shiny;
  if (["caught", "잡음", "잡은"].includes(t)) return !!e?.caught;
  if (["seen", "만남", "만나기만"].includes(t)) return !!e && !e.caught;
  if (["unknown", "못만남", "?"].includes(t)) return !e;
  if (["partner", "파트너"].includes(t)) return !!e?.partner;
  if (["legendary", "전설"].includes(t)) return LEGENDARY.has(n);
  if (["졸업", "grad"].includes(t)) return !!e.grad; // 🎓 · 🥚 (#84, 내 포켓몬)
  if (["알", "egg"].includes(t)) return !!e.egg;
  if (["mythical", "환상"].includes(t)) return MYTHICAL.has(n);
  const region = REGIONS.find(([name]) => name === t);
  if (region) return n >= region[1] && n <= region[2];
  const type = TYPE_KO[t] || (TYPE_ICON[t] ? t : null);
  if (type) return !!e?.types?.includes(type);
  return !!e?.name && e.name.toLowerCase().includes(t);
}
function dexMatch(q, n, e) {
  return q.split("&").every((group) => {
    const ors = group.split(",").map((x) => x.trim()).filter(Boolean);
    return !ors.length || ors.some((t) => (t.startsWith("!") ? !dexTerm(t.slice(1).trim(), n, e) : dexTerm(t, n, e)));
  });
}
// a search shows only the results (#22, like Pokémon GO): matching cells, the regions that have any
// (with their count), the number on each cell; nothing found → what was searched + how to fix it.
// d.hits = matching numbers (null = no search)
function dexFilter() {
  const d = dexState;
  if (!d) return;
  const q = dexQuery.trim(), grid = $("#dex-grid");
  d.hits = q ? [] : null;
  grid.classList.toggle("filtering", !!q);
  for (let n = 1; n <= d.total; n++) {
    const ok = !q || dexMatch(q, n, d.byNo.get(n));
    if (q && ok) d.hits.push(n);
    for (const c of grid.querySelectorAll(`.cell[data-n="${n}"]`)) c.classList.toggle("nomatch", !ok);
  }
  for (const cells of grid.querySelectorAll(".cells")) {
    const shown = cells.querySelectorAll(".cell:not(.nomatch)").length, h = cells.previousElementSibling;
    cells.hidden = h.hidden = !!q && !shown;
    if (h.dataset.name) h.textContent = q ? `${h.dataset.name} ${shown}` : h.dataset.name;
  }
  const empty = $("#dex-empty");
  empty.hidden = !q || d.hits.length > 0;
  if (!empty.hidden) {
    empty.innerHTML = `<b>"${esc(q)}"</b>에 맞는 포켓몬이 없어요<button id="dex-clear">검색 지우기</button>`
      + `<div class="dim">${q.includes("&") || q.includes("!") ? "&amp; 조건을 하나 줄이거나 ! 를 빼 보세요 · " : ""}예) 불꽃 · 전설 · 잡음 · age0 · 1-151</div>`;
  }
  $(".dex-preview").style.visibility = empty.hidden ? "" : "hidden"; // nothing found: no stale preview
  // the region buttons follow the search: its results in each, none → can't be pressed (#24)
  for (const b of document.querySelectorAll("#dex-regions button[data-a]")) {
    const r = b.dataset.a === "new" || b.dataset.a === "hatched" ? null : REGIONS.find(([, a]) => String(a) === b.dataset.a);
    const n = !q ? null : r ? d.hits.filter((x) => x >= r[1] && x <= r[2]).length : shownCells(`#dex-grid #${b.dataset.a === "new" ? "region-new" : "region-hatched"} + .cells.recent .cell`).length;
    b.dataset.label ??= b.innerHTML;
    b.innerHTML = n == null ? b.dataset.label : `${b.dataset.label.replace(/<span class="dim">.*<\/span>/, "")}<span class="dim">${n}</span>`;
    b.disabled = n === 0;
  }
  $("#dex-found").textContent = q ? `${d.hits.length}종` : "";
}

// with a search: ←→ jump between results
function dexStep(dir) {
  const d = dexState, h = d.hits;
  if (!h?.length) return dexSelect(dir > 0 ? d.sel % d.total + 1 : (d.sel - 2 + d.total) % d.total + 1);
  const next = dir > 0 ? h.find((n) => n > d.sel) ?? h[0] : [...h].reverse().find((n) => n < d.sel) ?? h.at(-1);
  dexSelect(next);
}
function dexSearchKey(e) {
  const box = $("#dex-search");
  if (e.isComposing || e.keyCode === 229) return false; // Hangul being typed
  const boxView = dexState?.view !== "dex";
  if (e.key === "Escape") { if (box.value) { box.value = ""; setQuery(""); if (boxView) boxRender(); else dexFilter(); } else box.blur(); return true; }
  if (e.key === "Enter" || e.key === "ArrowDown") {
    box.blur();
    if (boxView) { boxSelect(0); return true; }
    if (dexState.hits?.length) dexSelect(dexState.hits.find((n) => n >= dexState.sel) ?? dexState.hits[0]);
    return true;
  }
  return false; // typing: the box gets it
}
// 🪙 포켓코인 (#72, PKM-18): the balance as the main process last told (economy_state / "economy") · 진행 (#88): the bag tab's 🥚
let coins = null, coinsShown = null, prog = null, lastHatch = null;
const won = (n) => Number(n || 0).toLocaleString("en-US");
const coinTxt = (n) => `${won(n)}코인`; // the coin amount in words — the 🪙 picture is only on the chip (#75)
// the pk-coin chip, left of ✕ on every tab — opens 🛒 상점 (#76)
const coinChip = () => (coins ? incenseChip() + `<button class="pk-coin" data-view="shop" title="포켓코인 — 작업을 끝낼 때마다 쌓여요 · 누르면 상점">🪙 ${won(coins.balance)}</button>` : "");
// 🪔 향 burning: a chip beside the coins, minutes left (#79)
const incenseLeft = () => (coins?.incenseUntil > Date.now() ? Math.ceil((coins.incenseUntil - Date.now()) / 60000) : 0);
const incenseChip = () => (incenseLeft() ? `<button class="pk-incense" data-view="bag" title="향이 켜져 있어요 — 야생 포켓몬이 두 배로 자주 나와요">🪔 ${incenseLeft()}분</button>` : "");function dexTitle() {
  const d = dexState;
  const owned = d.entries.reduce((n, e) => n + (e.owned || 0), 0);
  const fresh = d.entries.reduce((n, e) => n + (e.fresh || 0), 0);
  const n = d.box ? boxMons(d.box).length : owned, view = d.view || "dex";
  const on = (v) => (view === v ? ' class="on"' : "");
  const cur = d.chooseOpts?.current;
  $("#dex-title").innerHTML = `<span class="pk-tabs"><button data-view="home"${on("home")}>🏠 홈</button>${tab ? `<button data-view="choose"${on("choose")}>🌟 파트너 고르기</button>` : ""}`
    + `<button data-view="dex"${on("dex")}>📕 도감</button><button data-view="box"${on("box")}>🎒 내 포켓몬 <span class="dim">${n}</span></button><button data-view="party"${on("party")}>⭐ 파티</button>`
    + `<button data-view="shop"${on("shop")}>🛒 상점</button><button data-view="bag"${on("bag")}>👜 가방${coins?.bagN ? ` <span class="dim">${coins.bagN}</span>` : ""}${prog?.inc ? ' <span class="dim">· 🥚</span>' : ""}</button></span>`
    + (view === "choose" && tab ? `<span class="pk-sub">${esc(tab.folder)}의 파트너 — ${cur ? `지금 ${cur.shiny ? "✨" : ""}${esc(cur.name)} · Lv ${cur.lv ?? "?"}` : "아직 없어요"}</span>`
      + coinChip() + '<button class="pk-close" title="닫기 (Esc)">✕</button>' : `<span class="chip">잡음 ${d.caught}</span><span class="chip">만남 ${d.entries.length}</span>`
    + `<span class="chip">/ ${d.total}</span><span class="chip">✨ ${d.shiny}</span><span class="chip">📦 ${owned}마리</span>`
    + (fresh ? `<span class="chip new">NEW ${fresh}</span>` : "") + coinChip() + '<button class="pk-close" title="닫기 (Esc)">✕</button>');
  // the number changed while the window was open: bold for a moment
  const chip = $("#dex-title .pk-coin");
  if (chip && coinsShown != null && coins.balance !== coinsShown) { chip.classList.add("bump"); setTimeout(() => chip.classList.remove("bump"), 400); }
  if (coins) coinsShown = coins.balance;
}

// ── "내 포켓몬" (#27): every individual you have — in the box or a folder's partner — as cards,
// sorted (newest catch first by default), searched with the same terms, taken from the preview ──
let dexLastView = "dex";
let boxSort = (() => { try { const v = localStorage.getItem("tamer.box.sort") || "recent"; return v === "exp" ? "lv" : v; } catch { return "recent"; } })(); // "exp" (경험치) became "lv" (#74)
const BOX_SORTS = [["recent", "최근 잡은 순"], ["no", "번호"], ["name", "이름"], ["lv", "레벨"], ["partner", "파트너 먼저"]];
const HOW = { wild: "야생에서 잡음", starter: "첫 파트너", legacy: "이전 기록에서 옮김", egg: "알에서 부화" };

const HELP = {
  choose: "←→↑↓ 고르기 · 1·2·3 첫 파트너 · Enter 이 탭의 파트너로 · / 검색 · 한 마리는 한 폴더에만, 레벨은 포켓몬을 따라가요 · Esc 닫기",
  dex: "←→↑↓ 이동 · / 검색 · Tab 다음 만난 포켓몬 · Enter 이 탭의 파트너로(박스에 있으면) · M 내 포켓몬 · Esc 닫기",
  box: "←→↑↓ 이동 · / 검색 · Enter 이 탭의 파트너로 · M 도감 · Esc 닫기",
  home: "⌘P 홈 · S 상점 · I 가방 · M 내 포켓몬 · Esc 닫기 — 한도는 각 에이전트가 마지막으로 알려 준 값이에요",
  party: "파트너가 없는 폴더·Tamer 밖에서 끝낸 작업으로 파티가 차례로 한 마리씩 커요 · 최대 6마리 · Esc 닫기", // #107
  shop: "←→↑↓ 고르기 · 한 번 더 누르면(− +) 수 · Enter 사기 · I 가방 · Esc 닫기 — 1,000코인 이상은 두 번 눌러 사요",
  bag: "←→↑↓ 고르기 · Enter 쓰기 · S 상점 · Esc 닫기",
  pick: "←→↑↓ 고르기 · Enter 사탕 주기 · Esc 가방으로",
  pickStone: "←→↑↓ 고르기 · 오른쪽 갈래 버튼으로 진화 · Esc 가방으로", // 💎 (#93)
};
// the frame for a view: which list shows, the tool row, the hints
function viewChrome(v) {
  const w = $("#dex");
  w.classList.toggle("cardview", v !== "dex");
  w.classList.toggle("chooseview", v === "choose");
  w.classList.toggle("homeview", v === "home" || v === "party"); // 파티 (#107) is laid out like 홈
  w.classList.toggle("shopview", v === "shop" || v === "bag");
  $("#dex-take").hidden = v === "home" || v === "party";
  $("#dex-pos").textContent = "";
  $("#dex-grid").hidden = v !== "dex";
  $("#box-grid").hidden = v === "dex";
  $("#dex-help").textContent = HELP[v];
  $("#dex-from").innerHTML = "";
  $("#dex-take").className = "";
}
async function dexView(v) {
  const d = dexState;
  if (!d) return;
  d.view = v;
  d.stoneDone = null; // a stone's result shows only where it was used (#94)
  if (v !== "choose") { dexLastView = v; invoke("poke_keep", { view: v }).catch(() => {}); } // 파트너 고르기 opens for a reason; the window remembers the others
  viewChrome(v);
  if (v === "home") { dexTitle(); return homeRender(); }
  if (v === "party") { dexTitle(); return partyRender(); }
  if (v === "shop" || v === "bag") { d.pick = false; d.ii = v === "bag" ? null : 0; d.qty = 1; dexTitle(); return shopRender(); }
  if (v === "dex") {
    $(".dex-preview").style.visibility = "";
    dexFilter();
    if (d.zone === "recent") dexRecent(d.ri); else dexSelect(d.sel);
  } else {
    if (v === "box" && !d.box) d.box = await invoke("box_list").catch(() => []);
    if (v === "choose") {
      if (!d.chooseOpts && tab) d.chooseOpts = await invoke("partner_options").catch(() => null);
      chooseWatch(d.chooseOpts);
    }
    if (!$("#box-sort")) $(".dex-search").insertAdjacentHTML("afterbegin", `<select id="box-sort" title="정렬">${BOX_SORTS.map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select>`);
    $("#box-sort").value = boxSort;
    d.bi = 0;
    d.list = null;
    boxRender();
  }
  dexTitle();
}

// ── ⭐ 파티 (PKM-31, #107): up to 6 that grow in turn from finishes in folders without a partner — a tab's
// or one done outside Tamer (STA-23). Six slots (넣기 · 빼기 · 선두로), the box below to add from ──
async function partyRender() {
  const d = dexState;
  const [p, box] = await Promise.all([invoke("party_state").catch(() => null), d.box ? d.box : invoke("box_list").catch(() => [])]);
  if (dexState !== d || d.view !== "party" || !p) return;
  d.box = box; d.party = p;
  const inParty = new Set(p.list.map((m) => m.uid));
  const slots = Array.from({ length: p.max }, (_, i) => {
    const m = p.list[i];
    if (!m) return `<div class="pk-party-slot empty"><span class="dim">빈 칸</span></div>`;
    return `<div class="pk-party-slot${i === p.next ? " next" : ""}">${pkCard({ ...m, folder: m.folder ? base(m.folder) : null }, `p${i}`, { icons: TYPE_ICON, ago })}`
      + `<span class="pk-party-acts">${i ? `<button data-party-lead="${m.uid}">선두로</button>` : '<span class="dim">선두</span>'}<button data-party-out="${m.uid}">빼기</button></span>`
      + (i === p.next ? '<i class="pk-party-turn">다음 차례</i>' : "") + "</div>";
  }).join("");
  const cands = boxMons(box).filter((m) => !inParty.has(m.uid) && !(m.grad && m.lv >= 100));
  const full = p.list.length >= p.max;
  const recent = (p.recent || []).slice(0, 3).map((r) => `<li>${r.outside ? "밖에서" : "탭"} · ${esc(r.folder)} · +${r.coins || 0}${r.mon?.name ? ` · ${esc(r.mon.name)}${r.mon.lv ? ` Lv ${r.mon.lv}` : ""}` : ""}</li>`).join("");
  $("#box-grid").innerHTML = `<div class="pk-home pk-party">
    <p class="pk-party-about">파트너가 없는 폴더에서 끝낸 작업과 Tamer 밖(다른 터미널·Claude 앱·Codex 앱)에서 끝낸 작업은 파티가 <b>차례로 한 마리씩</b> 받아요. 폴더 파트너는 그 폴더 작업으로 따로 커요.</p>
    <div class="pk-party-slots">${slots}</div>
    ${recent ? `<ul class="pk-party-recent">${recent}</ul>` : ""}
    <h4>${full ? "파티가 찼어요 — 빼고 넣으세요" : "내 포켓몬에서 넣기"}</h4>
    <div class="pk-party-cands">${cands.length ? cands.map((m, i) => `<div class="pk-party-cand">${pkCard(m, `c${i}`, { icons: TYPE_ICON, ago })}<button data-party-in="${m.uid}"${full ? " disabled" : ""}>파티에 넣기</button></div>`).join("") : '<span class="dim">넣을 포켓몬이 없어요 — 작업을 끝내면 가끔 야생 포켓몬이 나타나요</span>'}</div>
  </div>`;
  $("#box-grid").querySelectorAll("img[data-gif]").forEach((img) => spriteUrl(img.dataset.gif).then((u) => { if (u) img.src = u; }));
  $(".dex-preview").style.visibility = "hidden"; // nothing picked here — the last view's Pokémon mustn't linger
}
async function partyChange(uids) {
  const v = await invoke("party_set", { uids }).catch(() => null);
  if (v && dexState?.view === "party") partyRender();
}
listen("party", () => { if (dexState?.view === "party") partyRender(); });
listen("party-done", () => { if (dexState?.view === "party") partyRender(); });

// ── 🏠 홈 (#44): this tab's partner (the preview), tasks finished today and in a row, the last 7
// days, and each agent's 5-hour / weekly limit as last reported (nothing new is measured here) ──
const HOME_AGENTS = [["claude", "✻ Claude Code"], ["codex", "◎ Codex"]];
async function homeRender() {
  const d = dexState;
  const [st, box, c, usage] = await Promise.all([invoke("home_state").catch(() => null), d.box ? d.box : invoke("box_list").catch(() => []), invoke("economy_state").catch(() => coins), invoke("poke_usage").catch(() => ({}))]);
  if (dexState !== d || d.view !== "home") return;
  d.box = box;
  if (c) { coins = c; dexTitle(); }
  // 🪙 today's coins (bonuses too) and how much of the day's ₽300 for finishes is left (#72)
  const coinBox = coins ? `<div class="pk-coins"><b>${coinTxt(coins.today.earned)}</b><span>오늘 번 코인 · ${coins.today.capLeft > 0 ? `상한까지 ${coinTxt(coins.today.capLeft)}` : "오늘 상한 · 보너스만"}</span></div>` : "";
  // the 시작 코인, once — until ✕ (#72, SCREENS_P3 S2)
  const band = coins?.start ? `<div class="pk-band"><span>🪙 포켓코인이 생겼어요 — 지난 완료 ${won(coins.start.n)}번으로 <b>${coinTxt(coins.start.amount)}</b> 받았어요 · 작업을 끝낼 때마다 쌓여요</span><button class="pk-band-go" data-view="shop">상점 보기</button><button class="pk-band-x" title="닫기" aria-label="안내 닫기">✕</button></div>` : "";
  const mine = box.find((m) => m.folder === "here");
  const max = Math.max(1, ...(st?.week || []).map((x) => x.n));
  const wd = ["일", "월", "화", "수", "목", "금", "토"];
  const week = (st?.week || []).map((x, i, a) => `<div class="pk-day${i === a.length - 1 ? " today" : ""}" title="${x.day} · ${x.n}번"><i style="height:${Math.round((x.n / max) * 100)}%"></i><span>${wd[new Date(`${x.day}T12:00`).getDay()]}</span></div>`).join("");
  const left = (w) => (w && live(w) ? Math.max(0, 100 - Math.round(w.pct)) : null);
  const meter = (label, w) => {
    const p = left(w);
    if (p == null) return `<div class="pk-meter none"><b>${label}</b><span class="dim">아직 값 없음</span></div>`;
    const lv = p <= 20 ? "low" : p <= 50 ? "mid" : "ok";
    return `<div class="pk-meter ${lv}"><b>${label}</b><span class="pk-bar"><i style="width:${p}%"></i></span><span>${p}% 남음</span><span class="dim">${untilReset(w.resets_at).replace(/^\s*↻/, "") ? `${untilReset(w.resets_at).replace(/^\s*↻/, "")} 뒤 회복` : ""}</span></div>`;
  };
  const agentsHtml = HOME_AGENTS.map(([k, name]) => { const l = usage?.[k] || {}; return (l.five_hour || l.seven_day) ? `<div class="pk-agent"><h5>${name}${l.model ? ` <span class="dim">${esc(l.model)}</span>` : ""}</h5>${meter("5시간", l.five_hour)}${meter("주간", l.seven_day)}</div>` : ""; }).join("");
  // ⭐ 연구 스탬프 (#82, PKM-24): a stamp for each day with a finish, 7 = a legend
  // 전설의 길 · 리서치 (#86): each generation's share and legends, the research's steps
  const lr = await invoke("legend_road").catch(() => null);
  const openL = (lr?.road || []).flatMap((g) => g.legends.filter((l) => l.open)), wantL = openL.filter((l) => !l.owned);
  const stp = coins?.stamps, legendName = (id) => openL.find((l) => l.id === id)?.name || `#${id}`;
  const stampHtml = stp ? `<section class="pk-stamps"><h4 class="pk-group">연구 스탬프<span class="dim">작업을 끝낸 날마다 하나 · ${stp.need}개면 대발견(전설 확정)</span></h4>
    <div class="pk-stamp">${Array.from({ length: stp.need }, (_, i) => stp.days[i] ? `<span class="on" title="${stp.days[i]}">${Number(stp.days[i].slice(5, 7))}/${Number(stp.days[i].slice(8))}</span>` : "<span></span>").join("")}
    <b>${stp.n >= stp.need ? "⭐ 대발견!" : `${stp.need - stp.n}개 남음`}</b></div>
    <p class="pk-note">다음 대발견: ${coins.legend ? `⭐ ${legendName(coins.legend)} (전설의 향)` : wantL.length ? `열린 전설 중 아직 없는 종 — ${wantL.map((l) => l.name).join("·")}` : `열린 전설 중 하나 — 두 번째 마리도 와요`}</p></section>` : "";
  const rs = lr?.research;
  const researchHtml = rs?.title ? `<section class="pk-research"><h4 class="pk-group">리서치<span class="dim">✦ ${esc(rs.title)} — 끝내면 ${esc(rs.name)}와 확정 조우 + 마스터볼</span></h4>
    ${rs.steps.map((st) => `<div class="pk-rstep${st.done ? " done" : ""}"><span>${st.done ? "✔" : "▸"} ${esc(st.text)}</span><span class="pk-bar"><i style="width:${Math.round((st.have / st.n) * 100)}%"></i></span><span>${st.have}/${st.n}</span></div>`).join("")}</section>`
    : rs && rs.finished ? '<section class="pk-research"><h4 class="pk-group">리서치<span class="dim">✔ 뮤 — 다음 리서치는 곧</span></h4></section>' : "";
  const roadHtml = lr?.road ? `<section class="pk-road"><h4 class="pk-group">전설의 길<span class="dim">세대 도감(일반종)을 50% 채우면 그 세대 전설, 80%면 대표 전설이 대발견에 열려요</span></h4>
    ${lr.road.map((g) => `<div class="pk-rgen"><b>${g.region}</b><span class="pk-bar"><i style="width:${Math.min(100, g.pct)}%"></i></span><span>${g.pct}%</span>
      <span class="dim">${[
        g.legends.some((l) => l.open) && `✔ ${g.legends.filter((l) => l.open).map((l) => `${l.owned ? "●" : ""}${esc(l.name)}`).join("·")}`,
        g.legends.some((l) => !l.open && !l.cover) && `50%: ${g.legends.filter((l) => !l.open && !l.cover).map((l) => esc(l.name)).join("·")}`,
        g.legends.some((l) => !l.open && l.cover) && `80%: ${g.legends.filter((l) => !l.open && l.cover).map((l) => esc(l.name)).join("·")}`,
      ].filter(Boolean).join(" · ")}</span></div>`).join("")}</section>` : "";
  // 🥚 the incubator (#85)
  const inc = await invoke("incubator_state").catch(() => null);
  const incHtml = inc ? `<section class="pk-inc"><h4 class="pk-group">부화기<span class="dim">어느 폴더든 작업을 끝낼 때마다 하나</span></h4>
    <div class="pk-inc-row"><i class="pk-egg${inc.active.kind === "egg2" ? " rare" : ""}"></i><b>${esc(inc.active.name)}</b><span class="pk-bar"><i style="width:${Math.round((inc.active.have / inc.active.need) * 100)}%"></i></span><span>${inc.active.have}/${inc.active.need}</span>${inc.waiting ? `<span class="dim">대기 ${inc.waiting}</span>` : ""}</div></section>` : "";
  if (dexState !== d || d.view !== "home") return;
  $("#box-grid").innerHTML = `<div class="pk-home">${band}
    <section class="pk-today"><div><b>${st?.today ?? 0}</b><span>오늘 끝낸 작업</span></div><div><b>${st?.streak ? `🔥 ${st.streak}` : "0"}</b><span>일 연속</span></div>${coinBox}
      <div class="pk-week" title="최근 7일 끝낸 작업">${week}</div></section>${incHtml}${stampHtml}${researchHtml}${roadHtml}
    <section><h4 class="pk-group">사용 한도<span class="dim">남은 비율 · 마지막으로 알려 준 값</span></h4>${agentsHtml || '<p class="pk-note">아직 한도 정보가 없어요 — Claude Code나 Codex가 한 번 응답하면 보여요</p>'}</section>
  </div>`;
  $("#dex-found").textContent = "";
  // the preview: this tab's partner
  const img = $("#dex-img");
  $(".dex-preview").style.visibility = "";
  if (!mine) {
    img.removeAttribute("src");
    $("#dex-name").textContent = tab ? "파트너가 없어요" : "열린 탭이 없어요";
    $("#dex-meta").innerHTML = tab ? "🌟 파트너 고르기에서 데려오거나, 작업을 끝내면 나타나는 야생 포켓몬을 잡아요" : "폴더를 열면 그 폴더의 파트너가 여기 보여요";
    return;
  }
  if (mine.gif) spriteUrl(mine.gif).then(async (u) => { if (!u || dexState?.view !== "home") return; img.src = u; await img.decode().catch(() => {}); img.style.width = `${img.naturalWidth * Math.max(1, Math.min(4, Math.floor(200 / img.naturalWidth)))}px`; });
  $("#dex-name").textContent = `#${String(mine.id).padStart(3, "0")} ${mine.shiny ? "✨" : ""}${mine.name}`;
  $("#dex-meta").innerHTML = `${esc(tab.folder)}의 파트너<br>${esc(lvLine(mine))}`;
}

// ── 🛒 상점 · 👜 가방 (#76, PKM-22·23, SCREENS_P3 S3·S4): items as cards (pk-item), the preview buys
// (pk-qty · pk-buy = #dex-take) or uses them. The main process checks every purchase and use ──
const ITEM_ICON = { great: '<i class="pk-ball great"></i>', ultra: '<i class="pk-ball ultra"></i>', master: '<i class="pk-ball master"></i>', candy: "🍬", incense: "🪔", legend: "🏮", egg: '<i class="pk-egg"></i>', egg2: '<i class="pk-egg rare"></i>', stone: "💎", charm: "✨" };
const ITEM_GROUPS = [["ball", "볼"], ["grow", "성장"], ["explore", "탐험"], ["egg", "알"], ["special", "특별"]]; // 특별: 빛나는부적 (#93)
let shopSt = null; // the last shop_state
const shopView = () => dexView("shop");
const minsLeft = (until) => Math.max(1, Math.ceil((until - Date.now()) / 60000));
async function shopRender() {
  const d = dexState;
  const st = await invoke("shop_state").catch(() => null);
  if (d.view === "bag") d.box ||= await invoke("box_list").catch(() => []); // this tab's partner, its level now
  if (!st || dexState !== d || (d.view !== "shop" && d.view !== "bag")) return;
  shopSt = st;
  $(".dex-preview").style.visibility = "";
  $("#dex-help").textContent = HELP[d.pick === "stone" ? "pickStone" : d.pick ? "pick" : d.view];
  if (d.pick) return pickRender();
  const grid = $("#box-grid");
  const card = (it, i) => {
    const off = d.view === "shop" && (it.left === 0 || it.price > st.balance);
    const tail = d.view === "bag" ? (it.once ? "늘 효과" : `×${st.bag[it.id]}${it.id === "legend" && coins?.legend ? " · 걸어 둠" : ""}`)
      : it.left === 0 ? (it.once ? "가짐 ✔" : "이번 주 샀음") : coinTxt(it.price);
    const on = it.id === "incense" && st.incenseUntil;
    return `<div class="pk-item${off ? " off" : ""}" data-i="${i}">${on ? '<span class="pk-on" title="켜져 있어요"></span>' : ""}<span class="pk-icon">${ITEM_ICON[it.id] || "🎁"}</span><b>${esc(it.name)}</b><span class="dim">${esc(it.effect)}</span><span class="pk-price">${tail}</span></div>`;
  };
  if (d.view === "shop") {
    d.list = st.items;
    grid.innerHTML = ITEM_GROUPS.map(([g, title]) => {
      const items = st.items.map((it, i) => [it, i]).filter(([it]) => it.group === g);
      return items.length ? `<h4 class="pk-group">${title}</h4>${items.map(([it, i]) => card(it, i)).join("")}` : "";
    }).join("");
  } else {
    // the incubator's waiting eggs come first in the list (cards in its section, #88), then the bag's items
    const q = (st.incubator?.queue || []).map((e, k) => ({ id: "incq", group: "incq", pos: k + 1, ...e }));
    const items = st.items.filter((it) => st.bag[it.id]);
    d.list = [...q, ...items];
    if (d.ii == null) d.ii = items.length ? q.length : 0; // opening the bag: its first item, not the incubator's line
    const fx = [st.incenseUntil && `🪔 향 ${minsLeft(st.incenseUntil)}분 남음`, st.bag.charm && "✨ 빛나는부적"].filter(Boolean); // the incubator has its own section now
    const fxHtml = fx.length ? `<div class="pk-effects">켜진 효과: ${fx.join(" · ")}</div>` : "";
    grid.innerHTML = incubatorHtml(st, q) + fxHtml + (items.length ? items.map((it, k) => card(it, q.length + k)).join("") + '<p class="pk-note">볼은 야생 포켓몬이 나오면 카드에서 골라 던져요</p>'
      : '<p class="pk-empty">가방이 비었어요 — 🛒 상점에서 사요 <button class="pk-goods">상점 열기</button></p>');
  }
  $("#dex-found").textContent = "";
  if (!d.list.length) { itemPreview(null); return; }
  itemSelect(Math.min(d.ii || 0, d.list.length - 1));
}
// 🥚 부화기 섹션 (#88, PKM-25 rules 8–9, SCREENS_P3 S11): the egg in it (big), its line (cards to pick → 먼저 부화),
// a hatch of the last 30 minutes; empty → the eggs in the bag to put in, or the shop
const HATCH_SHOWN = 30 * 60000;
function incubatorHtml(st, q) {
  const a = st.incubator?.active, egg = (kind, big) => `<i class="pk-egg${big ? " big" : ""}${kind === "egg2" ? " rare" : ""}"></i>`;
  const head = '<h4 class="pk-group">🥚 부화기<span class="dim">어느 폴더든 작업을 끝낼 때마다 하나 · 한 번에 하나</span></h4>';
  const born = lastHatch && Date.now() - lastHatch.at < HATCH_SHOWN
    ? `<div class="pk-inc-born">🐣 <b>${esc(`${lastHatch.shiny ? "✨" : ""}${josa(lastHatch.name, "이", "가")}`)} 태어났어요!</b><span class="dim">내 포켓몬에 NEW · 도감 "🥚 새로 부화한" 줄</span><button data-view="box">보기</button></div>` : "";
  if (!a) {
    const eggs = [["egg", "알"], ["egg2", "희귀 알"]].filter(([k]) => st.bag[k] > 0);
    return `<section class="pk-incsec">${head}${born}<p class="pk-inc-empty">부화기가 비었어요 — ${eggs.length
      ? `가방에 ${eggs.map(([k, n]) => `${n} ${st.bag[k]}개`).join(" · ")} ${eggs.map(([k, n]) => `<button data-incadd="${k}">${n} 넣기</button>`).join("")}`
      : '알은 🛒 상점에서 (알 500 · 희귀 알 2,000) <button class="pk-goods">상점 열기</button>'}</p></section>`;
  }
  const left = a.need - a.have, soon = left === 1;
  const line = q.map((e, i) => `<div class="pk-item pk-incq" data-i="${i}" title="${esc(e.name)} — 고르면 [먼저 부화]"><b>${e.pos}</b>${egg(e.kind)}<span>${esc(e.name)}</span><span class="dim">${e.have}/${e.need}</span></div>`).join("");
  return `<section class="pk-incsec">${head}${born}<div class="pk-inc-now${soon ? " soon" : ""}">${egg(a.kind, true)}<div class="pk-inc-what"><b>${esc(a.name)}</b>
    <span class="pk-bar"><i style="width:${Math.round((a.have / a.need) * 100)}%"></i></span><span class="${soon ? "pk-soon" : "dim"}">${a.have}/${a.need} · ${soon ? "곧 태어나요 — 작업 1번" : `작업 ${left}번 남음`}</span></div>
    ${line ? `<div class="pk-incq-row"><span class="dim">차례</span>${line}</div>` : ""}</div>
    <p class="pk-note">최근 태어난 포켓몬은 📕 도감 "🥚 새로 부화한" 줄에서</p></section>`;
}
function itemSelect(i) {
  const d = dexState;
  if (!d?.list?.length) return;
  if (i !== d.ii) { d.qty = 1; d.askBuy = false; }
  d.ii = Math.max(0, Math.min(d.list.length - 1, i));
  for (const c of document.querySelectorAll("#box-grid .pk-item.sel")) c.classList.remove("sel");
  const c = $(`#box-grid .pk-item[data-i="${d.ii}"]`);
  c?.classList.add("sel");
  c?.scrollIntoView({ block: "nearest" });
  itemPreview(d.list[d.ii]);
  $("#dex-pos").textContent = `${d.ii + 1} / ${d.list.length}`;
}
// the preview: picture, what it does, how many you have — and the shop's count and price, or the bag's use
function itemPreview(it, note = "") {
  const d = dexState, st = shopSt, b = $("#dex-take"), img = $("#dex-img");
  img.removeAttribute("src"); img.style.width = "";
  $("#dex-from").innerHTML = note ? `<p class="pk-err">${esc(note)}</p>` : "";
  if (!it) { $("#dex-name").textContent = ""; $("#dex-meta").innerHTML = ""; b.hidden = true; return; }
  $("#dex-name").innerHTML = `<span class="pk-icon big">${ITEM_ICON[it.id] || "🎁"}</span>${esc(it.name)}`;
  const have = st.bag[it.id] || 0;
  b.hidden = false; b.disabled = false; b.className = "";
  if (d.view === "shop") {
    const max = it.many ? Math.max(1, Math.min(99, Math.floor(st.balance / it.price))) : 1;
    d.qty = Math.max(1, Math.min(d.qty || 1, max));
    const cost = it.price * d.qty;
    $("#dex-meta").innerHTML = `${esc(it.effect)}<br>가진 수 ${have}${it.weekly ? ` · 한 주에 ${it.weekly}개(월요일에 다시)` : ""}`
      + (it.many ? `<br><span class="pk-qty"><button data-q="-1" title="−">−</button><b>${d.qty}</b><button data-q="1" title="+">+</button></span><br>합계 ${coinTxt(cost)}` : "");
    if (it.once && it.left === 0) { $("#dex-meta").innerHTML += "<br>가지고 있어요 — 늘 효과"; b.hidden = true; return; } // 빛나는부적: once (#93)
    if (it.left === 0) { b.disabled = true; b.textContent = "이번 주 샀음 · 월요일에 다시"; }
    else if (cost > st.balance) { b.disabled = true; b.textContent = `${coinTxt(cost - st.balance)} 더 필요`; }
    else if (cost >= st.confirmAt && d.askBuy) { b.className = "confirm"; b.textContent = `한 번 더 눌러 사기 · ${coinTxt(cost)}`; }
    else b.textContent = `사기 · ${coinTxt(cost)}`;
    return;
  }
  // 👜 the bag
  if (it.id === "incq") { // 🥚 a waiting egg (#88): 먼저 부화 — the one in the incubator goes back to the front of the line
    const a = st.incubator?.active;
    $("#dex-name").innerHTML = `<span class="pk-icon big"><i class="pk-egg${it.kind === "egg2" ? " rare" : ""}"></i></span>${esc(it.name)}`;
    $("#dex-meta").innerHTML = `부화기 차례 ${it.pos} · ${it.have}/${it.need} · 작업 ${it.need - it.have}번${it.kind === "egg2" ? " · 이로치 ×2" : ""}`
      + (a ? `<br>지금 부화 중: ${esc(a.name)} ${a.have}/${a.need} — 먼저 부화하면 차례 1로(진행은 그대로)` : "");
    b.textContent = "먼저 부화";
    return;
  }
  if (it.group === "ball") { $("#dex-meta").innerHTML = `${esc(it.effect)}<br>가진 수 ${have}<br>야생 포켓몬이 나오면 카드에서 골라 던져요`; b.hidden = true; return; }
  if (it.id === "charm") { $("#dex-meta").innerHTML = "가지고 있으면 늘 효과 — 야생·알·대발견·리서치의 이로치 확률 1/64 → 1/32(희귀 알 1/16)"; b.hidden = true; return; } // #93
  if (it.id === "stone") { // 💎 (#93, PKM-28): pick who — only those a stone can evolve
    $("#dex-meta").innerHTML = `돌·도구로 진화하는 포켓몬, 갈래가 있는 포켓몬(이브이 등)을 골라 바로 진화 — 레벨 무관<br>가진 수 ${have}`;
    b.textContent = "쓸 포켓몬 고르기";
    return;
  }
  if (it.id === "incense") {
    $("#dex-meta").innerHTML = `${esc(it.effect)} · 대기 시간 절반<br>가진 수 ${have}${st.incenseUntil ? `<br>지금 켜져 있어요 — ${minsLeft(st.incenseUntil)}분 남음` : ""}`;
    b.textContent = st.incenseUntil ? "1시간 늘리기" : "향 피우기";
    return;
  }
  if (it.id === "egg" || it.id === "egg2") { // 🥚 the incubator (#85): any finished task, anywhere — one at a time
    const inc = st.incubator;
    $("#dex-meta").innerHTML = `${esc(it.effect)} — 전설·환상은 안 나와요<br>가진 수 ${have}<br>부화기에 넣으면 어느 폴더든 작업을 끝낼 때마다 부화가 가까워져요`
      + (inc ? `<br>지금 부화기: ${esc(inc.active.name)} ${inc.active.have}/${inc.active.need}${inc.waiting ? ` · 대기 ${inc.waiting}` : ""} — 넣으면 그 뒤에 차례` : "");
    b.textContent = inc ? "부화기에 넣기 (차례 기다림)" : "부화기에 넣기";
    return;
  }
  if (it.id === "legend") { // 전설의 향 (#82): which open legend the next breakthrough brings
    const set = coins?.legend, can = st.legends || []; // any open one — had ones too (#87)
    $("#dex-meta").innerHTML = `${esc(it.effect)} — 대발견 때 하나 써요<br>가진 수 ${have}${set ? `<br>지금: ⭐ ${esc((st.legends || []).find((l) => l.id === set)?.name || `#${set}`)}에 걸어 둠` : ""}`;
    b.hidden = true;
    $("#dex-from").innerHTML += can.length ? can.map((l) => `<button data-legend="${l.id}"${l.id === set ? ' class="on"' : ""}>⭐ ${esc(l.name)}${l.owned ? " ●" : ""}${l.id === set ? " ✓" : "에 걸기"}</button>`).join("") : "";
    return;
  }
  if (it.id === "candy") {
    const p = d.box?.find((m) => m.folder === "here"), lv = p?.lv;
    $("#dex-meta").innerHTML = `${esc(it.effect)} — 진화 레벨에 닿으면 진화해요<br>가진 수 ${have}`;
    if (p && lv != null && lv < 100) b.textContent = `이 탭 파트너에게 (Lv ${lv} → ${lv + 1})`;
    else { b.disabled = true; b.textContent = p ? "Lv 100이에요" : "이 탭에 파트너가 없어요"; }
    $("#dex-from").innerHTML += '<button data-a="pick">다른 포켓몬 고르기</button>';
  }
}
function itemKey(k) {
  const d = dexState, n = d.list?.length || 0;
  if (!n) return k === "Enter" || k.startsWith("Arrow");
  const cols = getComputedStyle($("#box-grid")).gridTemplateColumns.split(" ").length || 4;
  if (k === "ArrowRight" || k === "l") itemSelect(d.ii + 1);
  else if (k === "ArrowLeft" || k === "h") itemSelect(d.ii - 1);
  else if (k === "ArrowDown" || k === "j") itemSelect(Math.min(n - 1, d.ii + cols));
  else if (k === "ArrowUp" || k === "k") itemSelect(Math.max(0, d.ii - cols));
  else if (d.view === "shop" && (k === "-" || k === "+" || k === "=")) itemQty(k === "-" ? -1 : 1);
  else if (k === "Enter") itemAct();
  else return false;
  return true;
}
function itemQty(by) { const d = dexState; d.qty = (d.qty || 1) + by; d.askBuy = false; itemPreview(d.list[d.ii]); }
let buyTimer = null;
async function itemAct() {
  const d = dexState, it = d?.list?.[d.ii], st = shopSt;
  if (!it || $("#dex-take").disabled || $("#dex-take").hidden) return;
  if (d.view === "shop") {
    const cost = it.price * (d.qty || 1);
    // 1,000 coins or more: a second press within 3 s (SCREENS_P3 S3)
    if (cost >= st.confirmAt && !d.askBuy) { d.askBuy = true; itemPreview(it); clearTimeout(buyTimer); buyTimer = setTimeout(() => { if (dexState === d && d.askBuy) { d.askBuy = false; itemPreview(d.list[d.ii]); } }, 3000); return; }
    d.askBuy = false;
    const r = await invoke("shop_buy", { item: it.id, n: d.qty || 1 }).catch(() => ({ ok: false }));
    if (!r.ok) { await shopRender(); return itemPreview(dexState.list[dexState.ii], r.why === "weekly" ? "이번 주에는 이미 샀어요" : "코인이 모자라요 — 다시 확인해 주세요"); }
    shopSt = r;
    const b = $("#dex-take"); b.textContent = "✔ 샀어요"; b.disabled = true;
    setTimeout(() => { if (dexState === d && d.view === "shop") shopRender(); }, 600);
    return;
  }
  if (it.id === "incense") { const r = await invoke("bag_use", { item: "incense" }).catch(() => null); if (r?.ok) toast(`🪔 향을 피웠어요 — ${minsLeft(r.until)}분 동안 야생 포켓몬이 더 자주 나와요`); return shopRender(); }
  if (it.id === "candy") return candyGive(d.box?.find((m) => m.folder === "here"));
  if (it.id === "stone") { d.pick = "stone"; d.box = null; return shopRender(); } // 💎 (#93)
  if (it.id === "incq") { // 먼저 부화 (#88): one press
    const r = await invoke("incubator_first", { uid: it.uid }).catch(() => null);
    if (r?.ok) { toast(`🥚 ${josa(it.name, "이", "가")} 먼저 부화해요 — 지금 알은 차례 1로`); d.ii = 0; }
    return shopRender();
  }
  if (it.id === "egg" || it.id === "egg2") { // 🥚 (#85)
    const r = await invoke("bag_use", { item: it.id }).catch(() => null);
    if (!r?.ok) { toast("알이 없어요"); return shopRender(); }
    toast(r.incubator?.waiting ? "🥚 부화기 차례를 기다려요" : "🥚 부화기에 넣었어요 — 어느 폴더든 작업을 끝낼 때마다 부화가 가까워져요");
    return shopRender();
  }
}
// 🍬 given to an individual (this tab's partner, or one picked from 내 포켓몬)
async function candyGive(m) {
  if (!m?.uid || (m.lv ?? 0) >= 100) return;
  const r = await invoke("bag_use", { item: "candy", uid: m.uid }).catch(() => null);
  if (!r?.ok) { toast(r?.why === "lv" ? "Lv 100이에요" : "이상한사탕이 없어요"); return; } // stay on the same Pokémon (#78)
  // stay where you were and show the level going up (#78): the bag's candy, or the same Pokémon in the pick list
  const d = dexState;
  if (!d) return;
  d.lvup = { uid: r.uid, from: (m.lv ?? r.lv - 1), to: r.lv, evolved: r.evolved?.name || null, at: Date.now() };
  d.box = null;
  if (!d.pick) d.ii = Math.max(0, d.list?.findIndex((x) => x.id === "candy") ?? 0);
  await shopRender();
  if (d.pick) { const i = d.list.findIndex((x) => x.uid === r.uid); if (i >= 0) boxSelect(i); }
  lvupShow();
}
// "🆙 Lv 16 → 17!" in the preview for a moment after a candy (#78) — the card flashes too
function lvupShow() {
  const d = dexState, u = d?.lvup;
  if (!u || Date.now() - u.at > 2500) return;
  const line = document.createElement("div");
  line.className = "pk-lvup";
  line.textContent = `🆙 Lv ${u.from} → ${u.to}!${u.evolved ? ` ${u.evolved}(으)로 진화!` : ""}`;
  $("#dex-meta").prepend(line);
  const card = d.pick ? $(`#box-grid .pk-card[data-i="${d.bi}"]`) : null;
  card?.classList.add("lvup");
  setTimeout(() => { line.remove(); card?.classList.remove("lvup"); }, 2200);
}
// choosing who gets the candy: 내 포켓몬's cards in the list's place (Lv 100 can't)
async function pickRender() {
  const d = dexState, grid = $("#box-grid");
  d.box ||= await invoke("box_list").catch(() => []);
  if (dexState !== d || !d.pick) return;
  const stone = d.pick === "stone"; // 💎 only those a stone can evolve (#93)
  // the one a stone just evolved leaves the list — it's shown on the right until another card is picked (#95)
  const done = stone && d.stoneDone ? boxMons(d.box).find((m) => m.uid === d.stoneDone.uid) : null;
  if (d.stoneDone) d.stoneDone.mon = done;
  d.list = boxMons(d.box).filter((m) => !stone || (m.stone && m.uid !== done?.uid)).sort((a, b) => (a.folder === "here" ? -1 : 0) - (b.folder === "here" ? -1 : 0) || (b.lv ?? 0) - (a.lv ?? 0));
  grid.innerHTML = `<h4 class="pk-group"><button class="pk-back">← 가방으로</button> ${stone ? "진화의 돌을 쓸 포켓몬" : "이상한사탕을 줄 포켓몬"}</h4>`
    + (stone && !d.list.length ? '<p class="pk-empty">돌로 진화하는 포켓몬이 없어요 — 레벨로 진화하는 포켓몬엔 이상한사탕을</p>' : "")
    + d.list.map((m, i) => justEvolved(pkCard(m, i, { icons: TYPE_ICON, ago }).replace('class="pk-card', `class="pk-card${!stone && (m.lv ?? 0) >= 100 ? " off" : ""}`), m)).join("");
  for (const img of grid.querySelectorAll("img[data-gif]")) spriteUrl(img.dataset.gif).then((u) => { if (u) img.src = u; });
  if (done) { d.bi = Math.max(0, Math.min(d.list.length - 1, d.stoneAt ?? 0)); return boxPreview(done); } // no card picked: the keys start where it was
  if (!d.list.length) { itemPreview(null); return; }
  d.bi = 0;
  boxSelect(d.bi);
}
// 💎 진화의 돌 (#93, PKM-28 rule 3): this individual's stages as buttons — one press evolves it (the stone is used then)
let stoneSeq = 0;
async function stoneButtons(m) {
  const seq = ++stoneSeq, b = $("#dex-take"), from = $("#dex-from");
  b.hidden = true;
  from.innerHTML = '<p class="pk-note">갈래를 받는 중…</p>';
  const o = await invoke("stone_options", { uid: m.uid }).catch(() => null);
  if (seq !== stoneSeq) return;
  from.innerHTML = !o?.options?.length ? '<p class="pk-err">이 포켓몬은 진화의 돌로 진화하지 않아요</p>'
    : `<p class="pk-note">💎 진화의 돌 하나로 — 갈래를 골라요</p>${o.options.map((x) => `<button data-stone="${x.to}" data-uid="${m.uid}"${x.ready ? "" : " disabled"}>→ ${esc(x.name)}${x.ready ? "" : " (인터넷 필요)"}</button>`).join("")}`;
  if (dexState) dexState.stoneOpts = o;
}
// Enter in the stone list: the only stage there is (more than one: pick with its button)
function stoneEnter(m) {
  const o = dexState?.stoneOpts;
  if (o?.uid === m?.uid && o.options.length === 1 && o.options[0].ready) return stoneUse(m.uid, o.options[0].to);
  toast("💎 오른쪽에서 갈래를 골라 주세요");
}
async function stoneUse(uid, to) {
  const d = dexState, before = d?.list?.find((m) => m.uid === uid), at = d?.list?.indexOf(before);
  const r = await invoke("bag_use", { item: "stone", uid, to }).catch(() => null);
  if (!r?.ok) { toast(r?.why === "offline" ? "인터넷이 돌아오면 다시 — 진화의 돌은 그대로예요" : r?.why === "none" ? "진화의 돌이 없어요" : "이 포켓몬은 지금 진화의 돌로 진화하지 않아요"); return; }
  if (!d || dexState !== d) return;
  // its result in the preview (#94, PKM-28 rule 3-1) — 내 포켓몬: the same card, now the new form; the stone list: it leaves the list (#95)
  d.stoneDone = { uid, from: r.from || (before && { name: before.name, gif: before.gif }), to: r.evolved, coins: r.coins || 0, newCoins: r.newCoins || 0, played: false };
  d.stoneOpts = null; d.stoneAt = at; shopSt = r;
  coins = await invoke("economy_state").catch(() => coins);
  d.box = await invoke("box_list").catch(() => []);
  dexTitle();
  return d.view === "box" ? boxRender() : pickRender();
}
// the one a stone just evolved (#94) — an individual: starters and other cards without a uid never are
const isJust = (m) => m?.uid != null && dexState?.stoneDone?.uid === m.uid;
// its card: a sparkle and "✨ 방금 진화"
const justEvolved = (html, m) => (isJust(m) ? html.replace('class="pk-card', 'class="pk-card pk-just').replace(/(<div class="pk-card[^>]*>)/, '$1<span class="pk-justb">✨ 방금 진화</span>') : html);
// the result in the preview: the old picture → a white flash → the new one, what it earned, what next
async function stoneResult(m) {
  const d = dexState, s = d.stoneDone, b = $("#dex-take"), img = $("#dex-img"), box = $(".dex-preview");
  b.hidden = true;
  const left = coins?.stones || 0;
  $("#dex-meta").innerHTML = `<b class="pk-evo-msg">🎉 ${esc(josa(s.from?.name || "", "이", "가"))} ${esc(josa(s.to.name, "으로", "로"))} 진화했어요!</b><br>`
    + `<span class="pk-evo-coins">+${coinTxt(s.coins - s.newCoins)} 진화${s.newCoins ? ` · +${coinTxt(s.newCoins)} 새 종` : ""}</span><br>${esc(lvLine(m))}`;
  $("#dex-from").innerHTML = (m.folder !== "here" && tab ? '<button data-sd="take">이 탭의 파트너로</button>' : "")
    + '<button data-sd="box">내 포켓몬에서 보기</button>'
    + (left ? "" : '<p class="pk-note">진화의 돌을 다 썼어요</p>'); // another one: pick it on the left (#95)
  if (s.played) return;
  s.played = true;
  const show = async (gif) => { const u = gif && await spriteUrl(gif); if (u) { img.src = u; await img.decode().catch(() => {}); img.style.width = `${img.naturalWidth * Math.max(1, Math.min(4, Math.floor(200 / img.naturalWidth)))}px`; } };
  if (document.body.classList.contains("ui-test")) return show(s.to.gif || m.gif); // scenes: the end state
  await show(s.from?.gif);
  img.classList.add("pk-evo-out"); box.classList.add("pk-evo-flash");
  await new Promise((r) => setTimeout(r, 1100));
  await show(s.to.gif || m.gif);
  img.classList.remove("pk-evo-out"); img.classList.add("pk-evo-in");
  setTimeout(() => { img.classList.remove("pk-evo-in"); box.classList.remove("pk-evo-flash"); }, 900);
}
function candyButton(m) {
  const b = $("#dex-take"), left = shopSt?.bag?.candy || 0;
  b.hidden = false; b.className = "";
  b.disabled = (m.lv ?? 0) >= 100 || !left;
  b.textContent = (m.lv ?? 0) >= 100 ? "Lv 100이에요" : !left ? "이상한사탕을 다 썼어요" : `사탕 주기 (Lv ${m.lv} → ${m.lv + 1}) · 남은 ${left}개`;
}
$("#dex-meta").addEventListener("click", (e) => { const q = e.target.closest("[data-q]"); if (q) itemQty(Number(q.dataset.q)); });

function boxMatch(q, m) {
  const e = dexState.byNo.get(m.id);
  return dexMatch(q, m.id, { ...(e || { name: m.name, types: m.types, caught: true }), caughtAt: m.at, fresh: m.new ? 1 : 0, shiny: m.shiny, partner: m.folder ? 1 : 0, grad: m.grad, egg: m.egg });
}
// 알 are not Pokémon yet: they live in the bag's incubator, not among 내 포켓몬's cards (#91, PKM-14 rule 6)
const boxMons = (list) => (list || []).filter((m) => !m.egg);
function boxSorted() {
  const d = dexState, q = dexQuery.trim();
  const list = boxMons(d.box).filter((m) => !q || boxMatch(q, m));
  const recent = (a, b) => (b.at || 0) - (a.at || 0) || b.uid - a.uid;
  const by = {
    recent, no: (a, b) => a.id - b.id || recent(a, b), name: (a, b) => String(a.name).localeCompare(String(b.name), "ko") || recent(a, b),
    lv: (a, b) => (b.lv ?? 0) - (a.lv ?? 0) || recent(a, b), partner: (a, b) => (a.folder ? (a.folder === "here" ? 0 : 1) : 2) - (b.folder ? (b.folder === "here" ? 0 : 1) : 2) || recent(a, b),
  }[boxSort] || recent;
  return list.sort(by);
}
const CHOOSE_GROUPS = [
  ["starter", "🌟 첫 파트너", "처음 한 번 · 1·2·3"],
  ["rest", "📦 박스에서 쉬는 포켓몬", ""],
  ["other", "🏠 다른 폴더의 파트너", "데려오면 그 폴더는 파트너가 비어요"],
];
function boxRender() {
  const d = dexState, grid = $("#box-grid"), q = dexQuery.trim();
  const prev = d.list?.[d.bi];
  const card = (m) => pkCard(m, d.list.indexOf(m), { icons: TYPE_ICON, ago });
  let html = "", note = "";
  if (d.view === "choose") {
    const items = chooseItems(d.chooseOpts || { resting: [], others: [] }).filter((m) => m.kind === "loading" || !q || boxMatch(q, m));
    d.list = items.filter((m) => m.kind !== "loading");
    for (const [g, title, sub] of CHOOSE_GROUPS) {
      const these = items.filter((m) => m.group === g);
      if (g === "starter" && !d.chooseOpts?.starter) continue;
      if (g === "other" && !these.length) continue;
      html += `<h4 class="pk-group">${title}${sub ? `<span class="dim">${sub}</span>` : ""}</h4>`;
      if (g === "starter" && d.chooseNote) html += `<p class="pk-note">${esc(d.chooseNote)}</p>`;
      else if (g === "starter" && !d.chooseOpts.starter.ready) html += `<p class="pk-note">첫 파트너 후보를 받는 중… ${d.chooseOpts.starter.set.length}/${d.chooseOpts.starter.total} (PokéAPI)</p>`;
      html += these.length ? these.map(card).join("")
        : g === "rest" ? '<p class="pk-note">쉬는 포켓몬이 없어요 — 작업을 끝내면 야생 포켓몬이 나타날 수 있어요(파트너 없는 폴더는 더 자주)</p>' : "";
    }
  } else {
    d.list = boxSorted();
    const eggs = (d.box || []).filter((m) => m.egg).length;
    note = eggs && !q ? `<p class="pk-note pk-box-eggs">🥚 알 ${eggs}개는 👜 가방의 부화기에 있어요 <button data-view="bag">가방 열기</button></p>` : ""; // #91
    html = note + d.list.map((m) => justEvolved(card(m), m)).join("");
  }
  $("#dex-found").textContent = q ? `${d.list.length}마리` : "";
  if (!d.list.length && (q || d.view === "box")) {
    grid.innerHTML = note + `<div class="pk-empty" id="box-empty">${q ? `<b>"${esc(q)}"</b>에 맞는 포켓몬이 없어요<button id="box-clear">검색 지우기</button>`
      : "아직 잡은 포켓몬이 없어요 — 작업을 끝내면 가끔 야생 포켓몬이 나타나요"}</div>`;
    $(".dex-preview").style.visibility = "hidden";
    return;
  }
  grid.innerHTML = html;
  grid.querySelectorAll("img[data-gif]").forEach((img) => spriteUrl(img.dataset.gif).then((u) => { if (u) img.src = u; }));
  if (!d.list.length) { $(".dex-preview").style.visibility = "hidden"; return; }
  $(".dex-preview").style.visibility = "";
  const keep = prev ? d.list.findIndex((m) => (m.uid != null ? m.uid === prev.uid : m.key === prev.key)) : -1;
  boxSelect(keep >= 0 ? keep : Math.min(d.bi || 0, d.list.length - 1));
}
function boxSelect(i) {
  const d = dexState;
  if (!d?.list?.length) return;
  d.bi = Math.max(0, Math.min(d.list.length - 1, i));
  if (d.stoneDone?.mon) d.stoneDone = null; // another card picked: the stone's result is over (#95)
  for (const c of document.querySelectorAll("#box-grid .pk-card.sel")) c.classList.remove("sel");
  const card = $(`#box-grid .pk-card[data-i="${d.bi}"]`);
  card?.classList.add("sel");
  card?.scrollIntoView({ block: "nearest" });
  boxPreview(d.list[d.bi]);
}
// the preview of one Pokémon — a card's, or the one a stone just took out of the list (#95)
const boxCur = (d = dexState) => d?.stoneDone?.mon || d?.list?.[d.bi];
function boxPreview(m) {
  const d = dexState;
  d.boxAsk = false;
  if (d.stoneDone?.mon) for (const c of document.querySelectorAll("#box-grid .pk-card.sel")) c.classList.remove("sel");
  const img = $("#dex-img"), want = m.uid;
  img.className = "";
  const playing = isJust(m) && !d.stoneDone.played; // 💎 stoneResult draws the picture (#94)
  if (m.gif && !playing) spriteUrl(m.gif).then(async (u) => {
    if (!u || boxCur()?.uid !== want) return;
    img.src = u;
    await img.decode().catch(() => {});
    img.style.width = `${img.naturalWidth * Math.max(1, Math.min(4, Math.floor(200 / img.naturalWidth)))}px`;
  });
  else img.removeAttribute("src");
  $("#dex-name").textContent = m.egg ? `🥚 ${m.name}` : `#${String(m.id).padStart(3, "0")} ${m.grad ? "🎓 " : ""}${m.shiny ? "✨" : ""}${m.name}`; // #84
  const types = (m.types || []).map((t) => `${TYPE_ICON[t] || ""} ${t}`).join(" · ");
  if (m.kind === "starter") $("#dex-meta").innerHTML = `${types}<br>첫 파트너 후보 — 처음 한 번만 고를 수 있어요`;
  else {
    const where = m.folder === "here" ? "이 탭의 파트너" : m.folder ? `📁 ${esc(m.folder)}의 파트너${m.folderGone ? " (닫힌 폴더)" : ""}` : "박스에서 쉬는 중";
    $("#dex-meta").innerHTML = `${types}<br>${esc(lvLine(m))}<br>${where}`
      + (m.how || m.at ? `<br>${HOW[m.how] || ""}${m.at ? ` · ${ago(m.at)}` : ""}` : "")
      // the catch log (#44): where and during whose task (recorded from beta.29 on), evolutions
      + (m.caughtIn || m.caughtBy ? `<br><span class="dim">${m.caughtIn ? `📁 ${esc(m.caughtIn)}에서` : ""}${m.caughtBy ? ` ${esc(m.caughtBy)} 작업 중` : ""}</span>` : "")
      + (m.evo?.length ? `<br><span class="dim">진화: ${m.evo.map((e) => `${esc(e.from)} → ${esc(e.to)} (${ago(e.at)})`).join(", ")}</span>` : "");
  }
  $("#dex-from").innerHTML = "";
  boxButton();
  $("#dex-pos").textContent = d.stoneDone?.mon ? `– / ${d.list.length}` : `${d.bi + 1} / ${d.list.length}`;
  // looked at: its NEW goes (like the Pokédex)
  if (m.new) {
    invoke("dex_viewed", { id: m.id });
    for (const x of d.box || []) if (x.id === m.id) x.new = false;
    const e = d.byNo.get(m.id);
    if (e) e.fresh = 0;
    dexTitle();
    const uid = m.uid;
    setTimeout(() => { const c = $(`#box-grid .pk-card.new[data-i="${dexState?.list?.findIndex((x) => x.uid === uid)}"]`); c?.classList.remove("new"); c?.querySelector(".pk-newb")?.remove(); }, 1500);
  }
}
// the take button: a starter / resting → take · this tab's already · another folder's → press twice
function boxButton() {
  const d = dexState, m = boxCur(d), b = $("#dex-take");
  if (isJust(m)) return stoneResult(m); // 💎 just evolved: its result (#94)
  if (d.pick === "stone") return stoneButtons(m); // 💎 (#93)
  if (d.pick) return candyButton(m);
  if (d.view === "box" && m.stone && coins?.stones) $("#dex-from").innerHTML = `<button data-a="stone">💎 진화의 돌로 (${coins.stones})</button>`; // 내 포켓몬 (S5)
  b.hidden = !tab;
  b.disabled = m.folder === "here";
  b.className = d.boxAsk ? "confirm" : "";
  b.textContent = m.kind === "starter" ? `첫 파트너로 (${m.n})` : m.folder === "here" ? "이 탭의 파트너예요" : !m.folder ? "이 탭의 파트너로"
    : d.boxAsk ? `한 번 더 누르면 데려오기 (📁 ${m.folder}는 비어요)` : `📁 ${m.folder}에서 데려오기`;
  for (const c of document.querySelectorAll("#box-grid .pk-card.confirm")) c.classList.remove("confirm");
  if (d.boxAsk) $(`#box-grid .pk-card[data-i="${d.bi}"]`)?.classList.add("confirm");
}
async function boxTake() {
  const d = dexState, m = d?.list?.[d.bi];
  if (d?.view === "shop" || d?.view === "bag") return d.pick === "stone" ? stoneEnter(m) : d.pick ? candyGive(m) : itemAct();
  if (!m || m.folder === "here") return;
  if (m.folder && m.kind !== "starter" && !d.boxAsk) { d.boxAsk = true; return boxButton(); }
  return pkTake(m);
}
// take a Pokémon for this tab: a starter or an individual (uid) — the window closes, and the main window's pane shows
// it and reacts (💕, "…와 함께해요!" — the main process's "partner-taken"; Tamer's window isn't brought forward, APP-22 rule 8)
async function pkTake(m) {
  if (!tab) return;
  const args = m.kind === "starter" ? { starter: m.id } : { uid: m.uid };
  const from = m.folder && m.folder !== "here" && m.kind !== "starter" ? m.folder : null;
  const pk = await invoke("partner_take", { ...args, from }).catch((e) => { toast(String(e.message || e).replace(/^.*Error: /, "")); return null; });
  if (pk) closeDex();
}
function boxKey(k) {
  const d = dexState, n = d.list?.length || 0;
  if (d.view === "choose" && /^[1-3]$/.test(k)) { // the first partner, at once (as before)
    const s = d.list?.find((m) => m.kind === "starter" && m.n === Number(k));
    if (s) pkTake(s);
    return !!s;
  }
  const cols = getComputedStyle($("#box-grid")).gridTemplateColumns.split(" ").length || 4;
  const cur = $(`#box-grid .pk-card[data-i="${d.bi}"]`);
  // ↑↓: the card above / below (the groups of 파트너 고르기 break the rows)
  const vert = (dir) => { const to = cur && dexGeo(cur, [...document.querySelectorAll("#box-grid .pk-card[data-i]")].filter((c) => Number(c.dataset.i) >= 0), dir); if (to) boxSelect(Number(to.dataset.i)); };
  if (k === "/") $("#dex-search").focus();
  // a stone's result on the right, no card picked (#95): the first move picks the card where it was, Enter does nothing
  else if (d.stoneDone?.mon && n && /^(Arrow\w+|Home|End|[hjkl])$/.test(k)) boxSelect(k === "End" ? n - 1 : k === "Home" ? 0 : d.bi);
  else if (d.stoneDone?.mon && k === "Enter") return true;
  else if (!n) return k === "Enter" || k.startsWith("Arrow");
  else if (k === "ArrowRight" || k === "l") boxSelect(d.bi + 1);
  else if (k === "ArrowLeft" || k === "h") boxSelect(d.bi - 1);
  else if (k === "ArrowDown" || k === "j") vert(1);
  else if (k === "ArrowUp" || k === "k") vert(-1);
  else if (k === "Home") boxSelect(0);
  else if (k === "End") boxSelect(n - 1);
  else if (k === "Enter") boxTake();
  else return false;
  return true;
}
$("#box-grid").addEventListener("click", (e) => {
  if (e.target.id !== "box-clear") return;
  setQuery(""); $("#dex-search").value = ""; boxRender();
});

// a grid cell (the selection moves to the grid)
function dexSelect(n) {
  const d = dexState;
  if (!d) return;
  d.zone = "grid";
  dexShow(n);
}

// the i-th cell of the "새로 잡은" row
function dexRecent(i) {
  const d = dexState;
  if (!d?.recent?.length) return;
  d.zone = "recent";
  d.ri = Math.max(0, Math.min(d.recent.length - 1, i));
  dexShow(d.recent[d.ri].id);
}

// show species n; the outline is on the cell of the zone the selection is in
function dexShow(n) {
  const d = dexState;
  d.sel = Math.max(1, Math.min(d.total, n));
  for (const c of document.querySelectorAll("#dex-grid .cell.sel")) c.classList.remove("sel");
  const cell = d.zone === "recent" ? $(`#dex-grid .cells.recent .cell[data-ri="${d.ri}"]`) : $(`#dex-grid .cells:not(.recent) .cell[data-n="${d.sel}"]`);
  cell?.classList.add("sel");
  cell?.scrollIntoView({ block: "nearest" });
  const e = d.byNo.get(d.sel);
  // looked at: its new ones aren't new any more (the highlight goes once you move on)
  if (e?.fresh) {
    invoke("dex_viewed", { id: d.sel });
    e.fresh = 0;
    for (const m of d.recent || []) if (m.id === d.sel) m.new = false;
    dexTitle();
    const id = d.sel;
    setTimeout(() => {
      for (const c of document.querySelectorAll(`#dex-grid .cell.new[data-n="${id}"]`)) { c.classList.remove("new"); c.querySelector(".pk-newb")?.remove(); }
    }, 1500);
  }
  const no = `#${String(d.sel).padStart(3, "0")}`;
  const img = $("#dex-img");
  img.className = e && !e.caught ? "seen" : "";
  const want = d.sel; // a picture that arrives after you moved on is dropped
  if (e?.gif) spriteUrl(e.gif).then(async (u) => {
    if (!u || dexState?.sel !== want) return;
    img.src = u;
    await img.decode().catch(() => {});
    img.style.width = `${img.naturalWidth * Math.max(1, Math.min(4, Math.floor(200 / img.naturalWidth)))}px`;
  });
  else img.removeAttribute("src");
  $("#dex-name").textContent = e ? `${no} ${e.caught && e.shiny ? "✨" : ""}${e.name}` : `${no} ???`;
  $("#dex-meta").innerHTML = !e ? "아직 만나지 못했어요"
    : `${(e.types || []).map((t) => `${TYPE_ICON[t] || ""} ${t}`).join(" · ")}<br>만난 횟수 ${e.count} · ${e.caught ? `● 잡음 · 📦 ${e.owned || 0}마리` : "○ 만나기만 함"}`;
  // owned: where the individuals are, and what "take" will do (resting → now; another folder's → ask)
  const take = $("#dex-take");
  take.className = "";
  const o = d.opts, rest = o?.resting.filter((m) => m.id === d.sel) || [], others = o?.others.filter((m) => m.id === d.sel) || [];
  const mine = o?.current?.id === d.sel;
  if (e?.owned > 0) {
    const where = [mine ? "이 탭의 파트너" : "", rest.length ? `쉬는 ${rest.length}` : "", ...others.map((m) => `📁 ${esc(m.folderName)}`)].filter(Boolean).join(" · ");
    $("#dex-meta").innerHTML += `<br>${where}`;
  }
  take.hidden = !rest.length;
  take.textContent = "이 탭의 파트너로";
  // none resting: one button per folder that has one (EXP shown) — click twice to take it
  d.fromOthers = rest.length ? [] : others;
  renderFrom(e, -1);
  $("#dex-pos").textContent = `${d.sel} / ${d.total}`;
}

async function dexChoose() {
  if (dexState?.view !== "dex") return boxTake();
  const d = dexState, e = d?.byNo.get(d.sel);
  if (!e || !tab) return;
  if (!e.owned) { toast(e.caught ? `박스에 ${e.name}가 없어요` : `${josa(e.name, "은", "는")} 아직 잡지 못했어요`); return; }
  const o = d.opts;
  const rest = o?.resting.findLast((m) => m.id === e.id);
  const other = o?.others.find((m) => m.id === e.id);
  if (!rest && !other) { toast(o?.current?.id === e.id ? "이미 이 탭의 파트너예요" : `박스에 ${e.name}가 없어요`); return; }
  if (!rest) return dexFrom(0); // Enter: the first folder's (asks once)
  return dexTake(rest, null);
}

// take another folder's individual (i in dexState.fromOthers): first press asks, second takes
function dexFrom(i) {
  const m = dexState?.fromOthers?.[i];
  const b = $(`#dex-from button[data-i="${i}"]`);
  if (!m || !b) return;
  if (!b.classList.contains("confirm")) return renderFrom(dexState.byNo.get(dexState.sel), i);
  return dexTake(m, m);
}

// the folders this species can be taken from; `ask` = the one waiting for the second press
function renderFrom(e, ask) {
  const list = dexState?.fromOthers || [];
  $("#dex-from").innerHTML = list.length
    ? `<div class="dim">쉬는 ${esc(e.name)}가 없어요 — 다른 폴더에서 데려오기 (그 폴더는 비어요)</div>`
      + list.map((m, i) => i === ask
        ? `<button data-i="${i}" class="confirm">한 번 더 누르면 ${esc(m.folderName)}의 ${esc(m.name)} 데려오기</button>`
        : `<button data-i="${i}">📁 ${esc(m.folderName)} · Lv ${m.lv ?? "?"}</button>`).join("")
    : "";
}

// a resting one → this tab's partner; another folder's (other = it) → taken from there
const dexTake = (m, other) => pkTake({ uid: m.uid, folder: other ? other.folderName : null });

// Esc · ⌘W · ✕: the window goes (closed = gone, APP-22 rule 5) — its last view and search stay with the main process
function closeDex() { invoke("poke_close").catch(() => {}); }
const dexEsc = () => closeDex();
const dexOpen = () => !!dexState;

// grid columns right now (for ↑↓)
const dexCols = () => getComputedStyle($("#dex-grid .cells")).gridTemplateColumns.split(" ").length || 10;

// a letter key by its place on the keyboard, whatever the input source: with 한글 on, S comes as
// "ㄴ" (or "Process" while the IME has it) — the window's letter keys (S · I · M · q · hjkl) still work (#77)
function keyOf(e) {
  if (/^Key[A-Z]$/.test(e.code || "") && !/^[\x20-\x7e]$/.test(e.key)) { const c = e.code.slice(3); return e.shiftKey ? c : c.toLowerCase(); }
  return e.key;
}
function dexKey(e) {
  const d = dexState;
  if (!d) return false;
  const k = keyOf(e), cols = dexCols();
  if ((k === "Escape" || k === "q") && d.pick) { d.pick = false; d.stoneOpts = null; d.stoneDone = null; shopRender(); } // choosing who gets the candy / the stone: back to the bag
  else if (k === "Escape" || k === "q") dexEsc();
  else if (k === "m" || k === "M") dexView(d.view === "box" ? "dex" : "box");
  else if ((k === "s" || k === "S") && !d.pick) dexView("shop"); // #76
  else if ((k === "i" || k === "I") && !d.pick) dexView("bag");
  else if (d.view === "home") return true; // nothing to move on 홈 — keys stay in the window
  else if ((d.view === "shop" || d.view === "bag") && !d.pick) return itemKey(k);
  else if (d.view !== "dex") return boxKey(k);
  else if (k === "Enter") dexChoose();
  else if (d.hits && dexKeyFiltered(k, e)) { /* searching: shown cells only */ }
  else if (d.zone === "recent" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "h", "l", "k", "j", "Home", "End"].includes(k)) {
    // inside the "새로 잡은" / "새로 부화한" rows (#89): ←→ in order, ↑↓ by where the cells are on screen;
    // ↓ from the last line goes to this Pokémon's place in the grid
    const n = d.recent.length, row = [...document.querySelectorAll("#dex-grid .cells.recent .cell")];
    const cur = $(`#dex-grid .cells.recent .cell[data-ri="${d.ri}"]`);
    if (k === "ArrowLeft" || k === "h") dexRecent(d.ri - 1);
    else if (k === "ArrowRight" || k === "l") dexRecent(d.ri + 1);
    else if (k === "Home") dexRecent(0);
    else if (k === "End") dexRecent(n - 1);
    else { const up = k === "ArrowUp" || k === "k", to = cur && dexGeo(cur, row, up ? -1 : 1); if (to) dexRecent(Number(to.dataset.ri)); else if (!up) dexSelect(d.sel); }
  }
  // ↑ from the grid's first line: back to the "새로 잡은" row, where you were
  else if ((k === "ArrowUp" || k === "k") && d.sel <= cols && d.recent?.length) {
    dexRecent(d.ri);
    $("#region-new")?.scrollIntoView({ block: "start" });
  }
  else if (k === "/") $("#dex-search").focus();
  else if (k === "ArrowRight" || k === "l") dexStep(1);
  else if (k === "ArrowLeft" || k === "h") dexStep(-1);
  else if (k === "ArrowDown" || k === "j") dexSelect(d.sel + cols);
  else if (k === "ArrowUp" || k === "k") dexSelect(d.sel - cols);
  else if (k === "PageDown") dexSelect(d.sel + cols * 5);
  else if (k === "PageUp") dexSelect(d.sel - cols * 5);
  else if (k === "Home") dexSelect(1);
  else if (k === "End") dexSelect(d.total);
  else if (k === "Tab") { // next / previous Pokémon you've met
    const met = d.entries.map((x) => x.id);
    const next = e.shiftKey ? [...met].reverse().find((n) => n < d.sel) : met.find((n) => n > d.sel);
    dexSelect(next ?? (e.shiftKey ? met.at(-1) : met[0]) ?? d.sel);
  } else return false;
  return true;
}

$("#dex-grid").addEventListener("click", (e) => {
  const c = e.target.closest(".cell");
  if (c) c.dataset.ri != null ? dexRecent(Number(c.dataset.ri)) : dexSelect(Number(c.dataset.n));
});
$("#dex-grid").addEventListener("dblclick", (e) => { if (e.target.closest(".cell")) dexChoose(); });
$("#dex-regions").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const d = dexState;
  if (b.dataset.a === "new" || b.dataset.a === "hatched") { // 🆕 / 🥚 (#89): that row's first
    const first = shownCells(`#dex-grid #${b.dataset.a === "new" ? "region-new" : "region-hatched"} + .cells.recent .cell`)[0];
    dexRecent(first ? Number(first.dataset.ri) : 0);
  } else if (d?.hits) { // searching: the region's first result
    const r = REGIONS.find(([, a]) => String(a) === b.dataset.a);
    const n = d.hits.find((x) => x >= r[1] && x <= r[2]);
    if (n) dexSelect(n);
  } else dexSelect(Number(b.dataset.a));
  $(`#region-${b.dataset.a}`).scrollIntoView({ block: "start" });
});
$("#dex-take").addEventListener("click", () => dexChoose());
$("#dex-grid").addEventListener("click", (e) => {
  if (e.target.id !== "dex-clear") return;
  setQuery(""); $("#dex-search").value = ""; dexFilter();
  dexSelect(dexState.sel);
});
$("#dex-regions").addEventListener("input", (e) => {
  if (e.target.id === "dex-search") { setQuery(e.target.value); if (dexState?.view !== "dex") boxRender(); else dexFilter(); }
  if (e.target.id === "box-sort") { boxSort = e.target.value; try { localStorage.setItem("tamer.box.sort", boxSort); } catch {} boxRender(); }
});

$("#dex-title").addEventListener("click", (e) => {
  if (e.target.closest(".pk-close")) return dexEsc();
  const b = e.target.closest("button[data-view]");
  if (b) dexView(b.dataset.view);
});
$("#box-grid").addEventListener("click", async (e) => {
  if (e.target.closest(".pk-band-x")) { coins = await invoke("economy_start_seen").catch(() => coins); return homeRender(); } // 시작 코인 band: once (#72)
  if (e.target.closest(".pk-band-go")) { coins = await invoke("economy_start_seen").catch(() => coins); return dexView("shop"); }
  const it = e.target.closest(".pk-item[data-i]");
  if (it) { // the picked one again: one more (#81) — buying stays the button / Enter
    const d = dexState, i = Number(it.dataset.i);
    if (d.view === "shop" && i === d.ii && d.list[i]?.many) return itemQty(1);
    return itemSelect(i);
  }
  if (e.target.closest(".pk-goods")) return shopView(); // 빈 가방 → 상점
  // ⭐ 파티 (#107): a new list each time — the main process checks it (partner.partySet)
  const pin = e.target.closest("[data-party-in]"), pout = e.target.closest("[data-party-out]"), plead = e.target.closest("[data-party-lead]");
  if (pin || pout || plead) {
    const cur = (dexState?.party?.list || []).map((m) => m.uid);
    const u = Number((pin || pout || plead).dataset.partyIn || (pin || pout || plead).dataset.partyOut || (pin || pout || plead).dataset.partyLead);
    return partyChange(pin ? [...cur, u] : pout ? cur.filter((x) => x !== u) : [u, ...cur.filter((x) => x !== u)]);
  }
  const go = e.target.closest("button[data-view]"); // 내 포켓몬 "가방 열기" (#91) · 가방 "막 태어남 [보기]" (#88)
  if (go) return dexView(go.dataset.view);
  const add = e.target.closest("[data-incadd]"); // 빈 부화기 → 가방의 알 넣기 (#88)
  if (add) {
    const r = await invoke("bag_use", { item: add.dataset.incadd }).catch(() => null);
    if (r?.ok) toast("🥚 부화기에 넣었어요 — 어느 폴더든 작업을 끝낼 때마다 부화가 가까워져요");
    return shopRender();
  }
  if (e.target.closest(".pk-back")) { dexState.pick = false; dexState.stoneDone = null; return shopRender(); }
  const c = e.target.closest(".pk-card[data-i]"); if (c && Number(c.dataset.i) >= 0) boxSelect(Number(c.dataset.i));
});
$("#box-grid").addEventListener("dblclick", (e) => { if (dexState?.view === "party") return; if (e.target.closest(".pk-card[data-i]") || (dexState?.view === "bag" && e.target.closest(".pk-item[data-i]"))) boxTake(); }); // the shop buys only by its button (#81)
$("#dex-from").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (b?.dataset.a === "pick") { dexState.pick = true; return shopRender(); } // 🍬 다른 포켓몬 고르기 (#76)
  if (b?.dataset.a === "stone") { const m = dexState.list?.[dexState.bi]; if (m) stoneButtons(m); return; } // 💎 내 포켓몬에서 (#93)
  if (b?.dataset.stone) return stoneUse(Number(b.dataset.uid), Number(b.dataset.stone)); // 💎 a stage (#93)
  if (b?.dataset.sd) { // 💎 after the evolution (#94)
    const d = dexState, m = boxCur(d), uid = d.stoneDone?.uid;
    if (b.dataset.sd === "take" && m) { d.stoneDone = null; return pkTake(m); }
    d.stoneDone = null;
    if (b.dataset.sd === "box") { d.pick = false; await dexView("box"); const i = dexState.list.findIndex((x) => x.uid === uid); return boxSelect(Math.max(0, i)); }
    return;
  }
  if (b?.dataset.legend) return invoke("bag_use", { item: "legend", id: Number(b.dataset.legend) }).then((r) => { if (r?.ok) toast("⭐ 다음 대발견에 걸어 뒀어요"); return shopRender(); }); // #82
  if (b) dexFrom(Number(b.dataset.i));
});

// ── what the main process tells (APP-22 rule 3) ──────────────────────────────────────────────────────────────────
// asked again while open (⌘P · ⌘D · a chip · the dashboard · the overlay): that view / species
listen("poke-open", (e) => openDex(e.payload?.sel || undefined, e.payload?.view || undefined));
// this tab changed (another tab on screen, closed, its partner taken or freed): the same view, drawn for it
async function tabNow(t) {
  tab = t === undefined ? await invoke("poke_tab").catch(() => null) : t;
  if (dexState) openDex(dexState.view === "dex" ? dexState.sel : undefined, dexState.view);
}
listen("poke-tab", (e) => tabNow(e.payload || null));
listen("partner", (e) => { if (tab && e.payload?.ws === tab.ws) tabNow(); });
listen("partner-choose", (e) => { if (tab && e.payload?.ws === tab.ws) tabNow(); });
// starters arriving while 파트너 고르기 is open
listen("partner-today", async () => { if (dexState?.view === "choose") renderChoose(await invoke("partner_options").catch(() => null)); });
// 🪙 포켓코인 changed (#72): the chip and 홈 follow
listen("economy", (e) => {
  const { ws, gained, ...c } = e.payload;
  coins = c;
  if (dexState) { dexTitle(); if (dexState.view === "home") homeRender(); }
});
listen("progress", (e) => { prog = e.payload || null; if (dexState) dexTitle(); }); // the bag tab's 🥚 (#88)
// 🐣 the incubator hatched an egg (#85): it's in the box now — the bag's incubator says so for a while (#88)
listen("hatched", (e) => {
  lastHatch = { ...e.payload, at: Date.now() };
  if (dexState) { dexState.box = null; if (dexState.view === "home") homeRender(); }
});
listen("incubator", () => { if (dexState?.view === "home") homeRender(); if (dexState?.view === "bag" && !dexState.pick) shopRender(); });
setInterval(() => { if (dexState && coins?.incenseUntil) dexTitle(); }, 30000); // 🪔 n분

// ── keys: the window's own (physical key codes — 한글 자판 too, keyOf) ─────────────────────────────────────────
window.addEventListener("keydown", (e) => {
  if (!dexState) return;
  const hit = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
  if (e.metaKey) {
    if (e.code === "KeyF") return hit(() => $("#dex-search").focus()); // 도감 검색 (PKM-13 rule 6)
    if (e.code === "KeyW") return hit(closeDex);
    if (e.code === "KeyP") return hit(() => dexView("home"));
    if (e.code === "KeyD") return hit(() => (dexState.view === "dex" ? closeDex() : dexView("dex")));
    return; // ⌘Q · ⌘, · ⌘C …: the app menu's
  }
  if (e.target === $("#dex-search")) { if (dexSearchKey(e)) { e.preventDefault(); e.stopPropagation(); } return; }
  if (dexKey(e)) { e.preventDefault(); e.stopPropagation(); }
}, true);

// ── tests (CVIM_DESKTOP_TEST=1 only — poke_state says so): what's on screen as data, for the lab (labState in the
// main window merges it) and the scenes; the old #17 · #21 · #27 checks moved with the screens ─────────────────────
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function labState() {
  const d = dexState, st = d?.chooseOpts?.starter, on = !!d;
  return {
    poke: on ? d.view || "dex" : null, choose: d?.view === "choose", top: "poke", pokeFor: tab?.folder ?? null,
    starters: st ? { ready: !!st.ready, n: st.set.length } : null, cards: document.querySelectorAll("#box-grid .pk-card[data-i]").length,
    toast: $("#toast")?.classList.contains("show") ? $("#toast").textContent : null,
    focus: document.activeElement?.id || document.activeElement?.className?.toString().slice(0, 40) || null,
    incubator: on ? $("#box-grid .pk-inc-row")?.textContent || null : null, // #85
    bagInc: on ? { now: $("#box-grid .pk-inc-now")?.textContent.replace(/\s+/g, " ").trim() || null, soon: !!$("#box-grid .pk-inc-now.soon"),
      line: [...document.querySelectorAll("#box-grid .pk-incq")].map((c) => c.textContent.replace(/\s+/g, "")), empty: $("#box-grid .pk-inc-empty")?.textContent.replace(/\s+/g, " ").trim() || null,
      born: $("#box-grid .pk-inc-born")?.textContent.replace(/\s+/g, " ").trim() || null } : null,
    bagTab: on ? $('#dex-title [data-view="bag"]')?.textContent || null : null,
    boxEggs: on ? $("#box-grid .pk-box-eggs")?.textContent.replace(/\s+/g, " ").trim() || null : null, // #91
    boxTab: on ? $('#dex-title [data-view="box"]')?.textContent || null : null,
    road: on ? [...document.querySelectorAll("#box-grid .pk-rgen")].map((r) => r.textContent.replace(/\s+/g, " ").trim()) : null, // #86
    research: on ? [...document.querySelectorAll("#box-grid .pk-rstep")].map((r) => r.textContent.replace(/\s+/g, " ").trim()) : null,
    preview: on ? $("#dex-meta")?.textContent || null : null,
    dexName: on ? $("#dex-name")?.textContent || null : null, // #94
    dexPos: on ? $("#dex-pos")?.textContent || null : null, // #95
    justCard: on ? $("#box-grid .pk-card.pk-just b")?.textContent || null : null,
    selCard: on ? $("#box-grid .pk-card.sel b")?.textContent || null : null,
    fromBtns: on ? [...document.querySelectorAll("#dex-from button")].map((b) => `${b.textContent}${b.disabled ? " (꺼짐)" : ""}`) : null, // #93
    pokeTab: on ? $("#dex .pk-tabs button.on")?.dataset.view || null : null,
    pokeTabs: on ? [...document.querySelectorAll("#dex .pk-tabs button")].map((b) => b.dataset.view) : null,
    pos: on ? $("#dex-pos")?.textContent || null : null,
    dexRows: on ? [...document.querySelectorAll("#dex-grid h4[id^='region-']")].map((h) => `${h.textContent}:${h.nextElementSibling?.querySelectorAll(".cell").length}`) : null, // #89
    dexSel: d ? `${d.zone}:${d.sel}` : null,
    coin: on ? $("#dex-title .pk-coin")?.textContent || null : null, // 🪙 (#72)
    stamps: on ? $("#box-grid .pk-stamp")?.textContent?.replace(/\s+/g, " ").trim() || null : null, // ⭐ (#82)
    nextBig: on ? $("#box-grid .pk-stamps .pk-note")?.textContent || null : null,
    coinToday: on ? $("#box-grid .pk-coins")?.textContent || null : null,
    coinBand: on ? $("#box-grid .pk-band")?.textContent || null : null,
    takeBtn: on && !$("#dex-take").hidden ? `${$("#dex-take").textContent}${$("#dex-take").disabled ? " (꺼짐)" : ""}${$("#dex-take").classList.contains("confirm") ? " (확인)" : ""}` : null, // #76
    items: on ? [...document.querySelectorAll("#box-grid .pk-item")].map((c) => `${c.querySelector("b")?.textContent}:${c.querySelector(".pk-price")?.textContent}${c.classList.contains("off") ? ":off" : ""}`) : null,
    effects: on ? $("#box-grid .pk-effects")?.textContent || null : null,
    incense: on ? $("#dex-title .pk-incense")?.textContent || null : null, // #79
    homeAgents: on ? [...document.querySelectorAll("#box-grid .pk-agent")].map((a) => a.textContent.replace(/\s+/g, " ").trim()) : null, // PKM-10 rule 6
    // the frame inside the window, the hint row at its bottom (#38: a small window too)
    pokeFits: on ? (() => { const r = $("#dex .pk-window")?.getBoundingClientRect(), f = $("#dex .pk-window > footer")?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && !!f && f.bottom <= innerHeight + 1; })() : null,
  };
}
const typeIn = async (q) => { const b = $("#dex-search"); b.value = q; b.dispatchEvent(new Event("input", { bubbles: true })); await wait(200); };
const LAB = {
  state: () => labState(),
  view: async (v) => { await dexView(v); await wait(300); return dexState?.view; },
  search: (q) => typeIn(q),
  click: (sel) => { const b = $(sel); b?.click(); return !!b; },
  // 👜 who gets the candy / a stone (scenes): pick = true | "stone", then back
  pick: async (p) => { dexState.pick = p; dexState.stoneDone = null; await shopRender(); return true; },
  // 💎 the result in place (#94): the first card marked, the preview's message and buttons (the end state, no animation)
  stoneDone: async () => { const m = dexState.list?.[0]; if (!m) return false; dexState.stoneDone = { uid: m.uid, from: { name: "피츄", gif: null }, to: { name: m.name, gif: m.gif }, coins: 60, newCoins: 30, played: false }; await pickRender(); return true; },
  unpick: () => { dexState.stoneDone = null; dexState.pick = false; return true; },
  // #17: arrows inside the "새로 잡은" row, ↓ to the grid at that Pokémon, ↑ from the first line back
  async dexnav() {
    await dexView("dex");
    const st = () => `${dexState.zone}:${dexState.zone === "recent" ? dexState.ri : "-"}:#${dexState.sel}:${$("#dex-grid .cell.sel")?.closest(".recent") ? "row" : "grid"}`;
    const out = [`open=${st()} cols=${dexCols()}`];
    for (const k of ["ArrowRight", "ArrowRight", "ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowUp", "End", "ArrowRight", "ArrowDown", "ArrowUp", "ArrowUp", "ArrowLeft", "ArrowDown", "n"]) {
      const handled = dexKey(new KeyboardEvent("keydown", { key: k }));
      out.push(`${k}${handled ? "" : "(unhandled)"}=${st()}`);
    }
    document.querySelector('#dex-grid .cells.recent .cell[data-ri="1"]').click();
    out.push(`click-row-1=${st()}`);
    document.querySelector('#dex-grid .cells:not(.recent) .cell[data-n="7"]').click();
    out.push(`click-grid-7=${st()}`);
    dexRecent(3);
    out.push(`open-at-end=${dexOpen()}`);
    return out.join(" ");
  },
  // #21 #22 #24: GO-style search terms, typing in the box (letters don't move the dex), Enter → first hit
  async dexsearch() {
    await dexView("dex");
    const out = {};
    for (const q of ["전설", "환상", "전설,환상", "전설&!못만남", "p1", "불꽃", "물", "1-5", "new", "age0", "age1", "파트너", "불꽃,물", "잡음&!관동", "!잡음&관동", "못만남", "#37", "성도"]) {
      dexQuery = q; dexFilter(); out[q] = dexState.hits.length <= 3 ? dexState.hits.join("/") : dexState.hits.length;
    }
    dexQuery = ""; dexFilter();
    out.cleared = dexState.hits;
    const sel0 = dexState.sel;
    dexKey(new KeyboardEvent("keydown", { key: "/" }));
    out.focused = document.activeElement?.id;
    for (const [key, code, keyCode] of [["h", "KeyH", 72], ["p", "KeyP", 80], ["1", "Digit1", 49], ["5", "Digit5", 53]]) await invoke("key_test", { key, code, keyCode, text: key });
    await wait(200);
    out.typed = `${$("#dex-search").value}|sel-unchanged=${dexState.sel === sel0}|found=${$("#dex-found").textContent}`;
    await invoke("key_test", { key: "Backspace", code: "Backspace", keyCode: 8 });
    await typeIn("p15");
    await invoke("key_test", { key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
    await wait(200);
    out.enter = `sel=${dexState.sel} focus=${document.activeElement?.id || document.activeElement?.tagName} still-open=${dexOpen()}`;
    dexKey(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    out.right = dexState.sel;
    await typeIn("불꽃,물");
    dexSelect(1); dexKey(new KeyboardEvent("keydown", { key: "ArrowRight" })); const r1 = dexState.sel;
    dexKey(new KeyboardEvent("keydown", { key: "ArrowRight" })); out.step = `${r1}>${dexState.sel}`;
    const vis = () => shownCells("#dex-grid .cells:not(.recent) .cell").map((c) => c.dataset.n).join(",");
    const heads = () => [...document.querySelectorAll("#dex-grid h4")].filter((h) => !h.hidden).map((h) => h.textContent.trim()).join("|");
    out.filter = `grid=${vis()} heads=${heads()} row=${shownCells("#dex-grid .cells.recent .cell").length} found=${$("#dex-found").textContent}`;
    await typeIn("p1");
    dexSelect(1);
    const nav = [];
    for (const k of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "ArrowUp", "ArrowRight", "ArrowDown", "End", "Home"]) {
      dexKey(new KeyboardEvent("keydown", { key: k }));
      nav.push(`${k}=${dexState.zone}:${dexState.zone === "recent" ? dexState.ri : "#" + dexState.sel}`);
    }
    out.nav = `grid=${vis()} row=${shownCells("#dex-grid .cells.recent .cell").map((c) => c.dataset.n).join(",")} ${nav.join(" ")}`;
    await typeIn("불꽃&전설");
    out.empty = `shown=${!$("#dex-empty").hidden} text=${$("#dex-empty").textContent} heads=${heads()} preview=${$(".dex-preview").style.visibility}`;
    $("#dex-clear").click();
    await typeIn("불꽃,물");
    const btns = () => [...document.querySelectorAll("#dex-regions button[data-a]")].map((b) => `${b.textContent.trim()}${b.disabled ? "(off)" : ""}`).join("|");
    out.regions = btns();
    dexSelect(1); document.querySelector('#dex-regions button[data-a="1"]').click(); out.regionClick = dexState.sel;
    document.querySelector('#dex-regions button[data-a="152"]').click(); out.disabledClick = dexState.sel;
    await typeIn("");
    out.regionsCleared = btns();
    return out;
  },
  // #27 "내 포켓몬": cards, the five sorts, search, the take button, arrows (taking one closes the window — last)
  async box() {
    const out = {};
    await dexView("box");
    const ids = () => dexState.list.map((m) => m.id).join(",");
    out.title = $("#dex-title .pk-tabs").textContent.trim();
    out.cards = [...document.querySelectorAll("#box-grid .pk-card")].map((c) => c.textContent.replace(/\s+/g, " ").trim()).join(" | ");
    for (const [k] of BOX_SORTS) { $("#box-sort").value = k; $("#box-sort").dispatchEvent(new Event("input", { bubbles: true })); out[`sort-${k}`] = ids(); }
    $("#box-sort").value = "recent"; $("#box-sort").dispatchEvent(new Event("input", { bubbles: true }));
    for (const q of ["파트너", "age0", "new", "불꽃", "zzz"]) { await typeIn(q); out[`q-${q}`] = ids() || $("#box-empty")?.textContent; }
    $("#box-clear")?.click();
    out.cleared = ids();
    const at = (id) => dexState.list.findIndex((m) => m.id === id);
    const btn = () => `${$("#dex-take").textContent}${$("#dex-take").disabled ? "(off)" : ""}`;
    boxSelect(at(134)); out.btnHere = btn();
    boxSelect(at(222)); out.btnOther = btn(); await boxTake(); out.btnOther2 = btn();
    boxSelect(at(418)); out.btnRest = btn(); out.meta = $("#dex-meta").textContent;
    const nav = [];
    boxSelect(0);
    for (const k of ["ArrowRight", "ArrowRight", "ArrowLeft", "End", "Home", "ArrowDown"]) { boxKey(k); nav.push(`${k}=${dexState.bi}`); }
    out.nav = nav.join(" ");
    dexKey(new KeyboardEvent("keydown", { key: "m" })); out.toggled = `${dexState.view} grid-hidden=${$("#dex-grid").hidden}`;
    dexKey(new KeyboardEvent("keydown", { key: "m" })); out.back = dexState.view;
    boxSelect(at(37));
    return out;
  },
  take: (id) => { boxSelect(dexState.list.findIndex((m) => m.id === id)); return boxTake(); },
  // the old in-page checks (src/main.js — x1e, first run, new user, wild, poke): the window's data, a card by key, Enter …
  d: () => { const d = dexState; if (!d) return null; const o = d.chooseOpts, p = d.opts;
    const lite = (m) => m && { id: m.id, uid: m.uid, name: m.name, types: m.types, folderName: m.folderName };
    return { view: d.view, sel: d.sel, zone: d.zone, ri: d.ri, bi: d.bi, recent: d.recent?.length || 0, hits: d.hits, chooseNote: d.chooseNote || "",
      choose: o ? { starter: o.starter ? { ready: !!o.starter.ready, set: o.starter.set.map(lite) } : null, resting: o.resting.map(lite), others: o.others.map(lite), current: lite(o.current) } : null,
      opts: p ? { resting: p.resting.map(lite), others: p.others.map(lite), current: lite(p.current) } : null,
      owned: d.entries.filter((e) => e.owned > 0).map((e) => e.id), seenOnly: d.entries.filter((e) => !e.caught).map((e) => e.id),
      list: (d.list || []).map((m) => ({ key: m.key, id: m.id, uid: m.uid, name: m.name })) }; },
  pickKey: (key) => { boxSelect(dexState.list.findIndex((m) => m.key === key)); return !!$(`#box-grid .pk-card[data-key="${key}"].sel`); },
  enter: () => boxTake(),
  select: (n) => { dexSelect(n); return dexState.sel; },
  choose: () => dexChoose(),
  key: (k) => dexKey(new KeyboardEvent("keydown", { key: k })),
  rect: (sel) => { const r = $(sel)?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; },
  text: (sel) => $(sel)?.textContent ?? null,
  count: (sel) => document.querySelectorAll(sel).length,
};

// ── open: what the main process asked for, with what it keeps (the last view, the search), this tab ───────────────
invoke("poke_state").then(async (st) => {
  tab = st.tab || null; test = st.test || null;
  dexQuery = st.kept?.query || ""; dexLastView = st.kept?.view || "dex";
  if (test) window.lab = LAB;
  if (test?.ui_scenes) document.body.classList.add("ui-test"); // no animation, no blinking: same picture every run
  prog = await invoke("progress_state").catch(() => null);
  await openDex(st.want?.sel || undefined, st.want?.view || undefined);
}).catch((e) => invoke("poke_log", { line: `open failed ${e?.message || e}` }).catch(() => {}));
