// 설정 창 (APP-19 · APP-22 rule 9, #113 P1): a window of its own, so it opens with no terminal window (APP-22
// rule 8). The main process keeps ui/settings.json; this shows it and sends changes (it answers with the checked
// settings, broadcast to every window). The page may call only its own short list of commands
// (settingsCommands — POL-SEC-02).
import { invoke, listen } from "./host.js";
import { cardsHtml, sizePokes, applyShow, wildNoteHtml } from "./overlay-view.js";
import { MINUTE } from "./elapsed.js";

const $ = (s) => document.querySelector(s);
const root = $("#settings");

// 테마 (APP-20): the main process sets macOS's appearance for the app (settings.theme) — follow it
const darkMedia = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => { document.documentElement.dataset.theme = darkMedia.matches ? "dark" : "light"; };
applyTheme();
darkMedia.addEventListener("change", applyTheme);

let settingsNow = null;
const getPath = (o, k) => k.split(".").reduce((x, p) => x?.[p], o);
function applySettings(s) {
  if (!s) return;
  settingsNow = s;
  for (const el of root.querySelectorAll("input[data-set]")) {
    const v = getPath(s, el.dataset.set);
    if (el.type === "checkbox") el.checked = !!v; else el.value = v;
  }
  // a few choices: segment buttons — the one set is on
  for (const seg of root.querySelectorAll(".seg[data-set]")) {
    const v = getPath(s, seg.dataset.set);
    for (const b of seg.querySelectorAll("button")) { b.classList.toggle("on", b.dataset.v === v); b.setAttribute("aria-pressed", String(b.dataset.v === v)); }
  }
  for (const el of root.querySelectorAll("[data-val]")) el.textContent = `${getPath(s, el.dataset.val)}${el.dataset.unit || "%"}`;
  $(".set-group").classList.toggle("off", !s.overlay.on);
  $(".set-mb").classList.toggle("off", !s.menubar.on);
  if (setPage === "overlay") renderPreview(s.overlay);
}

// 미리보기 (#67): the overlay as these settings would draw it — the tab in front's partner, a tab that needs
// you, three sample tabs and a wild notice, with the overlay's own drawing code (src/overlay-view.js).
// The partners come from the main process (APP-22 rule 2): names and pictures only
const sprites = new Map();
const spriteUrl = (gif) => {
  if (!gif) return Promise.resolve(null);
  if (!sprites.has(gif)) sprites.set(gif, invoke("sprite_b64", { path: gif }).then((b) => `data:image/gif;base64,${b}`).catch(() => null));
  return sprites.get(gif);
};
let previewSeq = 0;
async function renderPreview(show) {
  const seq = ++previewSeq, now = Date.now(), ov = $(".set-preview-desk .ov");
  const pv = await invoke("settings_preview").catch(() => ({}));
  const others = pv.others || [];
  const tab = (ws, name, state, partner, extra = {}) => ({ ws, name, state, partner: partner || null, sessions: 1, times: {}, ...extra });
  const current = tab("pv-now", pv.folder || "my-project", "coding", pv.partner, { active: true, times: { turn_at: now - 12 * MINUTE } });
  const p = {
    show, current, urgent: tab("pv-wait", "api-server", "waiting", others[0]),
    minis: [tab("pv-1", "web", "coding", others[1]), tab("pv-2", "docs", "idle", others[2], { ended: "done" }), tab("pv-3", "notes", "sleep", others[3])],
    more: 0, counts: { waiting: 1, working: 2, done: 1, error: 0 },
    prog: { inc: { name: "알", have: 9, need: 10, soon: true }, stamps: { n: 6, need: 7, soon: true } }, // 진행 견본 (#88 #90)
  };
  const off = !show.on || !(show.partner || show.alerts || show.wild || show.progress);
  const html = off ? "" : await cardsHtml(p, { spriteUrl });
  if (seq !== previewSeq) return; // a newer change drew meanwhile
  applyShow(ov, show);
  ov.querySelector(".ov-cards").innerHTML = html;
  ov.querySelector(".ov-wild").innerHTML = !off && show.wild ? wildNoteHtml({ name: "피카츄" }, null) : "";
  ov.querySelector(".wild-note-timer")?.replaceChildren("· 24초");
  await sizePokes(ov, show.size);
  if (seq !== previewSeq) return;
  // 포켓몬 크기 (#127, APP-19 rule 14): a big partner taller / wider than the sample desktop — drawn smaller, from the bottom-right
  const desk = ov.parentElement, pad = getComputedStyle(ov); // its top / left padding is empty room — not counted
  const k = Math.min(1, desk.clientHeight / (ov.offsetHeight - parseFloat(pad.paddingTop)), desk.clientWidth / (ov.offsetWidth - parseFloat(pad.paddingLeft)));
  ov.style.transformOrigin = "100% 100%"; ov.style.transform = k < 1 ? `scale(${k.toFixed(3)})` : "";
  $(".set-preview-small").hidden = !(k < 1);
  $(".set-preview-off").hidden = !off;
}

