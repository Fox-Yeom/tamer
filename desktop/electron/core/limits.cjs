// 채팅 없이 한도 읽기 (STA-21, #104): the 5h · 7d limits without waiting for an agent's reply.
//   Codex  — its own app server (`codex app-server`, account/rateLimits/read): the official way, no
//            model turn, Codex reads its own login (POL-AGENT-02 rule 1)
//   Claude — only when the user turned it on (asked once, POL-AGENT-02 rules 1-1 … 1-6): Claude Code's
//            OAuth token, from <config>/.credentials.json or the macOS Keychain — the core (cvim-core, keychain.rs)
//            hands over the access token and its expiry only. Read when no token in memory works, by itself — at the
//            start, after it expires (#136, 2026-11-05: nobody can know when to press): first the way Claude Code
//            reads its own item (/usr/bin/security, on the item's list — no prompt, and Claude Code writing the item
//            anew doesn't undo it, as it does an "Always Allow" given to cvim-core, about hourly). Where that doesn't
//            work (it would ask): blocked — not by itself any more, and a press reads through cvim-core, macOS's
//            prompt naming it. Kept in memory only, sent to Anthropic's usage address (unofficial) and nowhere
//            else. Never refreshed, never written back, never logged
// Each window comes back as { pct, resets_at (unix s), at (ms, when read) } — the renderer merges it with
// what the agents report by STA-09 rule 5 (same window: the later one received).
// Tests (CVIM_DESKTOP_TEST=1) never touch the Keychain or the network: CVIM_TEST_LIMITS=<dir> stands in
// (claude-cred.json · claude-usage.json; test.tool = false: a Mac where `security` can't read it, test.denied = the
// prompt answered "no"), CVIM_LIMITS_CODEX_CMD a stand-in app server.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const https = require("node:https");
const { spawn } = require("node:child_process");

const TEST = process.env.CVIM_DESKTOP_TEST === "1";
const TEST_DIR = TEST ? process.env.CVIM_TEST_LIMITS || null : null;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const SERVICE = "Claude Code-credentials";

let token = null; // { value, exp (ms | null) } — memory only (rule 1-4)
let lost = "token"; // why there's no token: "token" (never read) | "expired" | "press" (blocked) | "denied" | "login" …
let blocked = false; // the quiet way didn't work on this Mac: a press only, until turned off and on (#136)
let keychain = null; // (services, read, tool) → the core's answer (main.cjs: cvim-core's claude_login)
const KEYCHAIN_WAIT = 120000; // a prompt nobody answers: given up after 2 minutes (the core keeps waiting alone)
// what a test can see (counts, never values) and set — tool: `security` reads the item here (#136), allowed: an
// "Always Allow" given to cvim-core, prompts: macOS's prompts shown (#124 — a read while allowed shows none)
const test = { keychainReads: 0, prompts: 0, fetches: 0, status: 200, tool: process.env.CVIM_TEST_LIMITS_TOOL !== "no", denied: false, allowed: false };

