// UI scenes, captured and compared (docs/UI_SYSTEM.md): builds a test copy of the app, seeds two
// data sets, lets the app put each registered screen in a known state (src/main.js uiScenes) and
// capture it, and reports how much each picture moved from the baseline.
//   npm run ui:shots                 compare with the baseline (exit 1 if a scene moved)
//   npm run ui:shots -- --baseline   save this run as the baseline (after an intended change)
//   npm run ui:shots -- --no-build   reuse the last test build
// Nothing of the user's data is used: the app runs on scratch folders; Pokémon pictures come from a
// dev cache (~/.cache/tamer-dev/ui-sprites, fetched once from PokéAPI) and stay on this Mac, like the
// baseline (~/.cache/tamer-dev/ui-baseline) — Pokémon assets are never put in the repository.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync, execFileSync, spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DEV = path.join(os.homedir(), ".cache/tamer-dev");
const BASE = path.join(DEV, "ui-baseline");
const SPRITES = path.join(DEV, "ui-sprites");
const WORK = path.join(os.tmpdir(), "tamer-ui");
const APP = path.join(WORK, "build/Tamer-darwin-arm64/Tamer.app");
const LIMIT = 0.003; // a scene "moved" when more than 0.3 % of its pixels changed
const args = process.argv.slice(2);
const saveBaseline = args.includes("--baseline");

// 1. a test build next to the user's app (never over desktop/out)
if (!args.includes("--no-build") || !fs.existsSync(APP)) {
  const pack = require(path.join(ROOT, "package.json")).scripts["electron:pack"]
    .replace("--out=out", `--out=${path.join(WORK, "build")}`)
    .replace("node scripts/fuses.cjs", `node scripts/fuses.cjs "${APP}"`)
    .replace(/node scripts\/sign\.cjs \S+/, `node scripts/sign.cjs "${APP}"`);
  console.log("building a test copy…");
  execSync(pack, { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, PATH: `${ROOT}/node_modules/.bin:${process.env.PATH}` } });
}

