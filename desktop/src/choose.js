// 포켓몬 고르기 창 (PKM-32 · APP-22 rule 11, #122): a window of its own — the first Pokémon (3 starters while the box is
// empty: the one picked is the 메인 파트너) or, with an empty party, the suggestion (the former folder partners once, else the
// box newest first; tap to add, the order tapped = the party's order). It opens by itself once (the main process's
// chooseAuto), else from [포켓몬 고르기]. The page may call only its own short list of commands (chooseCommands — POL-SEC-02).
import { invoke, listen } from "./host.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const TYPES = { normal: "노말", fire: "불꽃", water: "물", grass: "풀", electric: "전기", ice: "얼음", fighting: "격투", poison: "독", ground: "땅",
  flying: "비행", psychic: "에스퍼", bug: "벌레", rock: "바위", ghost: "고스트", dragon: "드래곤", dark: "악", steel: "강철", fairy: "페어리" };
const josa = (w, a, b) => { const c = String(w).charCodeAt(String(w).length - 1); return `${w}${c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? a : b}`; };

// 테마 (APP-20): the app sets macOS's appearance for itself — follow it like the other windows
const darkMedia = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => { document.documentElement.dataset.theme = darkMedia.matches ? "dark" : "light"; };
applyTheme();
darkMedia.addEventListener("change", applyTheme);

const sprites = new Map();
const sprite = (gif) => {
  if (!gif) return Promise.resolve(null);
  if (!sprites.has(gif)) sprites.set(gif, invoke("sprite_b64", { path: gif }).then((b) => `data:image/gif;base64,${b}`).catch(() => null));
  return sprites.get(gif);
};

let model = null, sel = 0, picked = [], slow = null;
const close = () => invoke("choose_close").catch(() => {});

// 첫 파트너: three cards (1 · 2 · 3) and [○○와 함께하기]
function drawFirst(m) {
  const st = m.starter || { set: [], total: 3 };
  $("#ch-title").textContent = "함께할 첫 포켓몬을 골라요";
  $("#ch-sub").innerHTML = "고른 포켓몬이 <b>메인 파트너</b>가 돼요 — 터미널 파트너 칸 · 바탕화면 · 메뉴바에 함께. 어디서 작업을 끝내도 파티가 커요";
  const cards = st.set.map((c, i) => `<button class="ch-card${i === sel ? " on" : ""}" role="option" aria-selected="${i === sel}" data-i="${i}"><i class="ch-n">${i + 1}</i><img alt="" data-gif="${esc(c.gif || "")}" />`
    + `<b>${c.shiny ? "✨" : ""}${esc(c.name)}</b><span class="ch-types">${(c.types || []).map((t) => `<em>${esc(TYPES[t] || t)}</em>`).join("")}</span></button>`);
  for (let i = st.set.length; i < st.total; i++) cards.push('<div class="ch-card wait"><i class="ch-n"></i><span class="ch-ball"></span><span class="dim">받는 중…</span></div>');
  $("#ch-cards").className = "first";
  $("#ch-cards").innerHTML = cards.join("");
  $("#ch-note").textContent = st.ready ? "" : m.loading ? `첫 포켓몬 후보를 받는 중… ${st.set.length}/${st.total} (PokéAPI)`
    : `후보를 다 받지 못했어요(${st.set.length}/${st.total}) — 인터넷이 되면 파트너 칸의 [포켓몬 고르기]로 다시 열어요`; // offline: the fetch ended
  const c = st.set[sel];
  $("#ch-foot").textContent = "처음 한 번만 고를 수 있어요 · 다음부터는 야생 포켓몬 · 알로";
  $("#ch-acts").innerHTML = `<button id="ch-go" class="ch-primary"${c ? "" : " disabled"}>${c ? `${esc(josa(c.name, "과", "와"))} 함께하기` : "함께하기"}</button>`;
  $("#ch-help").textContent = "1 · 2 · 3 고르기 · Enter 함께하기 · Esc 나중에(파트너 칸의 [포켓몬 고르기])";
  loadPics();
  clearTimeout(slow);
  if (!st.ready) slow = setTimeout(() => { if (model?.mode === "first" && !model.starter?.ready) $("#ch-note").textContent = "PokéAPI 응답이 느려요 — 나중에 파트너 칸의 [포켓몬 고르기]로 다시 열어도 돼요"; }, 30000);
}

