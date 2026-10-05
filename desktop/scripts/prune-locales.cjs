// Keep only the languages Tamer speaks (D1, 2026-10-05): Electron ships ~55 Chromium UI languages
// (locale.pak in every <lang>.lproj, ~49 MB) — Tamer's screens are Korean and macOS's own dialogs need
// English as the fallback. A Mac set to another language gets English in Chromium's few built-in
// strings (Chromium falls back to en-US when its language file isn't there).
// Run on a packaged app before the fuses and the signature (removing files after signing breaks it).
//   node scripts/prune-locales.cjs <Tamer.app>
const fs = require("node:fs");
const path = require("node:path");

const KEEP = new Set(["en", "en_GB", "ko", "Base"]);
function prune(app) {
  let n = 0, bytes = 0;
  const dirs = [path.join(app, "Contents", "Resources"), path.join(app, "Contents", "Frameworks", "Electron Framework.framework", "Resources")];
  const size = (p) => { const s = fs.lstatSync(p); return s.isDirectory() ? fs.readdirSync(p).reduce((a, f) => a + size(path.join(p, f)), 0) : s.size; };
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir)) {
      if (!e.endsWith(".lproj") || KEEP.has(e.slice(0, -6))) continue;
      const p = path.join(dir, e);
      bytes += size(p); n++;
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
  console.log(`locales: removed ${n} language folders (${(bytes / 1048576).toFixed(1)} MB), kept ${[...KEEP].join(" ")}`);
}
module.exports = { prune };
if (require.main === module) {
  const app = process.argv[2];
  if (!app || !fs.existsSync(app)) { console.error("usage: node scripts/prune-locales.cjs <Tamer.app>"); process.exit(1); }
  prune(app);
}
