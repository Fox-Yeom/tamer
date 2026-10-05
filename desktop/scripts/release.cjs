// Beta release on GitHub (private repo Y-jae-heon/tamer): uploads the DMGs of the current version
// as a pre-release with that version's notes from docs/CHANGELOG.md, and prints the link.
//   npm run release              build (npm run beta) if the DMGs are missing, then publish
//   npm run release -- --invite <github-user>   give a tester read access (private repo: needed to download)
// Testers need a GitHub account with access to the private repo; the link 404s for anyone else.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const REPO = "Y-jae-heon/tamer";
const { version } = require(path.join(ROOT, "package.json"));
const TAG = `v${version}`;
const OUT = path.join(ROOT, "out", "beta");
const gh = (args, opts = {}) => execFileSync("gh", args, { encoding: "utf8", cwd: ROOT, ...opts });

const invite = process.argv.indexOf("--invite");
if (invite > 0) {
  const user = process.argv[invite + 1];
  if (!user || !/^[A-Za-z0-9-]+$/.test(user)) throw new Error("usage: npm run release -- --invite <github-user>");
  gh(["api", "-X", "PUT", `repos/${REPO}/collaborators/${user}`, "-f", "permission=pull"]);
  console.log(`invited ${user} (read). They accept the invitation mail, then the release link works.`);
  process.exit(0);
}

// the release tag goes on main as GitHub has it: local main must be pushed first
const git = (args) => execFileSync("git", args, { encoding: "utf8", cwd: ROOT }).trim();
git(["fetch", "-q", "origin", "main"]);
if (git(["rev-parse", "HEAD"]) !== git(["rev-parse", "origin/main"])) {
  console.error("local main differs from origin/main — push first (git push), then npm run release");
  process.exit(1);
}

// the test lab passed on exactly this commit (docs/TESTING.md): every smoke case, real data untouched
const lab = (() => { try { return JSON.parse(fs.readFileSync(path.join(require("node:os").homedir(), ".cache/tamer-dev/lab-last.json"), "utf8")); } catch { return null; } })();
// — or on exactly this commit's desktop/ content before it was committed (the run records the tree it built)
const commitTree = git(["rev-parse", "HEAD:desktop"]);
const labOk = lab?.smoke && ((lab.head === git(["rev-parse", "HEAD"]) && !lab.dirty) || (lab.tree && lab.tree === commitTree));
if (!labOk) {
  console.error(`the test lab hasn't passed on this commit's content — cd desktop && npm run lab -- --tag smoke (last: ${lab ? `${lab.head.slice(0, 7)}${lab.dirty ? " with uncommitted changes" : ""}, content ${lab.tree?.slice(0, 10) || "?"} vs commit ${commitTree.slice(0, 10)}, smoke ${lab.smoke ? "pass" : "not met"}` : "none"})`);
  process.exit(1);
}

// the spec (docs/spec, rule 15): references intact, and every card this release's code changes hit
// directly names one of its issues (or the version) in **이력** — a fix that changed a feature without
// its card stops here. --spec-ok <ids>: those cards were looked at, nothing to change
{
  const node = (args) => { try { execFileSync(process.execPath, [path.join(ROOT, "scripts/spec.cjs"), ...args], { stdio: "inherit", cwd: ROOT }); return true; } catch { return false; } };
  if (!node(["check"])) { console.error("spec:check failed — fix the broken references first"); process.exit(1); }
  const last = (() => { try { return gh(["release", "list", "-R", REPO, "--limit", "1", "--json", "tagName", "-q", ".[0].tagName"]).trim(); } catch { return ""; } })();
  if (last && last !== TAG) {
    git(["fetch", "-q", "origin", "tag", last]);
    const i = process.argv.indexOf("--spec-ok");
    const ok = i > 0 ? process.argv[i + 1] || "" : "";
    if (!node(["gate", `${last}..HEAD`, version, ok])) process.exit(1);
  }
}