// 2. the Pokémon pictures the scenes use (dev cache; fetched once)
const IDS = [[1], [4], [7], [16], [25], [37], [134], [222], [418], [422, true]];
fs.mkdirSync(path.join(SPRITES, "pokemon"), { recursive: true });
const sp = (id, shiny) => path.join(SPRITES, "pokemon", `${id}${shiny ? "s" : ""}`);
for (const [id, shiny] of IDS) {
  if (fs.existsSync(sp(id, shiny) + ".gif")) continue;
  console.log(`fetching #${id}${shiny ? " ✨" : ""} (PokéAPI)…`);
  execFileSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(ROOT, "electron/core/pokeapi.cjs"))}).run(${JSON.stringify([String(id), ...(shiny ? ["shiny"] : [])])}).then(()=>process.exit(0))`],
    { env: { ...process.env, CVIM_CACHE_DIR: SPRITES, CVIM_STATE_DIR: SPRITES }, stdio: "inherit", timeout: 60000 });
}
const info = (id, shiny) => JSON.parse(fs.readFileSync(sp(id, shiny) + ".json", "utf8"));

// 3. the data sets
const now = Math.floor(Date.now() / 1000), h = 3600;
function seed(set, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of ["cache/pokemon", "state", "codex", "claudecfg", "proj", "other"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const f of fs.readdirSync(path.join(SPRITES, "pokemon"))) fs.copyFileSync(path.join(SPRITES, "pokemon", f), path.join(dir, "cache/pokemon", f));
  const C = path.join(dir, "cache"), put = (f, v) => fs.writeFileSync(path.join(C, f), JSON.stringify(v));
  const entry = (id, shiny, extra = {}) => { const i = info(id, shiny); return { name: i.name_ko || i.name_en, types: i.types || [], count: 1, first: now - 30 * 24 * h, ...(shiny ? { shiny: true } : {}), ...extra }; };
  if (set === "newuser") {
    put("box.json", { next: 1, mons: [] });
    put("starters.json", { set: [{ id: 1, shiny: false }, { id: 4, shiny: false }, { id: 7, shiny: false }] });
    put("pokedex.json", {});
    return;
  }
  const other = path.join(dir, "other");
  put("box.json", { next: 7, mons: [
    { uid: 1, id: 134, shiny: false, xp: 12, since_evo: 4, how: "starter", at: now - 5 * 24 * h, folder: null },
    { uid: 2, id: 37, shiny: false, xp: 0, since_evo: 0, how: "wild", at: now - 2 * h, folder: null, new: true },
    { uid: 3, id: 222, shiny: false, xp: 3, since_evo: 3, how: "wild", at: now - 30 * h, folder: other },
    { uid: 4, id: 418, shiny: false, xp: 0, since_evo: 0, how: "wild", at: now - 1 * h, folder: null },
    { uid: 5, id: 422, shiny: true, xp: 0, since_evo: 0, how: "wild", at: now - 3 * h, folder: null },
    { uid: 6, id: 25, shiny: false, xp: 7, since_evo: 7, how: "legacy", at: now - 10 * 24 * h, folder: null },
  ] });
  put("folders.json", { [other]: { id: 222, uid: 3, pinned: true } });
  put("pokedex.json", { 134: entry(134), 37: entry(37), 222: entry(222), 418: entry(418), 422: entry(422, true), 25: entry(25), 16: entry(16, false, { caught: false }) });
}

// 4. run each set; the app logs "ui-scenes shot <name> diff=<share>" and "ui-scenes done"
function run(set) {
  const dir = path.join(WORK, `run-${set}`), shots = path.join(WORK, "shots");
  seed(set, dir);
  fs.mkdirSync(shots, { recursive: true });
  const log = path.join(dir, "log.txt");
  const env = {
    ...process.env, CVIM_DESKTOP_TEST: "1", CVIM_DESKTOP_UI_SCENES: set, CVIM_WILD_CHANCE: "0",
    CVIM_DESKTOP_DIRS: path.join(dir, "proj"), CVIM_CACHE_DIR: path.join(dir, "cache"), CVIM_STATE_DIR: path.join(dir, "state"),
    CODEX_HOME: path.join(dir, "codex"), CLAUDE_CONFIG_DIR: path.join(dir, "claudecfg"), CVIM_DESKTOP_LOG: log,
    CVIM_DESKTOP_SHOTS: shots, CVIM_DESKTOP_QUIT_AFTER: "90000", ...(saveBaseline ? {} : { CVIM_UI_BASELINE: BASE }),
  };
  const child = spawn(path.join(APP, "Contents/MacOS/Tamer"), [], { env, stdio: "ignore" });
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
      if (text.includes("ui-scenes done") || Date.now() - t0 > 95000) {
        clearInterval(tick);
        child.kill("SIGTERM");
        const out = [...text.matchAll(/ui-scenes shot (\S+) diff=(\S+)(.*)/g)].map((m) => ({ scene: m[1], diff: m[2] === "-" ? null : Number(m[2]), note: m[3].trim() }));
        const err = text.match(/ui-scenes ERROR.*/)?.[0];
        resolve({ out, err, shots });
      }
    }, 500);
  });
}

(async () => {
  const all = [];
  for (const set of ["newuser", "owner"]) {
    const r = await run(set);
    if (r.err) console.error(r.err);
    all.push(...r.out);
  }
  const shots = path.join(WORK, "shots");
  if (saveBaseline) {
    fs.mkdirSync(BASE, { recursive: true });
    for (const s of all) fs.copyFileSync(path.join(shots, `${s.scene}.png`), path.join(BASE, `${s.scene}.png`));
    console.log(`baseline saved: ${all.length} scenes → ${BASE}`);
    for (const s of all) console.log(`  ${s.scene}`);
    return;
  }
  let moved = 0;
  for (const s of all) {
    const tag = s.diff == null ? "new (no baseline)" : s.diff > LIMIT ? `MOVED ${(s.diff * 100).toFixed(2)} %` : `same (${(s.diff * 100).toFixed(2)} %)`;
    if (s.diff == null || s.diff > LIMIT) moved++;
    console.log(`  ${s.scene.padEnd(16)} ${tag}${s.note ? ` — ${s.note}` : ""}`);
  }
  console.log(`pictures: ${shots}  ·  baseline: ${BASE}`);
  process.exit(moved ? 1 : 0);
})();
