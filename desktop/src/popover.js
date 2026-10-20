// 메뉴바 미니 대시보드 (STA-22, #105): the menu bar icon's left click. The main process sends the model
// (popoverModel in electron/main.cjs) when it opens and whenever something on it changes; this draws it.
// The page may call only its own short list of commands (popoverCommands — POL-SEC-02).
import { invoke, listen } from "./host.js";
import { DOING, esc } from "./overlay-view.js";
import { lvLine } from "./poke/card.js";
import { createWild } from "./wild.js";

const $ = (s) => document.querySelector(s);
const WORKING = ["thinking", "coding", "reading", "searching", "bash", "agent", "tool", "compact"];
const AGENTS = [["claude", "Claude"], ["codex", "Codex"]];
const TAB_MAX = 8;

// 테마 (APP-20): the app sets macOS's appearance for itself — follow it like the overlay
const darkMedia = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => { document.documentElement.dataset.theme = darkMedia.matches ? "dark" : "light"; };
applyTheme();
darkMedia.addEventListener("change", applyTheme);

const sprites = new Map(); // gif path → data: URL (the cache file, read once)
const sprite = (gif) => {
  if (!gif) return Promise.resolve(null);
  if (!sprites.has(gif)) sprites.set(gif, invoke("sprite_b64", { path: gif }).then((b) => `data:image/gif;base64,${b}`).catch(() => null));
  return sprites.get(gif);
};

const level = (p) => (p >= 80 ? "lv-bad" : p >= 50 ? "lv-warn" : "lv-ok"); // STA-08 rule 2
const live = (w, now) => w && Number.isFinite(w.pct) && (w.resets_at == null || w.resets_at * 1000 > now);
function until(sec, now) {
  if (!sec) return "";
  const m = Math.max(0, Math.round((sec * 1000 - now) / 60000));
  return m >= 1440 ? `${Math.floor(m / 1440)}일 ${Math.floor((m % 1440) / 60)}시간` : m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
}
const ago = (t, now) => { const m = Math.round((now - t) / 60000); return m < 1 ? "방금" : m < 60 ? `${m}분 전` : `${Math.round(m / 60)}시간 전`; };

let model = null;

async function drawPartner(m) {
  const p = m.partner, root = $("#pop-partner");
  if (!p) { root.innerHTML = `<div class="pop-none">${m.folder ? `${esc(m.folder)} — 이 탭엔 파트너가 없어요` : "열린 탭이 없어요"}</div>`; return; }
  const goal = p.final || p.grad ? 100 : p.next?.level || null;
  const pct = goal && p.lv ? Math.min(100, Math.round((p.lv / goal) * 100)) : null;
  const prog = m.prog || {};
  const chips = [prog.inc && `알 ${prog.inc.have}/${prog.inc.need}`, prog.stamps && `스탬프 ${prog.stamps.n}/${prog.stamps.need}`, prog.research && `리서치 ${prog.research.done}/${prog.research.of}`].filter(Boolean);
  root.innerHTML = `<div class="pop-sprite"><img alt="" /></div>
    <div class="pop-who"><div><span class="pop-name">${esc(p.name)}${p.shiny ? " ✨" : ""}</span> <span class="pop-lv">${esc(lvLine(p))}</span></div>
      ${pct != null ? `<div class="pop-bar"><i style="width:${pct}%"></i></div>` : ""}
      <div class="pop-chips"><span>${esc(m.folder || "")}</span>${chips.map((c) => `<span>· ${esc(c)}</span>`).join("")}</div></div>`;
  const src = await sprite(p.gif);
  const img = root.querySelector("img");
  if (src && img) img.src = src;
}

function drawToday(m) {
  const t = m.today || {}, c = m.coins;
  $("#pop-today").innerHTML = `<div class="pop-stat"><small>오늘 완료</small><b>${t.today ?? 0}</b></div>
    <div class="pop-stat"><small>연속</small><b>${t.streak ?? 0}일</b></div>
    <div class="pop-stat"><small>오늘 코인</small><b class="pop-coin">${c ? `+${c.today.earned.toLocaleString("en-US")}` : "—"}</b></div>`;
}

