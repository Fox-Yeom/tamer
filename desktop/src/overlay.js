// Desktop overlay (X1d): shown while another app is in front. The current tab's partner, tabs
// that need you / are working / just finished, and a wild Pokémon's notice. Click a card → that tab;
// click the notice → Tamer, to catch it there (#66); drag → move (remembered). The window is
// see-through except over the cards. The cards themselves: src/overlay-view.js (the 설정 창's
// preview draws the same).
import { invoke, listen } from "./host.js";
import { cardsHtml, sizePokes, applyShow, wildNoteHtml, hatchNoteHtml, evolveNoteHtml } from "./overlay-view.js";

const sprites = new Map(); // gif path -> data URL
async function spriteUrl(gif) {
  if (!gif) return null;
  if (!sprites.has(gif)) sprites.set(gif, invoke("sprite_b64", { path: gif }).then((b) => `data:image/gif;base64,${b}`).catch(() => null));
  return sprites.get(gif);
}

// 테마 (#60): the app sets macOS's appearance for itself — follow it like the main window
const darkMedia = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => { document.documentElement.dataset.theme = darkMedia.matches ? "dark" : "light"; };
applyTheme();
darkMedia.addEventListener("change", applyTheme);
const stack = document.getElementById("stack");
let last = null;
let popped = new Set(); // the bubbles of the last drawing (#114)
let show = {}; // what the 설정 창 lets through (#59): partner · alerts · wild, background, shadow, minimal
async function render(p) {
  last = p;
  show = p.show || {};
  applyShow(stack, show);
  const box = document.getElementById("cards");
  box.innerHTML = await cardsHtml(p, { spriteUrl });
  // a bubble already on screen keeps still: redraws come with every event, and each one popped it again (#114)
  const keys = new Set();
  for (const b of box.querySelectorAll(".bubble")) {
    const k = `${b.closest("[data-ws]")?.dataset.ws || b.closest("[data-act]")?.dataset.act || ""}|${b.textContent}`;
    if (popped.has(k)) b.classList.add("seen");
    keys.add(k);
  }
  popped = keys;
  sizePokes(box);
  if (hoverTip && stack.classList.contains("ov-minimal")) showTip(hoverTip.ws, hoverTip.text); else setTip(null);
  if (!show.wild) note.hide(); // 야생 포켓몬 off (#59): in the main window only
  if (show.progress === false) hatchNote.hide();
}

// ── 🐣 부화 알림 (#88, PKM-30 rule 5): 4 s under the wild notice; a click → Tamer's 내 포켓몬 ──
const hatchNote = (() => {
  const root = document.getElementById("hatch");
  let timer = null;
  const hide = () => { clearTimeout(timer); root.innerHTML = ""; };
  async function showNote(h) {
    if (!h || show.progress === false) return;
    const url = await spriteUrl(h.gif);
    root.innerHTML = hatchNoteHtml(h, url);
    clearTimeout(timer); timer = setTimeout(hide, 4000);
  }
  return { show: showNote, hide };
})();
listen("hatched", (e) => hatchNote.show(e.payload));
// ✨ 진화 알림 (#111): 5 s, under the wild notice — the 진행 setting doesn't hide it (it's the partner's news)
const evolveNote = (() => {
  const root = document.getElementById("evolve");
  let timer = null;
  const hide = () => { clearTimeout(timer); root.innerHTML = ""; };
  async function showNote(e) {
    if (!e || show.partner === false) return;
    root.innerHTML = evolveNoteHtml(e, await spriteUrl(e.gif));
    clearTimeout(timer); timer = setTimeout(hide, 5000);
  }
  return { show: showNote, hide };
})();
listen("evolved", (e) => evolveNote.show(e.payload));

