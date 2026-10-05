// CVIM Desktop (v2) — Electron main process: a thin layer between the UI (src/), the PTYs, and
// cvim-core (Rust, desktop/core-rs), which owns the agent state machine, the adapters (Claude
// hooks, Codex log, activity) and the path policy. Partner Pokémon data is still here (partner.cjs).
// Data: ~/.cache/tamer (copied once from the Neovim CVIM's ~/.cache/cvim — core/paths.cjs).
const { app, BrowserWindow, ipcMain, clipboard, session, dialog, screen, Menu, powerMonitor, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const pty = require("node-pty");
const { execFile } = require("node:child_process");
const { HOME, CACHE, STATE, TABS, ROOT, writeFile, mkdirPrivate, tighten, pruneTabs } = require("./core/paths.cjs");
const agents = require("./core/agents.cjs");
const partner = require("./core/partner.cjs");
const wild = require("./core/wild.cjs");
const prices = require("./core/prices.cjs");
const { RustCore } = require("./core/rust.cjs");

const ptys = new Map(); // pane id "<ws>:<agent|shell>" -> IPty
// test hooks (DevTools input emulation, stand-in commands) only exist in test runs
const TEST = process.env.CVIM_DESKTOP_TEST === "1";
// test instances show their window without activating it, so keys typed in the user's own apps
// never land in a test terminal (seen 2026-10-02); CVIM_DESKTOP_TEST_FOCUS=1 for IME tests that need focus
const QUIET_TEST = TEST && process.env.CVIM_DESKTOP_TEST_FOCUS !== "1";
const linksOpened = []; // tests: links ⌘-clicked (never opened)
const DIST = path.join(__dirname, "..", "dist");
// terminal panes per tab (the Neovim pane became the "changes" panel, E1b — nvim runs in the shell)
const KINDS = ["agent", "shell"];
let win;
let overlay; // desktop overlay (overlay.html): partners while you're in another app
let activeWs = null; // the tab on screen in the main window
let core; // cvim-core process (started when the app is ready)
const workspaces = new Map(); // ws id -> { id, cwd, agent, opened, partnerReady, partner, sessions }
// agent sessions (M1: several per folder). The tab's first session is the workspace itself (same
// id); more are "<ws>~s<n>" — each its own agent process, core workspace, hook files and terminal
const sessions = new Map(); // session id -> session ({ id, parent?, cwd, agent, opened, agentState … })
const tabOf = (s) => s.parent || s;
const pendingOpen = []; // folders handed to the app (Dock / Finder) before the window was ready

function send(event, payload) {
  if (win && !win.isDestroyed()) win.webContents.send("host-event", { event, payload });
}

// to both windows (wild encounters show in either)
function broadcast(event, payload) {
  send(event, payload);
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send("host-event", { event, payload });
}

// the app's own log: a file only with CVIM_DESKTOP_LOG (tests, diagnosis); the last lines are also
// kept in memory (never written) for "진단 정보 복사"
const RECENT_LOG = [];
const RECENT_LOG_MAX = 300;
function logLine(line) {
  if (process.env.CVIM_DESKTOP_LOG) fs.appendFileSync(process.env.CVIM_DESKTOP_LOG, line + "\n");
  RECENT_LOG.push(`${new Date().toTimeString().slice(0, 8)} ${line}`);
  if (RECENT_LOG.length > RECENT_LOG_MAX) RECENT_LOG.shift();
}

// the user's own Claude statusLine, chained after cvim's (same as nvim/lua/cvim/init.lua)
function userStatusline() {
  try {
    const cmd = JSON.parse(fs.readFileSync(path.join(HOME, ".claude/settings.json"), "utf8"))?.statusLine?.command;
    if (typeof cmd === "string" && !cmd.includes("cvim")) return cmd;
  } catch {}
  return undefined;
}

// ── folders: recent list (~/.cache/tamer/recent_dirs, last_dir; same format as the Neovim CVIM) ──
const RECENT = path.join(CACHE, "recent_dirs");
const LAST = path.join(CACHE, "last_dir");

function recentDirs() {
  let lines = [];
  try { lines = fs.readFileSync(RECENT, "utf8").split("\n"); } catch {}
  return lines.filter((d) => d && isDir(d)).slice(0, 10);
}

function noteRecent(dir) {
  writeFile(LAST, dir);
  const list = [dir, ...recentDirs().filter((d) => d !== dir)].slice(0, 10);
  writeFile(RECENT, list.join("\n") + "\n");
  app.addRecentDocument(dir); // Dock menu "recent" for this app
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ── PTYs ────────────────────────────────────────────────────────────────────
// shell: the user's own shell, interactive (any shell — zsh, bash, fish, tcsh …); otherwise the
// command (agents) runs through /bin/sh with the user's terminal environment (PATH etc. from
// agents.loginEnv) — the user's shell can't be relied on to take `-l -c <POSIX command>` (csh)
function spawnPty({ id, cmd, shell = false, cwd, cols, rows, env }) {
  const old = ptys.get(id);
  if (old) { try { old.kill(); } catch {} ptys.delete(id); }
  const [file, args] = shell ? [agents.userShell(), agents.shellArgs()] : ["/bin/sh", ["-c", cmd]];
  const p = pty.spawn(file, args, {
    name: "xterm-256color", cols, rows, cwd,
    // the user's terminal environment (PATH from their rc files, CODEX_HOME …) — agents installed
    // with nvm / Homebrew / pnpm start the same as in their terminal
    env: { ...agents.processEnv(), TERM: "xterm-256color", COLORTERM: "truecolor", LANG: process.env.LANG || "ko_KR.UTF-8", ...env },
    encoding: null, // Buffers: the UI reassembles UTF-8 split across chunks
  });
  p.startedAt = Date.now();
  // its terminal id can change: a running agent moved to another tab (pty_move, #3)
  p.cvimId = id;
  // a replaced process (agent switch) keeps talking for a moment after kill(): its late output
  // and exit notice must not land in its successor's terminal
  p.onData((buf) => {
    const id = p.cvimId, [wsId, kind] = id.split(":");
    if (ptys.get(id) !== p) return;
    if (kind === "agent") { const s = sessions.get(wsId); if (!(s?.host && !s.hostKey)) outputSeen(wsId); } // activity adapter (agents without a log); wsId = session id; a bare host shell isn't
    else if (kind === "shell" && workspaces.get(wsId)?.shell) outputSeen(workspaces.get(wsId).shell.id); // an agent run in the shell
    send("pty", { id, data: Buffer.from(buf).toString("base64") });
  });
  p.onExit(() => {
    const id = p.cvimId, [wsId, kind] = id.split(":");
    if (ptys.get(id) !== p) return;
    ptys.delete(id);
    const sess = kind === "agent" ? sessions.get(wsId) : null;
    // a resumed agent that quits right away (nothing to continue here): start it fresh instead
    if (sess?.resumed && Date.now() - sess.startedAt < 5000) {
      logLine(`agent-resume-failed ws=${wsId} -> fresh`);
      send("agent-restarted", { ws: tabOf(sess).id, session: sess.id });
      startAgent(sess, sess.size).catch((e) => logLine(`restart error ${e}`));
      return;
    }
    if (sess) {
      sess.running = false; // a restore opens this folder as a shell (no agent to continue)
      sess.host = false;
      sess.hostKey = null;
      saveSession();
      core.request("set_state", { ws: wsId, state: "sleep" }).catch(() => {});
    }
    send("pty-exit", { id });
  });
  ptys.set(id, p);
}

// ── workspaces (one per tab) ───────────────────────────────────────────────
const wsOf = (id) => {
  const ws = workspaces.get(String(id));
  if (!ws) throw new Error("no such workspace");
  return ws;
};

function agentInfo(ws) {
  const d = agents.get(ws.agent);
  return { key: d.key, name: d.name, short: d.short, icon: d.icon, color: d.color, label: agents.label(ws.agent) };
}

const wsInfo = (ws) => ({ id: ws.id, cwd: ws.cwd, agent: agentInfo(ws) });

function openWorkspace(cwd) {
  cwd = path.resolve(cwd);
  if (!isDir(cwd)) throw new Error("not a folder");
  for (const ws of workspaces.values()) if (ws.cwd === cwd) return { ...wsInfo(ws), existing: true }; // already open: switch to it
  const agent = agents.forDir(cwd);
  const ws = { id: `${Math.floor(Date.now() / 1000)}-${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`, cwd, agent };
  ws.sessions = [ws]; // the first session is the workspace itself
  workspaces.set(ws.id, ws);
  sessions.set(ws.id, ws);
  logLine(`workspace id=${ws.id} agent=${agent} cwd=${cwd}`);
  ws.opened = core.request("open", { ws: ws.id, kind: agents.stateOf(agent), cwd, tabs: TABS });
  // kept for the UI to ask for: assign() can finish before the UI listens for "partner"
  ws.partnerReady = partner.assign(cwd).then((p) => {
    if (p?.choose) { noPartner(ws); return { ws: ws.id, choose: true }; }
    ws.partner = p; send("partner", { ws: ws.id, ...p }); overlayUpdate(); return p;
  })
    .catch((e) => { logLine(`partner error ${e}`); return null; });
  noteRecent(cwd);
  saveSession();
  return { ...wsInfo(ws), existing: false };
}

function closeWorkspace(id) {
  const ws = workspaces.get(id);
  if (!ws) return;
  for (const sid of [...ws.sessions.map((x) => `${x.id}:agent`), `${id}:shell`]) {
    const p = ptys.get(sid);
    if (p) { ptys.delete(sid); settleKill(p); }
  }
  for (const x of ws.sessions) {
    sessions.delete(x.id);
    if (x !== ws) core.request("close", { ws: x.id }).catch(() => {});
  }
  setShellAgent(ws, null);
  workspaces.delete(id);
  if (activeWs === id) activeWs = null;
  saveSession();
  overlayUpdate();
  core.request("close", { ws: id }).catch(() => {});
  logLine(`workspace closed id=${id}`);
}

// ── choosing a partner (box rules, partner.cjs): the first partner's starters, a resting one,
// or another folder's (that folder is left without one) ──────────────────────────────────
// a folder without a partner: the dialog (and an empty state in the avatar pane / overlay)
function noPartner(ws, freed) {
  ws.partner = null;
  send("partner-choose", { ws: ws.id, freed: !!freed });
  overlayUpdate();
}

function partnerTake(ws, choice) {
  const { partner: p, freed } = partner.take(ws.cwd, choice);
  ws.partner = p;
  ws.partnerReady = Promise.resolve(p);
  logLine(`partner-take ws=${ws.id} ${JSON.stringify(choice)} -> ${p?.id}#${p?.uid} freed=${freed ? path.basename(freed) : "-"}`);
  send("partner", { ws: ws.id, ...p });
  // the folder it came from (if open) has no partner now
  for (const o of workspaces.values()) {
    if (o !== ws && o.cwd === freed) noPartner(o, true);
  }
  overlayUpdate();
  return p && { ws: ws.id, ...p };
}

// the first partner's 3 starters: downloaded at start while the box is empty (dialog shows progress)
let starterLoading = null;
function loadStarter() {
  if (!starterLoading) {
    starterLoading = partner.fillStarter((n) => send("partner-today", { n })).finally(() => {
      starterLoading = null;
      send("partner-today", { done: true });
    });
  }
  return starterLoading;
}

// (re)start the workspace's agent in its agent pane; the core resets its state for it
// s: a session (the workspace itself for the first one)
// A shell is killed only after its rc files ran: one killed while starting can leave a stale lock
// behind (`pyenv rehash` → ~/.pyenv/shims/.pyenv-shim, then every new terminal waits 60 s — seen
// 2026-10-02 when ⌘G replaced a shell 1 s old). Waits until the shell is SHELL_SETTLE old.
const SHELL_SETTLE = 3000;
// kill a terminal process, but not while its shell may still be running rc files (see above)
function settleKill(p) {
  const wait = Math.max(0, SHELL_SETTLE - (Date.now() - (p.startedAt || 0)));
  setTimeout(() => { try { p.kill(); } catch {} }, wait);
}
const shellSettled = (s) => new Promise((r) => setTimeout(r, s?.host && s.hostAt ? Math.max(0, SHELL_SETTLE - (Date.now() - s.hostAt)) : 0));

async function startAgent(s, { cols, rows, resume = false }) {
  await s.opened;
  await shellSettled(s); // replacing the shell in the agent pane
  const fresh = await core.request("restart", { ws: s.id, kind: agents.stateOf(s.agent), cwd: s.cwd }); // the tab's folder again
  const env = { CVIM_TAB_ID: s.id, CVIM_STATE_DIR: STATE };
  if (ROOT) env.CVIM_ROOT = ROOT;
  if (s.agent === "claude") { const chain = userStatusline(); if (chain) env.CVIM_CHAIN_STATUSLINE = chain; }
  Object.assign(env, agents.agentEnv(s.agent)); // A2: the OpenCode plugin for this run (Gemini: extension)
  // tests: a stand-in instead of the real agent (keeps the agent's state adapter)
  const cmd = process.env.CVIM_DESKTOP_AGENT_CMD || agents.command(s.agent, { resume });
  s.startedAt = Date.now();
  s.resumed = resume;
  s.running = true;
  s.host = false;
  s.hostKey = null;
  s.size = { cols, rows };
  spawnPty({ id: `${s.id}:agent`, cmd, cwd: s.cwd, cols: num(cols), rows: num(rows), env });
  logLine(`agent-start ws=${s.id} ${s.agent} resume=${resume}`);
  saveSession();
  send("agent-state", { ws: tabOf(s).id, session: s.id, source: "agent", agent: agentInfo(s), ...fresh });
  return agentInfo(s);
}

// S2: the env of a CVIM shell — what an agent typed into it needs to report to CVIM: its id
// (Gemini's CVIM extension writes there) and the OpenCode plugin. Claude / Codex typed by hand are
// read from their own logs.
function shellEnv(id) {
  const env = { CVIM_TAB_ID: id, CVIM_STATE_DIR: STATE, ...agents.agentEnv("opencode") };
  if (ROOT) env.CVIM_ROOT = ROOT;
  return env;
}

// how CVIM follows an agent typed into a shell (no CVIM flags on its command line)
function typedKind(d) {
  if (d.state === "codex_log") return "codex_log";
  if (d.key === "claude") return "claude_log";
  if (d.key === "gemini" || d.key === "opencode") return agents.stateOf(d.key) === "hooks" ? "hooks" : "activity";
  return "activity";
}

// S2: the agent pane runs the user's shell until an agent is picked (⌘G) or typed into it
function startHost(s, { cols, rows }) {
  s.hostAt = Date.now();
  s.host = true;
  s.hostKey = null;
  s.running = false;
  s.resumed = false;
  spawnPty({ id: `${s.id}:agent`, shell: true, cwd: s.cwd, cols: num(cols), rows: num(rows), env: shellEnv(s.id) });
  core.request("set_state", { ws: s.id, state: "idle" }).catch(() => {});
  logLine(`host-shell ws=${s.id}`);
  saveSession();
}

// an agent typed into the host shell (or it ended): it is this session's agent now
async function setHostAgent(s, d, cwd = null) {
  s.hostKey = d?.key || null;
  s.running = !!d;
  if (d) {
    s.agent = d.key;
    agents.remember(s.cwd, d.key);
  }
  logLine(`host-agent ws=${s.id} ${d?.key || "-"}${cwd && cwd !== s.cwd ? ` cwd=${cwd}` : ""}`);
  saveSession();
  send("host-agent", { ws: tabOf(s).id, session: s.id, agent: d ? agentInfo(s) : null, where: d ? whereOf(tabOf(s), cwd) : null });
  if (d) {
    // its logs are where it runs (after a `cd`, not necessarily the tab's folder) — #3
    const fresh = await core.request("restart", { ws: s.id, kind: typedKind(d), cwd: cwd || s.cwd }).catch(() => null);
    if (fresh) send("agent-state", { ws: tabOf(s).id, session: s.id, source: "agent", agent: agentInfo(s), ...fresh });
  }
}

// a session of this workspace (none given: the first one)
function sessOf(ws, sid) {
  if (sid == null || sid === ws.id) return ws;
  const s = sessions.get(String(sid));
  if (!s || s.parent !== ws) throw new Error("no such session");
  return s;
}

// M1: one more agent session in the same folder (shares the partner, changes and shell panes)
function newSession(ws, agentKey) {
  ws.nextSession = (ws.nextSession || 1) + 1;
  const key = agentKey && agents.all()[agentKey] && agents.bin(agentKey) ? agentKey : ws.agent;
  const s = { id: `${ws.id}~s${ws.nextSession}`, n: ws.nextSession, parent: ws, cwd: ws.cwd, agent: key };
  s.opened = core.request("open", { ws: s.id, kind: agents.stateOf(key), cwd: ws.cwd, tabs: TABS });
  ws.sessions.push(s);
  sessions.set(s.id, s);
  logLine(`session-new ${s.id} ${key}`);
  saveSession();
  overlayUpdate();
  return { id: s.id, n: s.n, agent: agentInfo(s) };
}

function closeSession(ws, s) {
  if (s === ws) throw new Error("the first session closes with its tab");
  const p = ptys.get(`${s.id}:agent`);
  if (p) { ptys.delete(`${s.id}:agent`); settleKill(p); }
  ws.sessions = ws.sessions.filter((x) => x !== s);
  sessions.delete(s.id);
  core.request("close", { ws: s.id }).catch(() => {});
  logLine(`session-close ${s.id}`);
  ws.state = shownState(ws);
  saveSession();
  overlayUpdate();
}

// agent output -> core (per workspace at most every 200 ms; the core counts busy polls)
const outputTimers = new Map();
function outputSeen(wsId) {
  if (outputTimers.has(wsId) || !(sessions.has(wsId) || shellOf.has(wsId))) return;
  core.notify("output", { ws: wsId });
  outputTimers.set(wsId, setTimeout(() => outputTimers.delete(wsId), 200));
}

// events from cvim-core
// a tab's state for the overlay: the shell's agent while it sits in the big slot, otherwise the
// most urgent of its sessions (needs you → failed → working → finished → idle → asleep)
const URGENCY = (st) => (st === "waiting" ? 0 : st === "error" ? 1 : WORKING.includes(st) ? 2 : st === "done" ? 3 : st === "interrupted" ? 4 : st === "sleep" ? 6 : 5);
function shownState(ws) {
  if (ws.shell && ws.swapped) return ws.shell.state || "idle";
  return ws.sessions.map((x) => x.agentState || "idle").sort((a, b) => URGENCY(a) - URGENCY(b))[0] || "idle";
}

function onCoreEvent(msg) {
  // "<ws>~shell" = the agent started by hand in that tab's shell pane
  const fromShell = shellOf.has(msg.ws);
  const sess = fromShell ? null : sessions.get(msg.ws); // an agent session ("<ws>" or "<ws>~s<n>")
  const ws = fromShell ? workspaces.get(shellOf.get(msg.ws)) : sess && tabOf(sess);
  if (!ws) return;
  if (msg.event === "state") {
    if (fromShell) {
      if (!ws.shell || ws.shell.id !== msg.ws) return;
      ws.shell.state = msg.payload.state;
      send("agent-state", { ws: ws.id, source: "shell", shellKey: ws.shell?.key, ...msg.payload });
    } else {
      sess.agentState = msg.payload.state;
      send("agent-state", { ws: ws.id, session: sess.id, source: "agent", agent: agentInfo(sess), ...msg.payload });
    }
    if (ws.state !== shownState(ws)) { ws.state = shownState(ws); overlayUpdate(); }
  }
  if (msg.event === "transition") logLine(`transition ws=${msg.ws} agent=${fromShell ? ws.shell?.key : sess.agent} ${msg.from} -> ${msg.to}`); // diagnostics
  // how a turn ended (done / interrupted / error): the overlay shows it for a while
  if (msg.event === "transition" && ["done", "interrupted", "error"].includes(msg.to) && msg.from !== msg.to) {
    // which shell (several in the folder): the bubble says "셸 2 완료" — another shell's "입력 필요"
    // must not hide it
    ws.ended = { how: msg.to, at: Date.now(), n: sess && ws.sessions.length > 1 ? ws.sessions.indexOf(sess) + 1 : null };
    overlayUpdate();
    setTimeout(overlayUpdate, 15100); // the bubble goes away
  }
  if (msg.event === "transition" && msg.to === "done" && msg.from !== "done") {
    // an agent without events (any CLI, or one whose events never came): "done" was guessed from its
    // output — it still raises the partner, at half the pace (every other one), and brings no wild
    if (msg.guess) {
      ws.guessed = (ws.guessed || 0) + 1;
      logLine(`guessed done ws=${msg.ws} n=${ws.guessed}`);
      if (ws.guessed % 2) return;
    }
    // sometimes a wild Pokémon comes out (PLAN 3.6)
    const w = msg.guess ? null : wild.onDone(ws.id, { empty: !ws.partner });
    if (w) { logLine(`wild appeared ${w.id}${w.shiny ? "s" : ""} ws=${ws.id}`); broadcast("wild", w); overlayUpdate(); }
    // a finished task: EXP for the folder's partner, maybe an evolution
    const t0 = Date.now();
    partner.onDone(ws.cwd).then(({ evolved, from }) => {
      logLine(`exp ws=${ws.id} ${JSON.stringify(partner.progress(ws.cwd))} evolved=${evolved?.id ?? "-"} ${Date.now() - t0}ms`);
      if (evolved) { ws.partner = { ...evolved, ...partner.progress(ws.cwd) }; overlayUpdate(); }
      send("partner-progress", { ws: ws.id, ...partner.progress(ws.cwd), evolved: evolved || null, from: from || null });
    }).catch((e) => logLine(`exp error ${e}`));
  }
}

// ── session restore (E1): the open tabs, reopened on the next launch with their agents resuming
// (Claude --continue, Codex resume --last) — only when the app didn't end by the user's choice:
// a Mac shutdown / restart, a power loss or a crash. Quitting the app yourself (⌘Q, Dock "Quit")
// starts clean next time. The file is rewritten on every tab change (atomic), so it survives a
// sudden power-off. ───────────────────────────────────────────────────────────────────────
const SESSION = path.join(CACHE, "ui", "desktop_session.json");
const AGENTS_SEEN = path.join(CACHE, "ui", "agents_seen.json"); // the agent list was shown once
let quitting = false; // tabs closing because the app is ending: not "the user closed them"
let systemShutdown = false;
function writeSession(data) {
  mkdirPrivate(path.dirname(SESSION));
  const tmp = SESSION + ".tmp";
  const fd = fs.openSync(tmp, "w", 0o600);
  fs.writeSync(fd, JSON.stringify(data));
  fs.fsyncSync(fd); // on disk before a power loss
  fs.closeSync(fd);
  fs.renameSync(tmp, SESSION);
}
function saveSession() {
  if (quitting) return;
  const tabs = [...workspaces.values()].map((w) => w.cwd);
  const active = workspaces.get(activeWs)?.cwd || null;
  // more sessions per folder (M1): their agents, started fresh on restore (null: a shell)
  const extra = Object.fromEntries([...workspaces.values()].filter((w) => w.sessions?.length > 1).map((w) => [w.cwd, w.sessions.slice(1).map((x) => (x.running ? x.agent : null))]));
  // folders whose agent wasn't running: reopened as a shell (S2 shell first)
  const shell = [...workspaces.values()].filter((w) => !w.running).map((w) => w.cwd);
  writeSession({ tabs, active, sessions: extra, shell });
}

// a folder handed to the app (Dock icon drop, Finder "Open With", Dock recent item)
function requestOpen(dir) {
  if (!isDir(dir)) return;
  if (win && !win.isDestroyed() && win.webContents.isLoading() === false && uiReady) send("open-folder", { cwd: dir });
  else pendingOpen.push(dir);
}
let uiReady = false;

// ── changes panel (E1b): git status / diff / revert of the folder ─────────────
// git runs with an argument list (no shell); only paths from the folder's current change list
// can be shown or reverted; a new (untracked) file goes to the Trash instead of being deleted.
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 10000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (err, out, errOut) => resolve({ ok: !err, code: err?.code ?? 0, out: String(out), err: String(errOut) }));
  });
}

