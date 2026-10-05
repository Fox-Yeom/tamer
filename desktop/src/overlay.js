// Desktop overlay (X1d): shown while another app is in front. The current tab's partner, tabs
// that need you / are working / just finished, and wild encounters. Click a card → that tab;
// drag → move (remembered). The window is see-through except over the cards.
import { invoke, listen } from "./host.js";
import { createWild } from "./wild.js";
import { timing, dur, MINUTE } from "./elapsed.js";
import { failLabel } from "./fail.js";

const ICON = {
  idle: "😌", sleep: "💤", thinking: "💭", coding: "⌨️", reading: "📖", searching: "🔍",
  bash: "💻", agent: "🤝", tool: "🛠", waiting: "❓", done: "🎉", compact: "🗜", error: "💥", interrupted: "⏹",
};
// how the last turn ended → bubble
const ENDED = { done: ["ok", "✅ 완료!"], interrupted: ["dim", "⏹ 중단됨"], error: ["bad", "💥 실패"] };
const DOING = {
  idle: "대기", sleep: "쉬는 중", thinking: "생각 중", coding: "편집", reading: "읽는 중", searching: "검색",
  bash: "실행", agent: "하위 에이전트", tool: "도구", waiting: "입력 필요", done: "완료", compact: "압축 중", error: "실패", interrupted: "중단됨",
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const sprites = new Map(); // gif path -> data URL

async function spriteUrl(gif) {
  if (!gif) return null;
  if (!sprites.has(gif)) sprites.set(gif, invoke("sprite_b64", { path: gif }).then((b) => `data:image/gif;base64,${b}`).catch(() => null));
  return sprites.get(gif);
}

// caught from the overlay: "도감에서 보기" brings Tamer to the front with the Pokédex on it (#25)
const wild = createWild(document.getElementById("wild"), { invoke, dexButton: (e) => invoke("wild_dex", { id: e.id }) });
// state colour of a small icon (needs you / failed / working / done / idle)
let stallMs; // from the payload (tests shorten it)
const tm = (t) => timing(t.times, { stallMs });
const DOT = (t) => (t.state === "waiting" ? "bad" : t.ended === "error" ? "bad" : t.ended === "done" ? "ok"
  : ["idle", "sleep", "done", "interrupted", "error"].includes(t.state) ? "idle" : tm(t).stall ? "stall" : "work");
// unattended runs (STA-20): the card's state line — · 12분, · 4분째, ⏳ 변화 없음
function stateLine(t) {
  const x = tm(t);
  if (x.stall && t.state !== "waiting") return `⏳ 변화 없음 ${x.stall}`;
  return `${ICON[t.state] || ""} ${DOING[t.state] || ""}${x.run ? ` · ${x.run}` : x.wait ? ` · ${x.wait}째` : ""}`;
}

async function bigCard(t, extra = "") {
  const url = await spriteUrl(t.partner?.gif);
  const end = ENDED[t.ended];
  // a finished shell shows even while another shell of the folder needs you (both bubbles)
  const took = t.ended === "done" && t.times?.took >= MINUTE ? ` · ${dur(t.times.took)}` // STA-20
    : t.ended === "error" && failLabel(t.endedKind || t.times?.kind) ? ` · ${failLabel(t.endedKind || t.times?.kind)}` : ""; // #53
  const endBubble = end ? `<div class="bubble ${end[0]}${t.state === "waiting" ? " second" : ""}">${t.endedN ? `셸 ${t.endedN} ` : ""}${end[1]}${took}</div>` : "";
  const bubble = (t.state === "waiting" ? '<div class="bubble bad">❗ 입력 필요</div>' : "") + endBubble;
  const motion = t.state === "waiting" ? "st-waiting" : ["done", "interrupted", "error", "idle", "sleep"].includes(t.state) ? `st-${t.state}` : "st-working";
  return `<div class="card hit${t.active ? " current" : ""}" data-ws="${esc(t.ws)}" title="클릭: 이 탭으로 · 드래그: 이동${t.active ? " · 더블클릭: 접기/펴기" : ""}">
    ${bubble}
    <div class="row"><div class="sprite">${url ? `<img class="poke ${motion}" src="${url}" alt="" />` : t.partner ? '<div class="pokeball"></div>' : '<div class="empty-ball" title="파트너가 없어요"></div>'}</div>
    <div class="meta"><div class="name">${esc(t.partner ? `${t.partner.shiny ? "✨" : ""}${t.partner.name}` : "파트너 없음")}${t.sessions > 1 ? ` <span class="sess-badge" title="이 폴더의 셸 수">셸 ${t.sessions}개</span>` : ""}</div>
      <div class="folder">${esc(t.name)}</div><div class="state${tm(t).stall && t.state !== "waiting" ? " stall" : ""}" title="${tm(t).stall ? "새 이벤트가 없어요 — 멈췄을 수 있어요(추정)" : ""}">${esc(stateLine(t))}</div></div></div>
    ${extra}
  </div>`;
}

let last = null;
async function render(p) {
  last = p;
  stallMs = p.stallMs;
  const box = document.getElementById("cards");
  // every other tab: a small icon + state dot, then the counts (same as the top bar)
  const minis = await Promise.all((p.minis || []).map(async (t) => {
    const url = await spriteUrl(t.partner?.gif);
    return `<span class="mini hit" data-ws="${esc(t.ws)}" title="${esc(t.name)} — ${DOING[t.state] || ""}">${url ? `<img src="${url}" alt="" />` : "·"}<i class="dot ${DOT(t)}"></i></span>`;
  }));
  const c = p.counts || {};
  const counts = [["bad", "❗", c.waiting], ["", "⌨️", c.working], ["ok", "✅", c.done], ["bad", "💥", c.error]]
    .filter(([, , n]) => n > 0).map(([cls, icon, n]) => `<span class="${cls}">${icon}${n}</span>`).join(" ");
  const strip = minis.length || p.more || (counts && !p.collapsed)
    ? `<div class="minis">${minis.join("")}${p.more ? `<span class="more">+${p.more}</span>` : ""}<span class="counts">${counts}</span></div>` : "";
  const cards = [];
  if (p.urgent) cards.push(await bigCard(p.urgent));
  if (p.current) cards.push(await bigCard(p.current, strip));
  else if (strip) cards.push(`<div class="card">${strip}</div>`);
  box.innerHTML = cards.join("");
  box.querySelectorAll(".poke").forEach((img) => img.decode().then(() => {
    const k = img.closest(".current") ? 2 : 1;
    img.style.width = `${Math.min(img.naturalWidth * k, k === 2 ? 120 : 64)}px`;
  }).catch(() => {}));
}

listen("overlay", (e) => render(e.payload));
// the times move on their own (STA-20): redraw the last state now and then
setInterval(() => { if (last && !drag) render(last); }, 15000);
listen("wild", (e) => wild.show(e.payload));
listen("wild-throw", (e) => wild.play(e.payload));
listen("wild-end", (e) => wild.end(e.payload));

// ── pointer: see-through except over cards; click = go to the tab; drag = move ──
let over = false;
let drag = null;
function setOver(v) {
  if (v === over) return;
  over = v;
  invoke("overlay_mouse", { over: v });
}
document.addEventListener("mousemove", (e) => {
  // the button was released where we didn't hear it (outside / app switch): the drag is over —
  // otherwise the overlay would follow the pointer the next time it comes near
  if (drag && !(e.buttons & 1)) { endDrag(e, false); return; }
  if (drag) {
    if (Math.abs(e.screenX - drag.x) + Math.abs(e.screenY - drag.y) > 4) drag.moved = true;
    if (drag.moved) invoke("overlay_drag", { phase: "move", x: e.screenX, y: e.screenY });
    return;
  }
  setOver(!!e.target.closest?.(".hit, .wild-card:not([hidden])"));
});
document.addEventListener("mouseleave", () => { if (!drag) setOver(false); });
document.addEventListener("mousedown", (e) => {
  const card = e.target.closest(".hit, .wild-card");
  if (!card || e.target.closest("button")) return;
  e.preventDefault();
  drag = { x: e.screenX, y: e.screenY, moved: false, ws: e.target.closest("[data-ws]")?.dataset.ws };
  invoke("overlay_drag", { phase: "start", x: e.screenX, y: e.screenY });
});
function endDrag(e, click) {
  const d = drag;
  drag = null;
  if (d.moved) invoke("overlay_drag", { phase: "end", x: e.screenX, y: e.screenY });
  else if (click && d.ws) invoke("overlay_click", { ws: d.ws });
}
document.addEventListener("mouseup", (e) => { if (drag) endDrag(e, true); });
window.addEventListener("blur", () => { drag = null; });

// the window follows the cards' size (see main.cjs overlay_fit)
const stack = document.getElementById("stack");
new ResizeObserver(() => invoke("overlay_fit", { width: stack.offsetWidth, height: stack.offsetHeight })).observe(stack);

// double-click the current tab's card: fold to just the partner / unfold
document.addEventListener("dblclick", (e) => { if (e.target.closest(".card.current")) invoke("overlay_collapse"); });

invoke("overlay_state").then((p) => { render(p); if (p.wild) wild.show(p.wild); });
