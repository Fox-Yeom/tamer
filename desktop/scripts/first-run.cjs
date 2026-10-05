// Try Tamer as a new user on this Mac, then get your own data back.
//   npm run firstrun -- start     Tamer closed → your data moves aside, Tamer starts empty
//   npm run firstrun -- restore   Tamer closed → the trial's data is kept aside, yours comes back
//   npm run firstrun -- status
// What moves (renamed on the same disk — nothing is copied or deleted):
//   ~/.cache/tamer                          partner · Pokédex · folders · state
//   ~/Library/Application Support/Tamer     window and browser storage (last usage, sort, font size)
// An empty ~/.cache/tamer is left in place: without it Tamer would copy the old CVIM data
// (~/.cache/cvim) in on its first launch, and it wouldn't be a first launch any more.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HOME = os.homedir();
const PLACES = { cache: path.join(HOME, ".cache/tamer"), profile: path.join(HOME, "Library/Application Support/Tamer") };
const ROOT = path.join(HOME, ".cache/tamer-firstrun-backup");
const cmd = process.argv[2] || "status";

function running() {
  try { return execFileSync("pgrep", ["-f", "Tamer.app/Contents/MacOS/Tamer$"], { encoding: "utf8" }).trim(); } catch { return ""; }
}
const sessions = () => (fs.existsSync(ROOT) ? fs.readdirSync(ROOT).sort() : []).map((s) => ({ dir: path.join(ROOT, s), ...JSON.parse(fs.readFileSync(path.join(ROOT, s, "manifest.json"), "utf8")) }));
const active = () => sessions().filter((s) => s.state === "trial").at(-1);
const save = (s) => { const { dir, ...m } = s; fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2)); };

if (cmd === "status") {
  const a = active();
  console.log(a ? `trial running since ${a.started} — your data is in ${a.dir} (npm run firstrun -- restore)` : "no trial: Tamer uses your own data");
  process.exit(0);
}
if (running()) { console.error("Tamer is running — quit it first (⌘Q), then run this again"); process.exit(1); }

if (cmd === "start") {
  if (active()) { console.error(`a trial is already on (${active().dir}) — restore it first`); process.exit(1); }
  const dir = path.join(ROOT, new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = { dir, state: "trial", started: new Date().toISOString(), moved: {} };
  for (const [k, p] of Object.entries(PLACES)) {
    if (!fs.existsSync(p)) continue;
    fs.renameSync(p, path.join(dir, k));
    s.moved[k] = p;
    save(s);
  }
  fs.mkdirSync(PLACES.cache, { recursive: true, mode: 0o700 }); // empty: no copying from ~/.cache/cvim
  save(s);
  console.log(`your data → ${dir}\nTamer now starts as a new user. When done: quit Tamer, npm run firstrun -- restore`);
} else if (cmd === "restore") {
  const s = active();
  if (!s) { console.error("no trial to restore"); process.exit(1); }
  const keep = path.join(s.dir, "trial");
  fs.mkdirSync(keep, { recursive: true });
  for (const [k, p] of Object.entries(PLACES)) {
    if (fs.existsSync(p)) fs.renameSync(p, path.join(keep, k)); // the trial's own data, kept to look at
    if (s.moved[k]) fs.renameSync(path.join(s.dir, k), p);
  }
  s.state = "restored";
  s.restored = new Date().toISOString();
  save(s);
  console.log(`your data is back. The trial's data is kept in ${keep} (delete it when you like)`);
} else {
  console.error("usage: npm run firstrun -- start | restore | status");
  process.exit(1);
}
