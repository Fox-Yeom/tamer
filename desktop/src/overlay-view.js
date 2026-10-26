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

// 진행 (#88 → #90, PKM-30 rule 4): the incubator whenever an egg is in it, stamps · research only one step
// before — each with what it means (the minimal mode's hover line: a lone ⭐ said nothing, #90)
export function progItems(prog) {
  const it = [], p = prog || {};
  if (p.inc) it.push({ icon: "🥚", n: p.inc.have, m: p.inc.need, soon: !!p.inc.soon,
    what: `부화기 ${p.inc.name || "알"} ${p.inc.have}/${p.inc.need} · ${p.inc.soon ? "곧 태어나요 — 작업 1번" : `작업 ${p.inc.need - p.inc.have}번 남음`}` });
  if (p.stamps?.soon) it.push({ icon: "⭐", n: p.stamps.n, m: p.stamps.need, soon: true, what: `연구 스탬프 ${p.stamps.n}/${p.stamps.need} · 대발견까지 1개` });
  if (p.research?.soon) it.push({ icon: "✦", n: p.research.done, m: p.research.of, soon: true, what: `리서치 ${p.research.done}/${p.research.of} · 마지막 단계 1번` });
  return it;
}
const progTip = (it) => it.map((i) => `${i.icon} ${i.what}`).join(" · ");
// the line under the current tab's card: 🥚 2/10 · ⭐ 곧 6/7
export const progHtml = (prog) => { const it = progItems(prog); return it.length ? `<div class="ov-prog" title="${esc(progTip(it))}">${it.map((i) => `<span${i.soon ? ' class="soon"' : ""}>${i.icon} ${i.soon ? "곧 " : ""}${i.n}/${i.m}</span>`).join(" · ")}</div>` : ""; };
// 최소 모드: small chips under the partner (🥚2/10 ⭐6/7); the hover line (overlay.js #tip) says what they are
const progMini = (prog, ws) => { const it = progItems(prog); return it.length ? `<div class="ov-prog-mini" data-ws="${esc(ws)}" data-tip="${esc(progTip(it))}">${it.map((i) => `<span${i.soon ? ' class="soon"' : ""}>${i.icon}${i.n}/${i.m}</span>`).join("")}</div>` : ""; };

// ball: the most urgent other tab (#122, STA-15) — its state's Poké Ball instead of a picture (every tab has the same 메인 파트너),
// the folder as its name
async function bigCard(t, { show, stallMs, spriteUrl, extra = "", ball = false }) {
  const url = ball ? null : await spriteUrl(t.partner?.gif);
  const min = isMinimal(show), end = ENDED[t.ended];
  const stall = timing(t.times, { stallMs }).stall;
  // a finished shell shows even while another shell of the folder needs you (both bubbles)
  const took = min ? "" : t.ended === "done" && t.times?.took >= MINUTE ? ` · ${dur(t.times.took)}` // STA-20
    : t.ended === "error" && failLabel(t.endedKind || t.times?.kind) ? ` · ${failLabel(t.endedKind || t.times?.kind)}` : ""; // #53
  const endBubble = end ? `<div class="bubble ${end[0]}${t.state === "waiting" ? " second" : ""}">${t.endedN && !min ? `셸 ${t.endedN} ` : ""}${min ? end[2] : end[1]}${took}</div>` : "";
  // 알림 off (#59): no "입력 필요" / "완료!" bubbles — the partner stays
  const bubble = show.alerts === false ? "" : (t.state === "waiting" ? `<div class="bubble bad">${min ? "❗" : "❗ 입력 필요"}</div>` : "") + endBubble;
  const motion = t.state === "waiting" ? "st-waiting" : ["done", "interrupted", "error", "idle", "sleep"].includes(t.state) ? `st-${t.state}` : "st-working";
  const sprite = ball ? `<span class="ball urgent ${dot(t, stallMs)}"></span>` : url ? `<img class="poke ${motion}" src="${url}" alt="" />` : t.partner ? '<div class="pokeball"></div>' : '<div class="empty-ball" title="포켓몬이 없어요"></div>';
  return `<div class="card hit${t.active ? " current" : ""}" data-ws="${esc(t.ws)}" data-tip="${esc(tip(t, stallMs))}" title="${min ? "" : `클릭: 이 탭으로 · 드래그: 이동${t.active ? " · 더블클릭: 접기/펴기" : ""}`}">
    ${bubble}
    <div class="row"><div class="sprite">${sprite}</div>
    ${min ? "" : `<div class="meta"><div class="name">${esc(ball ? t.name : t.partner ? `${t.partner.shiny ? "✨" : ""}${t.partner.name}` : "포켓몬 없음")}${t.sessions > 1 ? ` <span class="sess-badge" title="이 폴더의 셸 수">셸 ${t.sessions}개</span>` : ""}</div>
      ${ball ? "" : `<div class="folder">${esc(t.name)}</div>`}<div class="state${stall && t.state !== "waiting" ? " stall" : ""}" title="${stall ? "새 이벤트가 없어요 — 멈췄을 수 있어요(추정)" : ""}">${esc(stateLine(t, stallMs))}</div></div>`}</div>
    ${extra}
  </div>`;
}

