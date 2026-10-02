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

const dmgs = ["arm64", "x64"].map((a) => path.join(OUT, `Tamer-${version}-${a}.dmg`));
if (!dmgs.every((f) => fs.existsSync(f))) execFileSync("npm", ["run", "beta"], { stdio: "inherit", cwd: ROOT });

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
  gh(["release", "upload", TAG, ...dmgs, "-R", REPO, "--clobber"]);
  gh(["release", "edit", TAG, "-R", REPO, "--notes-file", notesFile]);
} else {
  gh(["release", "create", TAG, ...dmgs, "-R", REPO, "--prerelease", "--title", `Tamer ${version}`, "--notes-file", notesFile, "--target", "main"]);
}
const url = gh(["release", "view", TAG, "-R", REPO, "--json", "url", "-q", ".url"]).trim();
console.log(`\n${exists ? "updated" : "published"}: ${url}`);