function drawLimits(m, now) {
  const rows = [];
  for (const [k, name] of AGENTS) {
    const u = m.usage?.[k] || {};
    const ws = [["5h", u.five_hour], ["7d", u.seven_day]].filter(([, w]) => live(w, now));
    ws.forEach(([kk, w], i) => rows.push(`<span class="ag">${i ? "" : name}</span><span class="k">${kk}</span>
      <span class="gauge"><i class="${level(w.pct)}" style="width:${Math.min(100, Math.max(0, w.pct))}%"></i></span>
      <span class="pct">${Math.round(w.pct)}%</span><span class="until">${esc(until(w.resets_at, now))}</span>`));
  }
  const L = m.limits || {}, st = L.state || {};
  const last = Math.max(st.claude?.at || 0, st.codex?.at || 0);
  const need = L.claude && (!L.token || st.claude?.error === "expired");
  const note = need ? "Claude는 눌러야 읽어요" : last ? ago(last, now) : "";
  $("#pop-limits").innerHTML = `<div class="pop-h"><span>사용 한도</span>${L.codex || L.claude ? `<button id="pop-refresh" title="지금 다시 읽기">↻ 새로 고침${note ? ` · ${esc(note)}` : ""}</button>` : ""}</div>
    ${rows.length ? `<div class="pop-lim">${rows.join("")}</div>` : '<div class="pop-limits-none">에이전트가 아직 알려 주지 않았어요</div>'}`;
}

// needs you → failed → working → finished → resting (as the menu, STA-19)
function drawTabs(m) {
  const rank = (t) => (t.state === "waiting" ? 0 : t.ended === "error" ? 1 : WORKING.includes(t.state) ? 2 : t.ended === "done" ? 3 : 4);
  const tabs = [...(m.tabs || [])].sort((a, b) => rank(a) - rank(b));
  if (!tabs.length) { $("#pop-tabs").innerHTML = ""; return; }
  const row = (t) => {
    const r = rank(t), cls = ["waiting", "error", "working", "done", ""][r];
    const what = t.ended === "error" ? "실패" : r === 3 ? "완료" : DOING[t.state] || "대기";
    return `<button class="pop-tab${r === 0 ? " urgent" : ""}" data-ws="${esc(t.ws)}"><span class="dot ${cls}"></span><span class="nm">${esc(t.name)}</span><span class="st">${esc(what)}${t.active ? " · 지금 탭" : ""}</span></button>`;
  };
  $("#pop-tabs").innerHTML = `<div class="pop-h"><span>Tamer 탭</span></div>${tabs.slice(0, TAB_MAX).map(row).join("")}${tabs.length > TAB_MAX ? `<div class="pop-more">외 ${tabs.length - TAB_MAX}개 탭</div>` : ""}`;
}

function draw(m) {
  if (!m) return;
  model = m;
  const now = Date.now();
  drawPartner(m);
  drawToday(m);
  drawLimits(m, now);
  drawTabs(m);
}

// 야생 (rule 3): the wild card as in the main window — throw here (click / ⌘B); "도감에서 보기" opens Tamer
const wild = createWild($("#pop-wild"), {
  invoke,
  log: (line) => invoke("popover_log", { line }).catch(() => {}),
  dexButton: (e) => invoke("popover_dex", { id: e.id }),
});
listen("wild", (e) => wild.show(e.payload));
listen("wild-throw", (e) => wild.play(e.payload));
listen("wild-end", (e) => wild.end(e.payload));
listen("popover", (e) => draw(e.payload));

document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.id === "pop-refresh") { t.textContent = "↻ 읽는 중…"; invoke("limits_refresh", { user: true }).catch(() => {}); }
  else if (t.id === "pop-open") invoke("popover_open");
  else if (t.id === "pop-settings") invoke("popover_settings");
  else if (t.dataset.ws) invoke("popover_tab", { ws: t.dataset.ws });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") invoke("popover_hide");
  else if (e.metaKey && e.key.toLowerCase() === "b") { e.preventDefault(); wild.throwBall(); }
});

// the window follows the content's height
new ResizeObserver(() => invoke("popover_fit", { height: $("#pop").offsetHeight })).observe($("#pop"));
invoke("popover_state").then((m) => { draw(m); if (m.wild) wild.show({ ...m.wild, balls: m.balls }); }).catch(() => {});
setInterval(() => { if (model && !document.hidden) drawLimits(model, Date.now()); }, 30000); // 초기화까지 · n분 전
