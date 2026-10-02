// Signs a built Tamer.app with this Mac's own signing identity "Tamer Local Signing" (a
// self-signed code-signing certificate in the login keychain) when it exists. A stable identity
// keeps macOS's folder-access answers (Documents, Desktop …) across rebuilds and updates; ad-hoc
// signatures change every build, so macOS asked again each time. Without the identity: ad hoc
// (unchanged). Runs after the fuses (they reset the signature).
//   node scripts/sign.cjs <path/to/Tamer.app>
const { execFileSync } = require("node:child_process");

const LOCAL = "Tamer Local Signing";
const app = process.argv[2];
if (!app) throw new Error("usage: node scripts/sign.cjs <Tamer.app>");
const ids = execFileSync("security", ["find-identity", "-p", "codesigning"], { encoding: "utf8" });
if (!ids.includes(`"${LOCAL}"`)) {
  console.log(`sign: no "${LOCAL}" identity — ad hoc`);
  process.exit(0);
}
execFileSync("codesign", ["--force", "--deep", "--sign", LOCAL, "--timestamp=none", app], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
console.log(`sign: ${LOCAL} → ${app}`);
