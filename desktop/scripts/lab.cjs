// The test lab (docs/TESTING.md): runs the cases in test/lab-cases.cjs in sealed-off sandboxes and
// checks them, and makes sure the user's real data didn't move.
//   npm run lab                     every case
//   npm run lab -- --tag smoke      a tag (smoke = must pass before a release; release.cjs checks)
//   npm run lab -- --only late-drop one case (all its variants)
//   npm run lab -- --list           the cases
//   --no-build                      reuse the last test build
// Result: a table, each run's folder (log, pictures), and ~/.cache/tamer-dev/lab-last.json.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const T = require("./test-env.cjs");

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const CASES = require(path.join(T.ROOT, "test/lab-cases.cjs"));

// a case × its variants
const variants = (c) => {
  const [k, vals] = Object.entries(c.vary || {})[0] || [];
  return k ? vals.map((v) => ({ c, v: { [k]: v }, name: `${c.id}@${k}=${v}` })) : [{ c, v: {}, name: c.id }];
};
let picked = CASES;
if (opt("--tag")) picked = picked.filter((c) => c.tags.includes(opt("--tag")));
if (opt("--only")) picked = picked.filter((c) => c.id === opt("--only"));
if (args.includes("--list")) {
  for (const c of CASES) console.log(`${c.id.padEnd(24)} [${c.tags.join(",")}] ${c.what}${c.vary ? `  (× ${Object.values(c.vary)[0].length})` : ""}`);
  process.exit(0);
}
if (!picked.length) { console.error("no case matches"); process.exit(1); }

(async () => {
  if (!args.includes("--no-build") || !fs.existsSync(T.APP)) { console.log("building the test copy…"); T.buildTestApp(); }
  const userRunning = T.userTamerRunning();
  const before = T.realSnapshot();
  const results = [];
  for (const { c, v, name } of picked.flatMap(variants)) {
    const box = T.sandbox(name.replace(/[^\w@=.-]/g, "_"), { data: c.data, folders: c.folders?.length ? c.folders : ["proj"] });
    const env = { ...box.env, ...(c.env || {}), CVIM_LAB_STEPS: JSON.stringify(c.steps) };
    if (c.offline) env.CVIM_TEST_OFFLINE = "1";
    if (c.slowShell) env.SHELL = T.slowShell(box.dir, c.slowShell);
    const t0 = Date.now();
    const { log, timedOut } = await T.launch({ env, mode: c.mode, folders: (c.folders || []).map((f) => box.folder(f)), lateMs: v.lateMs ?? 300, timeoutMs: (c.timeoutMs || 60000) + (c.slowShell || 0) * 1000 });
    const probe = {};
    for (const m of log.matchAll(/^lab-probe (\S+) \+(\d+)ms (\{.*\})$/gm)) { try { probe[m[1]] = { ...JSON.parse(m[3]), _ms: Number(m[2]) }; } catch {} }
    let fails = [];
    try { fails = c.check({ probe, log, v }).filter((x) => typeof x === "string"); } // true = ok, a string = what went wrong
    catch (e) { fails = [`check threw: ${e.message}`]; }
    if (timedOut) fails.unshift("시간 초과(lab-done이 안 옴)");
    for (const m of log.matchAll(/^lab-(error|timeout|missing) (.*)$/gm)) fails.push(`${m[1]}: ${m[2].slice(0, 120)}`);
    results.push({ name, id: c.id, tags: c.tags, ok: !fails.length, fails, secs: ((Date.now() - t0) / 1000).toFixed(1), dir: box.dir });
    console.log(`${fails.length ? "✗" : "✓"} ${name.padEnd(30)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${c.what}`);
    for (const f of fails) console.log(`    - ${f}`);
  }
  // the user's real data: unchanged (unless their own Tamer was running and changed it itself)
  const moved = T.realChanged(before, T.realSnapshot());
  const guard = userRunning ? "skipped (your Tamer was running)" : moved.length ? `MOVED: ${moved.join(", ")}` : "unchanged";
  console.log(`\nreal data: ${guard}`);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: T.ROOT, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "."], { cwd: T.ROOT, encoding: "utf8" }).trim().length > 0;
  const passed = results.every((r) => r.ok) && !moved.length;
  const gate = results.filter((r) => r.tags.includes("explore"));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed${gate.length ? ` (explore cases record findings: ${gate.filter((r) => !r.ok).length} open)` : ""} · runs in ${path.join(T.WORK, "runs")}`);
  fs.mkdirSync(T.DEV, { recursive: true });
  // the release gate (scripts/release.cjs): every smoke case ran here and passed, real data unchanged
  const smokeIds = CASES.filter((c) => c.tags.includes("smoke")).map((c) => c.id);
  const smoke = !moved.length && smokeIds.every((id) => results.some((r) => r.id === id)) && results.filter((r) => r.tags.includes("smoke")).every((r) => r.ok);
  console.log(`release gate (smoke): ${smoke ? "pass" : "not met"}${dirty ? " — but there are uncommitted changes: commit, then run the lab again" : ""}`);
  fs.writeFileSync(path.join(T.DEV, "lab-last.json"), JSON.stringify({ at: new Date().toISOString(), head, dirty, args, guard, passed, smoke,
    results: results.map(({ dir, ...r }) => r) }, null, 2));
  const gateFails = results.filter((r) => !r.ok && !r.tags.includes("explore"));
  process.exit(gateFails.length || moved.length ? 1 : 0);
})();
