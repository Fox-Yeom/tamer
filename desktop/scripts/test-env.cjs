// The test environment, in one place (docs/TESTING.md) — npm run lab and npm run ui:shots use it.
// Every run is sealed off from the user's Tamer: its own build (never desktop/out), its own data
// folders, its own browser profile, and a check that the user's real data didn't move.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync, execFileSync, spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const HOME = os.homedir();
const DEV = path.join(HOME, ".cache/tamer-dev"); // baselines, sprites for tests, last lab result
const WORK = process.env.TAMER_LAB_WORK || path.join(os.tmpdir(), "tamer-test"); // another place: the usual test build is open (you trying it)
const APP = path.join(WORK, "build/Tamer-darwin-arm64/Tamer.app");
const BIN = path.join(APP, "Contents/MacOS/Tamer");
const SPRITES = path.join(DEV, "ui-sprites");

// ── the test build ───────────────────────────────────────────────────────────
// what desktop/ holds right now as a git tree id (committed or not, ignored files left out) — the
// same id `git rev-parse HEAD:desktop` gives once it's committed as is. Written next to the test
// build, so a lab run says which content it tested (the release gate accepts a run made before
// the commit when the commit holds exactly that content)
function contentTree() {
  const repo = path.resolve(ROOT, ".."), idx = path.join(os.tmpdir(), `tamer-lab-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    execFileSync("git", ["read-tree", "HEAD"], { cwd: repo, env });
    execFileSync("git", ["add", "-A", "--", "desktop"], { cwd: repo, env });
    return execFileSync("git", ["write-tree", "--prefix=desktop/"], { cwd: repo, env, encoding: "utf8" }).trim();
  } catch { return null; } finally { fs.rmSync(idx, { force: true }); }
}
const BUILT_TREE = () => { try { return fs.readFileSync(path.join(WORK, "build-tree.txt"), "utf8").trim() || null; } catch { return null; } };

// npm run electron:pack into another folder (out → `out`): the app at <out>/Tamer-darwin-arm64/Tamer.app
function packTo(out) {
  const app = path.join(out, "Tamer-darwin-arm64/Tamer.app");
  const pack = require(path.join(ROOT, "package.json")).scripts["electron:pack"]
    .replace("--out=out", `--out=${out}`)
    .replace("node scripts/prune-locales.cjs out/Tamer-darwin-arm64/Tamer.app", `node scripts/prune-locales.cjs "${app}"`)
    .replace("node scripts/fuses.cjs", `node scripts/fuses.cjs "${app}"`)
    .replace(/node scripts\/sign\.cjs \S+/, `node scripts/sign.cjs "${app}"`);
  execSync(pack, { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, PATH: `${ROOT}/node_modules/.bin:${process.env.PATH}` } });
  return app;
}

function buildTestApp() {
  const tree = contentTree(); // before the build: an edit made while it builds isn't in it
  fs.rmSync(path.join(WORK, "build-tree.txt"), { force: true });
  packTo(path.join(WORK, "build"));
  if (tree) fs.writeFileSync(path.join(WORK, "build-tree.txt"), tree + "\n");
  return APP;
}

// ── Pokémon pictures for seeded data (fetched once into the dev cache, never into the repo) ──
const sprite = (id, shiny) => path.join(SPRITES, "pokemon", `${id}${shiny ? "s" : ""}`);
function ensureSprites(ids) {
  fs.mkdirSync(path.join(SPRITES, "pokemon"), { recursive: true });
  const fetch = (args) => execFileSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(ROOT, "electron/core/pokeapi.cjs"))}).run(${JSON.stringify(args)}).then(()=>process.exit(0))`],
    { env: { ...process.env, CVIM_CACHE_DIR: SPRITES, CVIM_STATE_DIR: SPRITES }, stdio: "inherit", timeout: 60000 });
  for (const [id, shiny] of ids) {
    if (!fs.existsSync(sprite(id, shiny) + ".gif")) fetch([String(id), ...(shiny ? ["shiny"] : [])]);
    // how it evolves (levels, #74): the scenes and cases know it without the network
    if (!fs.existsSync(path.join(SPRITES, "pokemon", `${id}.evo.json`))) fetch(["evo", String(id)]);
  }
}
const SEED_IDS = [[1], [4], [7], [16], [25], [37], [134], [222], [418], [422, true]];