const lineCount = (file) => {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null; // binary
    return buf.length ? buf.toString("utf8").split("\n").length - (buf.at(-1) === 10 ? 1 : 0) : 0;
  } catch { return null; }
};

async function changesOf(ws) {
  const top = await git(ws.cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { repo: false };
  const root = top.out.trim();
  const head = (await git(ws.cwd, ["rev-parse", "--verify", "-q", "HEAD"])).ok;
  const st = await git(ws.cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  const items = [];
  const parts = st.out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2), rel = e.slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // the next entry is the old name
    const abs = path.join(root, rel);
    const status = xy === "??" ? "new" : xy.includes("D") ? "deleted" : xy.includes("A") ? "added" : xy[0] === "R" ? "renamed" : "modified";
    items.push({ abs, path: path.relative(ws.cwd, abs), status, xy, add: null, del: null });
  }
  // +/- lines: git for tracked files (vs HEAD), the file's lines for new ones
  if (head && items.some((x) => x.status !== "new")) {
    const num = await git(ws.cwd, ["diff", "--numstat", "-z", "HEAD", "--", "."]);
    const by = new Map(items.map((x) => [x.abs, x]));
    const f = num.out.split("\0");
    for (let i = 0; i < f.length; i++) {
      const m = f[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
      if (!m) continue;
      let rel = m[3];
      if (!rel) { i += 2; rel = f[i]; } // rename: old \0 new
      const x = by.get(path.join(root, rel));
      if (x) { x.add = m[1] === "-" ? null : Number(m[1]); x.del = m[2] === "-" ? null : Number(m[2]); x.binary = m[1] === "-"; }
    }
  }
  for (const x of items) if (x.status === "new" || (x.status === "added" && x.add == null)) { const n = lineCount(x.abs); x.add = n; x.del = 0; x.binary = n == null; }
  items.sort((a, b) => a.path.localeCompare(b.path));
  ws.changes = new Map(items.map((x) => [x.path, x]));
  return { repo: true, items: items.map(({ abs, ...x }) => x) };
}

async function changeDiff(ws, rel) {
  const x = ws.changes?.get(rel);
  if (!x) throw new Error("not in the change list");
  if (x.binary) return { binary: true };
  const head = (await git(ws.cwd, ["rev-parse", "--verify", "-q", "HEAD"])).ok;
  const r = x.status === "new" || (x.status === "added" && !head)
    ? await git(ws.cwd, ["diff", "--no-color", "--no-index", "--", "/dev/null", x.abs]) // exit 1 = differences
    : await git(ws.cwd, ["diff", "--no-color", "-U3", "HEAD", "--", x.abs]);
  if (!r.out && !r.ok && r.code !== 1) throw new Error(r.err.trim() || "git diff failed");
  return { diff: r.out.slice(0, 2_000_000), truncated: r.out.length > 2_000_000 };
}

// the Trash (tests: a scratch folder instead of the user's Trash)
async function toTrash(file) {
  if (TEST && process.env.CVIM_DESKTOP_TRASH_DIR) return fs.renameSync(file, path.join(process.env.CVIM_DESKTOP_TRASH_DIR, path.basename(file)));
  return shell.trashItem(file);
}

async function changeRevert(ws, rel) {
  const x = ws.changes?.get(rel);
  if (!x) throw new Error("not in the change list");
  const { inside } = await core.request("path_inside", { root: ws.cwd, path: x.abs });
  if (!inside) throw new Error("outside the folder");
  if (x.status === "new") {
    await toTrash(x.abs); // never delete: the Trash can bring it back
  } else if (x.status === "added") {
    await git(ws.cwd, ["rm", "--cached", "-q", "--", x.abs]);
    if (fs.existsSync(x.abs)) await toTrash(x.abs);
  } else {
    const r = await git(ws.cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", x.abs]);
    if (!r.ok) throw new Error(r.err.trim() || "git restore failed");
  }
  logLine(`changes revert ws=${ws.id} ${x.status} ${rel}`);
  return { ok: true, status: x.status };
}

// ── an agent started by hand in the shell pane (P0+) ────────────────────────
// The shell pane's foreground process is checked every 1.5 s (`ps -t <its tty>`); when it's a known
// agent the UI swaps that pane into the big slot, and back when it exits. Only names and the
// command's first words are looked at, nothing is kept.
function agentOf(args) {
  const words = String(args).trim().split(/\s+/).slice(0, 2).map((w) => path.basename(w));
  for (const d of Object.values(agents.all())) {
    const names = [d.key, ...(d.cmd || []).map((c) => path.basename(c))];
    if (words.some((w) => names.includes(w))) return d;
  }
  return null;
}

function foreground(p) {
  return new Promise((resolve) => {
    const tty = String(p.ptsName || "").replace(/^\/dev\//, "");
    if (!tty) return resolve(null);
    execFile("ps", ["-t", tty, "-o", "pid=,stat=,args="], { timeout: 2000 }, (err, out) => {
      if (err) return resolve(null);
      // the job in front: "+" in the state column (the shell itself waits in the background)
      const line = String(out).split("\n").map((l) => l.trim()).find((l) => /^\d+\s+\S*\+/.test(l));
      const m = line && line.match(/^(\d+)\s+\S+\s+(.*)$/);
      resolve(m ? { pid: Number(m[1]), args: m[2] } : null);
    });
  });
}

// the folders a pane's relative paths are from (#26): the program in front (an agent after `cd`),
// the shell, the tab — looked up at most every 2 s per pane
const dirsCache = new Map();
async function paneDirs(id, cwd) {
  const hit = dirsCache.get(id);
  if (hit && Date.now() - hit.at < 2000) return hit.dirs;
  const p = ptys.get(String(id)), dirs = [];
  if (p) {
    const fg = await foreground(p);
    for (const pid of [fg?.pid, p.pid]) { const d = pid && (await procCwd(pid)); if (d && !dirs.includes(d)) dirs.push(d); }
  }
  if (cwd && !dirs.includes(cwd)) dirs.push(String(cwd));
  dirsCache.set(id, { at: Date.now(), dirs });
  return dirs;
}
// the editor ⌘-clicked files open in: the first one installed
function editorApp() {
  for (const [name, scheme] of [["Visual Studio Code", "vscode"], ["Cursor", "cursor"], ["Zed", "zed"]]) {
    if ([`/Applications/${name}.app`, path.join(HOME, `Applications/${name}.app`)].some((a) => fs.existsSync(a))) return scheme;
  }
  return "text";
}

// where a process runs (an agent typed after `cd`): its working directory, from lsof
function procCwd(pid) {
  return new Promise((resolve) => {
    execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 2000 }, (err, out) => {
      const line = String(out || "").split("\n").find((l) => l.startsWith("n/"));
      resolve(line ? line.slice(1) : null);
    });
  });
}
// the agent's folder against the tab's: inside (a subfolder, rel) or outside (another project)
function whereOf(ws, cwd) {
  if (!cwd) return null;
  let base = ws.cwd;
  try { base = fs.realpathSync(ws.cwd); } catch {} // lsof gives the real path (/private/tmp, symlinks)
  const rel = path.relative(base, cwd);
  if (!rel) return null;
  const outside = rel.startsWith("..") || path.isAbsolute(rel);
  return { cwd, rel: outside ? null : rel, outside, label: path.basename(cwd), full: cwd.split(HOME).join("~") };
}

let scanning = false;
async function scanShells() {
  if (scanning) return;
  scanning = true;
  try { await scanAll(); } finally { scanning = false; }
}
async function scanAll() {
  for (const ws of [...workspaces.values()]) {
    const p = ptys.get(`${ws.id}:shell`);
    const fg = p ? await foreground(p) : null;
    const d = fg ? agentOf(fg.args) : null;
    if ((d?.key || null) !== (ws.shell?.key || null) && workspaces.has(ws.id)) setShellAgent(ws, d, d && (await procCwd(fg.pid)));
  }
  // S2: agent panes running a shell
  for (const s of [...sessions.values()]) {
    if (!s.host) continue;
    const p = ptys.get(`${s.id}:agent`);
    const fg = p ? await foreground(p) : null;
    const d = fg ? agentOf(fg.args) : null;
    if ((d?.key || null) !== (s.hostKey || null) && s.host && sessions.has(s.id)) await setHostAgent(s, d, d && (await procCwd(fg.pid)));
  }
}

// its state is tracked like the agent pane's, as "<ws>~shell" in the core: Codex by its session
// log, Claude by its conversation log (A2), others by output
const shellOf = new Map(); // "<ws>~shell" -> ws id
function setShellAgent(ws, d, cwd = null) {
  if (ws.shell) {
    core.request("close", { ws: ws.shell.id }).catch(() => {});
    shellOf.delete(ws.shell.id);
    ws.shell = null;
  }
  if (d) {
    const id = `${ws.id}~shell`;
    ws.shell = { id, key: d.key, state: "idle" };
    shellOf.set(id, ws.id);
    // Codex: its session log; Claude (started by hand, no CVIM hooks): its conversation log (A2);
    // others: output
    // its logs are where it runs (after a `cd`, not necessarily the tab's folder) — #3
    core.request("open", { ws: id, kind: typedKind(d), cwd: cwd || ws.cwd, tabs: TABS }).catch((e) => logLine(`shell core error ${e}`));
    agents.remember(ws.cwd, d.key); // ⌘G offers it first next time
  }
  logLine(`shell-agent ws=${ws.id} ${d?.key || "-"}${cwd && cwd !== ws.cwd ? ` cwd=${cwd}` : ""}`);
  ws.state = shownState(ws);
  overlayUpdate();
  send("shell-agent", { ws: ws.id, agent: d && { key: d.key, name: d.name, icon: d.icon, label: agents.label(d.key) }, where: d ? whereOf(ws, cwd) : null });
}

// ── desktop overlay ─────────────────────────────────────────────────────────
// A small always-on-top window (transparent, never takes focus) that shows up while you're in
// another app: the current tab's partner, tabs that are working / need you / just finished, and
// wild encounters. Click → back to that tab; drag → move (position remembered).
const OVERLAY_POS = path.join(CACHE, "ui", "desktop_overlay.json");
// the window is sized to its cards (overlay_fit) and anchored at its bottom-right corner: a big
// see-through window would stop the cards short of the screen top (macOS keeps windows below the
// menu bar). Starts at OVERLAY_W × OVERLAY_H until the page measures itself.
const OVERLAY_W = 300, OVERLAY_H = 420;
const MINI_MAX = 6;
let overlayCollapsed = !!readJsonSafe(OVERLAY_POS)?.collapsed; // double-click: only the partner
const WORKING = ["thinking", "coding", "reading", "searching", "bash", "agent", "tool", "compact"];

function overlayPayload() {
  const now = Date.now();
  const tabs = [...workspaces.values()].map((ws) => ({
    ws: ws.id, name: path.basename(ws.cwd), state: ws.state || "idle", active: ws.id === activeWs, sessions: ws.sessions?.length || 1,
    ended: ws.ended && now - ws.ended.at < 15000 ? ws.ended.how : null,
    endedN: ws.ended && now - ws.ended.at < 15000 ? ws.ended.n : null,
    partner: ws.partner && { name: ws.partner.name, shiny: ws.partner.shiny, gif: ws.partner.gif, types: ws.partner.types },
  }));
  // big cards: the current tab + the one that needs you most (needs input → failed → just
  // finished); every other tab is a small icon in a row (PLAN 7.8 order: needs you → working → done)
  const urgency = (t) => (t.state === "waiting" ? 1 : t.ended === "error" ? 2 : t.ended ? 3 : 9);
  const current = tabs.find((t) => t.active) || null;
  const urgent = overlayCollapsed ? null
    : tabs.filter((t) => !t.active && urgency(t) < 9).sort((a, b) => urgency(a) - urgency(b))[0] || null;
  const order = (t) => (t.state === "waiting" ? 0 : t.ended === "error" ? 1 : WORKING.includes(t.state) ? 2 : t.ended ? 3 : 4);
  const rest = tabs.filter((t) => t !== current && t !== urgent).sort((a, b) => order(a) - order(b));
  const count = (f) => tabs.filter(f).length;
  return {
    current, urgent, collapsed: overlayCollapsed,
    minis: overlayCollapsed ? [] : rest.slice(0, MINI_MAX), more: overlayCollapsed ? 0 : Math.max(0, rest.length - MINI_MAX),
    counts: { waiting: count((t) => t.state === "waiting"), working: count((t) => WORKING.includes(t.state)),
      done: count((t) => t.ended === "done"), error: count((t) => t.ended === "error") },
    wild: wild.current(),
  };
}

let overlayTimer = null;
function overlayUpdate() {
  if (!overlay || overlay.isDestroyed() || overlayTimer) return;
  overlayTimer = setTimeout(() => {
    overlayTimer = null;
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send("host-event", { event: "overlay", payload: overlayPayload() });
  }, 50);
}

function overlayBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const saved = readJsonSafe(OVERLAY_POS) || {};
  // saved bottom-right corner ({ x, y } = top-left of the old fixed-size window)
  let right = saved.right ?? (Number.isFinite(saved.x) ? saved.x + OVERLAY_W : NaN);
  let bottom = saved.bottom ?? (Number.isFinite(saved.y) ? saved.y + OVERLAY_H : NaN);
  if (!Number.isFinite(right) || !Number.isFinite(bottom)) { right = wa.x + wa.width - 16; bottom = wa.y + wa.height - 16; }
  // keep the corner on a screen that still exists
  const d = screen.getDisplayNearestPoint({ x: Math.round(right) - 1, y: Math.round(bottom) - 1 }).workArea;
  right = Math.min(Math.max(right, d.x + 80), d.x + d.width);
  bottom = Math.min(Math.max(bottom, d.y + 80), d.y + d.height);
  return { x: Math.round(right - OVERLAY_W), y: Math.round(bottom - OVERLAY_H), width: OVERLAY_W, height: OVERLAY_H };
}

