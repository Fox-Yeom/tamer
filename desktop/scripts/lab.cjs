// The test lab (docs/TESTING.md): runs the cases in test/lab-cases.cjs in sealed-off sandboxes and
// checks them, and makes sure the user's real data didn't move.
//   npm run lab                     every case
//   npm run lab -- --tag smoke      a tag (smoke = must pass before a release; release.cjs checks)
//   npm run lab -- --only late-drop one case (all its variants)
//   npm run lab -- --list           the cases
//   --no-build                      reuse the last test build
//   npm run lab -- --rerun-failed   only the cases that failed last time, on the same test build; the
//                                   record is the last one with those replaced (a flaky case doesn't
//                                   cost a whole smoke run again)
//   --anyway                        run smoke even though your own Tamer is open (the result can't
//                                   count for a release: the real-data check needs it closed)
// Result: a table, each run's folder (log, pictures), and ~/.cache/tamer-dev/lab-last.json.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const T = require("./test-env.cjs");

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const CASES = require(path.join(T.ROOT, "test/lab-cases.cjs"));
const LAST = path.join(T.DEV, "lab-last.json");
const readLast = () => { try { return JSON.parse(fs.readFileSync(LAST, "utf8")); } catch { return null; } };

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
// --rerun-failed: the last run's failures only (each variant by name), on the build it tested
const rerun = args.includes("--rerun-failed");
const last = rerun ? readLast() : null;
let only = null;
if (rerun) {
  if (!last?.tree || !fs.existsSync(T.APP)) { console.error("--rerun-failed: no last run (or test build) to go on — run the cases first"); process.exit(1); }
  if (T.BUILT_TREE() !== last.tree) { console.error(`--rerun-failed: the test build (${String(T.BUILT_TREE()).slice(0, 10)}) isn't the one the last run tested (${last.tree.slice(0, 10)}) — run the cases again`); process.exit(1); }
  if (!String(last.guard || "").startsWith("unchanged")) { console.error(`--rerun-failed: the last run's real data check wasn't clean (${last.guard}) — that needs a whole run again (close your Tamer first)`); process.exit(1); }
  only = new Set(last.results.filter((r) => !r.ok).map((r) => r.name));
  if (!only.size) { console.log("--rerun-failed: nothing failed last time"); process.exit(0); }
  picked = CASES.filter((c) => variants(c).some((x) => only.has(x.name)));
}
if (!picked.length) { console.error("no case matches"); process.exit(1); }
// a smoke run while your own Tamer is open can't count for a release (its data may move by itself,
// so the real-data check can't tell): stop before the 5 minutes, not after
const smokeRun = picked.some((c) => c.tags.includes("smoke")) && !opt("--only") && !rerun;
if (smokeRun && T.userTamerRunning() && !args.includes("--anyway")) {
  console.error("your own Tamer is open: this smoke run couldn't count for a release (the real-data check needs it closed).\nQuit Tamer and run again — or add --anyway to run it just to see.");
  process.exit(2);
}