// ── 야생 알림 (#66): the encounter's notice; ✕ closes it for this encounter only ──
const note = (() => {
  const root = document.getElementById("wild");
  let enc = null, tick = null;
  const closed = new Set(); // tokens
  function hide() { clearInterval(tick); enc = null; root.innerHTML = ""; }
  async function showNote(e) {
    if (!e || closed.has(e.token) || show.wild === false) return;
    enc = e;
    root.innerHTML = wildNoteHtml(e, await spriteUrl(e.gif));
    if (enc !== e) return;
    const t = root.querySelector(".wild-note-timer");
    const draw = () => { if (enc?.until) t.textContent = `· ${Math.max(0, Math.ceil((enc.until - Date.now()) / 1000))}초`; };
    clearInterval(tick); draw(); tick = setInterval(draw, 500);
    root.querySelector(".wild-note-close").addEventListener("click", () => { closed.add(e.token); hide(); });
  }
  return {
    show: showNote, hide,
    // a ball thrown in Tamer: caught / fled end it; a miss gives the clock back
    throw(r) { if (enc && r.token === enc.token && r.left) enc.until = Date.now() + r.left; },
    end(e) { if (enc && e.token === enc.token) hide(); },
  };
})();

listen("overlay", (e) => render(e.payload));
// the times move on their own (STA-20): redraw the last state now and then
setInterval(() => { if (last && !drag) render(last); }, 15000);
listen("wild", (e) => note.show(e.payload));
listen("wild-throw", (e) => note.throw(e.payload));
listen("wild-end", (e) => note.end(e.payload));

// ── 최소 모드 (#63): the hover line "폴더 — 상태" floating above the card under the pointer. It is
// out of the layout and its room is kept (overlay.css), so the window keeps its size (#68) ──
let hoverTip = null;
const tipEl = document.getElementById("tip");
function showTip(ws, text) {
  const card = [...document.querySelectorAll("#cards .card")].find((c) => c.dataset.ws === ws || c.querySelector(`[data-ws="${CSS.escape(ws)}"]`));
  if (!card) { tipEl.textContent = ""; return; }
  tipEl.textContent = text;
  // its right edge on the card's, just above it (over the card above, if any)
  tipEl.style.right = `${stack.clientWidth - card.offsetLeft - card.offsetWidth}px`;
  const lift = card.querySelector(":scope > .bubble") ? 12 : 0; // a bubble sticks out above the card
  tipEl.style.top = `${Math.max(2, card.offsetTop - lift - tipEl.offsetHeight - 3)}px`;
}
function setTip(el) {
  const next = el ? { ws: el.dataset.ws, text: el.dataset.tip } : null;
  if (next?.ws === hoverTip?.ws && next?.text === hoverTip?.text) return;
  hoverTip = next;
  if (next) showTip(next.ws, next.text); else tipEl.textContent = "";
}

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
  setOver(!!e.target.closest?.(".hit"));
  setTip(stack.classList.contains("ov-minimal") ? e.target.closest?.("[data-tip]") : null);
});
document.addEventListener("mouseleave", () => { if (!drag) { setOver(false); setTip(null); } });
document.addEventListener("mousedown", (e) => {
  const card = e.target.closest(".hit");
  if (!card || e.target.closest("button")) return;
  e.preventDefault();
  drag = { x: e.screenX, y: e.screenY, moved: false, ws: e.target.closest("[data-ws]")?.dataset.ws, act: e.target.closest("[data-act]")?.dataset.act };
  invoke("overlay_drag", { phase: "start", x: e.screenX, y: e.screenY });
});
// the wild notice's place in this page — the catch window sits beside it (#119)
function noteRect() {
  const r = document.querySelector("#wild .wild-note")?.getBoundingClientRect();
  return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
}
function endDrag(e, click) {
  const d = drag;
  drag = null;
  if (d.moved) invoke("overlay_drag", { phase: "end", x: e.screenX, y: e.screenY });
  else if (click && d.act === "wild") invoke("wild_open", { rect: noteRect() }); // the catch window beside it (#119)
  else if (click && d.act === "hatch") invoke("hatch_open");
  else if (click && d.act === "party") invoke("overlay_click", { ws: "" }); // 파티 card (#107): Tamer opens
  else if (click && d.ws) invoke("overlay_click", { ws: d.ws });
}
document.addEventListener("mouseup", (e) => { if (drag) endDrag(e, true); });
window.addEventListener("blur", () => { drag = null; });

// the window follows the cards' size (see main.cjs overlay_fit)
new ResizeObserver(() => invoke("overlay_fit", { width: stack.offsetWidth, height: stack.offsetHeight })).observe(stack);

// double-click the current tab's card: fold to just the partner / unfold
document.addEventListener("dblclick", (e) => { if (e.target.closest(".card.current")) invoke("overlay_collapse"); });

invoke("overlay_state").then((p) => { render(p); if (p.wild) note.show(p.wild); });