function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

function createOverlay() {
  overlay = new BrowserWindow({
    // panel: an NSPanel-style non-activating window — clicking / dragging it doesn't bring the
    // app forward (a normal window activated the app on mouse-down and the drag never arrived);
    // it also shows on every desktop and over full-screen apps
    type: "panel",
    ...overlayBounds(), show: false, frame: false, transparent: true, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, fullscreenable: false, minimizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false,
    },
  });
  overlay.setAlwaysOnTop(true, "floating");
  // skipTransformProcessType: otherwise macOS turns the whole app into a UIElement (no Dock icon,
  // main window never comes to the front)
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  overlay.on("hide", () => { drag = null; }); // a drag never outlives the overlay
  overlay.setIgnoreMouseEvents(true, { forward: true }); // see-through until the pointer is on a card
  overlay.webContents.on("will-navigate", (e) => e.preventDefault());
  overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  overlay.loadFile(path.join(DIST, "overlay.html"));
}

// shown while another app is in front (and there's something to show)
function overlaySync() {
  if (!overlay || overlay.isDestroyed()) return;
  const away = !BrowserWindow.getFocusedWindow();
  if ((away || overlayForced) && workspaces.size) {
    overlayUpdate();
    if (!overlay.isVisible()) overlay.showInactive();
  } else if (overlay.isVisible()) overlay.hide();
}
let overlayForced = false; // tests

