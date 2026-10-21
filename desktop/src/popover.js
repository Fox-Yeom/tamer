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
function until(sec, now) {
  if (!sec) return "";
  const m = Math.max(0, Math.round((sec * 1000 - now) / 60000));
  return m >= 1440 ? `${Math.floor(m / 1440)}일 ${Math.floor((m % 1440) / 60)}시간` : m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
}
const ago = (t, now) => { const m = Math.round((now - t) / 60000); return m < 1 ? "방금" : m < 60 ? `${m}분 전` : `${Math.round(m / 60)}시간 전`; };

let model = null;

// 위쪽 탭 · 에이전트 칩 (#118, rule 13): the page and the agent last looked at — this page's own storage, a
// convenience only (gone: 홈, the first agent)
const keep = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
let page = keep.get("pop.page") === "poke" ? "poke" : "home";
let agentPick = keep.get("pop.agent");
const wildOut = () => !$("#pop-wild .wild-card")?.hidden;
function showPage(p) {
  if (p !== page) document.scrollingElement.scrollTop = 0;
  page = p; keep.set("pop.page", p);
  for (const b of document.querySelectorAll("#pop-nav [data-page]")) { b.classList.toggle("on", b.dataset.page === p); b.setAttribute("aria-selected", String(b.dataset.page === p)); }
  $("#pg-home").hidden = p !== "home"; $("#pg-poke").hidden = p !== "poke";
  drawDot();
}
// 포켓몬 탭의 점: a wild one out, or an evolution since the page was last seen — never a switch by itself
function drawDot() {
  if (page === "poke") keep.set("pop.pokeSeen", String(Date.now()));
  const r = model?.recent?.[0], seen = Number(keep.get("pop.pokeSeen")) || 0;
  $("#pop-nav .pop-dot").hidden = page === "poke" || !(wildOut() || (r?.evolved && r.at > seen));
}

async function drawPartner(m) {
  const p = m.partner, root = $("#pop-partner");
  if (!p) { root.innerHTML = `<div class="pop-none">${m.folder ? `${esc(m.folder)} — 이 탭엔 파트너가 없어요` : "열린 탭이 없어요"}</div>`; return; }
  const goal = p.final || p.grad ? 100 : p.next?.level || null;
  const pct = goal && p.lv ? Math.min(100, Math.round((p.lv / goal) * 100)) : null;
  root.innerHTML = `<div class="pop-sprite"><img alt="" /></div>
    <div class="pop-who"><div><span class="pop-name">${esc(p.name)}${p.shiny ? " ✨" : ""}</span> <span class="pop-lv">${esc(lvLine(p))}</span></div>
      ${pct != null ? `<div class="pop-bar"><i style="width:${pct}%"></i></div>` : ""}
      <div class="pop-chips"><span>${esc(m.folder || "")}</span></div></div>`;
  const src = await sprite(p.gif);
  const img = root.querySelector("img");
  if (src && img) img.src = src;
}

// 파티 (PKM-31, #107): who grows from folders without a partner and from work outside Tamer — and the last such finish
async function drawParty(m) {
  const p = m.party || { list: [] }, r = m.recent?.[0], root = $("#pop-party");
  const head = `<div class="pop-h"><span>파티${m.outside ? " · Tamer 밖 작업도" : ""}</span><button id="pop-party-go">${p.list.length ? "바꾸기" : "파티 고르기"}</button></div>`;
  const last = r ? `<div class="pop-recent">${r.outside ? "밖에서" : "탭"} · ${esc(r.folder)} · +${r.coins || 0}${r.mon?.name ? ` · ${esc(r.mon.name)}${r.mon.lv ? ` Lv ${r.mon.lv}` : ""}` : ""}${r.evolved ? ` · 진화!` : ""}</div>` : "";
  if (!p.list.length) { root.innerHTML = head + '<div class="pop-none">파티가 비어 있어요 — 파트너 없는 폴더와 Tamer 밖 작업은 파티가 키워요</div>' + last; return; }
  // three to a row, the picture big enough to see (#117)
  root.innerHTML = head + `<div class="pop-party">${p.list.map((x, i) => `<span class="pop-mon${i === p.next ? " next" : ""}${i ? "" : " lead"}" data-uid="${x.uid}" title="${esc(x.name)} Lv ${x.lv ?? "?"}${i === p.next ? " · 다음 차례" : ""}${i ? " — 눌러서 선두로" : " · 선두"}"><img alt="" data-gif="${esc(x.gif || "")}" /><b class="nm">${esc(x.name)}${x.shiny ? " ✨" : ""}</b><small>Lv ${x.lv ?? "?"}</small></span>`).join("")}</div>` + last;
  for (const img of root.querySelectorAll("img[data-gif]")) sprite(img.dataset.gif).then((u) => { if (u) img.src = u; });
}