// 파티 제안: cards to tap (the order tapped = the party's order, the 1st = 메인), [나중에] [파티에 넣기 (n)]
function drawSuggest(m) {
  $("#ch-title").textContent = m.former ? "파티가 비어 있어요 — 예전 파트너를 데려올까요?" : "파티에 넣을 포켓몬을 골라요";
  $("#ch-sub").innerHTML = m.former
    ? `이제 포켓몬은 폴더가 아니라 <b>파티</b>로 커요. 폴더 파트너였던 포켓몬을 레벨 높은 순으로 골라 두었어요 — 최대 ${m.max}마리, 1번이 메인 파트너`
    : `어디서 작업을 끝내도 파티가 차례로 한 마리씩 커요 — 최대 ${m.max}마리, 1번이 메인 파트너`;
  const room = Math.max(0, m.room);
  $("#ch-cards").className = "suggest";
  $("#ch-cards").innerHTML = m.list.length ? m.list.map((x, i) => {
    const k = picked.indexOf(x.uid);
    return `<button class="ch-card${k >= 0 ? " on" : ""}${i === sel ? " cur" : ""}" role="option" aria-selected="${k >= 0}" data-i="${i}"><i class="ch-n">${k >= 0 ? `${k + 1}${k === 0 && !m.lead ? " · 메인" : ""}` : ""}</i><img alt="" data-gif="${esc(x.gif || "")}" />`
      + `<b>${x.shiny ? "✨" : ""}${esc(x.name)}</b><span class="dim">Lv ${x.lv ?? "?"}</span></button>`;
  }).join("") : '<p class="dim">고를 포켓몬이 없어요 — 작업을 끝내면 가끔 야생 포켓몬이 나타나요</p>';
  $("#ch-note").textContent = m.list.length ? `카드를 눌러 넣고 빼요 — 누른 순서가 파티 순서. 넣지 않은 포켓몬은 박스에서 쉬고, 레벨 · 진화 · 기록은 그대로예요${room < m.max ? ` · 남은 칸 ${room}` : ""}` : "";
  $("#ch-foot").textContent = "";
  $("#ch-acts").innerHTML = `<button id="ch-later">나중에</button><button id="ch-go" class="ch-primary"${picked.length ? "" : " disabled"}>파티에 넣기 (${picked.length})</button>`;
  $("#ch-help").textContent = "←→ 고르기 · Space 넣기/빼기 · Enter 파티에 넣기 · Esc 나중에(내 포켓몬 파티 줄에서 언제든)";
  loadPics();
}

function loadPics() { for (const img of document.querySelectorAll("#ch-cards img[data-gif]")) sprite(img.dataset.gif).then((u) => { if (u) img.src = u; }); }

function draw(m) {
  if (!m) return;
  const was = model?.mode;
  model = m;
  if (m.mode !== was) { sel = 0; picked = m.mode === "suggest" && m.former ? m.list.slice(0, Math.max(0, m.room)).map((x) => x.uid) : []; } // the former partners come ticked
  m.lead = false;
  (m.mode === "first" ? drawFirst : drawSuggest)(m);
}

async function go() {
  if (!model) return;
  if (model.mode === "first") {
    const c = model.starter?.set?.[sel];
    if (c) await invoke("choose_starter", { id: c.id }).catch((e) => { $("#ch-note").textContent = String(e?.message || e).replace(/^.*Error: /, ""); });
  } else if (picked.length) await invoke("choose_suggest", { uids: picked }).catch(() => {});
}
function toggle(i) {
  const x = model?.list?.[i];
  if (!x) return;
  const k = picked.indexOf(x.uid);
  if (k >= 0) picked.splice(k, 1); else if (picked.length < Math.max(0, model.room)) picked.push(x.uid);
  sel = i;
  drawSuggest(model);
}

document.addEventListener("click", (e) => {
  const c = e.target.closest(".ch-card[data-i]");
  if (c) { const i = Number(c.dataset.i); if (model.mode === "first") { sel = i; drawFirst(model); } else toggle(i); return; }
  const b = e.target.closest("button");
  if (b?.id === "ch-go") go();
  else if (b?.id === "ch-later") close();
});
// a starter double-clicked: that one at once (PKM-02 keys — as before in the Pokémon window)
document.addEventListener("dblclick", (e) => { const c = e.target.closest(".ch-card[data-i]"); if (c && model?.mode === "first") { sel = Number(c.dataset.i); go(); } });
document.addEventListener("keydown", (e) => {
  const n = model?.mode === "first" ? model.starter?.set?.length || 0 : model?.list?.length || 0;
  if (e.key === "Escape" || (e.metaKey && e.key.toLowerCase() === "w")) { e.preventDefault(); close(); }
  else if (e.key === "Enter") { e.preventDefault(); go(); }
  else if (model?.mode === "first" && /^[1-3]$/.test(e.key) && Number(e.key) <= n) { sel = Number(e.key) - 1; drawFirst(model); }
  else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && n) { sel = (sel + (e.key === "ArrowRight" ? 1 : n - 1)) % n; (model.mode === "first" ? drawFirst : drawSuggest)(model); }
  else if (e.key === " " && model?.mode === "suggest") { e.preventDefault(); toggle(sel); }
});

// tests: the page as drawn (test mode only — window.lab is what own_call_test reaches)
const LAB = { state: () => ({ mode: model?.mode || null, title: $("#ch-title").textContent, cards: [...document.querySelectorAll("#ch-cards .ch-card")].map((c) => c.textContent.replace(/\s+/g, " ").trim()),
  wait: document.querySelectorAll("#ch-cards .ch-card.wait").length, picked: [...picked], go: $("#ch-go")?.textContent || null, goOff: !!$("#ch-go")?.disabled, note: $("#ch-note").textContent, sel }) };

listen("choose", (e) => draw(e.payload));
invoke("choose_state").then((m) => { if (m?.test) window.lab = LAB; draw(m); }).catch(() => {});
