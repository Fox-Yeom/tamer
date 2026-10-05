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
const path = require("node:path");
const T = require("./test-env.cjs"); // the one test environment (docs/TESTING.md): build, data, sandbox, launch

const BASE = path.join(T.DEV, "ui-baseline");
const LIMIT = 0.003; // a scene "moved" when more than 0.3 % of its pixels changed
const args = process.argv.slice(2);
const saveBaseline = args.includes("--baseline");
const SHOTS = path.join(T.WORK, "shots");

if (!args.includes("--no-build") || !fs.existsSync(T.APP)) { console.log("building a test copy…"); T.buildTestApp(); }

// each data set: the app puts every scene of it on screen (src/main.js uiScenes) and captures it
async function run(set) {
  const box = T.sandbox(`ui-${set}`, { data: set });
  fs.mkdirSync(SHOTS, { recursive: true });
  const env = { ...box.env, CVIM_DESKTOP_UI_SCENES: set, CVIM_DESKTOP_SHOTS: SHOTS, ...(saveBaseline ? {} : { CVIM_UI_BASELINE: BASE }) };
  const { log } = await T.launch({ env, mode: "direct", folders: [box.folder()], until: "ui-scenes done", timeoutMs: 95000 });
  const out = [...log.matchAll(/ui-scenes shot (\S+) diff=(\S+)(.*)/g)].map((m) => ({ scene: m[1], diff: m[2] === "-" ? null : Number(m[2]), note: m[3].trim() }));
  return { out, err: log.match(/ui-scenes ERROR.*/)?.[0], shots: SHOTS };
}

(async () => {
  const all = [];
  for (const set of ["newuser", "owner"]) {
    const r = await run(set);
    if (r.err) console.error(r.err);
    all.push(...r.out);
  }
  const shots = SHOTS;
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
