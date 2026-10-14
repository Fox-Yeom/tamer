// The desktop overlay's cards as HTML (STA-15) — drawn by the overlay page and, with sample tabs, by
// the 설정 창's preview (#67), so both always look the same. No host calls in here: the caller hands
// in spriteUrl(gif) → data URL. Styles: src/overlay-cards.css, everything under `.ov`.
import { timing, dur, MINUTE } from "./elapsed.js";
import { failLabel } from "./fail.js";

export const ICON = {
  idle: "😌", sleep: "💤", thinking: "💭", coding: "⌨️", reading: "📖", searching: "🔍",
  bash: "💻", agent: "🤝", tool: "🛠", waiting: "❓", done: "🎉", compact: "🗜", error: "💥", interrupted: "⏹",
};
// how the last turn ended → bubble (full text, and the icon alone in the minimal mode)
const ENDED = { done: ["ok", "✅ 완료!", "✅"], interrupted: ["dim", "⏹ 중단됨", "⏹"], error: ["bad", "💥 실패", "💥"] };
export const DOING = {
  idle: "대기", sleep: "쉬는 중", thinking: "생각 중", coding: "편집", reading: "읽는 중", searching: "검색",
  bash: "실행", agent: "하위 에이전트", tool: "도구", waiting: "입력 필요", done: "완료", compact: "압축 중", error: "실패", interrupted: "중단됨",
};
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// 최소 모드 (#63): chosen, or automatic when the cards' background is 30 % or less
export const MINIMAL_AT = 30;
export const isMinimal = (show = {}) => show.minimal === "always" || (show.minimal !== "never" && (show.alpha ?? 82) <= MINIMAL_AT);

// the settings on a root element: background, shadow (#65), minimal (#63)
export function applyShow(root, show = {}) {
  const a = (show.alpha ?? 82) / 100;
  root.style.setProperty("--ov-alpha", String(a));
  // fades with the background below the default 82 % (the look it always had), none when off
  root.style.setProperty("--ov-shadow", String(show.shadow === false ? 0 : Math.min(1, (show.alpha ?? 82) / 82)));
  root.classList.toggle("ov-minimal", isMinimal(show));
}

// state colour of a small icon / ball (needs you / failed / working / done / idle)
export function dot(t, stallMs) {
  const tm = timing(t.times, { stallMs });
  return t.state === "waiting" ? "bad" : t.ended === "error" ? "bad" : t.ended === "done" ? "ok"
    : ["idle", "sleep", "done", "interrupted", "error"].includes(t.state) ? "idle" : tm.stall ? "stall" : "work";
}
// unattended runs (STA-20): the card's state line — · 12분, · 4분째, ⏳ 변화 없음
export function stateLine(t, stallMs) {
  const x = timing(t.times, { stallMs });
  if (x.stall && t.state !== "waiting") return `⏳ 변화 없음 ${x.stall}`;
  return `${ICON[t.state] || ""} ${DOING[t.state] || ""}${x.run ? ` · ${x.run}` : x.wait ? ` · ${x.wait}째` : ""}`;
}
// the hover line of the minimal mode: "폴더 — 상태" (src/overlay.js shows it in #tip)
const tip = (t, stallMs) => `${t.partner && t.active ? `${t.partner.name} · ` : ""}${t.name} — ${stateLine(t, stallMs).trim()}`;