// 진행 (#116, PKM-30 rule 9): the incubator · stamps · research — shown with no tab too — and 알 넣기 from the bag.
// The incubator is a small picture of it (#117): the drawn egg (PKM-25), its name, a bar and how many finishes are left
function drawProg(m) {
  const p = m.prog || {}, e = m.eggs || {}, a = p.inc, soon = (x) => (x?.soon ? "곧 " : "");
  const kind = e.egg > 0 ? "egg" : e.egg2 > 0 ? "egg2" : null; // an ordinary egg first
  const put = kind ? `<button id="pop-egg-in" data-kind="${kind}" title="가방의 ${kind === "egg" ? "알" : "희귀 알"}을 부화기에 — 작업을 끝낼 때마다 부화가 가까워져요">알 넣기 <span class="dim">가방 ${e.egg + e.egg2}</span></button>` : "";
  const inc = a
    ? `<div class="pop-inc${a.soon ? " soon" : ""}"><i class="pk-egg mid${a.kind === "egg2" ? " rare" : ""}"></i><div class="pop-inc-what">
        <b>${esc(a.name || "알")} ${a.have}/${a.need}</b><div class="pop-bar"><i style="width:${Math.round((a.have / a.need) * 100)}%"></i></div>
        <span class="dim">${a.soon ? "곧 태어나요 — 작업 1번" : `작업 ${a.need - a.have}번 남음`}${a.waiting ? ` · 대기 ${a.waiting}` : ""}</span></div></div>`
    : `<div class="pop-inc empty"><i class="pk-egg mid empty"></i><div class="pop-inc-what"><b>부화기가 비어 있어요</b>
        <span class="dim">${kind ? "알을 넣으면 작업을 끝낼 때마다 자라요" : "알은 🛒 상점에서 (알 500 · 희귀 알 2,000)"}</span></div></div>`;
  const more = [p.stamps && `⭐ ${soon(p.stamps)}스탬프 ${p.stamps.n}/${p.stamps.need}`, p.research && `✦ ${soon(p.research)}리서치 ${p.research.done}/${p.research.of}`].filter(Boolean);
  $("#pop-prog").innerHTML = `<div class="pop-h"><span>부화기 · 진행</span>${put}</div>${inc}${more.length ? `<div class="pop-progline">${more.join(" · ")}</div>` : ""}`;
}

function drawToday(m) {
  const t = m.today || {}, c = m.coins;
  $("#pop-today").innerHTML = `<div class="pop-stat"><small>오늘 완료</small><b>${t.today ?? 0}</b></div>
    <div class="pop-stat"><small>연속</small><b>${t.streak ?? 0}일</b></div>
    <div class="pop-stat"><small>오늘 코인</small><b class="pop-coin">${c ? `+${c.today.earned.toLocaleString("en-US")}` : "—"}</b></div>`;
}

