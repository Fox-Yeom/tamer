// A Pokémon card (#29, docs/UI_SYSTEM.md): 내 포켓몬 and 파트너 고르기 draw the same one.
//   item: { id, name, gif, shiny, xp, toEvolve, types, folder: "here" | a folder's name | null,
//           new, kind: "starter" | "loading" | …, n (the starter's 1·2·3) }
//   i: its place in the list (data-i), or null for one that can't be picked (loading)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function pkCard(item, i, { icons = {}, ago = () => "" } = {}) {
  if (item.kind === "loading") return '<div class="pk-card loading"><div class="pokeball"></div><span class="dim">찾는 중…</span></div>';
  const where = item.kind === "starter" ? "첫 파트너 후보" : item.folder === "here" ? "이 탭" : item.folder ? `📁 ${esc(item.folder)}` : "쉬는 중";
  const line = item.kind === "starter" ? (item.types || []).map((t) => icons[t] || t).join(" ")
    : `EXP ${item.xp || 0} · ${item.toEvolve == null ? "최종" : `진화까지 ${item.toEvolve}`}`;
  return `<div class="pk-card${item.new ? " new" : ""}${item.folder === "here" ? " here" : ""}" data-i="${i}"${item.key ? ` data-key="${item.key}"` : ""}`
    + ` title="${esc(item.name)}${item.at ? ` · ${ago(item.at)}` : ""}">`
    + (item.n ? `<span class="k">${item.n}</span>` : "")
    + (item.gif ? `<img data-gif="${esc(item.gif)}" alt="" />` : '<span class="q">?</span>')
    + `<b>${item.shiny ? "✨" : ""}${esc(item.name)}</b><span class="dim">${line}</span><span class="where">${where}</span>`
    + (item.new ? '<i class="pk-newb">NEW</i>' : "") + "</div>";
}
