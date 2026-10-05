// Beta build: Tamer.app for Apple Silicon and Intel → out/beta/Tamer-<version>-<arch>.dmg
//   npm run beta                 both architectures
//   ARCHS=arm64 npm run beta     one
// Steps per architecture: the Rust core for that target → package (icon, agent files in
// Contents/Resources) → fuses → sign → DMG → notarize + staple.
// Signing: a "Developer ID Application" identity in the keychain → hardened runtime + notarization
// (notarytool keychain profile "tamer", `xcrun notarytool store-credentials tamer …`); without it
// the app is signed ad hoc and testers open it with "Open Anyway" (Privacy & Security).
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { packager } = require("@electron/packager");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out", "beta");
const { version } = require(path.join(ROOT, "package.json"));
const ARCHS = (process.env.ARCHS || "arm64 x64").split(/\s+/).filter(Boolean);
const TARGET = { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" };
const PROFILE = process.env.NOTARY_PROFILE || "tamer";
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", cwd: ROOT });

function identity() {
  const m = out("security", ["find-identity", "-v", "-p", "codesigning"]).match(/"(Developer ID Application: [^"]+)"/);
  return m ? m[1] : null;
}
function hasProfile() {
  try { out("xcrun", ["notarytool", "history", "--keychain-profile", PROFILE]); return true; } catch { return false; }
}

async function build(arch, id) {
  console.log(`\n── ${arch} ──`);
  const cargoPath = `/opt/homebrew/opt/rustup/bin:${process.env.PATH}`;
  run("cargo", ["build", "--release", "--target", TARGET[arch], "--manifest-path", "core-rs/Cargo.toml"], { env: { ...process.env, PATH: cargoPath } });
  const core = path.join(ROOT, "core-rs", "target", TARGET[arch], "release", "cvim-core");
  const [dir] = await packager({
    dir: ROOT, name: "Tamer", platform: "darwin", arch, out: OUT, overwrite: true,
    icon: path.join(ROOT, "build", "icon.icns"), appBundleId: "dev.tamer.desktop", appVersion: version,
    appCategoryType: "public.app-category.developer-tools",
    extendInfo: path.join(ROOT, "electron", "Info.extra.plist"),
    extraResource: [core, path.join(ROOT, "..", "claude"), path.join(ROOT, "..", "agents"),
      path.join(ROOT, "build", "THIRD_PARTY_NOTICES.txt"), path.join(ROOT, "node_modules", "electron", "dist", "LICENSES.chromium.html")],
    asar: { unpack: "**/node_modules/node-pty/**" },
    // the arm64 build/Release/pty.node would be tried first on Intel: x64 uses node-pty's prebuild
    ignore: [/^\/src-tauri/, /^\/src$/, /^\/out/, /^\/core-rs/, /^\/scripts/, /^\/test/, /^\/build/, ...(arch === "x64" ? [/^\/node_modules\/node-pty\/build/] : []),
      // other platforms' node-pty binaries
      new RegExp(`^/node_modules/node-pty/prebuilds/(?!darwin-${arch})`)],
  });
  const app = path.join(dir, "Tamer.app");
  await flipFuses(app, {
    version: FuseVersion.V1, resetAdHocDarwinSignature: !id,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
  });
  if (id) {
    const { signApp } = require("@electron/osx-sign");
    await signApp({ app, identity: id, optionsForFile: () => ({ hardenedRuntime: true, entitlements: path.join(ROOT, "build", "entitlements.plist") }) });
  } else run("node", ["scripts/sign.cjs", app]); // this Mac's own identity (folder permissions survive updates)
  const dmg = path.join(OUT, `Tamer-${version}-${arch}.dmg`);
  const stage = fs.mkdtempSync(path.join(OUT, "stage-"));
  run("ditto", [app, path.join(stage, "Tamer.app")]);
  fs.symlinkSync("/Applications", path.join(stage, "Applications"));
  fs.rmSync(dmg, { force: true });
  run("hdiutil", ["create", "-volname", `Tamer ${version}`, "-srcfolder", stage, "-ov", "-format", "UDZO", dmg]);
  fs.rmSync(stage, { recursive: true, force: true });
  if (id) {
    run("codesign", ["--sign", id, "--timestamp", dmg]);
    if (hasProfile()) {
      run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", PROFILE, "--wait"]);
      run("xcrun", ["stapler", "staple", dmg]);
    } else console.log(`notarytool profile "${PROFILE}" missing: signed, not notarized`);
  }
  return { arch, app, dmg };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  run("python3", ["build/make_icon.py"]);
  run("node", ["scripts/notices.cjs"]);
  run("node", ["scripts/stamp.cjs", "release"]);
  run("chmod", ["+x", ...fs.readdirSync(path.join(ROOT, "node_modules/node-pty/prebuilds")).map((d) => `node_modules/node-pty/prebuilds/${d}/spawn-helper`).filter((f) => fs.existsSync(path.join(ROOT, f)))]);
  run("npx", ["vite", "build"]);
  const id = identity();
  console.log(id ? `signing: ${id.replace(/\(.*\)/, "(…)")}` : "signing: ad hoc (no Developer ID Application identity)");
  const done = [];
  for (const arch of ARCHS) done.push(await build(arch, id));
  console.log("\n" + done.map((d) => `${d.arch}: ${path.relative(ROOT, d.dmg)}`).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