// 한도 칸 (#115, STA-22 rule 10 — PokeTokenBar's "Limits"): per agent, each window a row — the bar fills with
// what's LEFT (coloured by how much is used, STA-08), "76% 남음", when it resets; a tick = the window's time
// left (a bar shorter than the tick: using faster than the clock — a fact, no forecast: STA-18 ✖). A window past
// its reset stays as "초기화됨"; one never heard of is "—"
const WINS = [["five_hour", "5시간 세션", 5 * 3600], ["seven_day", "주간", 7 * 86400]];
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
function resetAt(sec, now) {
  const d = new Date(sec * 1000), hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${until(sec, now)} (${sec * 1000 - now >= 86400000 ? `${DAYS[d.getDay()]} ` : ""}${hm})`;
}
function limitRow(label, w, span, now) {
  if (!w || !Number.isFinite(w.pct)) return `<div class="pop-win none"><span class="k">${label}</span><span class="gauge"></span><span class="pct">—</span></div>`;
  if (w.resets_at && w.resets_at * 1000 <= now) // A6: reset since — the next request opens a new window
    return `<div class="pop-win reset"><span class="k">${label}</span><span class="gauge"><i class="lv-ok" style="width:100%"></i></span><span class="pct">100% 남음</span><span class="when">초기화됨 — 다음 요청부터 새 창</span></div>`;
  const used = Math.min(100, Math.max(0, w.pct)), left = 100 - used;
  const rest = w.resets_at ? (w.resets_at * 1000 - now) / 1000 / span : null; // A4: the time left of the window (a reset further off than its length: no tick)
  const tick = rest != null && rest <= 1 ? Math.max(0, rest * 100) : null;
  return `<div class="pop-win"><span class="k">${label}</span><span class="gauge" ${tick != null ? `title="눈금: 남은 시간 ${Math.round(tick)}% — 막대가 눈금보다 짧으면 시간보다 빨리 쓰는 중"` : ""}><i class="${level(used)}" style="width:${left}%"></i>${tick != null ? `<b class="tick" style="left:${tick}%"></b>` : ""}</span>
    <span class="pct">${Math.round(left)}% 남음</span>${w.resets_at ? `<span class="when">${esc(resetAt(w.resets_at, now))}</span>` : ""}</div>`;
}
// the most used window still running → its level's colour (a chip's dot: the agent not shown nearing its limit is seen)
const worst = (u, now) => {
  const ps = WINS.map(([key]) => u?.[key]).filter((w) => w && Number.isFinite(w.pct) && !(w.resets_at && w.resets_at * 1000 <= now)).map((w) => w.pct);
  return ps.length ? level(Math.max(...ps)) : "";
};
function drawLimits(m, now) {
  // the agents with limits or today's use — two or more: one at a time behind chips (#118, rule 13)
  const shown = AGENTS.filter(([k]) => WINS.some(([key]) => m.usage?.[k]?.[key]) || m.spend?.[k]);
  const pick = shown.find(([k]) => k === agentPick) || shown[0];
  const blocks = [];
  if (pick) {
    const [k, name] = pick, u = m.usage?.[k] || {};
    const t = m.spend?.[k]; // A5: today's tokens · ≈$ (with STA-23's yes)
    const who = shown.length > 1
      ? `<span class="pop-agents" role="tablist">${shown.map(([key, nm]) => `<button role="tab" class="pop-chip${key === k ? " on" : ""}" data-agent="${key}" aria-selected="${key === k}"><i class="${worst(m.usage?.[key], now)}"></i>${nm}</button>`).join("")}</span>`
      : `<b>${name}</b>`;
    blocks.push(`<div class="pop-ag"><div class="pop-ag-h">${who}${t ? `<span class="spent" title="오늘 이 맥의 ${name} 기록에 쓰인 토큰 수 — ≈$는 API 가격으로 계산한 추정치, 실제 청구 금액이 아니에요">오늘 ${esc(tokens(t.tokens))}${t.usd != null ? ` · ≈$${t.usd.toFixed(2)}` : ""}</span>` : ""}</div>
      ${WINS.map(([key, label, span]) => limitRow(label, u[key], span, now)).join("")}</div>`);
  }
  const L = m.limits || {}, st = L.state || {};
  const last = Math.max(st.claude?.at || 0, st.codex?.at || 0);
  const need = L.claude && (!L.token || st.claude?.error === "expired");
  const note = need ? "Claude는 눌러야 읽어요" : last ? ago(last, now) : "";
  $("#pop-limits").innerHTML = `<div class="pop-h"><span>사용 한도</span>${L.codex || L.claude ? `<button id="pop-refresh" title="지금 다시 읽기">↻ 새로 고침${note ? ` · ${esc(note)}` : ""}</button>` : ""}</div>
    ${blocks.length ? blocks.join("") : '<div class="pop-limits-none">에이전트가 아직 알려 주지 않았어요</div>'}`;
}
const tokens = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n)) + " 토큰";

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
  drawParty(m);
  drawProg(m);
  drawToday(m);
  drawLimits(m, now);
  drawTabs(m);
  drawDot();
}

// 야생 (rule 3): the wild card as in the main window — throw here (click / ⌘B); "도감에서 보기" opens Tamer
const wild = createWild($("#pop-wild"), {
  invoke,
  log: (line) => invoke("popover_log", { line }).catch(() => {}),
  dexButton: (e) => invoke("popover_dex", { id: e.id }),
});
listen("wild", (e) => { wild.show(e.payload); drawDot(); });
listen("wild-throw", (e) => wild.play(e.payload));
listen("wild-end", (e) => { wild.end(e.payload); drawDot(); });
listen("popover", (e) => draw(e.payload));
listen("party", () => invoke("popover_state").then(draw).catch(() => {}));

document.addEventListener("click", (e) => {
  // 선두 바꾸기 right here (#112): a party member's picture → first in the party
  const mon = e.target.closest(".pop-mon[data-uid]:not(.lead)");
  if (mon && model?.party) { const u = Number(mon.dataset.uid); return invoke("party_set", { uids: [u, ...model.party.list.map((m) => m.uid).filter((x) => x !== u)] }).then(() => invoke("popover_state")).then(draw).catch(() => {}); }
  const t = e.target.closest("button");
  if (!t) return;
  if (t.id === "pop-refresh") { t.textContent = "↻ 읽는 중…"; invoke("limits_refresh", { user: true }).catch(() => {}); }
  else if (t.id === "pop-open") invoke("popover_open");
  else if (t.id === "pop-settings") invoke("popover_settings");
  else if (t.id === "pop-quit") invoke("popover_quit");
  else if (t.id === "pop-party-go") invoke("popover_party"); // 포켓몬 창의 ⭐ 파티 (#107)
  else if (t.id === "pop-egg-in") invoke("egg_in", { kind: t.dataset.kind }).then(() => invoke("popover_state")).then(draw).catch(() => {}); // 🥚 (#116) // 완전히 끄기 (#106 — the right-click menu's "Tamer 종료" too)
  else if (t.dataset.page) showPage(t.dataset.page); // 위쪽 탭 (#118)
  else if (t.dataset.agent) { agentPick = t.dataset.agent; keep.set("pop.agent", agentPick); drawLimits(model, Date.now()); } // 에이전트 칩
  else if (t.dataset.ws) invoke("popover_tab", { ws: t.dataset.ws });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") invoke("popover_hide");
  else if (e.metaKey && e.key.toLowerCase() === "b") { e.preventDefault(); if (wildOut()) showPage("poke"); wild.throwBall(); } // the throw shown where the card is
});

// the window follows the content's height
new ResizeObserver(() => invoke("popover_fit", { height: $("#pop").offsetHeight })).observe($("#pop"));
showPage(page);
invoke("popover_state").then((m) => { draw(m); if (m.wild) { wild.show({ ...m.wild, balls: m.balls }); drawDot(); } }).catch(() => {});
setInterval(() => { if (model && !document.hidden) { drawLimits(model, Date.now()); drawDot(); } }, 30000); // 초기화까지 · n분 전 · a wild one gone by itself
