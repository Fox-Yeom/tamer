// 채팅 없이 한도 읽기 (STA-21, #104): the 5h · 7d limits without waiting for an agent's reply.
//   Codex  — its own app server (`codex app-server`, account/rateLimits/read): the official way, no
//            model turn, Codex reads its own login (POL-AGENT-02 rule 1)
//   Claude — only when the user turned it on (asked once, POL-AGENT-02 rules 1-1 … 1-6): Claude Code's
//            OAuth token, read from the macOS Keychain (or <config>/.credentials.json) when it's turned
//            on and when the user presses 새로 고침 — never by the timer, so no Keychain prompt comes
//            unannounced — kept in memory only, sent to Anthropic's usage address (unofficial) and
//            nowhere else. Never refreshed, never written back, never logged
// Each window comes back as { pct, resets_at (unix s), at (ms, when read) } — the renderer merges it with
// what the agents report by STA-09 rule 5 (same window: the later one received).
// Tests (CVIM_DESKTOP_TEST=1) never touch the Keychain or the network: CVIM_TEST_LIMITS=<dir> stands in
// (claude-cred.json · claude-usage.json), CVIM_LIMITS_CODEX_CMD a stand-in app server.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const https = require("node:https");
const { execFile, spawn } = require("node:child_process");

const TEST = process.env.CVIM_DESKTOP_TEST === "1";
const TEST_DIR = TEST ? process.env.CVIM_TEST_LIMITS || null : null;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const SERVICE = "Claude Code-credentials";

let token = null; // { value, exp (ms | null) } — memory only (rule 1-4)
const test = { keychainReads: 0, fetches: 0, status: 200 }; // what a test can see (counts, never values)

