// Next version (docs/VERSIONING.md): `## 다음 버전` in CHANGELOG becomes this version's section.
// 0.MINOR.PATCH since 2026-10-19 (no -beta.N): a "새 기능:" line → the next MINOR, else the next PATCH.
//   npm run bump              0.8.1 → 0.8.2 (수정·개선) · 0.8.1 → 0.9.0 (새 기능)
//   npm run bump -- minor     / -- patch: that one, whatever the notes say
//   0.8.0-beta.5 → 0.8.0      the last beta's number without its suffix (the first release after betas)
// Refuses when `## 다음 버전` is empty: no number without a change. Run on develop, before main takes it.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PKG = path.join(ROOT, "package.json");
const LOG = path.join(ROOT, "..", "docs", "CHANGELOG.md");
const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
const m = pkg.version.match(/^(\d+)\.(\d+)\.(\d+)(-beta\.\d+)?$/);
if (!m) throw new Error(`not a version this knows: ${pkg.version}`);
const [major, minor, patch] = m.slice(1, 4).map(Number);

const log = fs.readFileSync(LOG, "utf8");
const at = log.indexOf("## 다음 버전");
if (at < 0) throw new Error("CHANGELOG: no '## 다음 버전' section");
const end = log.indexOf("\n## ", at + 1);
const body = log.slice(at + "## 다음 버전".length, end < 0 ? undefined : end).trim();
if (!body) { console.error("CHANGELOG '## 다음 버전' is empty — write what changed first"); process.exit(1); }

const feature = /^- 새 기능:/m.test(body);
const kind = process.argv.includes("minor") ? "minor" : process.argv.includes("patch") ? "patch" : feature ? "minor" : "patch";
const next = m[4] ? `${major}.${minor}.${patch}` : kind === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; // local date (UTC was a day behind after midnight KST)
const updated = log.slice(0, at) + `## 다음 버전\n\n## ${next} (${today})\n${body}\n` + (end < 0 ? "" : log.slice(end));
fs.writeFileSync(LOG, updated);
pkg.version = next;
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");
console.log(`${m[0]} → ${next}`);
