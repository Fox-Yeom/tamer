// Agent registry (port of nvim/lua/cvim/agents.lua). Choice file ~/.cache/tamer/agents.json (same
// format as the Neovim CVIM's). User additions: ~/.cvim/agents.json (JSON; the Lua file can't be read here)
//   { "aider": { "name": "Aider", "icon": "⌘", "cmd": ["aider"], "state": "activity" } }
//   state: "hooks" (Claude) | "codex_log" (Codex) | "activity" (anything else: working/idle only)
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { HOME, CACHE, ROOT, readJson, writeJson } = require("./paths.cjs");

const CHOICE = path.join(CACHE, "agents.json");
const ORDER = ["claude", "codex", "gemini", "opencode"];

const DEFS = {
  claude: { name: "Claude Code", short: "Claude", icon: "✻", color: "#D97757", cmd: ["claude"], state: "hooks" },
  codex: {
    name: "Codex", short: "Codex", icon: "◎", color: "#10A37F", state: "codex_log",
    // the npm wrapper can be installed without its native binary; the app's copy always works
    cmd: ["/Applications/Codex.app/Contents/Resources/codex", "codex"],
  },
  // A2: official events, injected for CVIM's run only (agentEnv) — Gemini hooks, an OpenCode plugin
  gemini: { name: "Gemini CLI", short: "Gemini", icon: "✦", color: "#4F8DF7", cmd: ["gemini"], state: "hooks" },
  opencode: { name: "OpenCode", short: "OpenCode", icon: "◆", color: "#E0E0E0", cmd: ["opencode"], state: "hooks" },
};

let defs;
function all() {
  if (defs) return defs;
  defs = JSON.parse(JSON.stringify(DEFS));
  const user = readJson(process.env.CVIM_AGENTS_JSON || path.join(HOME, ".cvim/agents.json"), {});
  for (const [key, d] of Object.entries(user)) {
    defs[key] = { ...(defs[key] || { name: key, icon: "▸", state: "activity" }), ...d };
    if (!ORDER.includes(key)) ORDER.push(key);
  }
  for (const [key, d] of Object.entries(defs)) {
    d.key = key;
    d.short = d.short || d.name;
    if (typeof d.cmd === "string") d.cmd = [d.cmd];
  }
  return defs;
}

const get = (key) => all()[key] || all().claude;