// Claude Code keeps its login under "Claude Code-credentials", or with CLAUDE_CONFIG_DIR set, that name
// plus the first 8 hex of the folder's SHA-256 (as PokeTokenBar reads it — 2026-10-20)
function claudeDir(env) { return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"); }
function services(env) {
  if (!env.CLAUDE_CONFIG_DIR) return [SERVICE];
  const d = env.CLAUDE_CONFIG_DIR.replace(/\/+$/, "");
  return [d, `${d}/`].map((p) => `${SERVICE}-${crypto.createHash("sha256").update(p).digest("hex").slice(0, 8)}`);
}
const credFile = (env) => path.join(claudeDir(env), ".credentials.json");
const run = (args, timeout) => new Promise((resolve) => execFile("/usr/bin/security", args, { timeout, maxBuffer: 1 << 20 }, (err, out) => resolve(err ? null : out)));

// is there a Claude Code login at all? (asked only then) — the item's attributes, no secret: no prompt
async function claudeHasLogin(env) {
  if (TEST) return !!TEST_DIR && fs.existsSync(path.join(TEST_DIR, "claude-cred.json"));
  if (fs.existsSync(credFile(env))) return true;
  for (const s of services(env)) if ((await run(["find-generic-password", "-s", s], 5000)) != null) return true;
  return false;
}

const parseCred = (text) => {
  try {
    const o = JSON.parse(text).claudeAiOauth;
    return o?.accessToken ? { value: String(o.accessToken), exp: Number.isFinite(Number(o.expiresAt)) ? Number(o.expiresAt) : null } : null;
  } catch { return null; }
};
// the token, read now (turning on · 새로 고침 only — macOS may ask about the Keychain: up to a minute to answer)
async function readToken(env) {
  test.keychainReads++;
  if (TEST) return TEST_DIR ? parseCred(fs.readFileSync(path.join(TEST_DIR, "claude-cred.json"), "utf8")) : null;
  try { const t = parseCred(fs.readFileSync(credFile(env), "utf8")); if (t) return t; } catch {}
  for (const s of services(env)) {
    const out = await run(["find-generic-password", "-s", s, "-w"], 60000);
    const t = out && parseCred(out.trim());
    if (t) return t;
  }
  return null;
}

const isoSec = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
// the usage answer → { five_hour, seven_day }: five_hour/seven_day { utilization 0–100, resets_at ISO },
// or the newer limits[] (kind session / weekly_all, percent) when those are null
function parseUsage(o, at) {
  const win = (w) => (w && Number.isFinite(Number(w.utilization)) ? { pct: Number(w.utilization), resets_at: isoSec(w.resets_at), at } : null);
  const ent = (kind) => { const e = (o?.limits || []).find((x) => x?.kind === kind); return e && Number.isFinite(Number(e.percent)) ? { pct: Number(e.percent), resets_at: isoSec(e.resets_at), at } : null; };
  const u = { five_hour: win(o?.five_hour) || ent("session"), seven_day: win(o?.seven_day) || ent("weekly_all") };
  return u.five_hour || u.seven_day ? u : null;
}
function get(value) {
  test.fetches++;
  if (TEST) {
    if (test.status !== 200) return Promise.resolve({ status: test.status });
    try { return Promise.resolve({ status: 200, body: fs.readFileSync(path.join(TEST_DIR, "claude-usage.json"), "utf8") }); } catch { return Promise.resolve({ status: 0 }); }
  }
  return new Promise((resolve) => {
    const req = https.get(USAGE_URL, { headers: { Authorization: `Bearer ${value}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "Tamer" }, timeout: 15000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { if (body.length < 1 << 20) body += d; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ status: 0 }));
  });
}

// Claude: { five_hour, seven_day } or { error } — error "token" (none in memory: press 새로 고침),
// "expired" (Anthropic said no: dropped, press 새로 고침), "busy" (429), "net", "shape" (the answer changed)
async function claude(env, { user = false } = {}) {
  if (user || !token) {
    if (!user) return { error: "token" };
    token = await readToken(env);
    if (!token) return { error: "login" };
  }
  if (token.exp && token.exp < Date.now()) { token = null; return { error: "expired" }; }
  const r = await get(token.value);
  if (r.status === 401 || r.status === 403) { token = null; return { error: "expired" }; }
  if (r.status === 429) return { error: "busy" };
  if (r.status !== 200) return { error: "net" };
  let o = null; try { o = JSON.parse(r.body); } catch {}
  return parseUsage(o, Date.now()) || { error: "shape" };
}
function forget() { token = null; }

// Codex: the app server, asked once and closed — the windows by their length (300 min → 5h,
// 10080 → 7d), else primary → 5h, secondary → 7d (as in its session logs)
function codex(cmd, env, { timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    let done = false, buf = "";
    const end = (v) => { if (done) return; done = true; clearTimeout(timer); try { p.kill(); } catch {} resolve(v); };
    let p;
    try { p = spawn(cmd, ["app-server"], { env, cwd: os.tmpdir(), stdio: ["pipe", "pipe", "ignore"] }); } catch { return resolve({ error: "start" }); }
    const timer = setTimeout(() => end({ error: "timeout" }), timeout);
    const send = (o) => { try { p.stdin.write(JSON.stringify(o) + "\n"); } catch {} };
    p.on("error", () => end({ error: "start" }));
    p.on("exit", () => end({ error: "exit" }));
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ method: "initialized" }); send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } }); }
        else if (m.id === 2) {
          const rl = m.result?.rateLimits, at = Date.now();
          const w = (x) => (x && Number.isFinite(Number(x.usedPercent)) ? { pct: Number(x.usedPercent), resets_at: Number.isFinite(Number(x.resetsAt)) && x.resetsAt != null ? Number(x.resetsAt) : null, at, mins: x.windowDurationMins } : null);
          const ws = [w(rl?.primary), w(rl?.secondary)];
          const pick = (mins, i) => { const x = ws.find((y) => y?.mins === mins) || (ws.every((y) => !y?.mins) ? ws[i] : null); if (!x) return null; const { mins: _m, ...rest } = x; return rest; };
          const u = { five_hour: pick(300, 0), seven_day: pick(10080, 1) };
          end(u.five_hour || u.seven_day ? u : { error: m.error ? "error" : "shape" });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "tamer", version: "1" } } });
  });
}

module.exports = { claude, claudeHasLogin, forget, codex, parseUsage, hasToken: () => !!token, test, setTestStatus: (s) => { if (TEST) test.status = Number(s) || 200; } };