function focusMain(wsId) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (QUIET_TEST) { win.showInactive(); if (wsId && workspaces.has(wsId)) send("select-tab", { ws: wsId }); return; }
  win.show();
  app.focus({ steal: true });
  win.focus();
  if (wsId && workspaces.has(wsId)) send("select-tab", { ws: wsId });
}

// what the overlay page may ask for (nothing that runs or reads anything else)
let drag = null;
const overlayCommands = {
  overlay_state: () => overlayPayload(),
  overlay_click({ ws }) { focusMain(String(ws)); },
  // "📕 도감에서 보기" on the overlay's wild card: Tamer in front (keyboard included), its Pokédex on it
  wild_dex({ id }) { focusMain(); send("open-dex", { id: Number(id) || null }); logLine("wild dex from overlay"); },
  // the cards' size: shrink / grow the window around them, bottom-right corner fixed
  overlay_fit({ width, height }) {
    if (drag) return;
    const w = Math.round(Math.min(Math.max(Number(width) || 0, 40), 400));
    const h = Math.round(Math.min(Math.max(Number(height) || 0, 40), 900));
    const b = overlay.getBounds();
    if (b.width === w && b.height === h) return;
    overlay.setBounds({ x: b.x + b.width - w, y: b.y + b.height - h, width: w, height: h });
  },
  overlay_collapse() {
    overlayCollapsed = !overlayCollapsed;
    const [wx, wy] = overlay.getPosition(), [w, h] = overlay.getSize();
    writeFile(OVERLAY_POS, JSON.stringify({ right: wx + w, bottom: wy + h, collapsed: overlayCollapsed }));
    overlayUpdate();
  },
  overlay_mouse({ over }) { overlay.setIgnoreMouseEvents(!over, { forward: true }); },
  // drag by the cards: start → move (screen coordinates of the pointer) → end (save)
  overlay_drag({ phase, x, y }) {
    x = Math.round(Number(x)); y = Math.round(Number(y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const [wx, wy] = overlay.getPosition();
    if (phase === "start") drag = { dx: x - wx, dy: y - wy };
    else if (phase === "move" && drag) overlay.setPosition(x - drag.dx, y - drag.dy);
    else if (phase === "end" && drag) {
      drag = null;
      const [w, h] = overlay.getSize();
      writeFile(OVERLAY_POS, JSON.stringify({ right: wx + w, bottom: wy + h, collapsed: overlayCollapsed }));
    }
  },
  sprite_b64: (args) => commands.sprite_b64(args),
  wild_throw: (args) => commands.wild_throw(args),
};

// ── commands from the UI ────────────────────────────────────────────────────
// What the UI may ask for. The UI never names a program: the main process decides what runs in
// each pane, and folders must be real directories (POLICY.md 11). A compromised page can't do more.
const commands = {
  app_info() {
    uiReady = true;
    const start = TEST && process.env.CVIM_DESKTOP_DIRS ? process.env.CVIM_DESKTOP_DIRS.split(":")
      : process.env.CVIM_DESKTOP_DIR ? [process.env.CVIM_DESKTOP_DIR] : [];
    const handed = [...start, ...pendingOpen.splice(0)].filter(isDir);
    // nothing handed to the app: reopen last time's tabs (session restore)
    const saved = readJsonSafe(SESSION);
    const sess = !start.length && !process.env.CVIM_DESKTOP_NO_RESTORE && !saved?.quit ? saved : null;
    const restored = sess?.tabs?.filter(isDir) || [];
    const open = [...new Set([...restored, ...handed])];
    return {
      home: HOME, shell: agents.userShell(), recent: recentDirs(), open,
      restored: restored.length ? { tabs: restored, active: sess.active, sessions: sess.sessions || {}, shell: sess.shell || [] } : null,
      // a new folder opens as a shell; the agent starts with ⌘G (or typed in the shell). Tests and
      // CVIM_DESKTOP_AUTOSTART=1: the agent starts right away like before
      autostart: !!process.env.CVIM_DESKTOP_AUTOSTART,
      log: !!process.env.CVIM_DESKTOP_LOG, // diagnostics: IME event log
      test: TEST ? {
        perf: !!process.env.CVIM_DESKTOP_PERF,
        shell_input: process.env.CVIM_DESKTOP_SHELL_INPUT || null, // typed into the shell pane
        ime_text: process.env.CVIM_DESKTOP_IME_TEXT || null, // composing text after shell_input
        switch_test: !!process.env.CVIM_DESKTOP_SWITCH_TEST, // compose in the agent pane, then ⌘G
        sec_test: !!process.env.CVIM_DESKTOP_SECTEST, // try what a hostile page would
        tabs_test: !!process.env.CVIM_DESKTOP_TABS_TEST, // drive tabs: switch, re-open, close
        poke_test: !!process.env.CVIM_DESKTOP_POKE_TEST, // partner: reactions, menu, Pokédex, evolution
        wild_test: !!process.env.CVIM_DESKTOP_WILD_TEST, // wild encounters, catching, overlay
        p0_test: !!process.env.CVIM_DESKTOP_P0_TEST, // turn results, shell agent → big slot
        x1e_test: !!process.env.CVIM_DESKTOP_X1E_TEST, // choosing a partner, compact overlay
        e1_test: !!process.env.CVIM_DESKTOP_E1_TEST, // composer, image paste, drop, font, menu
        e1b_test: !!process.env.CVIM_DESKTOP_E1B_TEST, // changes panel, diff, revert
        m1_test: !!process.env.CVIM_DESKTOP_M1_TEST, // several sessions in one folder
        m2_test: !!process.env.CVIM_DESKTOP_M2_TEST, // handing text between sessions
        a2_test: !!process.env.CVIM_DESKTOP_A2_TEST, // shell Claude via its conversation log
        s2_test: !!process.env.CVIM_DESKTOP_S2_TEST, // shell first, ⌘G picker
        s2x_test: !!process.env.CVIM_DESKTOP_S2X_TEST, // agents ending in sessions
        u1_test: !!process.env.CVIM_DESKTOP_U1_TEST, // usage before the first reply, shell Claude's model/ctx
        s3_test: !!process.env.CVIM_DESKTOP_S3_TEST, // Gemini / OpenCode typed into the shells
        agents_test: !!process.env.CVIM_DESKTOP_AGENTS_TEST, // the agent connection list
        dexnav_test: !!process.env.CVIM_DESKTOP_DEXNAV_TEST, // arrows in the "새로 잡은" row (#17)
        links_test: !!process.env.CVIM_DESKTOP_LINKS_TEST, // ⌘-click links (#19)
        dexsearch_test: !!process.env.CVIM_DESKTOP_DEXSEARCH_TEST, // dex search terms (#21)
        cost_test: !!process.env.CVIM_DESKTOP_COST_TEST, // ≈$ for a Claude typed in the shell (#23)
        box_test: !!process.env.CVIM_DESKTOP_BOX_TEST, // "내 포켓몬" (#27)
        keys_test: !!process.env.CVIM_DESKTOP_KEYS_TEST, // ⇧↵ / ⌘⌫ bytes (#7 #8)
        diag_test: !!process.env.CVIM_DESKTOP_DIAG_TEST, // diagnostics with nested folders open (#6)
        multi_test: !!process.env.CVIM_DESKTOP_MULTI_TEST, // a shell finishing while another needs you
        cd_test: !!process.env.CVIM_DESKTOP_CD_TEST, // agents typed after a cd (#3)
        tour_test: !!process.env.CVIM_DESKTOP_TOUR_TEST, // README screenshots (no Pokémon on screen)
        race_test: !!process.env.CVIM_DESKTOP_RACE_TEST, // ⌘G while the big shell is starting
        pick_test: !!process.env.CVIM_DESKTOP_PICK_TEST, // time to the picker
        fake_bin: process.env.CVIM_DESKTOP_FAKE_BIN || null,
        fake_claude: process.env.CVIM_DESKTOP_FAKE_CLAUDE || null,
        drop_files: process.env.CVIM_DESKTOP_DROP_FILES ? process.env.CVIM_DESKTOP_DROP_FILES.split(":") : null,
        newuser_test: !!process.env.CVIM_DESKTOP_NEWUSER_TEST, // empty box: starter, empty folders, wild bonus
      } : {},
    };
  },
  recent_dirs: () => recentDirs(),
  workspace_open({ cwd }) { return openWorkspace(String(cwd)); },
  workspace_close({ ws }) { closeWorkspace(String(ws)); },
  async choose_folder() {
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], message: "Tamer에서 열 폴더를 선택하세요" });
    return r.canceled ? null : r.filePaths[0];
  },
  // the shell pane: the command is fixed here (the agent pane uses agent_start)
  pane_start({ ws: id, kind, cols, rows }) {
    const ws = wsOf(id);
    if (kind !== "shell") throw new Error(`no such pane: ${kind}`);
    const perf = TEST && process.env.CVIM_DESKTOP_PERF;
    spawnPty({ id: `${ws.id}:${kind}`, ...(perf ? { cmd: "seq 1 300000" } : { shell: true }), cwd: ws.cwd, cols: num(cols), rows: num(rows), env: shellEnv(`${ws.id}~shell`) });
  },
  pty_write({ id, data }) {
    const p = ptys.get(String(id));
    if (!p) return;
    p.write(String(data));
    // Esc / Ctrl-C into the agent: Claude has no interrupt hook, the core watches for silence after it
    const [wsId, kind] = String(id).split(":");
    if (kind === "agent" && (data === "\x1b" || data === "\x03") && sessions.has(wsId)) core.notify("esc", { ws: wsId });
  },
  pty_resize({ id, cols, rows }) { const p = ptys.get(String(id)); if (p) p.resize(num(cols), num(rows)); },
  copy_text({ text }) { clipboard.writeText(String(text)); },
  // partner sprite GIFs only (from the cvim cache)
  async sprite_b64({ path: p }) {
    // the path policy lives in the Rust core (symlinks / `..` resolved there)
    const { inside, real } = await core.request("path_inside", { root: path.join(CACHE, "pokemon"), path: String(p) });
    if (!inside || !real.endsWith(".gif")) throw new Error("not a sprite");
    return fs.readFileSync(real).toString("base64");
  },
  log_line({ line }) { logLine(String(line)); },
  agent_start({ ws, session, cols, rows, resume }) { return startAgent(sessOf(wsOf(ws), session), { cols, rows, resume: !!resume }); },
  // M1 sessions: one more agent in this folder / close one (not the first: it closes with the tab)
  session_new({ ws, agent }) { return newSession(wsOf(ws), agent ? String(agent) : null); },
  session_close({ ws, session }) { const w = wsOf(ws); closeSession(w, sessOf(w, session)); },
  // files / folders dropped on a pane: their paths typed into the pane (shell-escaped like iTerm;
  // Claude turns image paths into attachments). Folders dropped on the tab bar / start screen
  // open as tabs instead (UI → workspace_open).
  drop_paths({ ws: id, pane, paths }) {
    const ws = wsOf(id);
    if (!KINDS.includes(pane)) throw new Error("bad pane");
    const list = (Array.isArray(paths) ? paths : []).map(String).filter((p) => path.isAbsolute(p) && fs.existsSync(p));
    const p = ptys.get(`${ws.id}:${pane}`);
    if (p && list.length) p.write(`\x1b[200~${list.map(shellEscape).join(" ")} \x1b[201~`);
    return { folders: 0, files: list.length };
  },
  // 📝 changes panel (E1b): what changed in the folder (git), a file's diff, revert one file
  changes_list({ ws }) { return changesOf(wsOf(ws)); },
  changes_diff({ ws, path: p }) { return changeDiff(wsOf(ws), String(p)); },
  changes_revert({ ws, path: p }) { return changeRevert(wsOf(ws), String(p)); },
  // "에이전트 연결" (⌘G → last item, first launch): each agent — found where, how much CVIM sees
  agents_status() { return { list: agents.status(), seen: !!readJsonSafe(AGENTS_SEEN) }; },
  agents_seen() { writeFile(AGENTS_SEEN, JSON.stringify({ at: Date.now() })); },
  // Gemini: link CVIM's extension (asks first; `gemini extensions link --consent` — an older link
  // to another copy is replaced)
  async agent_fix({ key }) {
    if (key !== "gemini") throw new Error("nothing to fix");
    const ext = ROOT && path.join(ROOT, "agents", "gemini-extension");
    const gem = agents.where("gemini");
    if (!ext || !fs.existsSync(ext) || !gem) return { ok: false, msg: "Gemini CLI 또는 확장 파일을 찾지 못했어요" };
    const r = await dialog.showMessageBox(win, {
      type: "question", buttons: ["연결", "취소"], defaultId: 0, cancelId: 1,
      message: "Gemini CLI에 Tamer 확장을 연결할까요?",
      detail: `Gemini가 생각 중·도구·완료를 Tamer에 알려 줍니다. Tamer 안에서 띄운 Gemini에서만 기록하고, 다른 곳에서 쓰는 Gemini에는 영향이 없어요.\n\n실행: gemini extensions link --consent ${ext}\n해제: gemini extensions uninstall cvim`,
    });
    if (r.response !== 0) return { ok: false, cancelled: true };
    const run = (args) => new Promise((resolve) => execFile(gem, args, { env: agents.processEnv(), timeout: 30000 },
      (err, out, errOut) => resolve({ ok: !err, out: String(out) + String(errOut) })));
    if (agents.geminiLinked()) await run(["extensions", "uninstall", "cvim"]);
    const res = await run(["extensions", "link", "--consent", ext]);
    logLine(`gemini link ok=${res.ok}`);
    return { ok: res.ok && agents.geminiLinked(), msg: res.ok ? "연결했어요 — 다음에 띄우는 Gemini부터 적용" : res.out.trim().split("\n").slice(-2).join(" ") };
  },
  // #3: an agent typed after `cd` into another folder moves — still running — into that folder's tab
  // (`to`, its session `toSession`): the terminal process is handed over, the source shell/session
  // gets its own folder back (the UI starts a fresh shell there). Its hook log keeps the source id.
  async pty_move({ from, pane, session, to, toSession }) {
    const src = wsOf(from), dst = wsOf(to), t = sessOf(dst, toSession);
    const s = pane === "shell" ? null : sessOf(src, session);
    const fromId = pane === "shell" ? `${src.id}:shell` : `${s.id}:agent`;
    const key = pane === "shell" ? src.shell?.key : s.hostKey;
    const p = ptys.get(fromId);
    if (!p || !key) throw new Error("no agent to move");
    const coreFrom = pane === "shell" ? src.shell.id : s.id;
    // the target's fresh shell makes way (once its rc files ran)
    await shellSettled(t);
    // its tracking moves along as it is (adapter, read position, hook log under its old id)
    const moved = await core.request("move", { from: coreFrom, to: t.id }).catch(() => null);
    // the source starts over with its own folder (the UI starts a fresh shell there)
    if (pane === "shell") { if (src.shell) { shellOf.delete(src.shell.id); src.shell = null; } send("shell-agent", { ws: src.id, agent: null, where: null }); }
    else {
      s.hostKey = null;
      s.running = false;
      await core.request("open", { ws: s.id, kind: "activity", cwd: s.cwd, tabs: TABS }).catch(() => {});
    }
    const old = ptys.get(`${t.id}:agent`);
    ptys.delete(fromId);
    p.cvimId = `${t.id}:agent`;
    ptys.set(p.cvimId, p);
    if (old && old !== p) { try { old.kill(); } catch {} }
    t.host = true;
    t.hostKey = key;
    t.running = true;
    t.agent = key;
    agents.remember(t.cwd, key);
    const fresh = moved;
    logLine(`pty-move ${fromId} -> ${p.cvimId} ${key}`);
    saveSession();
    send("host-agent", { ws: dst.id, session: t.id, agent: agentInfo(t), where: null });
    if (fresh) send("agent-state", { ws: dst.id, session: t.id, source: "agent", agent: agentInfo(t), ...fresh });
    return { agent: agentInfo(t), id: p.cvimId };
  },
  // official install pages only
  // file paths in a terminal (#26): which of these candidates are files / folders, from the pane's
  // folders (the program in front, the shell, the tab). Only existence is checked, nothing is read
  async file_links({ id, cwd, cands }) {
    const bases = await paneDirs(id, cwd);
    return (Array.isArray(cands) ? cands.slice(0, 40) : []).map((c) => {
      const p = String(c || "");
      if (!p || p.length > 400) return null;
      const tries = p.startsWith("/") ? [p] : p.startsWith("~/") ? [path.join(HOME, p.slice(2))] : bases.map((b) => path.resolve(b, p));
      for (const abs of tries) {
        try { const st = fs.statSync(abs); return { abs, dir: st.isDirectory() }; } catch {}
      }
      return null;
    });
  },
  // ⌘-click on a file path (#26): a file in the editor at its line (VS Code → Cursor → Zed → the
  // default text editor), a folder in Finder. Never runs anything. Tests only log it
  open_file({ abs, line, col }) {
    const p = String(abs || "");
    let st;
    try { st = fs.statSync(p); } catch { throw new Error("no such file"); }
    const ln = Math.max(1, Number(line) || 1), cl = Math.max(1, Number(col) || 1);
    const editor = st.isDirectory() ? "finder" : editorApp();
    logLine(`open file (${editor})`); // not the path: the log goes into the diagnostics
    if (TEST) { linksOpened.push(`${editor}:${p}:${ln}:${cl}`); return; }
    if (editor === "finder") return shell.openPath(p);
    if (editor === "text") return execFile("open", ["-t", p]);
    return shell.openExternal(`${editor}://file${encodeURI(p)}:${ln}:${cl}`);
  },
  // ⌘-click on a link in a terminal (#19): web pages only, in the user's browser. Tests only log it
  open_link({ url }) {
    let u;
    try { u = new URL(String(url)); } catch { throw new Error("not a link"); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("only web links");
    logLine("open link"); // not the address: the log goes into the diagnostics
    if (TEST) { linksOpened.push(u.href); return; }
    return shell.openExternal(u.href);
  },
  open_url({ url }) {
    if (!Object.values(agents.INSTALL).some((i) => i.url === url)) throw new Error("not an install page");
    return shell.openExternal(url);
  },
  // ⌘G picker: every agent, whether it's installed, which one this session has / runs
  agents_list({ ws: id, session }) {
    const s = sessOf(wsOf(id), session);
    const list = Object.values(agents.all()).map((d) => ({ key: d.key, name: d.name, short: d.short, icon: d.icon, color: d.color, label: agents.label(d.key), installed: !!agents.bin(d.key) }));
    return { current: s.agent, running: !!s.running, typed: s.hostKey, last: agents.chosen(s.cwd), list };
  },
  // S2: the agent pane runs a shell (a new folder, or after its agent ended)
  host_shell({ ws: id, session, cols, rows }) { startHost(sessOf(wsOf(id), session), { cols, rows }); },
  // ⌘G picker: start this agent in the session (replaces a running one), remembered for the folder
  agent_pick({ ws: id, session, agent, cols, rows }) {
    const ws = wsOf(id), s = sessOf(ws, session), key = String(agent);
    if (!agents.all()[key] || !agents.bin(key)) throw new Error("agent not installed");
    s.agent = key;
    agents.remember(ws.cwd, key);
    return startAgent(s, { cols, rows });
  },
  // ⌘G (old: the next available agent), remembered for this folder
  agent_switch({ ws: id, session, cols, rows }) {
    const ws = wsOf(id), s = sessOf(ws, session);
    s.agent = agents.next(s.agent);
    agents.remember(ws.cwd, s.agent);
    saveSession();
    return startAgent(s, { cols, rows });
  },
  async agent_state({ ws: id, session }) {
    const ws = wsOf(id), s = sessOf(ws, session);
    const payload = await core.request("snapshot", { ws: s.id });
    send("agent-state", { ws: ws.id, session: s.id, source: "agent", agent: agentInfo(s), ...payload });
  },
  // the partner now (the first answer can be stale: taken / given away since)
  async partner_state({ ws: id }) {
    const ws = wsOf(id);
    await ws.partnerReady;
    return ws.partner ? { ws: id, ...ws.partner } : { ws: id, choose: true };
  },
  // 🎲 / 📕 / 📌 (right-click menu, Pokédex)
  // the choose dialog: what can become this folder's partner (starters load meanwhile)
  partner_options({ ws }) {
    const o = partner.options(wsOf(ws).cwd);
    if (o.starter && !o.starter.ready) loadStarter();
    return { ...o, starterLoading: !!starterLoading };
  },
  // { starter: id } | { uid } — the rules are checked in partner.take
  partner_take({ ws, starter, uid }) { return partnerTake(wsOf(ws), starter != null ? { starter } : { uid }); },
  dex_list: () => partner.dex(),
  // model prices for an estimated cost (#23), fetched only when asked (an agent without its own cost)
  prices: () => prices.get(),
  dex_viewed: ({ id }) => partner.viewed(id),
  box_list: ({ ws }) => partner.boxList(ws && workspaces.has(ws) ? wsOf(ws).cwd : null), // "내 포켓몬" (#27)
  // the tab on screen (the overlay shows its partner first)
  // the UI swapped the agent / shell panes (which one is in the big slot)
  pane_swap({ ws: id, on }) {
    const ws = wsOf(id);
    ws.swapped = !!on;
    ws.state = shownState(ws);
    overlayUpdate();
  },
  tab_active({ ws }) { activeWs = workspaces.has(String(ws)) ? String(ws) : null; overlayUpdate(); saveSession(); },
  // 🌿 wild encounters
  wild_state: () => ({ enabled: wild.enabled(), current: wild.current() }),
  wild_toggle() { const on = wild.setEnabled(!wild.enabled()); overlayUpdate(); return on; },
  wild_throw({ token }) {
    const r = wild.throwBall(String(token));
    logLine(`wild throw ${r.result} shakes=${r.shakes}`);
    if (r.result !== "gone") broadcast("wild-throw", r);
    return r;
  },
};