// README is the testers' feature guide (per-version notes live in the releases): a version with a
// "새 기능:" line must come with a README change since the last release. --readme-ok: checked, nothing to add
{
  const notesOf = (v) => (fs.readFileSync(path.join(ROOT, "..", "docs", "CHANGELOG.md"), "utf8").split(/^## /m).find((s) => s.startsWith(v + " ")) || "");
  const last = (() => { try { return gh(["release", "list", "-R", REPO, "--limit", "1", "--json", "tagName", "-q", ".[0].tagName"]).trim(); } catch { return ""; } })();
  if (last && last !== TAG && /^- 새 기능:/m.test(notesOf(version)) && !process.argv.includes("--readme-ok")) {
    git(["fetch", "-q", "origin", "tag", last]);
    if (!git(["diff", "--name-only", last, "HEAD", "--", ":(top)README.md"])) { // the repo's README, not desktop/README.md
      console.error(`${TAG} has new features but README.md hasn't changed since ${last} — add them to the README (features, shortcuts, data, known issues), or --readme-ok if nothing belongs there`);
      process.exit(1);
    }
  }
}

// --check: only the checks above (pushed, lab passed, spec, README) — nothing is built, uploaded or edited
if (process.argv.includes("--check")) { console.log(`ready to release ${TAG}: pushed, the lab passed on this commit, the spec is in step`); process.exit(0); }

// a version is released once (docs/VERSIONING.md): its tag and DMGs are never replaced. A release
// that already exists means the version wasn't bumped (2026-10-05: a failed bump went unnoticed and
// the release step re-uploaded the previous version) — stop. Only notes: --notes-only
const already = (() => { try { gh(["release", "view", TAG, "-R", REPO]); return true; } catch { return false; } })();
if (already && !process.argv.includes("--notes-only")) {
  console.error(`${TAG} is already released — bump the version first (npm run bump), or --notes-only to rewrite its notes`);
  process.exit(1);
}

const dmgs = ["arm64", "x64"].map((a) => path.join(OUT, `Tamer-${version}-${a}.dmg`));
if (!already && !dmgs.every((f) => fs.existsSync(f))) execFileSync("npm", ["run", "beta"], { stdio: "inherit", cwd: ROOT });

// this version's notes: its section in docs/CHANGELOG.md, plus how to install
const changelog = fs.readFileSync(path.join(ROOT, "..", "docs", "CHANGELOG.md"), "utf8");
const section = changelog.split(/^## /m).find((s) => s.startsWith(version + " ")) || "";
const changes = section.split("\n").slice(1).join("\n").trim() || "-";
const notes = `## 받기
- Apple Silicon(M1~): \`Tamer-${version}-arm64.dmg\`
- Intel: \`Tamer-${version}-x64.dmg\`

## 설치
1. DMG를 열고 Tamer를 Applications로 끌어 놓기
2. 처음 한 번: 시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기" (또는 \`xattr -dr com.apple.quarantine /Applications/Tamer.app\`) — Apple 공증 전 베타라서
3. 사용법·문제 보고는 저장소 README

## 이번 버전
${changes}
`;
const exists = (() => { try { gh(["release", "view", TAG, "-R", REPO]); return true; } catch { return false; } })();
const notesFile = path.join(OUT, `notes-${version}.md`);
fs.writeFileSync(notesFile, notes);
if (exists) {
  gh(["release", "edit", TAG, "-R", REPO, "--notes-file", notesFile]); // --notes-only: never the DMGs
} else {
  gh(["release", "create", TAG, ...dmgs, "-R", REPO, "--prerelease", "--title", `Tamer ${version}`, "--notes-file", notesFile, "--target", "main"]);
}
const url = gh(["release", "view", TAG, "-R", REPO, "--json", "url", "-q", ".url"]).trim();
console.log(`\n${exists ? "updated" : "published"}: ${url}`);

// after a new release (docs/VERSIONING.md — was done by hand each time): every issue its notes name
// gets "v<version>에 반영" and the label `수정됨-확인 대기` (closing waits for the user), and this Mac's
// docs say the version where they said "다음 버전" (test scenarios' headings, spec cards)
if (!exists) {
  const issues = [...new Set([...changes.matchAll(/#(\d+)/g)].map((m) => m[1]))];
  for (const n of issues) {
    try {
      if (gh(["issue", "view", n, "-R", REPO, "--json", "state", "-q", ".state"]).trim() !== "OPEN") { console.log(`issue #${n}: closed — left as is`); continue; }
      gh(["issue", "comment", n, "-R", REPO, "--body", `v${version}에 반영`]);
      gh(["issue", "edit", n, "-R", REPO, "--add-label", "수정됨-확인 대기"]);
      console.log(`issue #${n}: v${version}에 반영 · 수정됨-확인 대기`);
    } catch (e) { console.error(`issue #${n}: not updated (${String(e.message).split("\n")[0]}) — do it by hand`); }
  }
  const short = version.replace(/^\d+\.\d+\.\d+-/, ""); // beta.35
  const docs = path.join(ROOT, "..", "docs");
  const stamp = (file, edit) => { try { const s = fs.readFileSync(file, "utf8"), t = edit(s); if (t !== s) { fs.writeFileSync(file, t); console.log(`stamped ${path.relative(path.join(ROOT, ".."), file)}`); } } catch {} };
  stamp(path.join(docs, "TEST_SCENARIOS.md"), (s) => s.replace(/^(## .*)\(다음 버전\)$/gm, `$1(${version})`));
  for (const f of fs.existsSync(path.join(docs, "spec")) ? fs.readdirSync(path.join(docs, "spec")) : []) {
    if (f.endsWith(".md")) stamp(path.join(docs, "spec", f), (s) => s.replace(/✅ 다음 버전/g, `✅ ${short}`).replace(/\(다음 버전\)/g, `(${short})`));
  }
}