// Claude Code keeps its login under "Claude Code-credentials", or with CLAUDE_CONFIG_DIR set, that name
// plus the first 8 hex of the folder's SHA-256 (as other limit readers do — 2026-10-20)
function claudeDir(env) { return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"); }
function services(env) {
  if (!env.CLAUDE_CONFIG_DIR) return [SERVICE];
  const d = env.CLAUDE_CONFIG_DIR.replace(/\/+$/, "");
  return [d, `${d}/`].map((p) => `${SERVICE}-${crypto.createHash("sha256").update(p).digest("hex").slice(0, 8)}`);
}
const credFile = (env) => path.join(claudeDir(env), ".credentials.json");
const ask = (env, read, tool = false) => (keychain ? Promise.race([keychain(services(env), read, tool), new Promise((r) => setTimeout(() => r({ timeout: true }), read && !tool ? KEYCHAIN_WAIT : 10000))]).catch(() => null) : Promise.resolve(null));

// is there a Claude Code login at all? (asked only then) — the item's attributes, no secret: no prompt
async function claudeHasLogin(env) {
  if (TEST) return !!TEST_DIR && fs.existsSync(path.join(TEST_DIR, "claude-cred.json"));
  if (fs.existsSync(credFile(env))) return true;
  return !!(await ask(env, false))?.found;
}

const parseCred = (text) => {
  try {
    const o = JSON.parse(text).claudeAiOauth;
    return o?.accessToken ? { value: String(o.accessToken), exp: Number.isFinite(Number(o.expiresAt)) ? Number(o.expiresAt) : null } : null;
  } catch { return null; }
};
const asToken = (r) => ({ value: r.token, exp: Number.isFinite(r.exp) ? r.exp : null });
const testRead = () => { try { const t = TEST_DIR && parseCred(fs.readFileSync(path.join(TEST_DIR, "claude-cred.json"), "utf8")); return t ? { token: t.value, exp: t.exp } : {}; } catch { return {}; } };
// macOS's prompt, stood in for
function testPrompt() {
  if (!test.allowed || test.denied) test.prompts++;
  if (test.denied) return { denied: true };
  test.allowed = true; // answered "Always Allow"
  return testRead();
}
// the token, read now → { token, how, ms } | { error: "login" | "press" | "denied" | "asking" }. how "tool": no prompt, the
// way Claude Code reads it · "read": through cvim-core, on a press only (a prompt answered shows as seconds) · "file":
// <config>/.credentials.json
async function readToken(env, user) {
  test.keychainReads++;
  if (!TEST) try { const t = parseCred(fs.readFileSync(credFile(env), "utf8")); if (t) return { token: t, how: "file" }; } catch {}
  const t0 = Date.now(), took = () => Date.now() - t0;
  if (!blocked) {
    const r = TEST ? (test.tool ? testRead() : { ask: true }) : await ask(env, true, true);
    if (typeof r?.token === "string" && r.token) return { token: asToken(r), how: "tool", ms: took() };
    if (r?.busy || r?.timeout) return { error: "asking", ms: took() };
    if (!r?.ask && !r?.denied) return { error: "login", ms: took() };
    blocked = true;
  }
  if (!user) return { error: "press", ms: took() };
  const r = TEST ? testPrompt() : await ask(env, true);
  if (typeof r?.token === "string" && r.token) return { token: asToken(r), how: "read", ms: took() };
  return { error: r?.denied ? "denied" : r?.busy || r?.timeout ? "asking" : "login", ms: took() };
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

// Claude: { five_hour, seven_day, how } or { error } — error "token" (none yet), "login" (no login found), "press" (the
// quiet way is blocked here: a press reads), "denied" (the prompt said no), "asking" (a prompt is open), "expired"
// (Claude Code hasn't renewed it: not used for a while), "busy" (429), "net", "shape" (the answer changed). The Keychain
// is read only when no token in memory works — once a call (#136); how "kept": a press answered with the token in memory
async function claude(env, { user = false } = {}) {
  let how = null, ms = null, read = false;
  if (token?.exp && token.exp < Date.now()) { token = null; lost = "expired"; }
  if (user && token) how = "kept";
  for (;;) {
    if (!token) {
      if (read || (blocked && !user)) return { error: lost, how, ms };
      read = true;
      const r = await readToken(env, user);
      how = r.how || null; ms = r.ms ?? null;
      if (!r.token) { if (r.error !== "asking") lost = r.error; return { error: r.error, how, ms }; }
      token = r.token;
      // one that came back expired: Claude Code hasn't renewed it yet (not used for a while)
      if (token.exp && token.exp < Date.now()) { token = null; lost = "expired"; return { error: "expired", how, ms }; }
    }
    const r = await get(token.value);
    if (r.status === 401 || r.status === 403) { token = null; lost = "expired"; continue; } // read once more
    if (r.status === 429) return { error: "busy", how, ms };
    if (r.status !== 200) return { error: "net", how, ms };
    let o = null; try { o = JSON.parse(r.body); } catch {}
    const u = parseUsage(o, Date.now());
    return u ? { ...u, how, ms } : { error: "shape", how, ms };
  }
}
// turned off: the token goes, and the next turning on starts over
function forget() { token = null; lost = "token"; blocked = false; }
// only a press can read it now (STA-21 rule 8) — not while it's merely expired or not read yet: pressing wouldn't help
const needsPress = () => !token && blocked;

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

module.exports = { claude, claudeHasLogin, forget, needsPress, codex, parseUsage, hasToken: () => !!token, useKeychain: (fn) => { keychain = fn; }, test, setTestStatus: (s) => { if (TEST) test.status = Number(s) || 200; } };
