// Which build this is: `dev` (npm run electron:pack — the commit is shown after the version,
// 0.3.0-beta.4+3b14329) or `release` (npm run beta — the version alone). Read by electron/main.cjs.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const kind = process.argv[2] === "release" ? "release" : "dev";
let commit = null;
try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", cwd: path.resolve(__dirname, "..") }).trim(); } catch {}
fs.writeFileSync(path.join(__dirname, "..", "electron", "build-info.json"), JSON.stringify({ kind, commit }) + "\n");
