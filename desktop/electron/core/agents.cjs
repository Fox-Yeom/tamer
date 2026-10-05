// Agent registry (ported from v1). Choice file ~/.cache/tamer/agents.json (same
// format as the Neovim CVIM's). User additions: ~/.cvim/agents.json (JSON; the Lua file can't be read here)
//   { "aider": { "name": "Aider", "icon": "⌘", "cmd": ["aider"], "state": "activity" } }
//   state: "hooks" (Claude) | "codex_log" (Codex) | "activity" (anything else: working/idle only)
const fs = require("node:fs");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { HOME, CACHE, ROOT, readJson, writeJson } = require("./paths.cjs");

const CHOICE = path.join(CACHE, "agents.json");
const ORDER = ["claude", "codex", "gemini", "opencode"];

const DEFS = {
  claude: { name: "Claude Code", short: "Claude", icon: "✻", color: "#D97757", cmd: ["claude"], state: "hooks" },
  codex: {
    name: "Codex", short: "Codex", icon: "◎", color: "#10A37F", state: "codex_log",
    // the user's own `codex` first — the one their terminal runs (#42: the Codex app's copy can be
    // older, 0.152 vs 0.160 here, and it showed "Update available"). Only one that answers --version:
    // the npm wrapper can be installed without its native binary — then an app's copy: the ChatGPT
    // app first (the Codex desktop app updates into it — same bundle id com.openai.codex — and the old
    // Codex.app stays behind, never updated: 0.152 vs 0.160 here, 2026-10-05), the old Codex.app last
    cmd: ["codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "/Applications/Codex.app/Contents/Resources/codex"], check: ["--version"],
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
// Read once, in the background, at startup (prepareEnv): nothing waits for it before the window
// is up — a slow or stuck shell config made the app unresponsive for seconds at launch, and macOS
// then refused to open it ("응답하지 않기 때문에 열 수 없습니다", #4). An interactive shell ignores
// SIGTERM: SIGKILL after 3 s, then the login PATH plus the usual places.
const MARK = "__CVIM_ENV__";
let termEnv, preparing;
const run = (shell, args, ms) => new Promise((resolve) =>
  execFile(shell, args, { encoding: "utf8", timeout: ms, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : out)));
function usualPath(login = "") {
  // nvm's node versions too (Gemini CLI is usually installed there with npm), newest first
  let nvm = [];
  try {
    const dir = path.join(HOME, ".nvm/versions/node");
    nvm = fs.readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((v) => path.join(dir, v, "bin"));
  } catch {}
  const usual = [path.join(HOME, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", path.join(HOME, ".bun/bin"), ...nvm];
  return [login, process.env.PATH || "", ...usual].filter(Boolean).join(":");
}
// The user's shell (any: zsh, bash, fish, ksh, tcsh/csh, nu …) — $SHELL if it runs, else zsh.
// csh / tcsh can't take -l with other options; they read ~/.tcshrc / ~/.cshrc for every shell.
const isCsh = (sh) => /^t?csh$/.test(path.basename(sh));
function userShell() {
  const sh = process.env.SHELL;
  try { if (sh && path.isAbsolute(sh)) { fs.accessSync(sh, fs.constants.X_OK); return sh; } } catch {}
  return "/bin/zsh";
}
// how an interactive terminal starts it: a login shell where the shell allows it
const shellArgs = (sh = userShell()) => (isCsh(sh) ? [] : ["-l"]);

const ENV_WAIT = Number(process.env.CVIM_ENV_WAIT_MS) || 15000;
let envFailed = false;
function prepareEnv() {
  if (preparing) return preparing;
  const shell = userShell();
  // absolute paths: the shell's own syntax (fish, nu, csh …) doesn't matter
  const script = `/usr/bin/printf '\\n${MARK}\\n'; /usr/bin/env -0`;
  preparing = (async () => {
    // up to 15 s: a heavy ~/.zshrc (nvm, pyenv, conda …) can take long, and since #34/#35 nothing on
    // screen waits for this — only starting an agent does. 3 s cut slow shells off and agents then
    // ran with PATH alone (their API keys, proxies … from the rc files missing)
    const out = await run(shell, isCsh(shell) ? ["-c", script] : ["-l", "-i", "-c", script], ENV_WAIT);
    if (out != null && out.includes(`${MARK}\n`)) {
      const body = out.slice(out.lastIndexOf(`${MARK}\n`) + MARK.length + 1); // rc files may print first
      const env = Object.fromEntries(body.split("\0").filter((kv) => kv.includes("=")).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
      // plus the usual places after it (an agent installed where this shell's config doesn't look)
      if (env.PATH) return (termEnv = { ...env, PATH: [...new Set(usualPath(env.PATH).split(":"))].join(":") });
    }
    const login = isCsh(shell) ? null : await run(shell, ["-l", "-c", "/usr/bin/printenv PATH"], 5000);
    envFailed = true; // the rc files' variables are missing: say so (log, diagnostics, a toast when an agent starts)
    return (termEnv = { PATH: usualPath(login || "") });
  })();
  return preparing;
}
// the terminal's environment once read; until then (never blocking) the app's PATH plus the usual places
function loginEnv() {
  return termEnv || { PATH: usualPath() };
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

// first runnable candidate of the agent's command (with its arguments). With `check`, the candidate
// must also answer it (exit 0, within 4 s) — remembered per file and its modification time
const answers = new Map();
function answersCheck(p, check) {
  let key;
  try { key = `${p}:${fs.statSync(p).mtimeMs}`; } catch { return false; }
  if (!answers.has(key)) {
    let ok = false;
    try { execFileSync(p, check, { timeout: 4000, stdio: "ignore", env: { ...process.env, PATH: shellPath() } }); ok = true; } catch {}
    answers.set(key, ok);
  }
  return answers.get(key);
}
function bin(key) {
  const d = all()[key];
  if (!d) return null;
  for (const c of d.cmd || []) {
    const p = findExe(c.split(/\s+/)[0]);
    if (p && (!d.check || answersCheck(p, d.check))) return c;
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
    const fix = d.key === "gemini" && at && !geminiLinked() ? "gemini_link"
      : d.key === "claude" && at && claudeLinkFile() ? (claudeLinked() ? "claude_linked" : "claude_link") : null; // #45
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

// ── Claude typed in a Tamer shell (#45, opt-in): one marked block in the user's shell startup file
// that only acts inside Tamer — Tamer's shells carry CVIM_CLAUDE_SETTINGS, so there `claude` gets
// Tamer's --settings (status line: 5h · 7d · ctx; hooks), like ⌘G. Anywhere else the variable is
// unset and the block does nothing. Added only after the user agrees; "연결 해제" removes exactly
// that block (a copy of the file is kept first). The global ~/.claude/settings.json is not touched.
const LINK_BEGIN = "# >>> Tamer: Claude 연결 (Tamer 셸 안에서만 동작 — 지우려면 Tamer의 에이전트 연결 창에서 해제) >>>";
const LINK_END = "# <<< Tamer: Claude 연결 <<<";
// the startup file a login shell of that kind reads, and the lines for it (null: not supported)
function claudeLinkFile(shell = userShell()) {
  const name = path.basename(shell);
  if (name === "zsh") return { file: path.join(loginEnv().ZDOTDIR || HOME, ".zshrc"), lines: ['[ -n "$CVIM_CLAUDE_SETTINGS" ] && alias claude=\'claude --settings "$CVIM_CLAUDE_SETTINGS"\''] };
  if (name === "bash") {
    // a login bash reads the first of these that exists (and only that one)
    const file = [".bash_profile", ".bash_login", ".profile"].map((f) => path.join(HOME, f)).find((f) => fs.existsSync(f)) || path.join(HOME, ".bash_profile");
    return { file, lines: ['[ -n "$CVIM_CLAUDE_SETTINGS" ] && alias claude=\'claude --settings "$CVIM_CLAUDE_SETTINGS"\''] };
  }
  if (name === "fish") return { file: path.join(HOME, ".config/fish/config.fish"), lines: ["if set -q CVIM_CLAUDE_SETTINGS", "    alias claude 'claude --settings $CVIM_CLAUDE_SETTINGS'", "end"] };
  return null;
}
const linkBlock = (lines) => [LINK_BEGIN, ...lines, LINK_END].join("\n");
function claudeLinked() {
  const f = claudeLinkFile();
  try { return !!f && fs.readFileSync(f.file, "utf8").includes(LINK_BEGIN); } catch { return false; }
}
// the file's real path (a dotfiles symlink: the file it points to), its text and mode
function readRc(file) {
  let real = file, text = "", mode = 0o644;
  try { real = fs.realpathSync(file); } catch {}
  try { text = fs.readFileSync(real, "utf8"); mode = fs.statSync(real).mode & 0o777; } catch {}
  return { real, text, mode };
}
function backupRc(real, text) {
  const dir = path.join(CACHE, "backup", "shell-rc");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const to = path.join(dir, `${path.basename(real).replace(/^\./, "")}.${new Date().toISOString().replace(/[:.]/g, "-")}`); // not hidden
  fs.writeFileSync(to, text, { mode: 0o600 });
  return to;
}
function claudeLink() {
  const f = claudeLinkFile();
  if (!f) throw new Error("unsupported shell");
  const { real, text, mode } = readRc(f.file);
  if (text.includes(LINK_BEGIN)) return { file: f.file, already: true };
  const backup = text ? backupRc(real, text) : null;
  fs.mkdirSync(path.dirname(real), { recursive: true });
  // a blank line before the block (and the newline the file may have lacked)
  fs.writeFileSync(real, `${text}${text && !text.endsWith("\n") ? "\n\n" : "\n"}${linkBlock(f.lines)}\n`, { mode });
  return { file: f.file, backup };
}
function claudeUnlink() {
  const f = claudeLinkFile();
  if (!f) return { file: null };
  const { real, text, mode } = readRc(f.file);
  const a = text.indexOf(LINK_BEGIN), b = text.indexOf(LINK_END, a);
  if (a < 0 || b < 0) return { file: f.file, absent: true };
  const backup = backupRc(real, text);
  // the file as it was (ending in a newline): the blank line before the block goes with it; anything
  // the user wrote after the block stays
  const before = text.slice(0, a).replace(/\n$/, ""), after = text.slice(b + LINK_END.length).replace(/^\n/, "");
  fs.writeFileSync(real, before + after, { mode });
  return { file: f.file, backup };
}

module.exports = { claudeLinkFile, claudeLinked, claudeLink, claudeUnlink, LINK_BEGIN, envFailed: () => envFailed, all, get, bin, available, command, agentEnv, stateOf, geminiLinked, forDir, chosen, remember, next, label, shellPath, loginEnv, prepareEnv, processEnv, userShell, shellArgs, where, status, INSTALL };
