// Open-source notices for the app (build/THIRD_PARTY_NOTICES.txt): the npm packages bundled into
// the app (runtime dependencies), Electron, and the Rust crates compiled into cvim-core — each with
// its license text. Chromium's own list ships next to it (LICENSES.chromium.html).
//   node scripts/notices.cjs        (run by npm run beta / electron:pack)
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "build", "THIRD_PARTY_NOTICES.txt");
const LICENSE_FILES = /^(LICEN[CS]E|COPYING)(-MIT|\.md|\.txt|-APACHE)?$/i;
const RUST = `/opt/homebrew/opt/rustup/bin:${process.env.PATH}`;

function licenseText(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => LICENSE_FILES.test(f)); } catch {}
  // dual MIT / Apache crates: the MIT text carries the copyright line
  const pick = files.find((f) => /MIT/i.test(f)) || files.find((f) => /^LICEN[CS]E(\.md|\.txt)?$/i.test(f)) || files[0];
  return pick ? fs.readFileSync(path.join(dir, pick), "utf8").trim() : "(license text not shipped with the package)";
}

const parts = [];
// npm: runtime dependencies and theirs (what ends up in the app)
const seen = new Set();
function npm(name) {
  if (seen.has(name)) return;
  const dir = path.join(ROOT, "node_modules", name);
  const pkgFile = path.join(dir, "package.json");
  if (!fs.existsSync(pkgFile)) return;
  seen.add(name);
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  parts.push({ name: `${pkg.name}@${pkg.version}`, license: pkg.license || "", text: licenseText(dir) });
  for (const dep of Object.keys(pkg.dependencies || {})) npm(dep);
}
const app = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
for (const dep of Object.keys(app.dependencies || {}).filter((d) => !d.startsWith("@tauri-apps/"))) npm(dep); // tauri: not in the Electron app
const electron = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules/electron/package.json"), "utf8"));
parts.push({ name: `electron@${electron.version}`, license: "MIT", text: fs.readFileSync(path.join(ROOT, "node_modules/electron/dist/LICENSE"), "utf8").trim() + "\n\n(Chromium and its components: see LICENSES.chromium.html next to this file)" });

// Rust crates compiled into cvim-core (normal dependencies, both macOS targets)
const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--manifest-path", path.join(ROOT, "core-rs/Cargo.toml")], { encoding: "utf8", env: { ...process.env, PATH: RUST } }));
const crates = new Set();
for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
  const out = execFileSync("cargo", ["tree", "-e", "normal", "--prefix", "none", "--format", "{p}", "--target", target, "--manifest-path", path.join(ROOT, "core-rs/Cargo.toml")], { encoding: "utf8", env: { ...process.env, PATH: RUST } });
  for (const line of out.split("\n")) {
    const m = line.match(/^(\S+) v(\S+)/);
    if (m && m[1] !== "cvim-core") crates.add(`${m[1]}@${m[2]}`);
  }
}
for (const id of [...crates].sort()) {
  const [name, version] = id.split("@");
  const p = meta.packages.find((x) => x.name === name && x.version === version);
  if (!p) continue;
  parts.push({ name: `${name}@${version} (Rust)`, license: p.license || "", text: licenseText(path.dirname(p.manifest_path)) });
}

const head = `Tamer — open-source notices\n\nTamer includes the following open-source software. Their licenses follow.\n\nPokémon names and images are fetched at runtime from PokéAPI and are not included in Tamer; all rights belong to Nintendo / Creatures / GAME FREAK / The Pokémon Company (unofficial fan feature).\n`;
const body = parts.map((p) => `\n${"=".repeat(78)}\n${p.name}${p.license ? ` — ${p.license}` : ""}\n${"=".repeat(78)}\n\n${p.text}\n`).join("");
fs.writeFileSync(OUT, head + body);
console.log(`notices: ${parts.length} packages → ${path.relative(ROOT, OUT)}`);
