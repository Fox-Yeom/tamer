// 메뉴바 (STA-19, #64): what the menu bar icon shows and its menu, as data — main.cjs turns it into
// a Tray and a native Menu (and a test reads it without putting an icon on anyone's menu bar).
// Items carry an `act` instead of a click: { tab: ws } · { set: patch } · "settings" · "open" ·
// "hide" · "quit".

const DOING = {
  idle: "대기", sleep: "쉬는 중", thinking: "생각 중", coding: "편집", reading: "읽는 중", searching: "검색",
  bash: "실행", agent: "하위 에이전트", tool: "도구", waiting: "입력 필요", done: "완료", compact: "압축 중", error: "실패", interrupted: "중단됨",
};
const WORKING = ["thinking", "coding", "reading", "searching", "bash", "agent", "tool", "compact"];
const AGENTS = [["claude", "✻ Claude Code"], ["codex", "◎ Codex"]];
const TAB_MAX = 10;

const live = (w, now) => w && Number.isFinite(w.pct) && (w.resets_at == null || w.resets_at * 1000 > now);
function untilText(sec, now) {
  const m = Math.max(0, Math.round((sec * 1000 - now) / 60000));
  return m >= 60 * 24 ? `${Math.round(m / 60 / 24)}일` : m >= 60 ? `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ""}` : `${m}분`;
}
// a tab's row: needs you → failed → working → finished → resting
function tabRow(t) {
  const [icon, rank] = t.state === "waiting" ? ["❗", 0] : t.ended === "error" ? ["💥", 1] : WORKING.includes(t.state) ? ["⌨️", 2]
    : t.ended === "done" ? ["✅", 3] : t.state === "sleep" ? ["💤", 4] : ["😌", 4];
  const doing = t.ended === "error" ? "실패" : t.ended === "done" && !WORKING.includes(t.state) && t.state !== "waiting" ? "완료" : DOING[t.state] || "대기";
  return { rank, item: { label: `${icon} ${t.name} — ${doing}${t.active ? " · 지금 탭" : ""}`, act: { tab: t.ws } } };
}

// tabs: [{ ws, name, state, ended, active }] · usage: { claude: { five_hour, seven_day } } · settings: readSettings()
function trayModel({ tabs = [], usage = {}, settings, now = Date.now() }) {
  const mb = settings.menubar, o = settings.overlay;
  const waiting = tabs.filter((t) => t.state === "waiting").length;
  const fives = AGENTS.map(([k]) => usage[k]?.five_hour).filter((w) => live(w, now)).map((w) => w.pct);
  const title = mb.text === "waiting" ? (waiting ? String(waiting) : "")
    : mb.text === "limit" ? (fives.length ? `${Math.round(Math.max(...fives))}%` : "") : "";

  const items = [];
  const rows = tabs.map(tabRow).sort((a, b) => a.rank - b.rank);
  if (!rows.length) items.push({ label: "열린 탭 없음", enabled: false });
  for (const r of rows.slice(0, TAB_MAX)) items.push(r.item);
  if (rows.length > TAB_MAX) items.push({ label: `외 ${rows.length - TAB_MAX}개 탭`, enabled: false });
  items.push({ type: "separator" });

  // 한도: the last values the agents reported (STA-08); none known → say so
  let any = false;
  for (const [k, name] of AGENTS) {
    const u = usage[k] || {}, f = live(u.five_hour, now) && u.five_hour, w = live(u.seven_day, now) && u.seven_day;
    if (!f && !w) continue;
    any = true;
    const parts = [f && `5시간 ${Math.round(f.pct)}%${f.resets_at ? ` (${untilText(f.resets_at, now)} 뒤 초기화)` : ""}`, w && `주간 ${Math.round(w.pct)}%`].filter(Boolean);
    items.push({ label: `${name}  ${parts.join(" · ")}`, enabled: false });
  }
  if (!any) items.push({ label: "한도: 에이전트가 아직 알려 주지 않았어요", enabled: false });
  items.push({ type: "separator" });

  const alphas = [100, 82, 50, 30, 0];
  if (!alphas.includes(o.alpha)) alphas.push(o.alpha);
  items.push(
    { label: "바탕화면 오버레이", type: "checkbox", checked: o.on, act: { set: { overlay: { on: !o.on } } } },
    { label: "오버레이 보일 것", enabled: o.on, submenu: [
      { label: "파트너", type: "checkbox", checked: o.partner, act: { set: { overlay: { partner: !o.partner } } } },
      { label: "알림", type: "checkbox", checked: o.alerts, act: { set: { overlay: { alerts: !o.alerts } } } },
      { label: "야생 포켓몬", type: "checkbox", checked: o.wild, act: { set: { overlay: { wild: !o.wild } } } },
    ] },
    { label: "최소 모드", enabled: o.on, submenu: [["auto", "배경 30% 이하일 때"], ["always", "항상"], ["never", "안 씀"]]
      .map(([v, l]) => ({ label: l, type: "radio", checked: o.minimal === v, act: { set: { overlay: { minimal: v } } } })) },
    { label: "카드 배경", enabled: o.on, submenu: alphas.sort((a, b) => b - a)
      .map((a) => ({ label: `${a}%${a === 82 ? " (기본)" : ""}`, type: "radio", checked: o.alpha === a, act: { set: { overlay: { alpha: a } } } })) },
    { label: "그림자", type: "checkbox", enabled: o.on, checked: o.shadow, act: { set: { overlay: { shadow: !o.shadow } } } },
    { type: "separator" },
    { label: "테마", submenu: [["system", "시스템 따라가기"], ["dark", "다크"], ["light", "라이트"]]
      .map(([v, l]) => ({ label: l, type: "radio", checked: settings.theme === v, act: { set: { theme: v } } })) },
    { label: "일하는 탭 테두리 효과", type: "checkbox", checked: settings.tabGlow, act: { set: { tabGlow: !settings.tabGlow } } },
    { type: "separator" },
    { label: "설정…", act: "settings" },
    { label: "Tamer 열기", act: "open" },
    { label: "메뉴바 아이콘 숨기기", act: "hide" },
    { type: "separator" },
    { label: "Tamer 종료", act: "quit" },
  );
  return { title, items };
}

// the icon: a Poké Ball outline as a template image (black + alpha; macOS paints it in the menu
// bar's colour) — drawn here, no picture file (POL-ASSET-01). 18 pt, drawn at 2×.
function trayIconBitmap(size = 36) {
  const c = size / 2, R = size / 2 - 1.5, ring = 2.6, band = 1.4, btn = size * 0.16, buf = Buffer.alloc(size * size * 4);
  const ink = (x, y) => {
    const d = Math.hypot(x - c, y - c);
    if (d > R) return 0;
    if (d > R - ring) return 1; // the outline
    if (d < btn - ring * 0.9) return d < btn * 0.35 ? 1 : 0; // the button: a dot in a ring
    if (d < btn) return 1;
    return Math.abs(y - c) < band ? 1 : 0; // the band through the middle
  };
  const S = 4; // 4×4 samples a pixel: smooth edges
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let n = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) n += ink(px + (sx + 0.5) / S, py + (sy + 0.5) / S);
    const a = Math.round((n / (S * S)) * 255), i = (py * size + px) * 4;
    buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = a; // BGRA
  }
  return { buf, size };
}
function trayIcon(nativeImage) {
  const { buf, size } = trayIconBitmap();
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}

module.exports = { trayModel, trayIcon, trayIconBitmap, AGENTS };