const testCommands = {
  // put the focused element into IME composition (as if typing Hangul) via DevTools protocol
  async ime_compose({ text }) {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    await dbg.sendCommand("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  },
  // tests: the IME commits the composition (what happens on the next key / focus change)
  async ime_commit({ text }) {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    await dbg.sendCommand("Input.insertText", { text });
  },
  links_opened_test: () => linksOpened.splice(0),
  // the overlay's "도감에서 보기" (#25), as if pressed there
  wild_dex_test({ id }) { overlayCommands.wild_dex({ id }); },
  // a mouse click at a point in the window (modifiers: 4 = ⌘) (#19)
  async click_test({ x, y, modifiers = 0 }) {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
    await new Promise((r) => setTimeout(r, 120)); // the link under the pointer is looked up on move
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, modifiers, button: "left", clickCount: 1 });
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, modifiers, button: "left", clickCount: 1 });
  },
  // a key as from the keyboard (modifiers: 8 = ⇧, 4 = ⌘) to the focused element (#7 #8 keys test)
  async key_test({ key, code, keyCode, modifiers = 0, text, commands }) {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    // commands: the macOS editing command the key would run (moveToBeginningOfLine …)
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers, ...(commands ? { commands } : {}) };
    await dbg.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    if (text) await dbg.sendCommand("Input.dispatchKeyEvent", { type: "char", ...base, text, unmodifiedText: text });
    await dbg.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  },
  // the IME commits a syllable and the key that did it arrives right after (#15)
  async ime_commit_key_test({ text, ...k }) {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers || 0, ...(k.commands ? { commands: k.commands } : {}) };
    await Promise.all([
      dbg.sendCommand("Input.insertText", { text }),
      dbg.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }),
      ...(k.text ? [dbg.sendCommand("Input.dispatchKeyEvent", { type: "char", ...base, text: k.text, unmodifiedText: k.text })] : []),
      dbg.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...base }),
    ]);
  },
  // type into a pane as if from the keyboard
  pty_write_test({ id, data }) { const p = ptys.get(id); if (p) p.write(data); },
  // the workspace ids the core knows about (tabs test: closed tabs must be gone)
  workspaces_test() { return [...workspaces.keys(), ...[...sessions.keys()].filter((k) => !workspaces.has(k))]; },
  // capture this window to $CVIM_DESKTOP_SHOTS/<name>.png (tests look at the result)
  async shot_test({ name }) {
    if (!process.env.CVIM_DESKTOP_SHOTS) return;
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(process.env.CVIM_DESKTOP_SHOTS, `${String(name).replace(/[^\w-]/g, "")}.png`), img.toPNG());
  },
  // a task finished (as if the agent said Stop) — EXP / evolution without a real agent
  partner_done_test({ ws }) { onCoreEvent({ event: "transition", ws, from: "thinking", to: "done" }); },
  // throws land as given: "caught" / "broke" / "fled" (random otherwise)
  wild_rig_test({ result }) {
    const seq = { caught: [0, 0, 0, 0], broke: [0, 0.999, 0.999], fled: [0.999, 0] }[result];
    let i = 0;
    wild.setRng(seq ? () => seq[i++ % seq.length] : Math.random);
  },
  // show / hide the overlay as if another app were in front; capture it
  overlay_show_test({ on }) { overlayForced = !!on; overlaySync(); },
  async overlay_shot_test({ name }) {
    if (!process.env.CVIM_DESKTOP_SHOTS || !overlay) return;
    const img = await overlay.webContents.capturePage();
    fs.writeFileSync(path.join(process.env.CVIM_DESKTOP_SHOTS, `${String(name).replace(/[^\w-]/g, "")}.png`), img.toPNG());
  },
  overlay_bounds_test: () => overlay.getBounds(),
  overlay_payload_test: () => overlayPayload(),
  diag_test: () => diagnostics(),
  // the app menu's first submenu labels, and whether the notices ship with the app
  appmenu_test: () => ({ items: Menu.getApplicationMenu()?.items[0]?.submenu?.items.map((i) => i.label || i.role || i.type), notices: !!NOTICES() && NOTICES().startsWith(process.resourcesPath || "/nope") }),
  quit_test() { setTimeout(() => app.quit(), 100); },
  // the app menu's items (no reload / close window / zoom)
  menu_test: () => Menu.getApplicationMenu().items.flatMap((m) => m.submenu.items.map((i) => `${i.role || i.label}${i.accelerator ? `(${i.accelerator})` : ""}`)),
  overlay_collapse_test: () => overlayCommands.overlay_collapse(),
  // a line in the workspace's hook log, as Claude's hook (claude/hooks/event.sh) writes it
  hook_event_test({ ws, event, detail }) {
    if (!sessions.has(String(ws)) || !/^\w+$/.test(String(event))) return; // any session
    fs.appendFileSync(path.join(TABS, `${ws}.log`), JSON.stringify({ event, ts: Math.floor(Date.now() / 1000), tool: "", detail: String(detail || "") }) + "\n");
  },
};
if (TEST) Object.assign(commands, testCommands);

