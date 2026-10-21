// What a UI change touches, before making it (docs/UI_SYSTEM.md):
//   npm run ui:impact -- <component | file | css class | scene | function>
//     → the components it belongs to, the screens using them, the scenes to compare (npm run ui:shots)
//   npm run ui:impact            (no argument) → only the CSS check below
// CSS check (always): the same selector defined in two places (two screens styling one class — the
// beta.18 ".mon" collision), and rules in a shared module's stylesheet outside its namespace.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, "src/poke/ui-map.json"), "utf8"));
const term = process.argv.slice(2).join(" ").trim();

// ── what it touches ──────────────────────────────────────────────────────────
if (term) {
  const t = term.toLowerCase();
  const hit = Object.entries(MAP.components).filter(([name, c]) =>
    name.toLowerCase().includes(t) || (c.files || []).some((f) => f.toLowerCase().includes(t) || t.includes(f.toLowerCase()))
    || (c.selectors || []).some((s) => s.toLowerCase().includes(t)) || (c.functions || []).some((f) => f.toLowerCase() === t)
    || Object.values(MAP.screens).some((sc) => sc.scenes.includes(term) && (c.screens || []).some((n) => MAP.screens[n] === sc)));
  if (!hit.length) console.log(`"${term}": no component in src/poke/ui-map.json — add it there if it's UI`);
  const screens = new Set(), scenes = new Set();
  for (const [name, c] of hit) {
    console.log(`component ${name} — ${c.what}`);
    for (const s of c.screens || []) { screens.add(s); for (const sc of MAP.screens[s]?.scenes || []) scenes.add(sc); }
  }
  if (screens.size) {
    console.log(`\nscreens: ${[...screens].map((s) => `${s} (${MAP.screens[s].what})`).join(", ")}`);
    console.log(`scenes to compare: ${[...scenes].join(", ") || "(none registered — add one)"}`);
    console.log("→ npm run ui:shots before and after; only these scenes should move");
  }
  // where the term appears in the code (call sites, markup, styles)
  const uses = [];
  for (const f of ["src/main.js", "src/wild.js", "src/overlay.js", "index.html", "src/style.css", "src/wild.css", "src/overlay.css", ...fs.readdirSync(path.join(ROOT, "src/poke")).map((x) => `src/poke/${x}`)]) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) continue;
    fs.readFileSync(p, "utf8").split("\n").forEach((l, i) => { if (l.includes(term)) uses.push(`${f}:${i + 1}`); });
  }
  if (uses.length) console.log(`\n"${term}" appears at ${uses.length} place(s): ${uses.slice(0, 30).join(" ")}${uses.length > 30 ? " …" : ""}`);
}

// ── CSS check ────────────────────────────────────────────────────────────────
function rules(file) {
  // comments blanked (line numbers kept); a selector = the text before "{" outside @keyframes
  const text = fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const out = [], stack = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      const s = text.slice(start, i).trim();
      const outer = stack.filter((x) => x.startsWith("@"));
      if (s && !s.startsWith("@") && !outer.some((x) => x.startsWith("@keyframes"))) {
        const parts = s.split(",");
        for (const one of parts) out.push({ sel: one.replace(/\s+/g, " ").trim(), media: outer.join(" "), line: text.slice(0, i).split("\n").length, file, shared: parts.length > 1 });
      }
      stack.push(s);
      start = i + 1;
    } else if (ch === "}") { stack.pop(); start = i + 1; }
    else if (ch === ";") start = i + 1;
  }
  return out.filter((r) => r.sel);
}
const CSS = ["src/style.css", "src/wild.css", "src/overlay.css", ...fs.readdirSync(path.join(ROOT, "src/poke")).filter((x) => x.endsWith(".css")).map((x) => `src/poke/${x}`)]
  .filter((f) => fs.existsSync(path.join(ROOT, f)));
const all = CSS.flatMap(rules);
const problems = [];
// the same selector in two places of one page (two screens styling one class) — pages are checked
// apart: the desktop overlay is another window with its own stylesheet
for (const [doc, files] of Object.entries(MAP.css?.documents || { all: CSS })) {
  const bySel = new Map();
  for (const r of all.filter((x) => files.includes(x.file))) { const k = `${r.media} ${r.sel}`.trim(); bySel.set(k, [...(bySel.get(k) || []), r]); }
  for (const [sel, rs] of bySel) {
    // a rule shared with other selectors ("a, b { … }") plus one of its own is deliberate; two rules
    // of its own in two places is two screens styling the same thing
    const own = [...new Set(rs.filter((r) => !r.shared).map((r) => `${r.file}:${r.line}`))];
    if (own.length > 1 && !(MAP.css?.allowRepeat || []).includes(sel)) problems.push(`${doc}: defined in ${own.length} places: ${sel}  (${own.join(", ")})`);
  }
}
// a module's own files: "file", or "files" when it has more than one (poke: poke.css + egg.css, the egg the dashboard draws too)
const own = (m) => m.files || [m.file];
for (const [mod, m] of Object.entries(MAP.css?.namespaces || {})) {
  for (const r of all.filter((x) => own(m).includes(x.file))) {
    if (!m.prefixes.some((p) => r.sel.startsWith(p) || r.sel.startsWith(`:root`) || r.sel.startsWith("body.ui-test"))) problems.push(`${mod} rule outside its namespace (${m.prefixes.join(" ")}): ${r.sel}  (${r.file}:${r.line})`);
  }
}
// classes that shared modules own must not be styled from elsewhere
for (const [mod, m] of Object.entries(MAP.css?.namespaces || {})) {
  for (const r of all.filter((x) => !own(m).includes(x.file))) {
    for (const p of m.prefixes.filter((p) => p.startsWith("."))) if (r.sel.includes(p)) problems.push(`${mod}'s ${p}* styled outside ${own(m).join(" · ")}: ${r.sel}  (${r.file}:${r.line})`);
  }
}
console.log(`\nCSS check: ${problems.length ? `${problems.length} problem(s)` : "ok"}`);
for (const p of problems) console.log(`  ✗ ${p}`);
process.exitCode = problems.length ? 1 : 0;