const PRESETS = { // 빠른 선택
  all: { on: true, partner: true, alerts: true, wild: true, progress: true }, pokemon: { on: true, partner: true, alerts: false, wild: true, progress: true },
  wild: { on: true, partner: false, alerts: false, wild: true, progress: false }, off: { on: false }, // 진행 (#88)
};
async function setSetting(key, value) {
  const [a, b] = key.split(".");
  applySettings(await invoke("settings_set", { patch: b ? { [a]: { [b]: value } } : { [a]: value } }));
}
// one of the sidebar's kinds at a time (#101) — the main process remembers the last one while the app runs
let setPage = "general";
function settingsPage(page) {
  setPage = page;
  for (const b of root.querySelectorAll(".set-nav button")) b.classList.toggle("on", b.dataset.page === page);
  for (const el of root.querySelectorAll(".set-page")) el.hidden = el.dataset.page !== page;
  if (page === "overlay" && settingsNow) renderPreview(settingsNow.overlay); // the 미리보기 lives on this page only
  invoke("settings_page", { page }).catch(() => {});
}

root.addEventListener("change", (e) => {
  const k = e.target.dataset?.set, t = e.target.type;
  if (k) setSetting(k, t === "checkbox" ? e.target.checked : t === "range" ? Number(e.target.value) : e.target.value);
});
root.addEventListener("input", (e) => {
  const k = e.target.dataset?.set, el = k && e.target.type === "range" && $(`[data-val="${k}"]`);
  if (!el) return;
  el.textContent = `${e.target.value}${el.dataset.unit || "%"}`;
  if (k !== "overlay.size" || !settingsNow) return;
  // the 미리보기 and the desktop overlay follow the drag (#127, APP-19 rule 14); saved on release
  renderPreview({ ...settingsNow.overlay, size: Number(e.target.value) });
  invoke("overlay_size_try", { size: Number(e.target.value) }).catch(() => {});
});
root.addEventListener("click", async (e) => {
  const pg = e.target.closest(".set-nav button")?.dataset.page;
  if (pg) return settingsPage(pg);
  const v = e.target.closest(".seg button");
  if (v) return setSetting(v.closest(".seg").dataset.set, v.dataset.v);
  const p = e.target.dataset?.preset;
  if (p) applySettings(await invoke("settings_set", { patch: { overlay: PRESETS[p] } }));
});
// Esc · ⌘W: close this window (only this one — never a terminal tab)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" || (e.metaKey && e.key.toLowerCase() === "w")) { e.preventDefault(); invoke("settings_close"); }
});

// 한도 (#104): when each was last read · Claude needs a press when the login wasn't read by itself (#115 A1)
const agoText = (t) => { const m = Math.round((Date.now() - t) / MINUTE); return m < 1 ? "방금" : m < 60 ? `${m}분 전` : `${Math.round(m / 60)}시간 전`; };
function limitsStateShow(v) {
  if (!v) return;
  const part = (name, on, s, needs) => (!on ? null : needs ? `${name} 눌러야 읽어요` : s?.error && !s.at ? `${name} 못 읽음` : s?.at ? `${name} ${agoText(s.at)}` : null);
  const t = [part("Codex", v.codex, v.state?.codex), part("Claude", v.claude, v.state?.claude, !v.token || v.state?.claude?.error === "expired")].filter(Boolean).join(" · ");
  $("#set-limits-state").textContent = t || "상단 바 5h·7d를 눌러도 돼요";
}
listen("limits-state", (e) => limitsStateShow(e.payload));
$("#set-limits-refresh").addEventListener("click", () => invoke("limits_refresh", { user: true }).then(limitsStateShow).catch(() => {}));
listen("settings", (e) => applySettings(e.payload));
listen("settings-page", (e) => settingsPage(e.payload?.page || setPage)); // opened again on another kind (⌘, · a menu)

invoke("settings_state").then((r) => { settingsPage(r.page || "general"); applySettings(r.settings); limitsStateShow(r.limits); }).catch(() => {});
