// Desktop overlay (X1d): shown while another app is in front. The current tab's partner, tabs
// that need you / are working / just finished, and a wild Pokémon's notice. Click a card → that tab;
// click the notice → Tamer, to catch it there (#66); drag → move (remembered). The window is
// see-through except over the cards. The cards themselves: src/overlay-view.js (the 설정 창's
// preview draws the same).
import { invoke, listen } from "./host.js";
import { cardsHtml, sizePokes, applyShow, wildNoteHtml } from "./overlay-view.js";

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
let show = {}; // what the 설정 창 lets through (#59): partner · alerts · wild, background, shadow, minimal
async function render(p) {
  last = p;
  show = p.show || {};
  applyShow(stack, show);
  const box = document.getElementById("cards");
  box.innerHTML = await cardsHtml(p, { spriteUrl });
  sizePokes(box);
  if (hoverTip) showTip(hoverTip.ws, hoverTip.text);
  if (!show.wild) note.hide(); // 야생 포켓몬 off (#59): in the main window only
}

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

// ── 최소 모드 (#63): the hover line "폴더 — 상태" over the card under the pointer ──
let hoverTip = null;
function showTip(ws, text) {
  for (const t of document.querySelectorAll(".tip")) t.textContent = "";
  const card = [...document.querySelectorAll("#cards .card")].find((c) => c.querySelector(`[data-ws="${CSS.escape(ws)}"]`) || c.dataset.ws === ws);
  const tip = card?.querySelector(".tip");
  if (tip) tip.textContent = text;
}
function setTip(el) {
  const next = el ? { ws: el.dataset.ws, text: el.dataset.tip } : null;
  if (next?.ws === hoverTip?.ws && next?.text === hoverTip?.text) return;
  hoverTip = next;
  if (next) showTip(next.ws, next.text); else for (const t of document.querySelectorAll(".tip")) t.textContent = "";
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
function endDrag(e, click) {
  const d = drag;
  drag = null;
  if (d.moved) invoke("overlay_drag", { phase: "end", x: e.screenX, y: e.screenY });
  else if (click && d.act === "wild") invoke("wild_open");
  else if (click && d.ws) invoke("overlay_click", { ws: d.ws });
}
document.addEventListener("mouseup", (e) => { if (drag) endDrag(e, true); });
window.addEventListener("blur", () => { drag = null; });

// the window follows the cards' size (see main.cjs overlay_fit)
new ResizeObserver(() => invoke("overlay_fit", { width: stack.offsetWidth, height: stack.offsetHeight })).observe(stack);

// double-click the current tab's card: fold to just the partner / unfold
document.addEventListener("dblclick", (e) => { if (e.target.closest(".card.current")) invoke("overlay_collapse"); });

invoke("overlay_state").then((p) => { render(p); if (p.wild) note.show(p.wild); });