const num = (v) => Math.max(1, Math.min(1000, Number(v) || 1));

// beta: where feedback goes, the open-source notices, the About panel
const FEEDBACK = "yeomjae5766@gmail.com";
// the version as people see it: a release build = the version, a dev build adds its commit
// (scripts/stamp.cjs → build-info.json; docs/VERSIONING.md 5)
const BUILD = (() => { try { return require("./build-info.json"); } catch { return { kind: "dev", commit: null }; } })();
const VERSION = () => app.getVersion() + (BUILD.kind === "release" || !BUILD.commit ? "" : `+${BUILD.commit}`);
const NOTICES = () => [process.resourcesPath && path.join(process.resourcesPath, "THIRD_PARTY_NOTICES.txt"), path.join(__dirname, "..", "build", "THIRD_PARTY_NOTICES.txt")].find((f) => f && fs.existsSync(f));
// "진단 정보 복사": version, macOS, agent connections, open tabs/shells and the recent app log —
// for the tester to paste into a feedback mail (nothing is sent by the app). No conversations,
// commands or file names: folders become 폴더1, 폴더2 …, paths become <경로>, the home folder ~.
function diagnostics() {
  const folders = [...workspaces.values()].map((w) => w.cwd);
  const label = new Map(folders.map((f, i) => [f, `폴더${i + 1}`]));
  const clean = (t) => {
    let s = String(t);
    // longest first: a folder inside another open folder must not end up as "폴더1/<its path>" (#6)
    for (const [f, l] of [...label].sort((a, b) => b[0].length - a[0].length)) s = s.split(f).join(l).split(` ${path.basename(f)}`).join(` ${l}`).split(`=${path.basename(f)}`).join(`=${l}`);
    s = s.replace(/(폴더\d+)\/[^\s"')]+/g, "$1/<경로>"); // a path under a hidden folder (e.g. a tab closed since)
    s = s.replace(/^(\S+ changes revert \S+ \S+) .*$/, "$1 <파일>"); // the reverted file's name
    s = s.replace(/(^|[\s=:("'])(\/|~\/)[^\s"')]+/g, "$1<경로>");
    return s.split(HOME).join("~");
  };
  const agentRows = agents.status().map((a) => `  ${a.name}: ${{ full: "전체", basic: "기본", none: "없음" }[a.level]}${a.path ? ` (${a.path.split(HOME).join("~")})` : ""}${a.fix ? " · Gemini 확장 미연결" : ""}`);
  const tabRows = [...workspaces.values()].map((w) => `  ${label.get(w.cwd)}: 셸 ${w.sessions.length}개 — ${w.sessions.map((s, i) => `${i + 1}:${s.host ? (s.hostKey ? `셸(${s.hostKey})` : "셸") : s.agent}/${s.agentState || "idle"}`).join(", ")}${w.shell ? ` · 셸 칸: ${w.shell.key}/${w.shell.state}` : ""}`);
  return [
    `Tamer ${VERSION()} · macOS ${process.getSystemVersion()} · ${process.arch} · Electron ${process.versions.electron}`,
    `만든 시각 ${new Date().toISOString()} · 켜진 지 ${Math.round(process.uptime() / 60)}분 · 야생 포켓몬 ${wild.enabled() ? "켬" : "끔"}`,
    "", "에이전트 연결:", ...agentRows,
    "", `열린 탭 ${workspaces.size}개:`, ...tabRows,
    "", `최근 앱 기록 (${RECENT_LOG.length}줄):`, ...RECENT_LOG.map(clean),
  ].join("\n");
}

const helpItems = [
  { label: "진단 정보 복사", click: () => {
    clipboard.writeText(diagnostics());
    dialog.showMessageBox(win, { type: "info", message: "진단 정보를 복사했어요", detail: `피드백 메일(${FEEDBACK})에 붙여넣어 주세요. 버전·macOS·에이전트 연결 상태·최근 앱 기록이 들어 있고, 대화 내용·명령어·파일 이름은 없으며 폴더 이름은 "폴더1"처럼 가려져 있어요. 보내기 전에 내용을 확인할 수 있어요.` });
  } },
  { label: "피드백 보내기…", click: () => shell.openExternal(`mailto:${FEEDBACK}?subject=${encodeURIComponent(`Tamer ${VERSION()} 피드백`)}&body=${encodeURIComponent(`무엇을 했고:\n무엇을 기대했고:\n무엇이 보였는지:\n\n(메뉴 Tamer → 진단 정보 복사 후 여기에 붙여넣기)\n\nTamer ${VERSION()} · macOS ${process.getSystemVersion()} · ${process.arch}\n`)}`) },
  { label: "오픈소스 고지", click: () => { const f = NOTICES(); if (f) shell.openPath(f); } },
];
app.setAboutPanelOptions({
  applicationName: "Tamer", applicationVersion: VERSION(),
  credits: "AI 코딩 에이전트와 함께 쓰는 터미널 · 피드백: " + FEEDBACK + "\n오픈소스 고지: Tamer 메뉴 → 오픈소스 고지\nPokémon은 비공식 팬 기능이며 권리는 Nintendo / Creatures / GAME FREAK / The Pokémon Company에 있습니다.",
});

ipcMain.handle("host-invoke", async (e, cmd, args) => {
  if (ready) await ready; // the core runs and agents have the terminal's environment
  // only our own pages may call in: the main window (dist/index.html, every command) and the
  // overlay (dist/overlay.html, its own short list)
  const url = e.senderFrame?.url || "";
  const page = url.startsWith("file://") ? decodeURIComponent(url.slice(7)).split(/[?#]/)[0] : "";
  const table = page === path.join(DIST, "index.html") && e.sender === win?.webContents ? commands
    : page === path.join(DIST, "overlay.html") && e.sender === overlay?.webContents ? overlayCommands : null;
  if (!table) throw new Error("unexpected sender");
  const fn = Object.hasOwn(table, cmd) && table[cmd];
  if (!fn) throw new Error(`unknown command ${cmd}`);
  return fn(args || {});
});

// macOS hands folders to the app (Dock icon drop, "Open With", Dock recent) — may come before ready
app.on("open-file", (e, file) => { e.preventDefault(); requestOpen(file); });

// the terminal environment is read in the background (#4); the core starts with it, and every
// command from the page waits for that — the window itself never waits
let ready = null;
app.whenReady().then(() => {
  ready = agents.prepareEnv().then(() => {
    core = new RustCore({ onEvent: onCoreEvent, log: logLine });
    logLine(`env ready (${Object.keys(agents.loginEnv()).length} vars)`);
  });
  appMenu();
  powerMonitor.on("shutdown", () => { systemShutdown = true; logLine("system shutdown: keeping the session"); });
  // tests: quit by itself like ⌘Q (never quit other instances by app name)
  if (TEST && process.env.CVIM_DESKTOP_QUIT_AFTER) setTimeout(() => app.quit(), Number(process.env.CVIM_DESKTOP_QUIT_AFTER));
  // no camera / mic / notifications / … for the page (voice will ask for the mic explicitly later)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win = new BrowserWindow({
    width: 1400, height: 900, title: "Tamer", backgroundColor: "#16161c", show: !QUIET_TEST,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      devTools: TEST, // debugger-driven tests need it; regular runs don't
    },
  });
  if (QUIET_TEST) win.showInactive(); // a test window never takes the keyboard from the user's apps
  // the window only ever shows our page: no navigation, no new windows
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.loadFile(path.join(DIST, "index.html"));
  win.on("focus", overlaySync);
  win.on("blur", () => setTimeout(overlaySync, 250)); // focus may be moving to our own dialog
  createOverlay();
  wild.setOnEnd((e) => { logLine(`wild end ${e.reason}`); broadcast("wild-end", e); overlayUpdate(); });
  if (wild.enabled()) wild.prefetch();
  // S1: owner-only data, old hook logs pruned (7 days without changes)
  try {
    const fixed = tighten(CACHE) + (STATE !== CACHE ? tighten(STATE) : 0);
    const pruned = pruneTabs(TABS, 7);
    logLine(`privacy: ${fixed} permissions tightened, ${pruned} old hook files removed`);
  } catch (e) { logLine(`privacy error ${e}`); }
  partner.migrate(); // box.json (first run: from folders.json / pokedex.json, backed up)
  loadStarter(); // the first partner's starters (only while the box is empty)
  setInterval(() => { if (workspaces.size) scanShells().catch((e) => logLine(`scan error ${e}`)); }, 1500);
});

// closing the main window ends the app (the overlay alone doesn't keep it running)
app.on("browser-window-created", (_e, w) => w.on("closed", () => { if (w === win && overlay && !overlay.isDestroyed()) overlay.destroy(); }));

// same escaping iTerm2 uses for dropped paths (nvim/lua/cvim/drop.lua)
function shellEscape(p) { return p.replace(/([\s!"#$&'()*,;<=>?[\]\\^`{|}~])/g, "\\$1"); }

// the app menu: Edit (copy / paste for the terminals and text fields), Window, Quit. No Reload,
// no Close Window, no page zoom — ⌘R / ⌘W / ⌘= ⌘- ⌘0 are the app's own keys (relayout, close
// tab, font size), and a default menu would catch them first.
function appMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: "about" }, { type: "separator" }, ...helpItems, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "togglefullscreen" }] },
  ]));
}

// the user quit (⌘Q / Dock): next launch starts clean. A Mac shutdown / restart also quits apps —
// that one keeps the tabs (powerMonitor "shutdown" comes first)
function userQuit() {
  if (!quitting && !systemShutdown) {
    const s = readJsonSafe(SESSION) || {};
    try { writeSession({ ...s, quit: true }); } catch {}
    logLine("user quit: next launch starts clean");
  }
  quitting = true;
}
app.on("before-quit", userQuit);

app.on("window-all-closed", () => {
  userQuit(); // closing the window is quitting too
  for (const id of [...workspaces.keys()]) closeWorkspace(id);
  for (const p of ptys.values()) { try { p.kill(); } catch {} }
  if (core) core.stop(); // the core removes its hook files and exits
  app.quit();
});