async function bigCard(t, { show, stallMs, spriteUrl, extra = "" }) {
  const url = await spriteUrl(t.partner?.gif);
  const min = isMinimal(show), end = ENDED[t.ended];
  const stall = timing(t.times, { stallMs }).stall;
  // a finished shell shows even while another shell of the folder needs you (both bubbles)
  const took = min ? "" : t.ended === "done" && t.times?.took >= MINUTE ? ` · ${dur(t.times.took)}` // STA-20
    : t.ended === "error" && failLabel(t.endedKind || t.times?.kind) ? ` · ${failLabel(t.endedKind || t.times?.kind)}` : ""; // #53
  const endBubble = end ? `<div class="bubble ${end[0]}${t.state === "waiting" ? " second" : ""}">${t.endedN && !min ? `셸 ${t.endedN} ` : ""}${min ? end[2] : end[1]}${took}</div>` : "";
  // 알림 off (#59): no "입력 필요" / "완료!" bubbles — the partner stays
  const bubble = show.alerts === false ? "" : (t.state === "waiting" ? `<div class="bubble bad">${min ? "❗" : "❗ 입력 필요"}</div>` : "") + endBubble;
  const motion = t.state === "waiting" ? "st-waiting" : ["done", "interrupted", "error", "idle", "sleep"].includes(t.state) ? `st-${t.state}` : "st-working";
  const sprite = url ? `<img class="poke ${motion}" src="${url}" alt="" />` : t.partner ? '<div class="pokeball"></div>' : '<div class="empty-ball" title="파트너가 없어요"></div>';
  return `<div class="card hit${t.active ? " current" : ""}" data-ws="${esc(t.ws)}" data-tip="${esc(tip(t, stallMs))}" title="${min ? "" : `클릭: 이 탭으로 · 드래그: 이동${t.active ? " · 더블클릭: 접기/펴기" : ""}`}">
    ${bubble}
    <div class="row"><div class="sprite">${sprite}</div>
    ${min ? "" : `<div class="meta"><div class="name">${esc(t.partner ? `${t.partner.shiny ? "✨" : ""}${t.partner.name}` : "파트너 없음")}${t.sessions > 1 ? ` <span class="sess-badge" title="이 폴더의 셸 수">셸 ${t.sessions}개</span>` : ""}</div>
      <div class="folder">${esc(t.name)}</div><div class="state${stall && t.state !== "waiting" ? " stall" : ""}" title="${stall ? "새 이벤트가 없어요 — 멈췄을 수 있어요(추정)" : ""}">${esc(stateLine(t, stallMs))}</div></div>`}</div>
    ${extra}
  </div>`;
}

// every card of an overlay payload { current, urgent, minis, more, counts, collapsed, show, stallMs }
export async function cardsHtml(p, { spriteUrl }) {
  const show = p.show || {}, stallMs = p.stallMs, min = isMinimal(show);
  // every other tab: a small icon + state dot (minimal: a Poké Ball in the state's colour), then the counts
  const minis = await Promise.all((p.minis || []).map(async (t) => {
    if (min) return `<span class="ball hit ${dot(t, stallMs)}" data-ws="${esc(t.ws)}" data-tip="${esc(tip(t, stallMs))}"></span>`;
    const url = await spriteUrl(t.partner?.gif);
    return `<span class="mini hit" data-ws="${esc(t.ws)}" title="${esc(t.name)} — ${DOING[t.state] || ""}">${url ? `<img src="${url}" alt="" />` : "·"}<i class="dot ${dot(t, stallMs)}"></i></span>`;
  }));
  const c = p.counts || {};
  const counts = min ? "" : [["bad", "❗", c.waiting], ["", "⌨️", c.working], ["ok", "✅", c.done], ["bad", "💥", c.error]]
    .filter(([, , n]) => n > 0).map(([cls, icon, n]) => `<span class="${cls}">${icon}${n}</span>`).join(" ");
  const strip = show.alerts !== false && (minis.length || p.more || (counts && !p.collapsed))
    ? `<div class="minis">${minis.join("")}${p.more ? `<span class="more">+${p.more}</span>` : ""}${counts ? `<span class="counts">${counts}</span>` : ""}</div>` : "";
  const cards = [];
  if (p.urgent && show.alerts !== false) cards.push(await bigCard(p.urgent, { show, stallMs, spriteUrl })); // the tab that needs you: an alert
  if (p.current && show.partner !== false) cards.push(await bigCard(p.current, { show, stallMs, spriteUrl, extra: strip }));
  else if (strip) cards.push(`<div class="card">${strip}</div>`); // no partner card: the icon row alone
  return cards.join("");
}

// sprites at their pixel size: ×2 on the current tab's card
export function sizePokes(root) {
  root.querySelectorAll(".poke").forEach((img) => img.decode().then(() => {
    const k = img.closest(".current") ? 2 : 1;
    img.style.width = `${Math.min(img.naturalWidth * k, k === 2 ? 120 : 64)}px`;
  }).catch(() => {}));
}

// 야생 알림 (#66, PKM-08): "야생의 ○○ 등장!" · seconds left · ✕ — a click brings Tamer to catch it
export function wildNoteHtml(e, url) {
  const name = `${e.shiny ? "✨" : ""}${esc(e.name)}`;
  return `<div class="wild-note hit" data-act="wild" title="클릭: Tamer에서 잡기">
    ${url ? `<img class="wild-note-poke" src="${url}" alt="" />` : '<div class="pokeball"></div>'}
    <div class="wild-note-text"><b>야생의 ${name}</b> 등장!<div class="wild-note-sub">눌러서 잡기 <span class="wild-note-timer"></span></div></div>
    <button class="wild-note-close" title="알림 닫기">✕</button></div>`;
}