// ── a sandbox: its folders and the env that points the app at them ──────────
// data: "empty" (nothing, like a brand-new Mac) · "newuser" (empty box, three starters ready) ·
//       "owner" (six Pokémon, one new, the party of one — Jolteon the 메인 파트너, #122) ·
//       "legacy" (only the Neovim CVIM's ~/.cache/cvim: a partner for the first folder, a Pokédex —
//       the app copies it into its own folder on the first launch) · "corrupt" (newuser whose
//       box.json, pokedex.json and folders.json are cut off mid-write)
// session: last time's tabs ({ tabs: [folder names], active, shell, quit }) in ui/desktop_session.json
// today: a fixed date (YYYY-MM-DD) for data seeded relative to "today" — UI scenes, whose 7-day row
// shows weekdays (the app reads the same date from CVIM_TEST_TODAY)
function sandbox(name, { data = "empty", folders = ["proj"], session = null, today = null } = {}) {
  const dir = path.join(WORK, "runs", name);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of ["cache", "state", "codex", "claudecfg", "profile", "shots", "other", ...folders]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const folder = (f = folders[0]) => path.join(dir, f);
  const legacy = data === "legacy";
  const C = legacy ? path.join(dir, "home", "tamer") : path.join(dir, "cache"); // where the app keeps its data
  seed(data, dir, folder, today);
  if (session) {
    fs.mkdirSync(path.join(C, "ui"), { recursive: true });
    const abs = (l) => (l || []).map(folder);
    fs.writeFileSync(path.join(C, "ui", "desktop_session.json"), JSON.stringify({ tabs: abs(session.tabs), active: session.active ? folder(session.active) : null,
      sessions: {}, shell: abs(session.shell ?? session.tabs), ...(session.quit ? { quit: true } : {}) }));
  }
  const env = {
    CVIM_DESKTOP_TEST: "1", CVIM_WILD_CHANCE: "0",
    // "legacy": the real-path layout (data under a fake home), so the first-run copy runs
    ...(legacy ? { CVIM_TEST_DATA_ROOT: path.join(dir, "home") } : { CVIM_CACHE_DIR: path.join(dir, "cache"), CVIM_STATE_DIR: path.join(dir, "state") }),
    CODEX_HOME: path.join(dir, "codex"), SHELL: testShell(dir),
    CVIM_AGENTS_JSON: path.join(dir, "agents-user.json"), // the user's own registered agents (~/.cvim/agents.json): not read in tests
    CLAUDE_CONFIG_DIR: path.join(dir, "claudecfg"), CVIM_DESKTOP_USERDATA: path.join(dir, "profile"),
    CVIM_DESKTOP_SHOTS: path.join(dir, "shots"), CVIM_DESKTOP_LOG: path.join(dir, "log.txt"), CVIM_DESKTOP_QUIT_AFTER: "120000",
  };
  return { dir, env, folder, data: C };
}
function seed(data, dir, folder, today = null) {
  if (data === "empty") return;
  const C = data === "legacy" ? path.join(dir, "home", "cvim") : path.join(dir, "cache");
  fs.mkdirSync(C, { recursive: true });
  const put = (f, v) => fs.writeFileSync(path.join(C, f), typeof v === "string" ? v : JSON.stringify(v));
  ensureSprites(SEED_IDS);
  fs.mkdirSync(path.join(C, "pokemon"), { recursive: true });
  for (const f of fs.readdirSync(path.join(SPRITES, "pokemon"))) fs.copyFileSync(path.join(SPRITES, "pokemon", f), path.join(C, "pokemon", f));
  const now = Math.floor(Date.now() / 1000), h = 3600;
  const info = (id, shiny) => JSON.parse(fs.readFileSync(sprite(id, shiny) + ".json", "utf8"));
  const entry = (id, shiny, extra = {}) => { const i = info(id, shiny); return { name: i.name_ko || i.name_en, types: i.types || [], count: 1, first: now - 30 * 24 * h, ...(shiny ? { shiny: true } : {}), ...extra }; };
  const starters = { set: [{ id: 1, shiny: false }, { id: 4, shiny: false }, { id: 7, shiny: false }] };
  if (data === "newuser") {
    put("box.json", { next: 1, mons: [] });
    put("starters.json", starters);
    put("pokedex.json", {});
    return;
  }
  if (data === "corrupt") { // a file cut off mid-write (by another tool, a full disk …)
    put("box.json", '{"next":3,"mons":[{"uid":1,"id":25,"shiny":false,"xp":40,"since_evo":4,"how":"starter","at":1,"folder":null},{"uid":2,"id":13');
    put("pokedex.json", '{"25":{"name":"피카츄","count":3');
    put("folders.json", "{");
    put("starters.json", starters);
    return;
  }
  if (data === "legacy") { // the Neovim CVIM before boxes: a partner per folder, a Pokédex
    put("folders.json", { [folder()]: { id: 25, xp: 30, since_evo: 3, name: info(25).name_ko } });
    put("pokedex.json", { 25: entry(25), 16: entry(16), 7: entry(7, false, { caught: false }) });
    put("recent_dirs", folder() + "\n");
    return;
  }
  if (data !== "owner") throw new Error(`unknown data set ${data}`);
  // the party model (#122): no folder partners — the party of one, Jolteon the 메인 파트너 (already moved: partyV 2)
  put("box.json", { next: 7, partyV: 2, party: [1], mons: [
    { uid: 1, id: 134, shiny: false, xp: 12, since_evo: 4, how: "starter", at: now - 5 * 24 * h, folder: null, evo: [{ from: 133, to: 134, at: now - 2 * 24 * h }] },
    { uid: 2, id: 37, shiny: false, xp: 0, since_evo: 0, how: "wild", at: now - 2 * h, folder: null, new: true },
    { uid: 3, id: 222, shiny: false, xp: 3, since_evo: 3, how: "wild", at: now - 30 * h, folder: null },
    { uid: 4, id: 418, shiny: false, xp: 0, since_evo: 0, how: "wild", at: now - 1 * h, folder: null, caught_in: path.join(dir, "proj"), caught_by: "codex" },
    { uid: 5, id: 422, shiny: true, xp: 0, since_evo: 0, how: "wild", at: now - 3 * h, folder: null },
    { uid: 6, id: 25, shiny: false, xp: 7, since_evo: 7, how: "legacy", at: now - 10 * 24 * h, folder: null },
  ] });
  // 🏠 홈 (#44): tasks finished in the last 7 days (today last)
  const day = (n) => { const t = today ? new Date(`${today}T12:00`) : new Date(); t.setDate(t.getDate() - n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
  put("stats.json", { days: Object.fromEntries([3, 0, 5, 2, 7, 4, 6].map((n, i) => [day(6 - i), n]).filter(([, n]) => n)) });
  put("pokedex.json", { 134: entry(134), 37: entry(37), 222: entry(222), 418: entry(418), 422: entry(422, true), 25: entry(25), 16: entry(16, false, { caught: false }) });
}

// The shell the test app runs: zsh with its own small rc (ZDOTDIR), never the user's ~/.zshrc —
// a test instance killed while that rc was starting left pyenv's rehash lock behind, and every
// new zsh of the user's waited 60 s (2026-10-05). Also makes the prompt the same on every Mac.
function testShell(dir) {
  // named zsh (in its own folder): Tamer treats it as zsh — the #45 shell line lands in this ZDOTDIR's .zshrc
  const z = path.join(dir, "zdot"), p = path.join(dir, "shellbin", "zsh");
  fs.mkdirSync(z, { recursive: true });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(path.join(z, ".zshrc"), "PS1='lab$ '\n");
  fs.writeFileSync(p, `#!/bin/sh\nexport ZDOTDIR=${JSON.stringify(z)}\nexec /bin/zsh "$@"\n`, { mode: 0o755 });
  return p;
}
// a shell that takes `seconds` to start (a heavy ~/.zshrc): Tamer reads the login environment through it
function slowShell(dir, seconds) {
  const p = path.join(dir, "slow-shell");
  fs.writeFileSync(p, `#!/bin/sh\nsleep ${Number(seconds)}\nexec ${JSON.stringify(testShell(dir))} "$@"\n`, { mode: 0o755 });
  return p;
}

// ── the user's real data must not move during a run ─────────────────────────
const REAL = [
  path.join(HOME, ".cache/tamer"), path.join(HOME, ".cache/tamer/box.json"), path.join(HOME, ".cache/tamer/folders.json"),
  path.join(HOME, ".cache/tamer/pokedex.json"), path.join(HOME, ".cache/tamer/recent_dirs"), path.join(HOME, ".cache/tamer/ui"),
  path.join(HOME, "Library/Application Support/Tamer"), path.join(HOME, "Library/Application Support/Tamer/Local Storage/leveldb"),
  path.join(HOME, ".cache/cvim"), path.join(HOME, ".claude/settings.json"),
  // the shell startup files the #45 opt-in line goes into
  path.join(HOME, ".zshrc"), path.join(HOME, ".bash_profile"), path.join(HOME, ".profile"), path.join(HOME, ".config/fish/config.fish"),
];
function realSnapshot() {
  return Object.fromEntries(REAL.map((p) => { try { const s = fs.statSync(p); return [p, `${s.mtimeMs}:${s.size}`]; } catch { return [p, "-"]; } }));
}
function realChanged(before, after) { return REAL.filter((p) => before[p] !== after[p]); }
// the user's own Tamer (anything but our test build): while it runs, it may change its data itself
function userTamerRunning() {
  try { return execFileSync("pgrep", ["-fl", "Tamer.app/Contents/MacOS/Tamer$"], { encoding: "utf8" }).split("\n").filter((l) => l && !l.includes(WORK)).length > 0; } catch { return false; }
}

// ── launching ────────────────────────────────────────────────────────────────
// mode "direct": the binary (folders via CVIM_DESKTOP_DIRS) · "open": like dropping the folders on
// the app to launch it (LaunchServices, in the background) · "late": launched empty, the folders
// handed in `lateMs` after the app logged its first line (a drop on the Dock icon while it starts)
function launch({ env, mode = "direct", folders = [], lateMs = 300, until = "lab-done", timeoutMs = 60000, args = [] }) {
  const log = env.CVIM_DESKTOP_LOG;
  const kill = () => { try { execFileSync("pkill", ["-f", `${BIN}$`]); } catch {} };
  kill(); // a leftover test instance (ours only: matched by the test build's path)
  if (mode === "direct") {
    spawn(BIN, args, { env: { ...process.env, ...env, ...(folders.length ? { CVIM_DESKTOP_DIRS: folders.join(":") } : {}) }, stdio: "ignore", detached: true }).unref();
  } else {
    const args = ["-g", "-n", "-a", APP, ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`])];
    execFileSync("open", mode === "open" ? [...args, ...folders] : args);
  }
  const t0 = Date.now();
  const read = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
  return new Promise((resolve) => {
    let handed = mode !== "late";
    const tick = setInterval(() => {
      const text = read();
      if (!handed && text.includes("privacy:")) { handed = true; setTimeout(() => execFileSync("open", ["-g", "-a", APP, ...folders]), lateMs); }
      if (text.includes(until) || Date.now() - t0 > timeoutMs) { clearInterval(tick); setTimeout(() => { kill(); resolve({ log: read(), timedOut: !text.includes(until) }); }, 300); }
    }, 100);
  });
}

module.exports = { ROOT, DEV, WORK, APP, BIN, buildTestApp, packTo, contentTree, BUILT_TREE, ensureSprites, sandbox, seed, slowShell, realSnapshot, realChanged, userTamerRunning, launch, SEED_IDS };
