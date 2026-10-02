// Next version (docs/VERSIONING.md): `## 다음 버전` in CHANGELOG becomes this version's section.
//   npm run bump              0.3.0-beta.4 → 0.3.0-beta.5
//   npm run bump -- minor     0.3.0-beta.9 → 0.4.0-beta.1   (a feature set)
// Refuses when `## 다음 버전` is empty: no number without a change.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PKG = path.join(ROOT, "package.json");
const LOG = path.join(ROOT, "..", "docs", "CHANGELOG.md");
const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
const m = pkg.version.match(/^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/);
if (!m) throw new Error(`not a beta version: ${pkg.version}`);
const [major, minor, patch, n] = m.slice(1).map(Number);
const next = process.argv.includes("minor") ? `${major}.${minor + 1}.0-beta.1` : `${major}.${minor}.${patch}-beta.${n + 1}`;

const log = fs.readFileSync(LOG, "utf8");
const at = log.indexOf("## 다음 버전");
if (at < 0) throw new Error("CHANGELOG: no '## 다음 버전' section");
const end = log.indexOf("\n## ", at + 1);
const body = log.slice(at + "## 다음 버전".length, end < 0 ? undefined : end).trim();
if (!body) { console.error("CHANGELOG '## 다음 버전' is empty — write what changed first"); process.exit(1); }

const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; // local date (UTC was a day behind after midnight KST)
const updated = log.slice(0, at) + `## 다음 버전\n\n## ${next} (${today})\n${body}\n` + (end < 0 ? "" : log.slice(end));
fs.writeFileSync(LOG, updated);
pkg.version = next;
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");
console.log(`${m[0]} → ${next}`);
