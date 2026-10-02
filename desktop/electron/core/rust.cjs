// Client for cvim-core (desktop/core-rs), the Rust process that owns agent state and the path
// policy (docs/PLATFORM.md 3.8). JSON lines on stdio; see core-rs/src/main.rs for the protocol.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

// packaged: Contents/Resources/cvim-core (extra resource, outside the asar); dev: the cargo build
function binary() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, "cvim-core"),
    path.join(__dirname, "..", "..", "core-rs", "target", "release", "cvim-core"),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

class RustCore {
  constructor({ onEvent, log }) {
    this.onEvent = onEvent;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.start();
  }

  start() {
    const bin = binary();
    if (!bin) throw new Error("cvim-core binary not found (cd desktop/core-rs && cargo build --release)");
    // where the agents keep their logs, as the user's terminal sets it (CODEX_HOME, CLAUDE_CONFIG_DIR
    // in their rc files) — the app's own environment (tests) wins
    const t = require("./agents.cjs").loginEnv();
    const homes = Object.fromEntries(["CODEX_HOME", "CLAUDE_CONFIG_DIR"].filter((k) => t[k] && !process.env[k]).map((k) => [k, t[k]]));
    this.proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...homes } });
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => this.receive(line));
    this.proc.stderr.on("data", (d) => this.log(`core stderr: ${d}`));
    this.proc.on("exit", (code, sig) => {
      this.log(`core exited code=${code} sig=${sig}`);
      for (const { reject } of this.pending.values()) reject(new Error("cvim-core exited"));
      this.pending.clear();
      this.proc = null;
    });
  }

  receive(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return this.log(`core: bad line ${line.slice(0, 200)}`); }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      return msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
    }
    if (msg.event) this.onEvent(msg);
  }

  request(method, params) {
    if (!this.proc) return Promise.reject(new Error("cvim-core not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  // fire-and-forget (no reply)
  notify(method, params) {
    if (this.proc) this.proc.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  stop() {
    if (this.proc) this.proc.stdin.end(); // the core cleans up and exits when stdin closes
  }
}

module.exports = { RustCore, binary };
