// 메뉴바 (STA-19, #64): what the menu bar icon shows and its menu, as data — main.cjs turns it into
// a Tray and a native Menu (and a test reads it without putting an icon on anyone's menu bar).
// Items carry an `act` instead of a click: { tab: ws } · { set: patch } · "settings" · "open" ·
// "hide" · "quit" · "limits" (한도 새로 고침, #104).

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
// limits (#104): { codex, claude (turned on), token (Claude's in memory), state: { claude|codex: { at, error } } }
function trayModel({ tabs = [], usage = {}, settings, coins = null, prog = null, limits = null, now = Date.now() }) {
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
  // 한도 새로 고침 (#104): when it was last read; a turned-on Claude without a token reads only when pressed
  if (limits && (limits.codex || limits.claude)) {
    const last = Math.max(limits.state?.claude?.at || 0, limits.state?.codex?.at || 0);
    const ago = last ? Math.max(0, Math.round((now - last) / 60000)) : null;
    const need = limits.claude && (!limits.token || limits.state?.claude?.error === "expired");
    items.push({ label: `↻ 한도 새로 고침${need ? " — Claude는 눌러야 읽어요" : ago != null ? ` (${ago ? `${ago}분 전` : "방금"})` : ""}`, act: "limits" });
  }
  // 🪙 포켓코인 (#72, SCREENS_P3 S10): one line, not clickable — never on the icon's text
  if (coins) items.push({ label: `🪙 포켓코인 ${coins.balance.toLocaleString("en-US")} · 오늘 +${coins.today.earned.toLocaleString("en-US")}`, enabled: false });
  // 진행 (#88, PKM-30 rule 7): what there is of the incubator · stamps · research, one line, not clickable
  const pl = prog && [prog.inc && `🥚 부화기 ${prog.inc.have}/${prog.inc.need}`, prog.stamps && `⭐ 스탬프 ${prog.stamps.n}/${prog.stamps.need}`,
    prog.research && `✦ 리서치 ${prog.research.done}/${prog.research.of}`].filter(Boolean);
  if (pl?.length) items.push({ label: pl.join(" · "), enabled: false });
  items.push({ type: "separator" });

  const alphas = [100, 82, 50, 30, 0];
  if (!alphas.includes(o.alpha)) alphas.push(o.alpha);
  items.push(
    { label: "바탕화면 오버레이", type: "checkbox", checked: o.on, act: { set: { overlay: { on: !o.on } } } },
    { label: "오버레이 보일 때", enabled: o.on, submenu: [["away", "다른 앱을 쓸 때만"], ["always", "늘 (Tamer가 앞에 있어도)"]] // #98
      .map(([v, l]) => ({ label: l, type: "radio", checked: o.when === v, act: { set: { overlay: { when: v } } } })) },
    { label: "오버레이 보일 것", enabled: o.on, submenu: [
      { label: "파트너", type: "checkbox", checked: o.partner, act: { set: { overlay: { partner: !o.partner } } } },
      { label: "알림", type: "checkbox", checked: o.alerts, act: { set: { overlay: { alerts: !o.alerts } } } },
      { label: "야생 포켓몬", type: "checkbox", checked: o.wild, act: { set: { overlay: { wild: !o.wild } } } },
      { label: "진행 — 곧 일어날 일", type: "checkbox", checked: o.progress, act: { set: { overlay: { progress: !o.progress } } } }, // #88
    ] },
    { label: "최소 모드", enabled: o.on, submenu: [["auto", "배경 30% 이하일 때"], ["always", "항상"], ["never", "안 씀"]]
      .map(([v, l]) => ({ label: l, type: "radio", checked: o.minimal === v, act: { set: { overlay: { minimal: v } } } })) },
    { label: "카드 배경", enabled: o.on, submenu: alphas.sort((a, b) => b - a)
      .map((a) => ({ label: `${a}%${a === 0 ? " (기본)" : ""}`, type: "radio", checked: o.alpha === a, act: { set: { overlay: { alpha: a } } } })) },
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

// ── the party lead on the menu bar (STA-24, #108): its cached GIF's frames (electron/gif.cjs), cut to where there's
// picture in any frame, made to fit 22 pt (44 px at 2×), and the states drawn on — ! (needs you), z (resting, dimmed),
// grass at its feet (a wild one out), a hop (coins). Colour pictures, not template ones ──
const ICON_H = 44, CONTENT_H = 36, HOP = 3;
// frames: [{ rgba }] of width × height → the frames cut and scaled: { w, h, frames: [Uint8Array rgba] }
function leadFrames({ width, height, frames }) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (const f of frames) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (f.rgba[(y * width + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null; // nothing drawn
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, k = Math.min(1, CONTENT_H / bh); // smaller: as it is (crisp); bigger: shrunk to fit
  const w = Math.max(1, Math.round(bw * k)), h = Math.max(1, Math.round(bh * k)), S = k < 1 ? 4 : 1;
  const out = frames.map((f) => {
    const o = new Uint8Array(w * h * 4);
    for (let ty = 0; ty < h; ty++) for (let tx = 0; tx < w; tx++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) { // a few samples a pixel: shrunk pixel art stays even
        const x = x0 + Math.min(bw - 1, Math.floor((tx + (sx + 0.5) / S) / k)), y = y0 + Math.min(bh - 1, Math.floor((ty + (sy + 0.5) / S) / k)), i = (y * width + x) * 4, al = f.rgba[i + 3];
        r += f.rgba[i] * al; g += f.rgba[i + 1] * al; b += f.rgba[i + 2] * al; a += al;
      }
      const d = (ty * w + tx) * 4;
      if (a) { o[d] = r / a; o[d + 1] = g / a; o[d + 2] = b / a; o[d + 3] = a / (S * S); }
    }
    return o;
  });
  return { w, h, frames: out };
}
// one picture of the icon: a frame of the lead with the state drawn on → { buf: BGRA premultiplied, width, height } at 2×
const Z = ["11111", "00010", "00100", "01000", "11111"]; // a small z
function leadIcon(lead, i, { dim = false, z = false, badge = false, grass = false, hop = false } = {}) {
  const W = Math.max(lead.w + 8, 24), H = ICON_H, buf = new Uint8Array(W * H * 4), src = lead.frames[i % lead.frames.length];
  const ox = Math.floor((W - lead.w) / 2) - (badge || z ? 2 : 0), oy = H - lead.h - 4 - (hop ? HOP : 0);
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= W || y >= H || !a) return;
    const d = (y * W + x) * 4, fa = a / 255, ba = buf[d + 3] / 255, oa = fa + ba * (1 - fa);
    if (!oa) return;
    // over what's there (stored as straight colour here, premultiplied at the end)
    buf[d] = (r * fa + buf[d] * ba * (1 - fa)) / oa; buf[d + 1] = (g * fa + buf[d + 1] * ba * (1 - fa)) / oa; buf[d + 2] = (b * fa + buf[d + 2] * ba * (1 - fa)) / oa; buf[d + 3] = oa * 255;
  };
  for (let y = 0; y < lead.h; y++) for (let x = 0; x < lead.w; x++) {
    const s = (y * lead.w + x) * 4, a = src[s + 3];
    if (!a) continue;
    let r = src[s], g = src[s + 1], b = src[s + 2];
    if (dim) { const l = (r + g + b) / 3; r = (r + l) / 2; g = (g + l) / 2; b = (b + l) / 2; } // resting: greyer and see-through
    put(ox + x, oy + y, r, g, b, dim ? a * 0.55 : a);
  }
  if (grass) for (let x = 0; x < W; x++) { // tufts at its feet: blades of 3–6 px, two greens
    const tall = 3 + ((x * 7) % 4), dark = x % 3 === 0;
    for (let y = 0; y < tall; y++) put(x, H - 1 - y, dark ? 46 : 74, dark ? 125 : 170, dark ? 50 : 70, 255);
  }
  if (z) Z.forEach((row, y) => [...row].forEach((c, x) => { if (c === "1") put(W - 7 + x, 3 + y, 120, 170, 255, 255); }));
  if (badge) { // a red dot with a white ! — needs you
    const cx = W - 5.5, cy = 6.5, R = 5.5;
    for (let y = 0; y < 13; y++) for (let x = W - 12; x < W; x++) { const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); if (d <= R) put(x, y, 229, 72, 77, d > R - 0.8 ? 160 : 255); }
    for (let y = 3; y <= 9; y++) if (y !== 8) { put(W - 6, y, 255, 255, 255, 255); }
  }
  const out = Buffer.alloc(W * H * 4); // RGBA straight → BGRA premultiplied (nativeImage.createFromBitmap)
  for (let d = 0; d < out.length; d += 4) { const a = buf[d + 3]; out[d] = (buf[d + 2] * a) / 255; out[d + 1] = (buf[d + 1] * a) / 255; out[d + 2] = (buf[d] * a) / 255; out[d + 3] = a; }
  return { buf: out, width: W, height: H };
}
// what the icon does now (rule 4): wild → needs you → working (faster with more working tabs) → resting
function leadState({ tabs = [], wild = null, now = Date.now() }) {
  const working = tabs.filter((t) => WORKING.includes(t.state)).length, waiting = tabs.filter((t) => t.state === "waiting").length;
  const state = wild ? "wild" : waiting ? "waiting" : working ? "working" : "rest";
  return { state, working, waiting, step: state === "working" || state === "wild" ? Math.min(3, Math.max(1, working)) : 0,
    wildLeft: wild && !wild.big && wild.until ? Math.max(0, Math.ceil((wild.until - now) / 1000)) : null };
}

module.exports = { trayModel, trayIcon, trayIconBitmap, AGENTS, leadFrames, leadIcon, leadState };