(async () => {
  if (!rerun && (!args.includes("--no-build") || !fs.existsSync(T.APP))) { console.log("building the test copy…"); T.buildTestApp(); }
  const userRunning = T.userTamerRunning();
  const before = T.realSnapshot();
  const results = [];
  for (const { c, v, name } of picked.flatMap(variants).filter((x) => !only || only.has(x.name))) {
    const made = [...(c.folders || []), ...(c.make || [])];
    const box = T.sandbox(name.replace(/[^\w@=.-]/g, "_"), { data: c.data, folders: made.length ? made : ["proj"], session: c.session });
    const caseEnv = Object.fromEntries(Object.entries(c.env || {}).map(([k, v]) => [k, typeof v === "function" ? v(box) : v])); // a value may be a function of the sandbox
    const env = { ...box.env, ...caseEnv, CVIM_LAB_STEPS: JSON.stringify(typeof c.steps === "function" ? c.steps(box) : c.steps) }; // steps may need the sandbox's paths
    if (c.offline) env.CVIM_TEST_OFFLINE = "1";
    if (c.slowShell) env.SHELL = T.slowShell(box.dir, c.slowShell);
    // files the case puts in its sandbox ({ "fakebin/codex": "#!/bin/sh …" }, made executable) and
    // folders put first on PATH (a fake program shadowing the real one)
    // a file's text may be a function of the sandbox (paths of its folders): (box) => text
    for (const [f, text] of Object.entries(c.files || {})) { const p = path.join(box.dir, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof text === "function" ? text(box) : text, { mode: 0o755 }); }
    if (c.setup) c.setup(box); // anything else the case needs in its sandbox before launch (old files, dates …)
    if (c.pathFirst) env.PATH = [...c.pathFirst.map((d) => path.join(box.dir, d)), process.env.PATH].join(":");
    const t0 = Date.now();
    const { log, timedOut } = await T.launch({ env, mode: c.mode, ...(c.until ? { until: c.until } : {}), folders: (c.folders || []).map((f) => box.folder(f)), lateMs: v.lateMs ?? 300, args: c.args || [], timeoutMs: (c.timeoutMs || 60000) + (c.slowShell || 0) * 1000 });
    const probe = {};
    for (const m of log.matchAll(/^lab-probe (\S+) \+(\d+)ms (\{.*\})$/gm)) { try { probe[m[1]] = { ...JSON.parse(m[3]), _ms: Number(m[2]) }; } catch {} }
    let fails = [];
    try { fails = c.check({ probe, log, v, box }).filter((x) => typeof x === "string"); } // true = ok, a string = what went wrong
    catch (e) { fails = [`check threw: ${e.message}`]; }
    if (timedOut) fails.unshift("시간 초과(lab-done이 안 옴)");
    for (const m of log.matchAll(/^lab-(error|timeout|missing) (.*)$/gm)) fails.push(`${m[1]}: ${m[2].slice(0, 120)}`);
    results.push({ name, id: c.id, tags: c.tags, ok: !fails.length, fails, secs: ((Date.now() - t0) / 1000).toFixed(1), dir: box.dir });
    console.log(`${fails.length ? "✗" : "✓"} ${name.padEnd(30)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${c.what}`);
    for (const f of fails) console.log(`    - ${f}`);
  }
  // the user's real data: unchanged (unless their own Tamer was running and changed it itself)
  const moved = T.realChanged(before, T.realSnapshot());
  const guard = moved.length ? `${userRunning ? "changed while your Tamer was running" : "MOVED"}: ${moved.join(", ")}` : userRunning ? "unchanged (your Tamer was running)" : "unchanged";
  console.log(`\nreal data: ${guard}`);
  // --rerun-failed: the last record with these cases replaced
  if (rerun) {
    const now = new Map(results.map((r) => [r.name, r]));
    const kept = last.results.filter((r) => !now.has(r.name));
    console.log(`(rerun of ${results.length} failed — merged with the last run's ${kept.length})`);
    results.splice(0, results.length, ...last.results.map((r) => now.get(r.name) || r));
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: T.ROOT, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "."], { cwd: T.ROOT, encoding: "utf8" }).trim().length > 0;
  const passed = results.every((r) => r.ok) && !moved.length;
  const gate = results.filter((r) => r.tags.includes("explore"));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed${gate.length ? ` (explore cases record findings: ${gate.filter((r) => !r.ok).length} open)` : ""} · runs in ${path.join(T.WORK, "runs")}`);
  fs.mkdirSync(T.DEV, { recursive: true });
  // the release gate (scripts/release.cjs): every smoke case ran here and passed, real data unchanged
  const smokeIds = CASES.filter((c) => c.tags.includes("smoke")).map((c) => c.id);
  const smoke = !moved.length && smokeIds.every((id) => results.some((r) => r.id === id)) && results.filter((r) => r.tags.includes("smoke")).every((r) => r.ok);
  // which content was tested: the test build's (made from desktop/ as it was then); the release gate
  // takes this run if the commit holds exactly that — no second run after committing
  const tree = T.BUILT_TREE(), now = T.contentTree();
  const moving = tree && now && tree !== now; // desktop/ changed since the build: the run is about older content
  // why it isn't met, in words (a failed case / real data / smoke cases not run) — not just "not met"
  const why = [
    ...results.filter((r) => r.tags.includes("smoke") && !r.ok).map((r) => `failed ${r.name}${rerun ? "" : " (only this? npm run lab -- --rerun-failed)"}`),
    ...(moved.length ? [`real data changed: ${moved.join(", ")}${userRunning ? " — your Tamer was running: close it and run again" : ""}`] : []),
    ...(smokeIds.every((id) => results.some((r) => r.id === id)) ? [] : ["not every smoke case ran (npm run lab -- --tag smoke)"]),
  ];
  console.log(`release gate (smoke): ${smoke ? "pass" : `not met — ${why.join(" · ")}`} · tested content ${tree ? tree.slice(0, 10) : "unknown (build again)"}${moving ? " — desktop/ has changed since the test build: build again (no --no-build) before relying on it" : dirty ? " — not committed yet: committing exactly this (a later npm run bump is fine) is enough for the release" : ""}`);
  const at = new Date().toISOString();
  fs.writeFileSync(LAST, JSON.stringify({ at, head, dirty, tree: rerun ? last.tree : tree, args: rerun ? [...last.args, "--rerun-failed"] : args,
    guard: rerun && last.guard !== "unchanged" && guard === "unchanged" ? last.guard : guard, passed, smoke,
    results: results.map(({ dir, ...r }) => r) }, null, 2));
  const gateFails = results.filter((r) => !r.ok && !r.tags.includes("explore"));
  process.exit(gateFails.length || moved.length ? 1 : 0);
})();
