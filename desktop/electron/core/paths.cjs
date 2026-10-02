// Where Tamer keeps its data: ~/.cache/tamer (2026-10-02 — its own, not the Neovim CVIM's
// ~/.cache/cvim). On the first run the CVIM data (partners, Pokédex, folders, agent choice,
// settings) is copied over once, so nothing is lost; the CVIM folder stays for the Neovim app.
// Agents started by Tamer get CVIM_STATE_DIR, so their hooks write here too.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = os.homedir();
const DATA = path.join(HOME, ".cache/tamer");
const LEGACY = path.join(HOME, ".cache/cvim");
// not copied: hook logs (tabs/), the Neovim app's own state (overlay/, backup/), old agent files
const LEGACY_SKIP = new Set(["tabs", "overlay", "backup", "agents"]);
function adoptLegacy() {
  if (process.env.CVIM_CACHE_DIR || process.env.CVIM_STATE_DIR) return; // tests, custom places
  if (fs.existsSync(DATA) || !fs.existsSync(LEGACY)) return;
  try {
    fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
    const copied = [];
    for (const name of fs.readdirSync(LEGACY)) {
      if (LEGACY_SKIP.has(name) || name.startsWith(".")) continue;
      fs.cpSync(path.join(LEGACY, name), path.join(DATA, name), { recursive: true, errorOnExist: false, force: false });
      copied.push(name);
    }
    fs.writeFileSync(path.join(DATA, ".from-cvim.json"), JSON.stringify({ from: LEGACY, at: new Date().toISOString(), copied }), { mode: 0o600 });
  } catch {}
}
adoptLegacy();
const CACHE = process.env.CVIM_CACHE_DIR || DATA;
// Claude hooks write here (claude/hooks/event.sh gets CVIM_STATE_DIR from Tamer)
const STATE = process.env.CVIM_STATE_DIR || DATA;
const TABS = path.join(STATE, "tabs");

// CVIM's agent files (claude/settings.json + hooks + statusline, agents/ — Gemini extension,
// OpenCode plugin): $CVIM_ROOT, else the nearest parent of this app that has them (a build inside
// the repo; a packaged app carries them in Contents/Resources — the beta build)
function findRoot() {
  if (process.env.CVIM_ROOT && fs.existsSync(path.join(process.env.CVIM_ROOT, "claude/settings.json"))) {
    return process.env.CVIM_ROOT;
  }
  let dir = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, "claude/settings.json")) ? process.resourcesPath : __dirname;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, "claude/settings.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
const ROOT = findRoot();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

// CVIM's data is the user's alone (POLICY 11.3, S1): folders 700, files 600
const DIR_MODE = 0o700, FILE_MODE = 0o600;
function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

// atomic write (other CVIM processes read the same files), owner-only
function writeFile(file, text) {
  mkdirPrivate(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: FILE_MODE });
  fs.renameSync(tmp, file);
}
const writeJson = (file, data) => writeFile(file, JSON.stringify(data));

// existing files from before (or written by other tools with the default umask): owner-only.
// Only under the data folder, never following symlinks out of it.
function tighten(dir) {
  let n = 0;
  const walk = (d) => {
    let st;
    try { st = fs.lstatSync(d); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      if ((st.mode & 0o777) !== DIR_MODE) { fs.chmodSync(d, DIR_MODE); n++; }
      for (const e of fs.readdirSync(d)) walk(path.join(d, e));
    } else if (st.isFile() && (st.mode & 0o777) !== FILE_MODE) { fs.chmodSync(d, FILE_MODE); n++; }
  };
  walk(dir);
  return n;
}

// hook logs / status files left behind (app crashes, old runs): removed after `days` without changes
function pruneTabs(dir, days, keep = new Set()) {
  let n = 0;
  const cutoff = Date.now() - days * 86400 * 1000;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!/\.(log|status\.json)$/.test(name) || keep.has(name.split(".")[0])) continue;
    const f = path.join(dir, name);
    try { if (fs.statSync(f).mtimeMs < cutoff) { fs.unlinkSync(f); n++; } } catch {}
  }
  return n;
}

// read-modify-write in one step: several apps/tabs update folders.json and pokedex.json
function updateJson(file, fn) {
  const data = readJson(file, {});
  const out = fn(data) || data;
  writeJson(file, out);
  return out;
}

module.exports = { HOME, CACHE, STATE, TABS, ROOT, readJson, writeJson, writeFile, updateJson, mkdirPrivate, tighten, pruneTabs };