// 파티 (#107, STA-15 rule 11): no tab open (Tamer in the menu bar only) — the 메인 파트너 big, the others small,
// and the last finish done outside Tamer / grown by the party as a bubble ("밖에서 +5 · 리자드 Lv 31"). A click: the
// Pokémon window's 홈 (#122 J2 — it never opens the terminal window, APP-22 rule 8)
async function partyCard(party, note, { show, spriteUrl, prog = null }) {
  const [lead, ...rest] = party.list, min = isMinimal(show);
  const url = await spriteUrl(lead.gif);
  const others = await Promise.all(rest.map(async (m) => { const u = await spriteUrl(m.gif); return `<span class="mini" title="${esc(m.name)} Lv ${m.lv ?? "?"}">${u ? `<img src="${u}" alt="" />` : "·"}</span>`; }));
  const said = note && show.alerts !== false ? `<div class="bubble ok">${min ? "+" : `${note.outside ? "밖에서 " : ""}+${note.coins || 0}${note.mon?.name ? ` · ${esc(note.mon.name)}${note.mon.lv ? ` Lv ${note.mon.lv}` : ""}` : ""}`}</div>` : "";
  return `<div class="card hit current party" data-act="party" title="${min ? "" : "파티 — 클릭: 포켓몬 창 홈 · 드래그: 이동"}">
    ${said}
    <div class="row"><div class="sprite">${url ? `<img class="poke st-idle" src="${url}" alt="" />` : '<div class="pokeball"></div>'}</div>
    ${min ? "" : `<div class="meta"><div class="name">${esc(`${lead.shiny ? "✨" : ""}${lead.name}`)}</div><div class="folder">메인 파트너 · Lv ${lead.lv ?? "?"}</div><div class="state">어디서 작업을 끝내도 파티가 커요</div></div>`}</div>
    ${others.length && !min ? `<div class="minis">${others.join("")}</div>` : ""}
    ${prog ? (min ? progMini(prog, "") : progHtml(prog)) : ""}
  </div>`; // 진행 (#116): the egg · stamps · research under the party too, as under a tab's card
}

// the other tabs (#122): every tab shows the same 메인 파트너, so a tab is a Poké Ball in its state's colour — the minimal
// mode's, now in both (the normal one says the folder and what it's doing on hover)
export const tabBalls = (minis, stallMs, min) => minis.map((t) => `<span class="ball hit ${dot(t, stallMs)}" data-ws="${esc(t.ws)}" data-tip="${esc(tip(t, stallMs))}"${min ? "" : ` title="${esc(t.name)} — ${esc(DOING[t.state] || "")}"`}></span>`);

// every card of an overlay payload { current, urgent, minis, more, counts, collapsed, show, stallMs }
export async function cardsHtml(p, { spriteUrl }) {
  const show = p.show || {}, stallMs = p.stallMs, min = isMinimal(show);
  // every other tab: a Poké Ball in its state's colour (#122), then the counts
  const minis = tabBalls(p.minis || [], stallMs, min);
  const c = p.counts || {};
  const counts = min ? "" : [["bad", "❗", c.waiting], ["", "⌨️", c.working], ["ok", "✅", c.done], ["bad", "💥", c.error]]
    .filter(([, , n]) => n > 0).map(([cls, icon, n]) => `<span class="${cls}">${icon}${n}</span>`).join(" ");
  const strip = show.alerts !== false && (minis.length || p.more || (counts && !p.collapsed))
    ? `<div class="minis">${minis.join("")}${p.more ? `<span class="more">+${p.more}</span>` : ""}${counts ? `<span class="counts">${counts}</span>` : ""}</div>` : "";
  const cards = [];
  if (p.urgent && show.alerts !== false) cards.push(await bigCard(p.urgent, { show, stallMs, spriteUrl, ball: true })); // the tab that needs you: an alert, its Poké Ball (#122)
  // 진행 (#88 #90): a line under the current tab's card (minimal: chips under the partner), or a card of its own
  const prog = show.progress !== false && progItems(p.prog).length ? p.prog : null;
  if (p.current && show.partner !== false) cards.push(await bigCard(p.current, { show, stallMs, spriteUrl, extra: (prog && min ? progMini(prog, p.current.ws) : "") + strip + (prog && !min ? progHtml(prog) : "") }));
  else if (p.party?.list?.length && show.partner !== false) cards.push(await partyCard(p.party, p.partyNote, { show, spriteUrl, prog })); // no tab: the party (#107) and 진행 (#116)
  else if (strip || prog) cards.push(`<div class="card">${strip}${prog ? progHtml(prog) : ""}</div>`); // no partner card: the icon row / the line alone
  return cards.join("");
}