// The environment of the user's terminal: an interactive login shell (its rc files: nvm, Homebrew,
// pnpm … add to PATH there; CODEX_HOME / CLAUDE_CONFIG_DIR may be set there). An app started from
// Finder has a minimal PATH and none of that, so agents started by CVIM — and the core reading their
// logs — get this environment, like in the user's own terminal.
// An interactive shell ignores SIGTERM: a stuck shell config (e.g. a stale `pyenv rehash` lock)
// would block the app — SIGKILL after 3 s, then the login PATH plus the usual places.
const MARK = "__CVIM_ENV__";
let termEnv;
function loginEnv() {
  if (termEnv) return termEnv;
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const out = execFileSync(shell, ["-lic", `printf '\\n${MARK}\\n'; env -0`], { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
    const body = out.slice(out.lastIndexOf(`${MARK}\n`) + MARK.length + 1); // rc files may print first
    termEnv = Object.fromEntries(body.split("\0").filter((kv) => kv.includes("=")).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
    if (!termEnv.PATH) throw new Error("no PATH");
  } catch {
    let login = "";
    try { login = execFileSync(shell, ["-lc", "printf %s \"$PATH\""], { encoding: "utf8", timeout: 2000, killSignal: "SIGKILL" }); } catch {}
    // nvm's node versions too (Gemini CLI is usually installed there with npm), newest first
    let nvm = [];
    try {
      const dir = path.join(HOME, ".nvm/versions/node");
      nvm = fs.readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((v) => path.join(dir, v, "bin"));
    } catch {}
    const usual = [path.join(HOME, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", path.join(HOME, ".bun/bin"), ...nvm];
    termEnv = { PATH: [login, process.env.PATH || "", ...usual].filter(Boolean).join(":") };
  }
  return termEnv;
}
const shellPath = () => loginEnv().PATH;

// what a process CVIM starts gets: the terminal's environment, with the app's own variables on top
// (CVIM_* and test settings) — except PATH, which is the terminal's
function processEnv() {
  const t = loginEnv();
  return { ...t, ...process.env, PATH: t.PATH };
}

function findExe(exe) {
  if (exe.includes("/")) return fs.existsSync(exe) ? exe : null;
  for (const dir of shellPath().split(":")) {
    const p = path.join(dir, exe);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

// first runnable candidate of the agent's command (with its arguments)
function bin(key) {
  const d = all()[key];
  if (!d) return null;
  for (const c of d.cmd || []) {
    const exe = c.split(/\s+/)[0];
    if (findExe(exe)) return c;
  }
  return null;
}

const available = () => ORDER.filter((k) => all()[k] && bin(k));

// the shell command the agent pane runs. Claude gets cvim's hooks/statusLine via --settings.
// resume: pick up the folder's last conversation (session restore) — Claude --continue,
// Codex resume --last; others start fresh
function command(key, { resume = false } = {}) {
  if (key === "claude") {
    const base = (process.env.CVIM_CLAUDE_CMD || "claude") + (resume ? " --continue" : "");
    return ROOT ? `${base} --settings '${path.join(ROOT, "claude/settings.json")}'` : base;
  }
  const c = bin(key) || key;
  return resume && key === "codex" ? `${c} resume --last` : c;
}

// env for one agent run so it reports its lifecycle to CVIM (same log lines as Claude's hooks),
// without touching the user's own config:
//   OpenCode: OPENCODE_CONFIG_CONTENT → {"plugin":["file://…/agents/opencode-cvim.js"]} (merged)
//   Gemini CLI: nothing per run — Gemini only reads a system settings file owned by root, so its
//     hooks come from the CVIM extension (agents/gemini-extension, `gemini extensions link`), which
//     does nothing unless CVIM_TAB_ID is set. Without it, Gemini falls back to output activity.
function agentEnv(key) {
  if (!ROOT) return {};
  if (key === "opencode" && !process.env.OPENCODE_CONFIG_CONTENT) {
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [`file://${path.join(ROOT, "agents/opencode-cvim.js")}`] }) };
  }
  return {};
}

// where an agent was found (the first runnable candidate, resolved on the terminal's PATH)
function where(key) {
  const c = bin(key);
  return c ? findExe(c.split(/\s+/)[0]) : null;
}

// how to get the agents CVIM knows (official instructions; npm ones need Node.js)
const INSTALL = {
  claude: { cmd: "curl -fsSL https://claude.ai/install.sh | bash", url: "https://code.claude.com/docs/en/quickstart" },
  codex: { cmd: "npm install -g @openai/codex", url: "https://github.com/openai/codex" },
  gemini: { cmd: "npm install -g @google/gemini-cli", url: "https://github.com/google-gemini/gemini-cli" },
  opencode: { cmd: "curl -fsSL https://opencode.ai/install | bash", url: "https://opencode.ai/docs/" },
};

// the agent connection list (⌘G → "에이전트 연결"): what CVIM sees of each agent
//   full  = every state (thinking, tools, waiting, done, interrupted …), partner EXP and wild
//   basic = working / idle from its output; a long stretch of work that goes quiet counts as done
//           (EXP at half pace, no wild)
function status() {
  return Object.values(all()).map((d) => {
    const at = where(d.key);
    const level = !at ? "none" : stateOf(d.key) === "activity" ? "basic" : "full";
    const fix = d.key === "gemini" && at && !geminiLinked() ? "gemini_link" : null;
    return { key: d.key, name: d.name, icon: d.icon, color: d.color, path: at, level, fix, install: INSTALL[d.key] || null };
  });
}

// the CVIM Gemini extension linked into ~/.gemini/extensions (A2)
const geminiLinked = () => fs.existsSync(path.join(HOME, ".gemini", "extensions", "cvim"));

// how CVIM reads an agent's state: its definition, except Gemini without the extension → activity
function stateOf(key) {
  const d = get(key);
  return key === "gemini" && d.state === "hooks" && !geminiLinked() ? "activity" : d.state;
}

// agent for a folder: env > folder's last choice > global default > claude
function forDir(dir) {
  if (process.env.CVIM_AGENT && all()[process.env.CVIM_AGENT]) return process.env.CVIM_AGENT;
  const t = readJson(CHOICE, {});
  for (const key of [dir && t[dir], t._default]) {
    if (key && all()[key] && bin(key)) return key;
  }
  return "claude";
}

// the agent chosen for this folder before (none: forDir falls back to the default)
const chosen = (dir) => readJson(CHOICE, {})[dir] || null;

function remember(dir, key) {
  const t = readJson(CHOICE, {});
  t[dir || "_default"] = key;
  writeJson(CHOICE, t);
}

function next(key) {
  const list = available();
  if (!list.length) return key;
  const i = list.indexOf(key);
  return list[(i + 1) % list.length];
}

const label = (key) => `${get(key).icon} ${get(key).name}`;

module.exports = { all, get, bin, available, command, agentEnv, stateOf, geminiLinked, forDir, chosen, remember, next, label, shellPath, loginEnv, processEnv, where, status, INSTALL };
