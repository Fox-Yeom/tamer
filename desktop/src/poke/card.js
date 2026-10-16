// A Pokémon card (#29, docs/UI_SYSTEM.md): 내 포켓몬 and 파트너 고르기 draw the same one.
//   item: { id, name, gif, shiny, lv, final, next, types, folder: "here" | a folder's name | null,
//           new, kind: "starter" | "loading" | …, n (the starter's 1·2·3) }
//   i: its place in the list (data-i), or null for one that can't be picked (loading)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// the level line (#74, PKM-21): "Lv 24 · 진화 Lv 36" · after its last form "Lv 72 · 졸업까지 28" ·
// friendship "Lv 9 · 친밀도 12/20" · a trade "교환 진화" · a stone / anything else Lv 30 (stones come later, PKM-28)
export function lvLine(m) {
  if (m.egg) return `부화 ${m.egg.have}/${m.egg.need}`; // 🥚 (#84)
  if (m.lv == null) return `EXP ${m.xp || 0}`;
  const lv = `Lv ${m.lv}`, n = m.next;
  if (m.final || m.grad) return m.lv >= 100 ? `${lv} · ${m.grad ? "졸업" : "최종"}` : `${lv} · 졸업까지 ${100 - m.lv}`;
  if (!n) return lv; // how it evolves isn't known yet (fetched in the background)
  return `${lv} · ${n.kind === "friend" ? `친밀도 ${n.friend}/${n.of}` : n.kind === "trade" ? "교환 진화" : `진화 Lv ${n.level}`}`;
}

export function pkCard(item, i, { icons = {}, ago = () => "" } = {}) {
  if (item.kind === "loading") return '<div class="pk-card loading"><div class="pokeball"></div><span class="dim">찾는 중…</span></div>';
  const where = item.kind === "starter" ? "첫 파트너 후보" : item.inc ? (item.inc === "active" ? "🥚 부화기" : "부화기 대기") : item.folder === "here" ? "이 탭" : item.folder ? `📁 ${esc(item.folder)}` : "쉬는 중";
  const line = item.kind === "starter" ? (item.types || []).map((t) => icons[t] || t).join(" ")
    : lvLine(item);
  return `<div class="pk-card${item.new ? " new" : ""}${item.folder === "here" ? " here" : ""}" data-i="${i}"${item.key ? ` data-key="${item.key}"` : ""}`
    + ` title="${esc(item.name)}${item.at ? ` · ${ago(item.at)}` : ""}">`
    + (item.n ? `<span class="k">${item.n}</span>` : "")
    + (item.egg ? `<i class="pk-egg${item.egg.kind === "egg2" ? " rare" : ""}"></i>` : item.gif ? `<img data-gif="${esc(item.gif)}" alt="" />` : '<span class="q">?</span>')
    + `<b>${item.grad ? "🎓 " : ""}${item.shiny ? "✨" : ""}${esc(item.name)}</b><span class="dim">${line}</span><span class="where">${where}</span>`
    + (item.new ? '<i class="pk-newb">NEW</i>' : "") + "</div>";
}