// sprites at their pixel size: ×2 on the current tab's card — inside a box (120 × 120, small cards
// 64 × 64): only the width was capped, so a tall one (a deer's antlers) grew to ~290 px and the window,
// anchored at its bottom, ran out of room above and cut it off (#109)
export const POKE_BOX = { big: [120, 120], small: [64, 64] };
export function sizePokes(root) {
  root.querySelectorAll(".poke").forEach((img) => img.decode().then(() => {
    const big = !!img.closest(".current"), [w, h] = POKE_BOX[big ? "big" : "small"];
    const k = Math.min(big ? 2 : 1, w / img.naturalWidth, h / img.naturalHeight);
    img.style.width = `${Math.round(img.naturalWidth * k)}px`;
  }).catch(() => {}));
}

// 야생 알림 (#66, PKM-08): "야생의 ○○ 등장!" · seconds left · ✕ — a click brings Tamer to catch it
export function wildNoteHtml(e, url) {
  const name = `${e.shiny ? "✨" : ""}${esc(e.name)}`;
  // ⭐ a breakthrough (#82, SCREENS_P3 S9): gold border, no seconds — it doesn't run away
  return `<div class="wild-note hit${e.big ? " big" : ""}" data-act="wild" title="클릭: 옆에 뜨는 창에서 잡기">
    ${url ? `<img class="wild-note-poke" src="${url}" alt="" />` : '<div class="pokeball"></div>'}
    <div class="wild-note-text">${e.big ? `⭐ 대발견! 전설의 <b>${name}</b>` : `<b>야생의 ${name}</b> 등장!`}<div class="wild-note-sub">눌러서 잡기 <span class="wild-note-timer">${e.big ? "· 도망가지 않아요" : ""}</span></div></div>
    <button class="wild-note-close" title="알림 닫기">✕</button></div>`;
}

// 🐣 부화 알림 (#88, PKM-30 rule 5): like the wild notice, green — 4 s, a click opens the Pokémon window's 내 포켓몬 on it
// ✨ 진화 알림 (#111): an evolution while Tamer isn't in front (the party · work outside Tamer · any tab) —
// the new form flashing, who it was, the coins. A click → 내 포켓몬 on it (#121 — was Tamer's window)
export function evolveNoteHtml(e, url) {
  return `<div class="wild-note evolve hit" data-act="evolve"${e.id ? ` data-sel="${Number(e.id)}"` : ""} title="클릭: 포켓몬 창 내 포켓몬">
    ${url ? `<img class="wild-note-poke evo-flash" src="${url}" alt="" />` : '<div class="pokeball"></div>'}
    <div class="wild-note-text">✨ ${e.from ? `<b>${esc(e.from)}</b>${josaRo(e.from)} ` : ""}<b>${e.shiny ? "✨" : ""}${esc(e.to)}</b>${e.from ? josaEuro(e.to) : ""} 진화했어요!<div class="wild-note-sub">${e.outside ? "Tamer 밖 작업" : e.via === "party" ? "파티" : "작업 끝"}${e.coins ? ` · 🪙 +${e.coins}` : ""}</div></div></div>`;
}
// 이/가 · (으)로 after a Pokémon's name (no 받침 / ㄹ 받침 → 로)
const finalOf = (name) => { const c = String(name).charCodeAt(String(name).length - 1); return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0; };
const josaRo = (name) => (finalOf(name) ? "이" : "가");
const josaEuro = (name) => (finalOf(name) && finalOf(name) !== 8 ? "으로" : "로");

export function hatchNoteHtml(h, url) {
  return `<div class="wild-note hatch hit" data-act="hatch"${h.id ? ` data-sel="${Number(h.id)}"` : ""} title="클릭: 포켓몬 창 내 포켓몬">
    ${url ? `<img class="wild-note-poke" src="${url}" alt="" />` : '<div class="pokeball"></div>'}
    <div class="wild-note-text">🐣 알에서 <b>${h.shiny ? "✨" : ""}${esc(h.name)}</b> 태어났어요<div class="wild-note-sub">부화기 · 내 포켓몬에서 파트너로</div></div></div>`;
}
