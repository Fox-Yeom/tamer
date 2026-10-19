// A preview of develop for the user to try before anything is released (docs/VERSIONING.md, 2026-10-19):
// checks that develop is pushed and the lab passed on it, builds Tamer.app into out/preview (never
// out/Tamer-darwin-arm64 or the Applications copy), tells every open issue in CHANGELOG's
// `## 다음 버전` that it's on develop (label `수정됨-확인 대기`) and prints how to open it.
//   npm run preview              check, build, tell the issues
//   npm run preview -- --check   only the checks
// The app is a dev build (version + commit in Tamer 정보) on the user's own data — they quit their
// Tamer first (no single-instance lock: two copies would write the same files).
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const REPO = "Fox-Yeom/tamer";
const OUT = path.join(ROOT, "out", "preview");
const APP = path.join(OUT, "Tamer-darwin-arm64", "Tamer.app");
const git = (args) => execFileSync("git", args, { encoding: "utf8", cwd: ROOT }).trim();
const gh = (args) => execFileSync("gh", args, { encoding: "utf8", cwd: ROOT });
const stop = (msg) => { console.error(msg); process.exit(1); };

if (git(["rev-parse", "--abbrev-ref", "HEAD"]) !== "develop") stop("previews are of develop: git checkout develop");
if (git(["status", "--porcelain", "--", "."])) stop("desktop/ has uncommitted changes — commit them to develop (the preview is what develop holds)");
git(["fetch", "-q", "origin", "develop"]);
if (git(["rev-parse", "HEAD"]) !== git(["rev-parse", "origin/develop"])) stop("local develop differs from origin/develop — git push first");
const gate = require("./smoke-gate.cjs").smokePassed(git);
if (!gate.ok) stop(gate.why);
const head = git(["rev-parse", "--short", "HEAD"]);
if (process.argv.includes("--check")) { console.log(`ready to preview develop ${head}: pushed, the lab passed on it`); process.exit(0); }

// the preview being tried right now isn't rebuilt under it
try { execFileSync("pgrep", ["-f", `${APP}/Contents/MacOS/Tamer`]); stop(`the preview is open (${APP}) — quit it first`); } catch {}
fs.rmSync(OUT, { recursive: true, force: true });
console.log("building the preview…");
require("./test-env.cjs").packTo(OUT);

// the issues this develop holds: those named in `## 다음 버전`
const log = fs.readFileSync(path.join(ROOT, "..", "docs", "CHANGELOG.md"), "utf8");
const at = log.indexOf("## 다음 버전"), end = log.indexOf("\n## ", at + 1);
const pending = at < 0 ? "" : log.slice(at, end < 0 ? undefined : end);
for (const n of new Set([...pending.matchAll(/#(\d+)/g)].map((m) => m[1]))) {
  try {
    const st = JSON.parse(gh(["issue", "view", n, "-R", REPO, "--json", "state,comments"]));
    if (st.state !== "OPEN") { console.log(`issue #${n}: closed — left as is`); continue; }
    const body = `develop에 반영 (${head}) — 미리보기로 확인 대기`;
    if (!st.comments.some((c) => c.body === body)) gh(["issue", "comment", n, "-R", REPO, "--body", body]);
    gh(["issue", "edit", n, "-R", REPO, "--add-label", "수정됨-확인 대기"]);
    console.log(`issue #${n}: ${body}`);
  } catch (e) { console.error(`issue #${n}: not updated (${String(e.message).split("\n")[0]}) — do it by hand`); }
}
console.log(`\npreview of develop ${head}: ${APP}\n  quit Tamer (⌘Q), then: open "${APP}"`);
