// CVIM Desktop (v2) — Electron main process: a thin layer between the UI (src/), the PTYs, and
// cvim-core (Rust, desktop/core-rs), which owns the agent state machine, the adapters (Claude
// hooks, Codex log, activity) and the path policy. Partner Pokémon data is still here (partner.cjs).
// Data: ~/.cache/tamer (copied once from the Neovim CVIM's ~/.cache/cvim — core/paths.cjs).
const { app, BrowserWindow, ipcMain, clipboard, session, dialog, screen, Menu, Tray, powerMonitor, shell, nativeImage, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const pty = require("node-pty");
const { execFile } = require("node:child_process");
const { HOME, CACHE, STATE, TABS, ROOT, writeFile, mkdirPrivate, tighten, pruneTabs } = require("./core/paths.cjs");
const agents = require("./core/agents.cjs");
const partner = require("./core/partner.cjs");
const wild = require("./core/wild.cjs");
const { trayModel, trayIcon, AGENTS: TRAY_AGENTS } = require("./tray.cjs");
const prices = require("./core/prices.cjs");
const stats = require("./core/stats.cjs");
const economy = require("./core/economy.cjs"); // 포켓코인 (#72)
const legends = require("./core/legends.cjs"); // 전설의 길 (#86)
const research = require("./core/research.cjs"); // 환상 스페셜 리서치 (#86)
const limits = require("./core/limits.cjs"); // 채팅 없이 한도 (#104)
const outside = require("./core/outside.cjs"); // Tamer 밖에서 끝낸 작업 (#107)
const { RustCore } = require("./core/rust.cjs");

const ptys = new Map(); // pane id "<ws>:<agent|shell>" -> IPty
// test hooks (DevTools input emulation, stand-in commands) only exist in test runs
const TEST = process.env.CVIM_DESKTOP_TEST === "1";
// a test run keeps its own browser profile (localStorage: last usage, 내 포켓몬 sort, font size …),
// fresh every run — never the user's ~/Library/Application Support/Tamer (until 2026-10-05 they
// shared it, and a test's sort choice showed up in ui:shots)
if (TEST) app.setPath("userData", process.env.CVIM_DESKTOP_USERDATA || path.join(require("node:os").tmpdir(), `tamer-test-profile-${process.pid}`));
// 한 번만 실행 (APP-21 rule 6, #106): a second launch ends at once and the running Tamer shows its window
// (two Tamers would write the same data — the preview app and the installed one share it). Tests skip it
if (!TEST && !app.requestSingleInstanceLock()) { app.quit(); return; }
// … but a second launch while this one is quitting (its terminals ending, a few seconds) must not bring its
// window back — closing that one finished the quit, menu bar icon too (#110): start a fresh one when done
let relaunchAfterQuit = false;
app.on("second-instance", () => { if (quitting || draining) { relaunchAfterQuit = true; logLine("second launch while quitting: relaunch after"); return; } focusMain(); });
// test instances show their window without activating it, so keys typed in the user's own apps
// never land in a test terminal (seen 2026-10-02); CVIM_DESKTOP_TEST_FOCUS=1 for IME tests that need focus
const QUIET_TEST = TEST && process.env.CVIM_DESKTOP_TEST_FOCUS !== "1";
// …and the app itself never becomes the front app: macOS activates a launched app even when its
// window shows inactive (2026-10-06: a smoke run took the front ~30 times in 5 min). An accessory
// app (no Dock icon, no menu bar of its own) isn't activated at launch
if (QUIET_TEST && process.platform === "darwin") {
  app.setActivationPolicy("accessory");
  // a folder handed in by LaunchServices (`open -g … folder`, a drop) still activates it: give the
  // front back at once (hide = the previous app comes back), and show the window again, inactive
  app.on("did-become-active", () => {
    logLine("test: became active -> yield");
    app.hide();
    setTimeout(() => { if (win && !win.isDestroyed()) win.showInactive(); overlaySync(); }, 60);
  });
}
const linksOpened = []; // tests: links ⌘-clicked (never opened)
// UI scenes (npm run ui:shots, docs/UI_SYSTEM.md): captures compared with $CVIM_UI_BASELINE/<scene>.png
// (the page stills its sprites and hides the terminals itself)
const UI_SCENES = TEST && process.env.CVIM_DESKTOP_UI_SCENES ? process.env.CVIM_DESKTOP_UI_SCENES : null;
const DIST = path.join(__dirname, "..", "dist");
// terminal panes per tab (the Neovim pane became the "changes" panel, E1b — nvim runs in the shell)
const KINDS = ["agent", "shell"];
let win;
let overlay; // desktop overlay (overlay.html): partners while you're in another app
let popover = null; // 메뉴바 미니 대시보드 (popover.html, STA-22 #105): the menu bar icon's left click
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

// to every window (wild encounters show in any — the dashboard catches too, #105)
function broadcast(event, payload) {
  send(event, payload);
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send("host-event", { event, payload });
  if (popover && !popover.isDestroyed()) popover.webContents.send("host-event", { event, payload });
}

// the app's own log: a file only with CVIM_DESKTOP_LOG (tests, diagnosis); the last lines are also
// kept in memory (never written) for "진단 정보 복사"
const RECENT_LOG = [];
const RECENT_LOG_MAX = 300;
// startup timing, ms since the process began (in the log and the diagnostics)
const BOOT = Date.now() - Math.round(process.uptime() * 1000);
const since = () => Date.now() - BOOT;
function logLine(line) {
  if (process.env.CVIM_DESKTOP_LOG) fs.appendFileSync(process.env.CVIM_DESKTOP_LOG, line + "\n");
  RECENT_LOG.push(`${new Date().toTimeString().slice(0, 8)} ${line}`);
  if (RECENT_LOG.length > RECENT_LOG_MAX) RECENT_LOG.shift();
}

// the user's own Claude statusLine, chained after cvim's (as v1 did)
// #45: ask, then add the shell line (agents.claudeLink) — shows the exact lines and the file first
async function claudeLinkAsk() {
  const f = agents.claudeLinkFile();
  if (!f) return { ok: false, msg: "이 셸은 아직 자동 연결을 지원하지 않아요(zsh·bash·fish만)" };
  const r = await dialog.showMessageBox(win, {
    type: "question", buttons: ["연결", "취소"], defaultId: 0, cancelId: 1,
    message: "셸에서 직접 친 Claude도 Tamer에 연결할까요?",
    detail: `⌘G로 띄운 Claude처럼 5시간·주간 한도, ctx %, 생각 중·도구·입력 필요가 보여요.\n\n${f.file.replace(HOME, "~")} 끝에 아래 블록을 넣어요:\n\n${f.lines.join("\n")}\n\nTamer 셸 안에서만 동작해요(그 밖의 터미널에선 CVIM_CLAUDE_SETTINGS가 없어 아무 일도 안 함). ~/.claude/settings.json은 건드리지 않아요. 넣기 전 파일 사본을 ~/.cache/tamer/backup/shell-rc에 두고, 에이전트 연결 창에서 언제든 해제할 수 있어요. 새로 여는 셸부터 적용돼요.`,
  });
  if (r.response !== 0) return { ok: false, cancelled: true };
  try { const l = agents.claudeLink(); logLine(`claude link ${l.already ? "already" : "ok"}`); relinkShown(); return { ok: true, msg: "연결했어요 — 새로 여는 셸(⌘⇧T 또는 새 탭)부터 적용돼요" }; }
  catch (e) { logLine(`claude link error ${e.code || e.message}`); return { ok: false, msg: `연결하지 못했어요: ${e.message}` }; }
}

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
// every terminal process whose exit hasn't been heard yet — also ones already dropped from `ptys`
// (closed tabs, replaced agents): quitting waits for all of them (#54)
const livePtys = new Set();
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
  livePtys.add(p);
  p.onExit(() => {
    livePtys.delete(p);
    if (quitting) return; // quitting: nothing restarts, nothing is saved (drainPtys only waits for this)
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
  // the first tab: the window had focus before it — with the right column folded (or 보일 때 늘) the overlay
  // shows now, not at the next focus change (#97: it didn't at launch)
  overlaySync();
  return { ...wsInfo(ws), existing: false };
}

function closeWorkspace(id) {
  const ws = workspaces.get(id);
  if (!ws) return;
  try { ws.gitWatch?.close(); } catch {} // #52
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
  overlaySync(); // the last tab gone: no overlay (#97)
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
  if (ready) await ready; // the terminal's environment (PATH, API keys …) — read once, up to 15 s
  if (agents.envFailed() && !envWarned) { envWarned = true; send("toast", { text: "셸 설정(~/.zshrc 등)을 15초 안에 읽지 못해, 에이전트가 일부 환경 변수 없이 실행될 수 있어요" }); }
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
  if (ROOT) {
    env.CVIM_ROOT = ROOT;
    // #45: what the opt-in shell line gives a `claude` typed here (--settings: status line, hooks);
    // the user's own status line still shows, chained after Tamer's
    env.CVIM_CLAUDE_SETTINGS = path.join(ROOT, "claude/settings.json");
    const chain = userStatusline();
    if (chain) env.CVIM_CHAIN_STATUSLINE = chain;
  }
  return env;
}

// how CVIM follows an agent typed into a shell (no CVIM flags on its command line)
// #49: a Claude typed in a shell that isn't linked is read from its conversation log — no "입력 필요"
// (the log never says a permission dialog is open) and no 5h · 7d. Say how to get them, once per run
let linkHinted = false;
// a Claude typed here and read from its log (no "입력 필요"): "off" — the shell line isn't on;
// "stale" — it's on, but this shell was opened before (the alias only reaches new shells); null — fine
function linkState(d, kind) {
  if (d?.key !== "claude" || kind !== "claude_log" || !agents.claudeLinkFile()) return null;
  return agents.claudeLinked() ? "stale" : "off";
}
// the link was just turned on / off: the Claudes already running in shells keep their adapter (an
// alias only reaches new shells), but their top-bar chip must say so now — "새 셸에서 다시" / "연결 안 됨"
function relinkShown() {
  for (const s of sessions.values()) if (s.hostKey === "claude" && s.hostKind) send("claude-link", { ws: tabOf(s).id, session: s.id, unlinked: linkState({ key: "claude" }, s.hostKind) });
  for (const ws of workspaces.values()) if (ws.shell?.key === "claude" && ws.shell.kind) send("claude-link", { ws: ws.id, shell: true, unlinked: linkState({ key: "claude" }, ws.shell.kind) });
}
function hintClaudeLink(d, kind) {
  if (linkHinted || d?.key !== "claude" || kind !== "claude_log" || !agents.claudeLinkFile() || agents.claudeLinked()) return;
  linkHinted = true;
  logLine("hint: shell claude not linked");
  send("toast", { text: "셸에서 친 Claude는 '입력 필요'·한도를 알 수 없어요 — ⌘G → ⚙ 에이전트 연결 상태 → \"셸에서 친 Claude도 연결\"을 켜면 ⌘G처럼 보여요", ms: 6000 });
}

function typedKind(d, args = "") {
  if (d.state === "codex_log") return "codex_log";
  // a Claude that came up with Tamer's --settings (the opt-in shell line, #45): hooks + status line like ⌘G
  if (d.key === "claude") return ROOT && String(args).includes(path.join(ROOT, "claude/settings.json")) ? "hooks" : "claude_log";
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
async function setHostAgent(s, d, cwd = null, args = "") {
  if (d && ready) await ready; // which adapter fits (Gemini linked or not …) depends on the PATH
  s.hostKey = d?.key || null;
  s.running = !!d;
  if (d) {
    s.agent = d.key;
    agents.remember(s.cwd, d.key);
  }
  logLine(`host-agent ws=${s.id} ${d?.key || "-"}${d ? ` kind=${typedKind(d, args)}` : ""}${cwd && cwd !== s.cwd ? ` cwd=${cwd}` : ""}`);
  saveSession();
  send("host-agent", { ws: tabOf(s).id, session: s.id, agent: d ? agentInfo(s) : null, where: d ? whereOf(tabOf(s), cwd) : null, unlinked: d ? linkState(d, typedKind(d, args)) : null });
  if (d) {
    // its logs are where it runs (after a `cd`, not necessarily the tab's folder) — #3
    hintClaudeLink(d, typedKind(d, args));
    s.hostKind = typedKind(d, args);
    const fresh = await core.request("restart", { ws: s.id, kind: typedKind(d, args), cwd: cwd || s.cwd }).catch(() => null);
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
// unattended runs (STA-20): no new event for this long while working = a stall is suspected
// (tests: CVIM_STALL_SECS)
const STALL_MS = (TEST && Number(process.env.CVIM_STALL_SECS) * 1000) || 10 * 60 * 1000;
const TIMES = (p) => ({ state: p.state, turn_at: p.turn_at, state_at: p.state_at, event_at: p.event_at, took: p.took, watch: p.watch,
  kind: p.state === "error" ? p.detail || null : null }); // how it failed (#53): the kind, never the error text
// the times of the state the overlay shows for a tab (shownState's pick)
function shownTimes(ws) {
  if (ws.shell && ws.swapped) return ws.shell.times || null;
  return ws.sessions.map((x) => x.times).filter(Boolean).sort((a, b) => URGENCY(a.state) - URGENCY(b.state))[0] || null;
}
const URGENCY = (st) => (st === "waiting" ? 0 : st === "error" ? 1 : WORKING.includes(st) ? 2 : st === "done" ? 3 : st === "interrupted" ? 4 : st === "sleep" ? 6 : 5);
function shownState(ws) {
  if (ws.shell && ws.swapped) return ws.shell.state || "idle";
  return ws.sessions.map((x) => x.agentState || "idle").sort((a, b) => URGENCY(a) - URGENCY(b))[0] || "idle";
}

const heldStates = new Set(); // tests only (agent_state_test hold)
function onCoreEvent(msg) {
  if (heldStates.size && !msg.test && heldStates.has(msg.ws)) return;
  // "<ws>~shell" = the agent started by hand in that tab's shell pane
  const fromShell = shellOf.has(msg.ws);
  const sess = fromShell ? null : sessions.get(msg.ws); // an agent session ("<ws>" or "<ws>~s<n>")
  const ws = fromShell ? workspaces.get(shellOf.get(msg.ws)) : sess && tabOf(sess);
  if (!ws) return;
  if (msg.event === "state") {
    if (fromShell) {
      if (!ws.shell || ws.shell.id !== msg.ws) return;
      ws.shell.state = msg.payload.state;
      ws.shell.times = TIMES(msg.payload);
      send("agent-state", { ws: ws.id, source: "shell", shellKey: ws.shell?.key, ...msg.payload });
    } else {
      sess.agentState = msg.payload.state;
      sess.times = TIMES(msg.payload);
      send("agent-state", { ws: ws.id, session: sess.id, source: "agent", agent: agentInfo(sess), ...msg.payload });
    }
    // the core sends the transition before this state: a failure's kind arrives here (#53)
    if (ws.ended?.how === "error" && !ws.ended.kind && msg.payload.state === "error") ws.ended.kind = msg.payload.detail || null;
    if (ws.state !== shownState(ws)) ws.state = shownState(ws);
    overlayUpdate(); // the times move with every event (STA-20)
  }
  if (msg.event === "transition") {
    logLine(`transition ws=${msg.ws} agent=${fromShell ? ws.shell?.key : sess.agent} ${msg.from} -> ${msg.to}`); // diagnostics
  }
  // how a turn ended (done / interrupted / error): the overlay shows it for a while
  if (msg.event === "transition" && ["done", "interrupted", "error"].includes(msg.to) && msg.from !== msg.to) {
    // which shell (several in the folder): the bubble says "셸 2 완료" — another shell's "입력 필요"
    // must not hide it
    ws.ended = { how: msg.to, at: Date.now(), n: sess && ws.sessions.length > 1 ? ws.sessions.indexOf(sess) + 1 : null,
      kind: msg.to === "error" ? (fromShell ? ws.shell?.times : sess?.times)?.kind || null : null }; // #53
    overlayUpdate();
    setTimeout(overlayUpdate, 15100); // the bubble goes away
  }
  if (msg.event === "transition" && msg.to === "done" && msg.from !== "done") {
    // an agent without events (any CLI, or one whose events never came): "done" was guessed from its
    // output — it still raises the partner, at half the pace (every other one), and brings no wild
    if (msg.guess) {
      ws.guessed = (ws.guessed || 0) + 1;
      logLine(`guessed done ws=${msg.ws} n=${ws.guessed}`);
    }
    // the core sends the transition before the "done" state: the times are still the turn's
    // (turn_at = when it started); a test sends the state first, with its own times
    const t = (fromShell ? ws.shell?.times : sess?.times) || {};
    finishGame({ ws, cwd: ws.cwd, agent: fromShell ? ws.shell?.key : sess?.agent, took: t.took ?? (t.turn_at ? Date.now() - t.turn_at : null), turnAt: t.turn_at || null,
      guess: !!msg.guess, skipGrowth: !!msg.guess && ws.guessed % 2 === 1 });
  }
}

// ── a finished task, wherever it was done (a tab, or outside Tamer — STA-23, #107): the same game for both
// (POL-FUT-05 rule 4). ws = the tab (null outside Tamer); skipGrowth = a guessed finish's every other one
function finishGame({ ws = null, cwd, agent = null, took = null, turnAt = null, guess = false, skipGrowth = false, outside = false }) {
  stats.recordDone(); // Home: today's count, the streak (#44) — every finished task, guessed ones too
  research.onDone(cwd, caughtSet().size); // ✦ "서로 다른 폴더 3곳" (#86)
  bigCheck(); // ⭐ the 7th 연구 스탬프 brings a legend (#82) · a research done brings its mythical (#86)
  if (skipGrowth) return;
  // 🪙 포켓코인 (#72, PKM-18): +5 (+1 for a turn under 30 s), the day's first +20, ₽300 a day (tabs and outside together)
  const coins = economy.onDone({ turnAt, took });
  if (coins) {
    logLine(`coins ${ws ? `ws=${ws.id}` : "outside"} +${coins.gained} (${coins.pay}${coins.first ? `+${coins.first}` : ""}${coins.capped ? " capped" : ""})`);
    send("economy", { ...economy.summary(), ws: ws?.id || null, gained: coins.gained });
  }
  // sometimes a wild Pokémon comes out (PLAN 3.6) — where and during whose task it showed up: kept with the
  // individual if it's caught (#44). A folder without a partner: more often (PKM-06)
  const empty = ws ? !ws.partner : partner.progress(cwd).lv == null;
  const w = guess ? null : wild.onDone(ws ? ws.id : null, { empty, folder: cwd, agent, incense: !!economy.incenseUntil() });
  if (w) { logLine(`wild appeared ${w.id}${w.shiny ? "s" : ""} ${ws ? `ws=${ws.id}` : "outside"}`); broadcast("wild", { ...w, balls: ballsOwned() }); overlayUpdate(); }
  // 🥚 the incubator (#85): every finished task anywhere — the first egg one closer, maybe a hatch into the box
  partner.incubatorStep().then((r) => {
    if (!r) return;
    if (r.hatched) {
      const coins = r.newdex ? economy.onNewDex() : 0;
      logLine(`incubator hatched ${r.hatched.id}${r.hatched.shiny ? "s" : ""}${coins ? " newdex" : ""}`);
      if (research.onCatch(caughtSet().size)) researchCheck();
      // the overlay shows it too (#88, PKM-30 rule 5) — with its picture, no further download
      broadcast("hatched", { id: r.hatched.id, name: r.hatched.name, shiny: r.hatched.shiny, coins, gif: partner.loadSprite(r.hatched.id, r.hatched.shiny)?.gif || null });
      send("economy", economy.summary());
    }
    send("incubator", partner.incubator());
    progressBump(); // the stamp of the day too (stats are in by now)
  }).catch((e) => logLine(`incubator error ${e}`));
  // EXP for the folder's partner — none there: the party's next in turn (PKM-31) — maybe an evolution
  const t0 = Date.now();
  partner.onDone(cwd).then(({ evolved, from, miles = [], hatched, newdex, graduated, evoNew, via, uid }) => {
    logLine(`exp ${ws ? `ws=${ws.id}` : "outside"} via=${via || "-"} ${JSON.stringify(via === "party" ? { uid } : partner.progress(cwd))} evolved=${evolved?.id ?? "-"} miles=${miles.join(",") || "-"}${hatched ? ` hatched=${hatched.id}${hatched.shiny ? "s" : ""}` : ""}${graduated ? " graduated" : ""} ${Date.now() - t0}ms`);
    const newCoins = evolved && evoNew ? economy.onNewDex() : 0; // 🪙 a species new to the Pokédex by evolving: +30 more (#94)
    const evoCoins = (evolved ? economy.onEvolve() : hatched && newdex ? economy.onNewDex() : 0) + newCoins; // 🪙 +30 (#72) · a new species out of an egg (#84)
    if (evolved && research.onEvolve(caughtSet().size)) researchCheck(); // ✦ "진화 3번" (#86)
    const mileCoins = miles.reduce((s) => s + economy.onMilestone(), 0); // every 10 levels ₽20 (#74)
    const gradCoins = graduated ? economy.graduated() : 0; // 🎓 300 + an egg (#84)
    if (evolved || mileCoins || gradCoins || evoCoins) send("economy", economy.summary());
    if (evolved) progressBump(); // ✦ "진화 3번"
    // 진화 연출 off the main window (#111): with no window, or Tamer not in front, the overlay shows it
    if (evolved && (!win || win.isDestroyed() || !win.isFocused())) {
      broadcast("evolved", { from: from?.name || null, to: evolved.name, shiny: !!evolved.shiny, gif: evolved.gif || null, coins: evoCoins, outside, via: via || null });
      logLine(`overlay evolved ${evolved.id}`);
    }
    // the tabs showing this individual (the folder's own tab; a party member may be some folder's partner too)
    const grown = via === "party" ? partner.party().list.find((m) => m.uid === uid) : null;
    const tabs = [...workspaces.values()].filter((x) => (via === "folder" ? x.cwd === cwd : grown?.folder && x.cwd === grown.folder));
    for (const x of tabs) {
      if (evolved || hatched) { x.partner = { ...(evolved || hatched), ...partner.progress(x.cwd) }; overlayUpdate(); }
      send("partner-progress", { ws: x.id, ...partner.progress(x.cwd), evolved: evolved || null, from: from || null, coins: evoCoins, newCoins, mile: miles.at(-1) || null, mileCoins,
        hatched: hatched || null, graduated: !!graduated, gradCoins });
    }
    // 파티 · 밖 작업 (#107): the dashboard, the overlay and the 파티 tab hear who grew
    if (via === "party" || outside) {
      const mon = via ? partner.mon(uid) : null; // who grew — by name, also a folder partner with no tab open (#111)
      const note = { at: Date.now(), outside, folder: path.basename(cwd), agent, via: via || null, coins: coins?.gained || 0,
        mon: mon ? { uid: mon.uid, name: mon.name, lv: mon.lv ?? null } : null, evolved: evolved ? { id: evolved.id, name: evolved.name } : null };
      recentDone.unshift(note); recentDone.length = Math.min(recentDone.length, 5);
      broadcast("party-done", note);
      popoverUpdate(); overlayUpdate();
      setTimeout(overlayUpdate, 15100); // its bubble goes away
    }
  }).catch((e) => logLine(`exp error ${e}`));
}
const recentDone = []; // the last few finishes done outside Tamer or grown by the party — memory only (#107)
const partyLite = () => { try { const p = partner.party(); return { list: p.list.map((m) => ({ uid: m.uid, name: m.name, gif: m.gif, shiny: m.shiny, lv: m.lv })), next: p.next }; } catch { return { list: [], next: 0 }; } };

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
let sessionKept = false; // 백그라운드 (#106): the tabs as the window closed — kept for its next opening
function saveSession() {
  if (quitting || sessionKept) return;
  const tabs = [...workspaces.values()].map((w) => w.cwd);
  const active = workspaces.get(activeWs)?.cwd || null;
  // more sessions per folder (M1): their agents, started fresh on restore (null: a shell)
  const extra = Object.fromEntries([...workspaces.values()].filter((w) => w.sessions?.length > 1).map((w) => [w.cwd, w.sessions.slice(1).map((x) => (x.running ? x.agent : null))]));
  // folders whose agent wasn't running: reopened as a shell (S2 shell first)
  const shell = [...workspaces.values()].filter((w) => !w.running).map((w) => w.cwd);
  // names the user gave the shells (#99, TAB-20 rule 3), by their place in the folder
  const names = Object.fromEntries([...workspaces.values()].filter((w) => w.sessions?.some((x) => x.name)).map((w) => [w.cwd, w.sessions.map((x) => x.name || null)]));
  writeSession({ tabs, active, sessions: extra, shell, ...(Object.keys(names).length ? { names } : {}) });
}
// a shell's name, as typed (#99): one line, 40 characters at most; empty = none (the agent's title again)
const sessionName = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
function titlesToCore() { core?.request("titles", { on: settings.titles }).catch((e) => logLine(`core titles error ${e}`)); }

// a folder handed to the app (Dock icon drop, Finder "Open With", Dock recent item)
function requestOpen(dir) {
  if (!isDir(dir)) return;
  if (win && !win.isDestroyed() && win.webContents.isLoading() === false && uiReady) send("open-folder", { cwd: dir });
  else { pendingOpen.push(dir); if (app.isReady() && (!win || win.isDestroyed())) createMain(); } // in the menu bar only (#106): a window for it
}
let uiReady = false;
let envWarned = false;
// what waits for the window's page (#106: a window made again from the menu bar — 설정 · 도감 after it's up)
const uiQueue = [];
function whenUi(fn) { if (uiReady && win && !win.isDestroyed()) fn(); else uiQueue.push(fn); }

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

// git's own state files changed (a branch switch, a commit, staging, a fetch): the changes pane
// reads again at once instead of on its next 10 s tick (#52). One watcher per tab, on the git
// directory (a worktree's own one too), only for HEAD / index / FETCH_HEAD / ORIG_HEAD
const GIT_STATE = new Set(["HEAD", "index", "FETCH_HEAD", "ORIG_HEAD"]);
async function watchGit(ws) {
  if (ws.gitWatch !== undefined) return;
  ws.gitWatch = null;
  const dir = await git(ws.cwd, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok || !workspaces.has(ws.id)) return;
  try {
    let timer = null;
    ws.gitWatch = fs.watch(dir.out.trim(), (_, name) => {
      if (!GIT_STATE.has(String(name))) return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (workspaces.has(ws.id)) send("changes-dirty", { ws: ws.id }); }, 300);
    });
    ws.gitWatch.on("error", () => { try { ws.gitWatch?.close(); } catch {} ws.gitWatch = null; });
  } catch { ws.gitWatch = null; }
}

async function changesOf(ws) {
  const top = await git(ws.cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { repo: false };
  watchGit(ws);
  const root = top.out.trim();
  const head = (await git(ws.cwd, ["rev-parse", "--verify", "-q", "HEAD"])).ok;
  // -b: the first entry is the branch line (TRM-18) — no extra git run for it
  const st = await git(ws.cwd, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all", "--", "."]);
  const items = [];
  const parts = st.out.split("\0");
  const branch = parts[0]?.startsWith("## ") ? branchOf(parts.shift().slice(3)) : null;
  if (branch?.detached) branch.name = (await git(ws.cwd, ["rev-parse", "--short", "HEAD"])).out.trim() || "HEAD";
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
  return { repo: true, branch, items: items.map(({ abs, ...x }) => x) };
}

// git status -b's branch line (TRM-18): "main...origin/main [ahead 2, behind 1]" · "main" ·
// "No commits yet on main" (older git: "Initial commit on main") · "HEAD (no branch)" · "… [gone]"
function branchOf(line) {
  const born = line.match(/^(?:No commits yet on|Initial commit on) (.+)$/);
  if (born) return { name: born[1], unborn: true };
  if (/^HEAD \(no branch\)/.test(line)) return { detached: true };
  const m = line.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/);
  if (!m) return null;
  const n = (k) => Number((m[3] || "").match(new RegExp(`${k} (\\d+)`))?.[1] || 0);
  return { name: m[1], upstream: m[2] || null, ahead: n("ahead"), behind: n("behind"), gone: /gone/.test(m[3] || "") };
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
    execFile("ps", ["-t", tty, "-o", "pid=,ppid=,tpgid=,stat=,args="], { timeout: 2000 }, (err, out) => resolve(err ? null : fgOf(out)));
  });
}
// the job in front (AGT-07): the leader of the terminal's foreground process group — the command the
// shell started. Not the first "+" line: ps lists by pid, and once pids wrap around an agent's own
// child (Claude Code's caffeinate, an MCP server) can come first — the agent was lost while it
// worked (#69). No leader (it exited): the member whose parent is outside the group.
function fgOf(out) {
  const rows = String(out).split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), tpgid: Number(m[3]), front: m[4].includes("+"), args: m[5] }));
  const group = rows.filter((r) => r.front);
  const lead = group.find((r) => r.pid === r.tpgid) || group.find((r) => !group.some((x) => x.pid === r.ppid)) || group[0];
  return lead ? { pid: lead.pid, args: lead.args } : null;
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
    if ((d?.key || null) !== (ws.shell?.key || null) && workspaces.has(ws.id)) setShellAgent(ws, d, d && (await procCwd(fg.pid)), fg?.args);
  }
  // S2: agent panes running a shell
  for (const s of [...sessions.values()]) {
    if (!s.host) continue;
    const p = ptys.get(`${s.id}:agent`);
    const fg = p ? await foreground(p) : null;
    const d = fg ? agentOf(fg.args) : null;
    if ((d?.key || null) !== (s.hostKey || null) && s.host && sessions.has(s.id)) await setHostAgent(s, d, d && (await procCwd(fg.pid)), fg?.args);
  }
}

// its state is tracked like the agent pane's, as "<ws>~shell" in the core: Codex by its session
// log, Claude by its conversation log (A2), others by output
const shellOf = new Map(); // "<ws>~shell" -> ws id
function setShellAgent(ws, d, cwd = null, args = "") {
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
    // which adapter fits depends on the PATH (Gemini linked …): after the shell environment
    hintClaudeLink(d, typedKind(d, args));
    ws.shell.kind = typedKind(d, args);
    Promise.resolve(ready).then(() => core.request("open", { ws: id, kind: typedKind(d, args), cwd: cwd || ws.cwd, tabs: TABS })).catch((e) => logLine(`shell core error ${e}`));
    agents.remember(ws.cwd, d.key); // ⌘G offers it first next time
  }
  logLine(`shell-agent ws=${ws.id} ${d?.key || "-"}${cwd && cwd !== ws.cwd ? ` cwd=${cwd}` : ""}`);
  ws.state = shownState(ws);
  overlayUpdate();
  send("shell-agent", { ws: ws.id, agent: d && { key: d.key, name: d.name, icon: d.icon, label: agents.label(d.key) }, where: d ? whereOf(ws, cwd) : null, unlinked: d ? linkState(d, typedKind(d, args)) : null });
}

// ── desktop overlay ─────────────────────────────────────────────────────────
// A small always-on-top window (transparent, never takes focus) that shows up while you're in
// another app: the current tab's partner, tabs that are working / need you / just finished, and
// wild encounters. Click → back to that tab; drag → move (position remembered).
const OVERLAY_POS = path.join(CACHE, "ui", "desktop_overlay.json");
// 설정 창 (APP-19, #59): only known keys, each checked — anything else falls back to the default,
// which is how the app behaved before (everything on)
const SETTINGS = path.join(CACHE, "ui", "settings.json");
// card background: 0 % by default (#100) — only the Pokémon on the desktop (minimal mode, auto ≤ 30 %); a settings.json that has a value keeps it
const SETTINGS_DEFAULT = { overlay: { on: true, partner: true, alerts: true, wild: true, progress: true, alpha: 0, shadow: true, minimal: "auto", when: "away" }, tabGlow: true, theme: "system", side: true, titles: true,
  menubar: { on: true, text: "waiting" }, // 메뉴바 (STA-19, #64)
  limits: { codex: true, claude: null }, // 채팅 없이 한도 (STA-21, #104): Codex app server · Claude usage API (null = not asked yet)
  background: true, loginOpen: false, backgroundSeen: false, // 백그라운드 (APP-21, #106): stay in the menu bar · open at login · the one-time notice
  outside: null }; // Tamer 밖 작업도 포켓몬에 (STA-23, #107): null = not asked yet
const MENUBAR_TEXT = ["waiting", "limit", "none"];
const MINIMAL = ["auto", "always", "never"];
const WHEN = ["away", "always"]; // 보일 때 (#98): while another app is in front (as before) / always, Tamer in front too // 최소 모드 (#63): by the background (≤ 30 %), always, never
const THEMES = ["system", "dark", "light"]; // 테마 (APP-20, #60)
function readSettings(raw = readJsonSafe(SETTINGS)) {
  const o = raw?.overlay || {}, d = SETTINGS_DEFAULT.overlay, b = (v, def) => (typeof v === "boolean" ? v : def);
  const a = Number(o.alpha);
  return {
    overlay: { on: b(o.on, d.on), partner: b(o.partner, d.partner), alerts: b(o.alerts, d.alerts), wild: b(o.wild, d.wild), progress: b(o.progress, d.progress), // #88
      alpha: Number.isFinite(a) ? Math.round(Math.min(100, Math.max(0, a))) : d.alpha,
      shadow: b(o.shadow, d.shadow), minimal: MINIMAL.includes(o.minimal) ? o.minimal : d.minimal, when: WHEN.includes(o.when) ? o.when : d.when }, // #65 #63 #98
    tabGlow: b(raw?.tabGlow, SETTINGS_DEFAULT.tabGlow),
    side: b(raw?.side, SETTINGS_DEFAULT.side), // the right column shown (#97) — folded, the overlay shows with Tamer in front too
    titles: b(raw?.titles, SETTINGS_DEFAULT.titles), // 세션 제목 (#99): agents' conversation titles read and shown
    menubar: { on: b(raw?.menubar?.on, SETTINGS_DEFAULT.menubar.on), text: MENUBAR_TEXT.includes(raw?.menubar?.text) ? raw.menubar.text : SETTINGS_DEFAULT.menubar.text },
    theme: THEMES.includes(raw?.theme) ? raw.theme : SETTINGS_DEFAULT.theme,
    limits: { codex: b(raw?.limits?.codex, SETTINGS_DEFAULT.limits.codex), claude: typeof raw?.limits?.claude === "boolean" ? raw.limits.claude : null },
    background: b(raw?.background, SETTINGS_DEFAULT.background), loginOpen: b(raw?.loginOpen, SETTINGS_DEFAULT.loginOpen), backgroundSeen: b(raw?.backgroundSeen, false),
    outside: typeof raw?.outside === "boolean" ? raw.outside : null,
  };
}
let settings = readSettings();
nativeTheme.themeSource = settings.theme;
// macOS switched between dark and light: "시스템 따라가기" pages re-pick their colours (#60)
nativeTheme.on("updated", () => { broadcast("settings", settings); overlayUpdate(); });
function setSettings(patch) {
  settings = readSettings({ ...settings, ...patch, overlay: { ...settings.overlay, ...(patch?.overlay || {}) }, menubar: { ...settings.menubar, ...(patch?.menubar || {}) }, limits: { ...settings.limits, ...(patch?.limits || {}) } });
  nativeTheme.themeSource = settings.theme; // menus, dialogs, scroll bars follow too (#60)
  writeFile(SETTINGS, JSON.stringify(settings));
  broadcast("settings", settings);
  overlaySync();
  overlayUpdate();
  if (patch && "titles" in patch) titlesToCore();
  // 로그인할 때 열기 (APP-21 rule 7): the login item only when the user turns it on (POL-OS-01)
  if (patch && "loginOpen" in patch && !TEST) { try { app.setLoginItemSettings({ openAtLogin: settings.loginOpen }); } catch (e) { logLine(`login item error ${e}`); } }
  appMenu();
  trayUpdate();
  return settings;
}

// ── 메뉴바 (STA-19, #64): an icon (+ who waits / the 5-hour limit) and a menu made fresh on each click ──
let tray = null;
const usageSeen = {}; // agent → its last 5h · 7d, as the window remembers them (memory only, POL-DATA-02)
let trayTimer = null;
const trayTabs = () => [...workspaces.values()].map((ws) => ({ ws: ws.id, name: path.basename(ws.cwd), state: ws.state || "idle", active: ws.id === activeWs,
  ended: ws.ended && Date.now() - ws.ended.at < 15000 ? ws.ended.how : null }));
const coinsNow = () => { try { return economy.summary(); } catch { return null; } };
// ⭐ 연구 스탬프 · 주간 대발견 (#82, PKM-24): 7 days with a finish → a legend that stays until caught
// (전설의 향's species, else an open one you don't have — all of them had: 200 coins), +100 coins
async function bigShow() {
  const v = await wild.showBig().catch(() => null);
  if (v) { logLine(`wild big ${v.id}${v.shiny ? "s" : ""}`); broadcast("wild", { ...v, balls: ballsOwned() }); overlayUpdate(); }
}
// ✨ 1/64, with 빛나는부적 1/32 (#93, PKM-28 rule 6)
const shinyOdds = () => (economy.charmOn() ? 1 / 32 : 1 / 64);
// the species you have caught (전설의 길 · 리서치 "20종") — from the Pokédex
const caughtSet = () => new Set(partner.dex().entries.filter((e) => e.caught).map((e) => e.id));
// ✦ a research done: its mythical (once nothing else is on screen) and a Master Ball (#86, PKM-27)
function researchCheck() {
  if (wild.bigPending() || wild.current()) return false;
  const r = research.take(partner.ownedSpecies());
  if (!r) return false;
  economy.gift("master");
  send("economy", economy.summary());
  if (r.owned) { logLine(`research ${r.id} done — already with you`); return false; }
  wild.startBig(r.id, Math.random() < shinyOdds(), "research");
  logLine(`research ${r.id} done — encounter`);
  bigShow();
  return true;
}
function bigCheck() {
  if (wild.bigPending()) return bigShow(); // still waiting (shown after another encounter, or offline before)
  if (researchCheck()) return;
  const st = economy.stamps();
  if (st.n < st.need) return;
  economy.breakthrough();
  // 전설의 향's species (even one you have), else an open legend you don't have yet — all had: any open one,
  // a second of it (legends can be had more than once, #87)
  const owned = partner.ownedSpecies(), want = economy.takeLegend(), open = legends.openLegends(caughtSet(), owned).map((l) => l.id);
  const fresh = open.filter((id) => !owned.has(id));
  const pool = want ? [want] : fresh.length ? fresh : open;
  const id = pool[Math.floor(Math.random() * pool.length)];
  wild.startBig(id, Math.random() < shinyOdds());
  logLine(`breakthrough ${id}${want ? " (전설의 향)" : ""}`);
  send("economy", economy.summary());
  return bigShow();
}
// the open legends and whether you have each (the shop's 전설의 향, the bag's choice)
const legendsView = () => { const owned = partner.ownedSpecies(); return legends.openLegends(caughtSet(), owned).map((l) => ({ id: l.id, name: l.name, owned: l.owned })); };
const shopNow = () => ({ ...economy.shopState(), legends: legendsView(), incubator: partner.incubator() });
// 진행 (#88, PKM-30): the incubator · stamps · research for the partner pane, the overlay and the menu bar.
// "soon" = one more to go. Read from what's already kept (nothing new stored); cached until something moves
let progCache = null;
function progressNow() {
  if (progCache && Date.now() - progCache.at < 5000) return progCache.v;
  const v = {};
  try {
    const a = partner.incubator();
    if (a) v.inc = { name: a.active.name, kind: a.active.kind, have: a.active.have, need: a.active.need, waiting: a.waiting, soon: a.active.need - a.active.have === 1 };
  } catch {}
  try { const st = economy.stamps(); v.stamps = { n: st.n, need: st.need, soon: st.n === st.need - 1 }; } catch {}
  try {
    const r = research.view(caughtSet().size, partner.ownedSpecies());
    if (r.title && !r.ready) {
      const done = r.steps.filter((x) => x.done).length, cur = r.steps[done];
      v.research = { name: r.name, title: r.title, done, of: r.steps.length, soon: done === r.steps.length - 1 && !!cur && cur.n - cur.have === 1 };
    }
  } catch {}
  progCache = { at: Date.now(), v };
  return v;
}
// what the overlay shows (#90): an egg in the incubator always, stamps · research when one more to go
const progShown = (v = progressNow()) => !!(v.inc || v.stamps?.soon || v.research?.soon);
function progressBump() { progCache = null; send("progress", progressNow()); overlaySync(); overlayUpdate(); }
// the balls in the bag, for the wild card's ball chips (#76)
const ballsOwned = () => { try { const b = economy.bag(); return { great: b.great || 0, ultra: b.ultra || 0, master: b.master || 0 }; } catch { return {}; } };
const trayNow = () => trayModel({ tabs: trayTabs(), usage: usageSeen, settings, coins: coinsNow(), prog: progressNow(), limits: limitsView() });
function trayAct(act) {
  if (act?.tab) focusMain(String(act.tab));
  else if (act?.set) setSettings(act.set);
  else if (act === "settings") { focusMain(); whenUi(() => send("open-settings", {})); }
  else if (act === "open") focusMain();
  else if (act === "hide") setSettings({ menubar: { on: false } });
  else if (act === "quit") app.quit();
  else if (act === "limits") limitsRefresh({ user: true });
  logLine(`menubar ${typeof act === "string" ? act : Object.keys(act || {})[0] || "-"}`);
}
const trayTemplate = (items) => items.map(({ act, submenu, ...it }) => ({ ...it, ...(submenu ? { submenu: trayTemplate(submenu) } : {}), ...(act ? { click: () => trayAct(act) } : {}) }));
function trayUpdate() {
  // a test app never puts an icon on the menu bar (it would sit on the tester's own) — tray_test reads the model
  if (TEST || draining || !app.isReady()) return;
  if (!settings.menubar.on) { if (tray) { tray.destroy(); tray = null; } return; }
  if (!tray) {
    tray = new Tray(trayIcon(nativeImage));
    tray.setToolTip("Tamer");
    const open = () => { popoverHide(); limitsRefresh(); tray.popUpContextMenu(Menu.buildFromTemplate(trayTemplate(trayNow().items))); }; // #104: older than a minute → read again (shown next time)
    tray.on("click", (_e, bounds) => popoverToggle(bounds)); // left: the dashboard (#105) · right: the menu
    tray.on("right-click", open);
  }
  tray.setTitle(trayNow().title, { fontType: "monospacedDigit" });
}
// ── 채팅 없이 한도 (STA-21, #104 — POL-AGENT-02 rules 1 … 1-6) ──────────────────────────────────
// Codex: its app server, on a timer too. Claude: only when turned on (asked once); the Keychain only when
// it's turned on or the user presses 새로 고침 (tray · 설정 · the top bar's 5h / 7d), the timer uses the
// token kept in memory. Results go to the windows as "limits" — they merge them like an agent's report
const limitsState = { claude: { at: 0, error: null }, codex: { at: 0, error: null } };
let limitsBusy = null, limitsLast = 0, limitsResetTimer = null;
const codexCmd = () => (TEST ? process.env.CVIM_LIMITS_CODEX_CMD || null : agents.where("codex"));
const limitsView = () => ({ codex: settings.limits.codex, claude: settings.limits.claude === true, token: limits.hasToken(), state: limitsState });
async function limitsRefresh({ user = false } = {}) {
  if (limitsBusy) return limitsBusy;
  if (!user && Date.now() - limitsLast < 60000) return limitsView();
  limitsLast = Date.now();
  limitsBusy = (async () => {
    await ready;
    const env = agents.processEnv(), cmd = settings.limits.codex ? codexCmd() : null;
    const jobs = [cmd && ["codex", limits.codex(cmd, env)], settings.limits.claude === true && ["claude", limits.claude(env, { user })]].filter(Boolean);
    for (const [key, job] of jobs) {
      const r = await job;
      limitsState[key] = r.error ? { ...limitsState[key], error: r.error } : { at: Date.now(), error: null };
      if (!r.error) broadcast("limits", { key, five_hour: r.five_hour, seven_day: r.seven_day });
      logLine(`limits ${key} ${r.error || "ok"}${user ? " (asked)" : ""}`);
    }
  })();
  try { await limitsBusy; } finally { limitsBusy = null; }
  send("limits-state", limitsView());
  trayUpdateSoon();
  return limitsView();
}
// a window's reset time passed: read again once (30 s after)
function limitsResetSoon() {
  clearTimeout(limitsResetTimer);
  const now = Date.now(), next = Object.values(usageSeen).flatMap((u) => [u?.five_hour?.resets_at, u?.seven_day?.resets_at])
    .filter((t) => t && t * 1000 > now).sort((a, b) => a - b)[0];
  if (next) limitsResetTimer = setTimeout(() => limitsRefresh(), Math.min(next * 1000 - now + 30000, 2 ** 31 - 1));
}
// rule 1-2: what turning it on means, before anything is read — closing it without an answer = off
async function limitsConsent() {
  if (TEST) { logLine("limits ask"); return process.env.CVIM_TEST_LIMITS_CONSENT === "yes"; }
  const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: "question", buttons: ["켜기", "켜지 않음"], defaultId: 0, cancelId: 1,
    message: "Claude 한도를 대화 없이 볼까요?",
    detail: "켜면 Tamer가 Claude Code의 로그인 정보를 macOS 키체인에서 읽어, Anthropic에 이 계정의 5시간·주간 사용률만 물어봐요.\n\n"
      + "· 보내는 것: 로그인 토큰(Anthropic에만). 대화·폴더·파일은 보내지 않아요\n"
      + "· 토큰은 메모리에만 두고 저장하지 않아요\n"
      + "· 공개되지 않은 주소라 언제든 바뀌거나 막힐 수 있어요. Anthropic 약관상 허용되는지 Tamer는 확인하지 못했어요\n"
      + "· 켤 때와 '한도 새로 고침'을 누를 때 macOS가 키체인 확인 창을 띄울 수 있어요\n"
      + "· 켜지 않으면 지금처럼 Claude가 응답할 때 받은 값을 써요. 설정 › 일반 › 한도에서 언제든 바꿀 수 있어요",
  });
  return r.response === 0;
}
// once, after the window is up: Codex's limits, and the question when there is a Claude Code login and it was never asked
async function limitsStart() {
  await limitsRefresh();
  if (settings.limits.claude !== null || !(await limits.claudeHasLogin(agents.processEnv()))) return;
  const yes = await limitsConsent();
  setSettings({ limits: { claude: yes } });
  if (yes) limitsRefresh({ user: true });
}
setInterval(() => limitsRefresh(), 15 * 60 * 1000); // window or not (#106)

// ── Tamer 밖에서 끝낸 작업 (STA-23, #107 — POL-FUT-05): with the user's yes, the agents' own logs are
// watched (every 3 s, new lines only) and a finish feeds finishGame like a tab's. Not counted: the folder
// has a Tamer tab running that agent (the tab counts it)
let outsideWatch = null, outsideTimer = null;
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const tabHas = (agent, cwd) => {
  const c = realOf(cwd);
  return [...workspaces.values()].some((ws) => realOf(ws.cwd) === c && (ws.shell?.key === agent || ws.sessions?.some((x) => x.running && x.agent === agent)));
};
function outsidePoll() {
  if (!outsideWatch) return;
  for (const d of outsideWatch.poll()) {
    if (tabHas(d.agent, d.cwd)) { logLine(`outside skip ${d.agent}: a tab runs it there`); continue; }
    logLine(`outside done ${d.agent} took=${d.took ?? "-"}`);
    finishGame({ cwd: d.cwd, agent: d.agent, took: d.took, outside: true });
  }
}
function outsideSync() {
  const on = settings.outside === true;
  if (on && !outsideWatch) {
    outsideWatch = outside.createWatch(agents.processEnv()); // from the logs' size now: nothing before counts (rule 4)
    outsideTimer = setInterval(outsidePoll, TEST ? 700 : 3000);
    logLine(`outside on: ${outsideWatch.size()} logs`);
  } else if (!on && outsideWatch) { clearInterval(outsideTimer); outsideWatch = null; logLine("outside off"); }
}
// rule 6: what's read, what isn't, what's kept — before anything is opened; closing it = off
async function outsideConsent() {
  if (TEST) { logLine("outside ask"); return process.env.CVIM_TEST_OUTSIDE_CONSENT === "yes"; }
  const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: "question", buttons: ["켜기", "켜지 않음"], defaultId: 0, cancelId: 1,
    message: "Tamer 밖에서 한 작업도 포켓몬에 반영할까요?",
    detail: "다른 터미널(iTerm 등)·Claude 앱의 Code·Codex 앱에서 끝낸 Claude Code·Codex 작업도 레벨·코인·야생에 반영해요. 탭에서 끝낸 것과 같은 규칙이에요(하루 상한도 함께).\n\n"
      + "· 읽는 곳: 에이전트가 이 맥에 남기는 기록(~/.claude/projects · ~/.codex/sessions)\n"
      + "· 읽는 것: '작업이 끝났다'는 줄의 폴더·걸린 시간·어디서 실행했는지만\n"
      + "· 안 읽는 것: 대화 내용·명령·파일 — 저장·전송도 없어요. 어디까지 읽었는지도 메모리에만\n"
      + "· Tamer가 켜져 있는 동안만 세요(창이 없어도). 스크립트·다른 에이전트가 띄운 실행은 세지 않아요\n"
      + "· 설정 › 일반 › 포켓몬에서 언제든 바꿀 수 있어요",
  });
  return r.response === 0;
}
async function outsideStart() {
  if (settings.outside === null && outside.hasLogs(agents.processEnv())) setSettings({ outside: await outsideConsent() });
  outsideSync();
}

// ── 메뉴바 미니 대시보드 (STA-22, #105): a panel under the icon — doesn't bring Tamer forward, closes when
// another place is clicked (blur), Esc, or the icon again. Its model is redrawn while it's open ─────
const POP_W = 360;
let popoverClosedAt = 0;
function popoverModel() {
  const cur = workspaces.get(activeWs) || null, p = cur?.partner;
  return {
    folder: cur ? path.basename(cur.cwd) : null,
    partner: p ? { name: p.name, gif: p.gif, shiny: p.shiny, lv: p.lv, final: p.final, next: p.next, grad: p.grad, xp: p.xp, egg: p.egg } : null,
    today: (() => { try { return stats.summary(); } catch { return null; } })(), coins: coinsNow(), prog: progressNow(),
    usage: usageSeen, limits: limitsView(), tabs: trayTabs(), wild: wild.current(), balls: ballsOwned(),
    party: partyLite(), recent: recentDone.slice(0, 3), outside: settings.outside, // #107
    eggs: (() => { try { const b = economy.bag(); return { egg: b.egg || 0, egg2: b.egg2 || 0 }; } catch { return { egg: 0, egg2: 0 }; } })(), // 🥚 in the bag (#116)
  };
}
function popoverCreate() {
  popover = new BrowserWindow({
    // panel: like the overlay, a non-activating NSPanel — opening it doesn't bring Tamer's main window forward
    type: "panel", width: POP_W, height: 400, show: false, frame: false, resizable: false, movable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: true, roundedCorners: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1b22" : "#ffffff",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false },
  });
  popover.setAlwaysOnTop(true, "pop-up-menu");
  popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  popover.on("blur", () => { if (!TEST) popoverHide(); });
  popover.webContents.on("will-navigate", (e) => e.preventDefault());
  popover.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  popover.loadFile(path.join(DIST, "popover.html"));
}
// under the icon, kept on the icon's screen
function popoverPlace(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea, [, h] = popover.getSize();
  const x = Math.round(Math.min(Math.max(bounds.x + bounds.width / 2 - POP_W / 2, area.x + 8), area.x + area.width - POP_W - 8));
  popover.setBounds({ x, y: Math.round(bounds.y + bounds.height + 4), width: POP_W, height: h });
}
function popoverShow(bounds) {
  if (!popover || popover.isDestroyed()) popoverCreate();
  popoverPlace(bounds);
  popover.webContents.send("host-event", { event: "popover", payload: popoverModel() });
  if (TEST) popover.showInactive(); else { popover.show(); popover.focus(); }
  limitsRefresh(); // older than a minute → read again (STA-21 rule 3)
  logLine("popover open");
}
function popoverHide() {
  if (!popover || popover.isDestroyed() || !popover.isVisible()) return;
  popover.hide();
  popoverClosedAt = Date.now();
}
// the icon's click also blurs the open dashboard first (closing it): that same click mustn't reopen it
function popoverToggle(bounds) {
  if (popover?.isVisible?.()) return popoverHide();
  if (Date.now() - popoverClosedAt < 300) return;
  popoverShow(bounds || tray?.getBounds?.() || { x: 0, y: 0, width: 0, height: 24 });
}
function popoverUpdate() {
  if (popover && !popover.isDestroyed() && popover.isVisible()) popover.webContents.send("host-event", { event: "popover", payload: popoverModel() });
}

function trayUpdateSoon() {
  if (trayTimer) return;
  trayTimer = setTimeout(() => { trayTimer = null; trayUpdate(); popoverUpdate(); }, 100);
}
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
    endedKind: ws.ended && now - ws.ended.at < 15000 ? ws.ended.kind : null, // #53
    times: shownTimes(ws), // STA-20
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
    wild: settings.overlay.wild ? wild.current() : null, stallMs: STALL_MS, show: settings.overlay, theme: settings.theme, // #59 #60
    prog: settings.overlay.progress ? progressNow() : null, // #88
    // 파티 (#107): only while no tab is open; the last finish outside Tamer / by the party for 15 s
    party: tabs.length ? null : partyLite(), partyNote: recentDone[0] && now - recentDone[0].at < 15000 ? recentDone[0] : null, // (prog above shows under it too, #116)
  };
}

let overlayTimer = null;
function overlayUpdate() {
  trayUpdateSoon(); // the same changes move the menu bar's count
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
  overlaySync(); // a session restored before it existed (#97)
}

// shown while another app is in front — or always (보일 때 #98), or while the right column with the partner
// is folded away (#97) — and there's something to show
// focused: is a Tamer window in front · quiet: a test window (never focused — its overlay shows only when a
// test asks: it sat on the user's screen)
function overlayWants({ focused = !!BrowserWindow.getFocusedWindow(), quiet = QUIET_TEST } = {}) {
  const o = settings.overlay, away = (!focused || o.when === "always" || !settings.side) && !quiet;
  // the 설정 창 (#59): off, or nothing chosen to show (a wild card counts only while one is out)
  const something = o.partner || o.alerts || (o.wild && wild.current()) || (o.progress && progShown()); // #88 #90: the progress line alone
  // no tab (in the menu bar only, #106): the party shows instead (#107, STA-15 rule 11)
  return !!((away || overlayForced) && (workspaces.size || (o.partner && partner.party().list.length)) && o.on && something);
}
let overlayFront = null; // tests: would it show with Tamer in front — logged when it changes (#97)
function overlaySync() {
  if (!overlay || overlay.isDestroyed()) return;
  if (draining) { overlay.hide(); return; } // quitting (#54): the hidden window's blur mustn't bring it back
  if (QUIET_TEST) { const f = overlayWants({ focused: true, quiet: false }); if (f !== overlayFront) logLine(`overlay front=${overlayFront = f}`); }
  if (overlayWants()) {
    overlayUpdate();
    if (!overlay.isVisible()) overlay.showInactive();
  } else if (overlay.isVisible()) overlay.hide();
}
let overlayForced = false; // tests

function focusMain(wsId) {
  if (!win || win.isDestroyed()) { if (app.isReady()) createMain(); return; } // in the menu bar only (#106): open it again (last tabs back)
  if (win.isMinimized()) win.restore();
  if (QUIET_TEST) { win.showInactive(); if (wsId && workspaces.has(wsId)) send("select-tab", { ws: wsId }); return; }
  win.show();
  app.focus({ steal: true });
  win.focus();
  if (wsId && workspaces.has(wsId)) send("select-tab", { ws: wsId });
}

// what the overlay page may ask for (nothing that runs or reads anything else)
let drag = null;
// the dashboard page (popover.html) may call only these (POL-SEC-02)
const popoverCommands = {
  popover_state: () => popoverModel(),
  popover_fit({ height }) {
    if (!popover || popover.isDestroyed()) return;
    const b = popover.getBounds(), area = screen.getDisplayMatching(b).workArea;
    const h = Math.round(Math.min(Math.max(Number(height) || 0, 80), area.y + area.height - b.y - 8));
    if (h !== b.height) popover.setBounds({ ...b, height: h });
  },
  popover_hide: () => popoverHide(),
  popover_tab({ ws }) { popoverHide(); focusMain(String(ws)); },
  popover_open() { popoverHide(); focusMain(); },
  popover_quit() { popoverHide(); logLine("popover quit"); app.quit(); }, // 완전히 끄기 — as ⌘Q / the menu's Tamer 종료
  popover_party() { popoverHide(); focusMain(); whenUi(() => send("open-dex", { view: "party" })); }, // ⭐ 파티 (#107)
  party_set: (args) => commands.party_set(args), // 선두 바꾸기 right there (#112) — partner.partySet checks the list
  // 🥚 알 넣기 right there (#116, PKM-30 rule 9): an egg from the bag into the incubator — eggs only, as the bag does it
  async egg_in({ kind }) {
    if (kind !== "egg" && kind !== "egg2") return { ok: false };
    const r = await commands.bag_use({ item: kind });
    popoverUpdate(); overlayUpdate();
    return { ok: !!r?.ok, incubator: r?.incubator || null };
  },
  popover_settings() { popoverHide(); focusMain(); whenUi(() => send("open-settings", {})); },
  popover_dex({ id }) { popoverHide(); focusMain(); whenUi(() => send("open-dex", { id: Number(id) || null })); },
  popover_log({ line }) { logLine(`popover ${String(line).slice(0, 120)}`); },
  limits_refresh: () => limitsRefresh({ user: true }), // pressed in the dashboard = the user's 새로 고침 (STA-21)
  sprite_b64: (args) => commands.sprite_b64(args),
  wild_throw: (args) => commands.wild_throw(args),
};

const overlayCommands = {
  overlay_state: () => overlayPayload(),
  overlay_click({ ws }) { focusMain(String(ws)); },
  // the wild notice (#66): Tamer in front (keyboard included) — its own wild card shows there, to catch
  wild_open() { if (!settings.side) setSettings({ side: true }); focusMain(); logLine("wild open from overlay"); }, // the wild card is in the right column (#97)
  // the hatch notice (#88): Tamer, on 🎒 내 포켓몬 where the hatchling is
  hatch_open() { focusMain(); send("open-dex", { view: "box" }); logLine("hatch open from overlay"); },
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
// each pane, and folders must be real directories (docs/policy POL-SEC-02). A compromised page can't do more.
// ⌘-clicked files opened with macOS's default app (a browser for index.html, Preview …) instead of
// the editor, as in iTerm2 (#57); code and text keep going to the editor at their line
const OPEN_DEFAULT = new Set([".html", ".htm", ".svg", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".mp4", ".mov", ".webm", ".mp3", ".wav", ".m4a"]);
const commands = {
  // 설정 창 (APP-19): read, and change (only known keys survive readSettings)
  settings_get: () => settings,
  // turning 'Claude 한도' on asks first (POL-AGENT-02 rule 1-2); off forgets the token at once
  async settings_set({ patch }) {
    let p = patch && typeof patch === "object" ? patch : {};
    const on = p.limits?.claude === true && settings.limits.claude !== true;
    if (on && !(await limitsConsent())) p = { ...p, limits: { ...p.limits, claude: false } };
    if (p.limits?.claude === false) limits.forget();
    // 'Tamer 밖 작업도 포켓몬에' (STA-23 rule 6): turning it on shows what's read first
    if (p.outside === true && settings.outside !== true && !(await outsideConsent())) p = { ...p, outside: false };
    const s = setSettings(p);
    if (on && s.limits.claude) limitsRefresh({ user: true });
    if ("outside" in p) outsideSync();
    return s;
  },
  // 한도 새로 고침 (#104): user = pressed by the user (the only time the Keychain is read, besides turning it on)
  limits_refresh: ({ user } = {}) => limitsRefresh({ user: !!user }),
  limits_state: () => limitsView(),
  // 파티 (PKM-31, #107): the list and its changes (checked by partner.partySet); everyone showing it hears
  party_state: () => ({ ...partner.party(), recent: recentDone }),
  party_set({ uids }) { const v = partner.partySet(uids); logLine(`party ${v.list.map((m) => m.uid).join(",") || "-"}`); broadcast("party", v); popoverUpdate(); overlayUpdate(); return v; },
  // 메뉴바 (STA-19): the last 5h · 7d the window remembers for an agent — numbers only, kept in memory
  usage_seen({ key, five_hour, seven_day }) {
    if (!TRAY_AGENTS.some(([k]) => k === key)) return;
    const win = (w) => (w && Number.isFinite(Number(w.pct)) ? { pct: Number(w.pct), resets_at: Number.isFinite(Number(w.resets_at)) && w.resets_at != null ? Number(w.resets_at) : null } : null);
    usageSeen[key] = { five_hour: win(five_hour), seven_day: win(seven_day) };
    trayUpdateSoon();
    limitsResetSoon();
  },
  startup_mark({ what }) { logLine(`startup ${String(what).slice(0, 40)} +${since()}ms`); },
  app_info() {
    uiReady = true;
    sessionKept = false; // this window shows the tabs now (#106)
    setTimeout(() => { for (const fn of uiQueue.splice(0)) fn(); }, 600);
    const start = TEST && process.env.CVIM_DESKTOP_DIRS ? process.env.CVIM_DESKTOP_DIRS.split(":")
      : process.env.CVIM_DESKTOP_DIR ? [process.env.CVIM_DESKTOP_DIR] : [];
    const handed = [...start, ...pendingOpen.splice(0)].filter(isDir);
    // nothing handed to the app: reopen last time's tabs (session restore)
    const saved = readJsonSafe(SESSION);
    const sess = !start.length && !process.env.CVIM_DESKTOP_NO_RESTORE && !saved?.quit ? saved : null;
    const restored = sess?.tabs?.filter(isDir) || [];
    const open = [...new Set([...restored, ...handed])];
    return {
      stallMs: STALL_MS, // STA-20
      home: (TEST && process.env.CVIM_DESKTOP_TEST_HOME) || HOME, shell: agents.userShell(), recent: recentDirs(), open,
      // in front: the folder handed in (dropped on the app to launch it), else last time's front tab
      front: handed.at(-1) || (restored.length ? sess.active : null),
      restored: restored.length ? { tabs: restored, active: sess.active, sessions: sess.sessions || {}, shell: sess.shell || [], names: sess.names || {} } : null,
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
        choose_shot: !!process.env.CVIM_DESKTOP_CHOOSE_SHOT, // the partner dialog, captured (UI checks)
        lab: (() => { try { return JSON.parse(process.env.CVIM_LAB_STEPS || "null"); } catch { return null; } })(), // npm run lab
        first_launch: !!process.env.CVIM_DESKTOP_FIRST_LAUNCH, // as a first launch (the agents dialog), nothing scripted
        drop_check: !!process.env.CVIM_DESKTOP_DROP_CHECK, // a folder dropped on the app to launch it
        first_run: !!process.env.CVIM_DESKTOP_FIRST_RUN, // a new user's first launch (agents dialog + first partner)
        ui_scenes: UI_SCENES, // npm run ui:shots: "newuser" / "owner" scene sets
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
    // tests: no system dialog — the folder the case names (CVIM_DESKTOP_TEST_CHOOSE), or "cancelled"
    if (TEST) { logLine(`choose_folder (test) ${process.env.CVIM_DESKTOP_TEST_CHOOSE || "cancel"}`); return process.env.CVIM_DESKTOP_TEST_CHOOSE || null; }
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
  // tests never touch the system clipboard (CLAUDE.md): the test copy only says what it would copy
  copy_text({ text }) { if (TEST) return void logLine(`copy_text ${JSON.stringify(String(text))}`); clipboard.writeText(String(text)); },
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
  session_name({ session, name }) { const x = sessions.get(session); if (!x) return null; x.name = sessionName(name) || undefined; saveSession(); return x.name || null; }, // #99
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
    if (key === "claude") return claudeLinkAsk(); // #45
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
  // #45: undo the opt-in shell line (the marked block only; a copy of the file is kept first)
  async agent_unfix({ key }) {
    if (key !== "claude") throw new Error("nothing to undo");
    const f = agents.claudeLinkFile();
    const r = await dialog.showMessageBox(win, { type: "question", buttons: ["해제", "취소"], defaultId: 0, cancelId: 1,
      message: "셸에서 친 Claude 연결을 해제할까요?", detail: `${f?.file?.replace(HOME, "~")}에서 Tamer가 넣은 블록만 지워요(지우기 전 파일 사본: ~/.cache/tamer/backup/shell-rc). 새로 여는 셸부터 적용돼요.` });
    if (r.response !== 0) return { ok: false, cancelled: true };
    try { const u = agents.claudeUnlink(); logLine(`claude unlink ${u.absent ? "absent" : "ok"}`); relinkShown(); return { ok: true, msg: "해제했어요 — 새로 여는 셸부터" }; }
    catch (e) { logLine(`claude unlink error ${e.code || e.message}`); return { ok: false, msg: `해제하지 못했어요: ${e.message}` }; }
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
    const editor = st.isDirectory() ? "finder" : OPEN_DEFAULT.has(path.extname(p).toLowerCase()) ? "default" : editorApp();
    logLine(`open file (${editor})`); // not the path: the log goes into the diagnostics
    if (TEST) { linksOpened.push(`${editor}:${p}:${ln}:${cl}`); return; }
    if (editor === "finder" || editor === "default") return shell.openPath(p); // a folder in Finder, a web page / picture / video in its own app (#57)
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
  // 🎓 the graduation band's answer (#84): keep it, or let it rest and choose a new partner
  partner_grad({ ws: id, keep }) {
    const ws = wsOf(id);
    const ok = partner.gradChoice(ws.cwd, !!keep);
    logLine(`grad ${keep ? "keep" : "rest"} ws=${ws.id} ${ok ? "ok" : "-"}`);
    if (ok && !keep) noPartner(ws);
    return ok;
  },
  // { starter: id } | { uid } — the rules are checked in partner.take
  partner_take({ ws, starter, uid }) { return partnerTake(wsOf(ws), starter != null ? { starter } : { uid }); },
  dex_list: () => partner.dex(),
  // model prices for an estimated cost (#23), fetched only when asked (an agent without its own cost)
  prices: () => prices.get(),
  dex_viewed: ({ id }) => partner.viewed(id),
  box_list: ({ ws }) => partner.boxList(ws && workspaces.has(ws) ? wsOf(ws).cwd : null) // "내 포켓몬" (#27)
    .map((m) => (m.caughtBy ? { ...m, caughtBy: agents.all()[m.caughtBy]?.name || m.caughtBy } : m)), // the agent's name (#44)
  // 🏠 Home (#44): tasks finished today, the streak, the last 7 days
  // tests: a fixed "today" (CVIM_TEST_TODAY, YYYY-MM-DD) so the 7-day row's weekdays don't move with the calendar
  home_state: () => stats.summary(TEST && process.env.CVIM_TEST_TODAY ? new Date(`${process.env.CVIM_TEST_TODAY}T12:00`) : undefined),
  // 🪙 포켓코인 (#72): the balance, today's, the 시작 코인 band (until closed) — read only, the main process writes
  economy_state: () => economy.summary(),
  economy_start_seen: () => economy.dismissStart(),
  // 🛒 상점 · 👜 가방 (#76, PKM-22·23): the screen asks, the main process checks and writes (POL-SEC-02)
  shop_state: () => shopNow(),
  incubator_state: () => partner.incubator(), // 🥚 (#85)
  // 먼저 부화 (#88): a waiting egg into the incubator, the one there next in line
  incubator_first({ uid }) {
    const inc = partner.incubatorFirst(uid);
    logLine(`incubator first ${uid} ${inc ? "ok" : "no"}`);
    if (inc) { send("incubator", inc); progressBump(); }
    return { ok: !!inc, incubator: inc, ...shopNow() };
  },
  progress_state: () => progressNow(), // #88
  stone_options: ({ uid }) => partner.stoneOptions(uid), // 💎 its stages to choose from (#93)
  // 전설의 길 · 리서치 (#86): each generation's share and legends, the research's steps
  legend_road: () => { const c = caughtSet(), owned = partner.ownedSpecies(); return { road: legends.road(c, owned), research: research.view(c.size, owned) }; },

  shop_buy({ item, n }) {
    const r = economy.buy(String(item), Number(n));
    logLine(`shop buy ${item} ×${n} ${r.ok ? "ok" : r.why}`);
    if (r.ok) send("economy", economy.summary());
    return r.ok ? { ...r, ...shopNow() } : r;
  },
  async bag_use({ item, uid, id, to, ws: wsId }) {
    if (item === "egg" || item === "egg2") { // 🥚 into the incubator (#85) — behind any egg already there
      if (!economy.use(item)) return { ok: false, why: "none", ...shopNow() };
      const inc = partner.incubatorAdd(item);
      logLine(`bag use ${item} incubator ${JSON.stringify(inc?.active)} waiting=${inc?.waiting}`);
      send("economy", economy.summary()); send("incubator", inc); progressBump();
      return { ok: true, incubator: inc, ...shopNow() };
    }
    if (item === "legend") { // 전설의 향 on one open legend you don't have (#82) — used when the breakthrough comes
      const ok = legendsView().some((l) => l.id === Number(id)) && economy.setLegend(Number(id)); // any open one, had or not (#87)
      logLine(`bag use legend ${id} ${ok ? "ok" : "no"}`);
      if (ok) send("economy", economy.summary());
      return { ok, ...shopNow() };
    }
    if (item === "incense") {
      const until = economy.burnIncense();
      logLine(`bag use incense ${until ? "ok" : "none"}`);
      if (until) send("economy", economy.summary());
      return { ok: !!until, until, ...shopNow() };
    }
    if (item === "stone") { // 💎 진화의 돌 (#93, PKM-28): the chosen stage now — the stone is used once it worked
      if (!(economy.bag().stone > 0)) return { ok: false, why: "none", ...shopNow() };
      const r = await partner.stoneEvolve(uid, to);
      if (!r || r.offline) { logLine(`bag use stone uid=${uid} to=${to} ${r?.offline ? "offline" : "no"}`); return { ok: false, why: r?.offline ? "offline" : "no", ...shopNow() }; }
      economy.use("stone");
      let newCoins = 0; for (let i = 0; i < (r.evoNew || 0); i++) newCoins += economy.onNewDex(); // a species new to the Pokédex: +30 more each (#94)
      const coins = economy.onEvolve() + newCoins;
      if (research.onEvolve(caughtSet().size)) researchCheck();
      logLine(`bag use stone uid=${uid} to=${r.evolved.id}`);
      const ws = r.folder && [...workspaces.values()].find((w) => w.cwd === r.folder);
      if (ws) {
        ws.partner = { ...r.evolved, ...partner.progress(ws.cwd) }; overlayUpdate();
        send("partner-progress", { ws: ws.id, ...partner.progress(ws.cwd), evolved: r.evolved, from: r.from || null, coins, newCoins, mile: null, mileCoins: 0, graduated: false, gradCoins: 0 });
      }
      send("economy", economy.summary()); progressBump();
      return { ok: true, uid: r.uid, lv: r.lv, evolved: { id: r.evolved.id, name: r.evolved.name, gif: r.evolved.gif || null }, from: r.from ? { id: r.from.id, name: r.from.name, gif: r.from.gif || null } : null, coins, newCoins, ...shopNow() };
    }
    if (item !== "candy") return { ok: false, why: "unknown" };
    if (!partner.candyOk(uid)) return { ok: false, why: "lv" };
    if (!economy.use("candy")) return { ok: false, why: "none" };
    const r = await partner.candy(uid);
    const newCoins = r?.evolved && r.evoNew ? economy.onNewDex() : 0; // #94
    const coins = (r?.evolved ? economy.onEvolve() : 0) + newCoins;
    if (r?.evolved && research.onEvolve(caughtSet().size)) researchCheck(); // ✦ (#86)
    const gradCoins = r?.graduated ? economy.graduated() : 0; // 🎓 a candy to Lv 100 (#84)
    const mileCoins = (r?.miles || []).reduce((s) => s + economy.onMilestone(), 0);
    logLine(`bag use candy uid=${uid} lv=${r?.lv} evolved=${r?.evolved?.id ?? "-"} miles=${(r?.miles || []).join(",") || "-"}`);
    // a folder's partner: its pane shows the new level (and the evolution) like after a finish
    const ws = r?.folder && [...workspaces.values()].find((w) => w.cwd === r.folder);
    if (ws) {
      if (r.evolved) { ws.partner = { ...r.evolved, ...partner.progress(ws.cwd) }; overlayUpdate(); }
      send("partner-progress", { ws: ws.id, ...partner.progress(ws.cwd), evolved: r.evolved || null, from: r.from || null, coins, newCoins, mile: r.miles.at(-1) || null, mileCoins, graduated: !!r.graduated, gradCoins });
    }
    send("economy", economy.summary());
    return { ok: true, uid: r?.uid, lv: r?.lv, evolved: r?.evolved ? { id: r.evolved.id, name: r.evolved.name } : null, coins, newCoins, mileCoins, ...shopNow() };
  },
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
  wild_state: () => ({ enabled: wild.enabled(), current: wild.current(), balls: ballsOwned() }),
  wild_toggle() { const on = wild.setEnabled(!wild.enabled()); overlayUpdate(); return on; },
  // ball: "poke" (free) or one from the bag (#76) — taken from the bag only when the throw goes ahead
  wild_throw({ token, ball = "poke" }) {
    const r = wild.throwBall(String(token), String(ball), (b) => economy.use(b));
    r.balls = ballsOwned();
    if (r.ball && r.ball !== "poke" && r.result !== "noball") send("economy", economy.summary());
    if (r.newdex) { r.coins = economy.onNewDex(); send("economy", economy.summary()); } // a species never caught before: 🪙 +₽30 (#72)
    if (r.result === "caught") { research.onCatch(caughtSet().size); progressBump(); } // ✦ "20종 잡기" — its encounter after this one ends (#86)
    logLine(`wild throw ${r.result} shakes=${r.shakes}${r.coins ? ` coins=${r.coins}` : ""}`);
    if (r.result !== "gone") broadcast("wild-throw", r);
    return r;
  },
};

let backgroundTested = false;
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
  // the window's inner size (lab: narrow windows)
  win_resize_test({ w, h }) { win.setContentSize(Math.max(200, Number(w) || 800), Math.max(200, Number(h) || 600)); },
  // a UI scene: this window as a picture in $CVIM_DESKTOP_SHOTS/<name>.png, and how much of it differs
  // from $CVIM_UI_BASELINE/<name>.png (share of pixels whose colour moved more than a little)
  async ui_shot({ name, target }) {
    const n = String(name).replace(/[^\w-]/g, "");
    const wc = (target === "overlay" && overlay ? overlay : target === "popover" && popover ? popover : win).webContents; // the overlay's own page (STA-20) · the dashboard's (#105)
    wc.invalidate(); await new Promise((r) => setTimeout(r, 120)); // paint the current scene first, not a stale frame
    const img = await wc.capturePage();
    if (process.env.CVIM_DESKTOP_SHOTS) fs.writeFileSync(path.join(process.env.CVIM_DESKTOP_SHOTS, `${n}.png`), img.toPNG());
    const basePath = process.env.CVIM_UI_BASELINE && path.join(process.env.CVIM_UI_BASELINE, `${n}.png`);
    if (!basePath || !fs.existsSync(basePath)) return { name: n, diff: null };
    const base = nativeImage.createFromPath(basePath), a = img.getSize(), b = base.getSize();
    if (a.width !== b.width || a.height !== b.height) return { name: n, diff: 1, note: `size ${b.width}x${b.height} → ${a.width}x${a.height}` };
    const x = img.toBitmap(), y = base.toBitmap();
    // also where: a few changed words are a tiny share of the window but crowd one spot (2026-10-06:
    // "· 4분째" in the top bar was 0.08 % — "same"). block = the most changed 24-pixel square's share
    const B = 24, cols = Math.ceil(a.width / B), blocks = new Uint32Array(cols * Math.ceil(a.height / B));
    let changed = 0;
    for (let i = 0; i < x.length; i += 4) {
      if (Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2])) > 24) {
        changed++;
        const p = i / 4;
        blocks[Math.floor(Math.floor(p / a.width) / B) * cols + Math.floor((p % a.width) / B)]++;
      }
    }
    return { name: n, diff: changed / (x.length / 4), block: Math.max(...blocks) / (B * B) };
  },
  // the Pokédex on a species, as the wild card's "도감에서 보기" (#25) asks
  wild_dex_test({ id }) { focusMain(); send("open-dex", { id: Number(id) || null }); },
  wild_open_test: () => overlayCommands.wild_open(),
  hatch_open_test: () => overlayCommands.hatch_open(), // #88
  charm_test: () => ({ charm: economy.charmOn(), odds: shinyOdds() }), // ✨ (#93)
  // the pointer over the current tab's partner / gone (scenes, #68)
  // 메뉴바 (#64): the icon's text and the menu as data (a test app shows no icon); a menu item's click by its labels
  tray_test: () => ({ shown: !!tray, ...trayNow() }),
  // 대시보드 (#105): open / close as the icon's left click would (a test app has no icon — a fixed place),
  // its text and buttons as shown, a click on one of them
  // the main window closed as by its red button (#106: off → the app ends)
  win_close_test() { setTimeout(() => win.close(), 100); },
  // 백그라운드 (#106): close the window, then — the page is gone, so from here — the dashboard's
  // [Tamer 열기] brings a window back; each step logged ("bg …"), "bg-done" at the end
  // once: the window opened again runs the case's steps from the top
  background_test() {
    if (backgroundTested) return;
    backgroundTested = true;
    const T = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      await T(100); win.close(); await T(1500);
      logLine(`bg closed win=${!!win} tabs=${workspaces.size} popover=${!!popover && !popover.isDestroyed()} saved=${(readJsonSafe(SESSION)?.tabs || []).length} quit=${!!readJsonSafe(SESSION)?.quit}`);
      logLine(`bg overlay alive=${!!overlay && !overlay.isDestroyed()} wants=${overlayWants({ focused: false, quiet: false })} party=${overlayPayload().party?.list.length ?? "-"}`); // #107
      // the overlay as it looks now — the party card, no tab (#109): a picture beside the run, and its size vs the cards'
      overlayForced = true; overlaySync(); overlayUpdate(); await T(2500);
      const fit = await overlay.webContents.executeJavaScript(`(() => { const s = document.getElementById("stack"), r = s.getBoundingClientRect(); return { win: [innerWidth, innerHeight], stack: [Math.round(r.width), Math.round(r.height)], scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] }; })()`);
      logLine(`bg overlay fit ${JSON.stringify(fit)} bounds=${JSON.stringify(overlay.getBounds())}`);
      if (process.env.CVIM_DESKTOP_SHOTS) fs.writeFileSync(path.join(process.env.CVIM_DESKTOP_SHOTS, "bg-overlay.png"), (await overlay.webContents.capturePage()).toPNG());
      // a finish outside Tamer with a wild one out (CVIM_WILD_CHANCE=1 in the case): the notice over the party (#109)
      if (process.env.CVIM_WILD_CHANCE === "1") {
        finishGame({ cwd: "/tmp/tamer-lab-outside", agent: "claude", took: 60000, outside: true }); await T(3000);
        const fit2 = await overlay.webContents.executeJavaScript(`(() => { const s = document.getElementById("stack"), r = s.getBoundingClientRect(), n = document.querySelector(".wild-note"), nr = n?.getBoundingClientRect(), t = n?.querySelector(".wild-note-text");
          return { win: [innerWidth, innerHeight], stack: [Math.round(r.width), Math.round(r.height)], note: nr ? [Math.round(nr.left), Math.round(nr.top), Math.round(nr.width), Math.round(nr.height)] : null, text: t ? [t.scrollWidth, t.clientWidth, t.innerText] : null }; })()`);
        logLine(`bg overlay wild ${JSON.stringify(fit2)} bounds=${JSON.stringify(overlay.getBounds())}`);
        if (process.env.CVIM_DESKTOP_SHOTS) fs.writeFileSync(path.join(process.env.CVIM_DESKTOP_SHOTS, "bg-overlay-wild.png"), (await overlay.webContents.capturePage()).toPNG());
      }
      overlayForced = false; overlaySync();
      popoverShow({ x: 900, y: 0, width: 24, height: 24 }); await T(1500);
      const ok = await popover.webContents.executeJavaScript(`(() => { const b = document.querySelector("#pop-open"); if (b) b.click(); return !!b; })()`);
      await T(6000);
      logLine(`bg reopened click=${ok} win=${!!win && !win.isDestroyed()} tabs=${workspaces.size} overlay=${!!overlay && !overlay.isDestroyed()}`);
      logLine("bg-done");
    })();
  },
  popover_test({ open }) { if (open) popoverShow({ x: 900, y: 0, width: 24, height: 24 }); else popoverHide(); return { open: !!popover?.isVisible?.() }; },
  popover_read_test: () => (popover?.isVisible?.() ? popover.webContents.executeJavaScript(`({ text: document.querySelector("#pop").innerText,
    tabs: [...document.querySelectorAll(".pop-tab")].map((b) => b.innerText.replace(/\\s+/g, " ").trim()),
    wild: !document.querySelector("#pop-wild .wild-card")?.hidden, height: innerHeight })`) : null),
  popover_click_test: ({ sel }) => popover.webContents.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(String(sel))}); if (b) b.click(); return !!b; })()`),
  // 한도 (#104): what was read and how often the token was — counts only, never a value; status = the stand-in's answer
  // Tamer 밖 작업 (#107): a line appended to a log as an agent would write it — only under the test's own
  // CLAUDE_CONFIG_DIR / CODEX_HOME — and the watcher's next look right away
  outside_append_test({ agent, rel, lines }) {
    const root = outside.roots(agents.processEnv())[agent === "codex" ? "codex" : "claude"], f = path.join(root, String(rel));
    if (!f.startsWith(root + path.sep)) return false;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tab = [...workspaces.values()][0]?.cwd || ""; // "$tab": the first tab's folder (a case can't know its path)
    fs.appendFileSync(f, (lines || []).map((l) => (typeof l === "string" ? l : JSON.stringify(l)).replaceAll("$tab", tab) + "\n").join(""));
    outsidePoll();
    return true;
  },
  // 파티 (#107): the first n of the box as the party (a test can't pick uids)
  party_test({ n = 2 }) { const b = partner.boxList(null).filter((m) => !m.egg).slice(0, Number(n)); return partner.partySet(b.map((m) => m.uid)); },
  overlay_payload_test: () => ({ wants: overlayWants({ focused: false, quiet: false }), ...overlayPayload() }),
  // the overlay's page as drawn: its bubbles (and whether they pop again) and the evolution notice (#111 #114)
  overlay_pop_test: () => overlay.webContents.executeJavaScript(`({ bubbles: [...document.querySelectorAll("#cards .bubble")].map((b) => b.textContent.trim() + (b.classList.contains("seen") ? " [seen]" : "")),
    evolve: document.querySelector("#evolve .wild-note")?.innerText.replace(/\\s+/g, " ").trim() || null })`),
  // an evolution while Tamer isn't in front, as finishGame tells it (#111) — and the overlay's picture of it
  async evolved_note_test({ from = "파이리", to = "리자드", gif = null } = {}) {
    const g = gif || partner.boxList(null).find((m) => m.gif)?.gif || null;
    broadcast("evolved", { from, to, gif: g, coins: 30, outside: true, via: "party" });
    await new Promise((r) => setTimeout(r, 900));
    if (process.env.CVIM_DESKTOP_SHOTS) fs.writeFileSync(path.join(process.env.CVIM_DESKTOP_SHOTS, "overlay-evolve.png"), (await overlay.webContents.capturePage()).toPNG());
    return true;
  },
  // auto: the timer's read now (as if a minute had passed — the Keychain must not be touched)
  async limits_test({ status, auto } = {}) {
    if (status != null) limits.setTestStatus(status);
    if (auto) { limitsLast = 0; await limitsRefresh(); }
    return { ...limitsView(), keychainReads: limits.test.keychainReads, fetches: limits.test.fetches, settings: settings.limits }; },
  tray_click_test({ path: labels }) {
    let items = trayNow().items, it = null;
    for (const l of labels || []) { it = items.find((x) => x.label === l); items = it?.submenu || []; }
    if (it?.act) trayAct(it.act);
    return !!it?.act;
  },
  overlay_hover_test: ({ on }) => overlay.webContents.executeJavaScript(on
    ? `document.querySelector("#cards .card.current .sprite")?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }))`
    : `document.dispatchEvent(new MouseEvent("mouseleave"))`),
  // the minimal mode's hover line (#68): the pointer over the partner — the line shows, and neither the
  // window (a resize draws a frame from the top-left: the partner jumped) nor the partner moves
  async overlay_tip_test() {
    const js = (code) => overlay.webContents.executeJavaScript(code);
    const where = () => js(`(() => { const s = document.querySelector("#cards .card.current .sprite")?.getBoundingClientRect();
      return s ? [Math.round(innerWidth - s.right), Math.round(innerHeight - s.bottom)] : null; })()`);
    const b0 = overlay.getBounds(), p0 = await where();
    await js(`document.querySelector("#cards .card.current .sprite")?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 400));
    const tip = await js(`document.getElementById("tip").textContent`), b1 = overlay.getBounds(), p1 = await where();
    await js(`document.dispatchEvent(new MouseEvent("mouseleave"))`);
    await new Promise((r) => setTimeout(r, 400));
    const b2 = overlay.getBounds();
    return { tip, same: [b0, b1, b2].every((b) => JSON.stringify(b) === JSON.stringify(b0)), bounds: [b0, b1, b2].map((b) => `${b.x},${b.y},${b.width}x${b.height}`), partner: [p0, p1] };
  },
  // what the overlay page shows (#63 #66): minimal mode, balls, words, the wild notice, the shadow
  overlay_dom_test: () => overlay.webContents.executeJavaScript(`(() => {
    const st = document.getElementById("stack"), card = document.querySelector("#cards .card"), note = document.querySelector(".wild-note");
    return { minimal: st.classList.contains("ov-minimal"), balls: [...document.querySelectorAll(".ball")].map((b) => b.className.replace(/ball|hit/g, "").trim()),
      minis: document.querySelectorAll(".mini").length, meta: !!document.querySelector(".card .meta"), counts: !!document.querySelector(".counts"),
      bubbles: [...document.querySelectorAll(".bubble")].map((b) => b.textContent.trim()), shadow: card ? getComputedStyle(card).boxShadow : null,
      bg: card ? getComputedStyle(card).backgroundColor : null, note: note ? note.textContent.replace(/\\s+/g, " ").trim() : null,
      noteShadow: note ? getComputedStyle(note).boxShadow : null, noteBg: note ? getComputedStyle(note).backgroundColor : null, // #92
      prog: document.querySelector(".ov-prog")?.textContent || null, progMini: document.querySelector(".ov-prog-mini")?.textContent || null, // #88 #90
      progTip: document.querySelector(".ov-prog-mini")?.dataset.tip || null,
      hatch: document.querySelector(".wild-note.hatch")?.textContent.replace(/\\s+/g, " ").trim() || null };
  })()`),
  // a mouse click at a point in the window (modifiers: 4 = ⌘) (#19)
  async click_test({ x, y, modifiers = 0, button = "left", count = 1 }) {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
    await new Promise((r) => setTimeout(r, 120)); // the link under the pointer is looked up on move
    for (let n = 1; n <= count; n++) { // count 2 = a double-click (the second press says clickCount 2)
      await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, modifiers, button, clickCount: n });
      await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, modifiers, button, clickCount: n });
    }
  },
  // the (test) pointer to a corner of the page: no :hover left on a scene by wherever the real mouse is
  async mouse_park_test() {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  },
  // a mouse drag from (x1, y1) to (x2, y2) with the left button held — selecting text as a hand does (TRM-04)
  async drag_test({ x1, y1, x2, y2 }) {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    const ev = (type, x, y, extra = {}) => dbg.sendCommand("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });
    await ev("mouseMoved", x1, y1, { button: "none" });
    await ev("mousePressed", x1, y1, { clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 6; i++) { await ev("mouseMoved", x1 + ((x2 - x1) * i) / 6, y1 + ((y2 - y1) * i) / 6, { buttons: 1 }); await new Promise((r) => setTimeout(r, 30)); }
    await ev("mouseReleased", x2, y2, { clickCount: 1, buttons: 0 });
  },
  // Finder files dropped at (x, y) — the real drag path (dragenter/over/drop with File objects) (TAB-07)
  async drop_test({ x, y, files }) {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    const data = { items: [], files: files.map(String), dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) await dbg.sendCommand("Input.dispatchDragEvent", { type, x, y, data });
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
  // #45: the opt-in shell line without its dialog (lab: the line goes into the sandbox shell's ZDOTDIR)
  claude_link_test({ on }) { const r = on ? agents.claudeLink() : agents.claudeUnlink(); relinkShown(); return r; },
  // an agent's state changes as the core would report it
  // hold: keep this state — the core's own updates for that tab are ignored until a call without hold
  // (UI scenes: the core's idle came between setting a state and the picture)
  agent_state_test({ ws, from, to, times, hold }) {
    if (hold) heldStates.add(String(ws)); else heldStates.delete(String(ws));
    onCoreEvent({ event: "state", ws: String(ws), payload: { state: String(to), ...(times || {}) }, test: true });
    onCoreEvent({ event: "transition", ws: String(ws), from: String(from), to: String(to), test: true });
  },
  // 🥚 an egg straight into the incubator with some progress (UI scenes, #85)
  incubator_add_test({ kind = "egg", have = 0 }) {
    partner.incubatorAdd(kind);
    for (let i = 0; i < have; i++) partner.incubatorStep();
    send("incubator", partner.incubator()); progressBump();
    return partner.incubator();
  },
  // 🪙 finishes counted straight into the ledger (UI scenes: today's coins without touching EXP or stats)
  economy_earn_test({ n = 1, took = null }) {
    for (let i = 0; i < Math.min(500, Number(n) || 0); i++) economy.onDone({ took });
    send("economy", economy.summary());
    return economy.summary();
  },
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
  overlay_visible_test: () => !!overlay && !overlay.isDestroyed() && overlay.isVisible(),
  overlay_want_test: ({ focused }) => overlayWants({ focused: !!focused, quiet: false }), // would it show with Tamer in front / not (#97 #98)
  overlay_payload_test: () => overlayPayload(),
  diag_test: () => diagnostics(),
  // the app menu's first submenu labels, and whether the notices ship with the app
  appmenu_test: () => ({ items: Menu.getApplicationMenu()?.items[0]?.submenu?.items.map((i) => i.label || i.role || i.type), notices: !!NOTICES() && NOTICES().startsWith(process.resourcesPath || "/nope") }),
  quit_test() { setTimeout(() => app.quit(), 100); },
  // the app menu's items (no reload / close window / zoom)
  menu_test: () => Menu.getApplicationMenu().items.flatMap((m) => m.submenu.items.map((i) => `${i.role || i.label}${i.accelerator ? `(${i.accelerator})` : ""}`)),
  overlay_collapse_test: () => overlayCommands.overlay_collapse(),
  // a line in the workspace's hook log, as Claude's hook (claude/hooks/event.sh) writes it
  // what Tamer 정보 · 피드백 메일 · 진단 정보 say (native panels and the mail app can't be looked at in a test)
  about_test() { return { about: aboutOptions(), feedback: feedbackUrl(), version: VERSION(), pkg: app.getVersion(), build: BUILD, notices: !!NOTICES(), menu: helpItems.map((i) => i.label).filter(Boolean) }; },
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
// the feedback mail draft (APP-09): only a mailto: draft, nothing is sent; diagnostics are pasted by the user
const feedbackUrl = () => `mailto:${FEEDBACK}?subject=${encodeURIComponent(`Tamer ${VERSION()} 피드백`)}&body=${encodeURIComponent(`무엇을 했고:\n무엇을 기대했고:\n무엇이 보였는지:\n\n(메뉴 Tamer → 진단 정보 복사 후 여기에 붙여넣기)\n\nTamer ${VERSION()} · macOS ${process.getSystemVersion()} · ${process.arch}\n`)}`;
// Tamer 정보 (APP-07)
const aboutOptions = () => ({
  applicationName: "Tamer", applicationVersion: VERSION(),
  credits: "AI 코딩 에이전트와 함께 쓰는 터미널 · 피드백: " + FEEDBACK + "\n오픈소스 고지: Tamer 메뉴 → 오픈소스 고지\nPokémon은 비공식 팬 기능이며 권리는 Nintendo / Creatures / GAME FREAK / The Pokémon Company에 있습니다.",
});
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
  { label: "피드백 보내기…", click: () => shell.openExternal(feedbackUrl()) },
  { label: "오픈소스 고지", click: () => { const f = NOTICES(); if (f) shell.openPath(f); } },
];
app.setAboutPanelOptions(aboutOptions());

// only agent work waits for the shell environment (up to 15 s with a heavy ~/.zshrc): finding an
// agent (its PATH), starting one (its variables) — the window, tabs, shells and the core don't
// (#31 #34 #35). startAgent waits too, for every other way an agent starts.
const NEEDS_ENV = new Set(["agents_status", "agents_list", "agent_pick", "agent_start", "agent_fix", "agent_unfix", "diag_test"]);
ipcMain.handle("host-invoke", async (e, cmd, args) => {
  if (ready && NEEDS_ENV.has(cmd)) await ready; // agents get the terminal's environment
  // only our own pages may call in: the main window (dist/index.html, every command) and the
  // overlay (dist/overlay.html, its own short list)
  const url = e.senderFrame?.url || "";
  const page = url.startsWith("file://") ? decodeURIComponent(url.slice(7)).split(/[?#]/)[0] : "";
  const table = page === path.join(DIST, "index.html") && e.sender === win?.webContents ? commands
    : page === path.join(DIST, "overlay.html") && e.sender === overlay?.webContents ? overlayCommands
    : page === path.join(DIST, "popover.html") && e.sender === popover?.webContents ? popoverCommands : null;
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
logLine(`startup main loaded +${since()}ms`);
app.whenReady().then(() => {
  logLine(`startup app ready +${since()}ms`);
  // the core starts at once (tabs and shells don't wait for the shell environment, #35); the
  // agents' log folders follow when the environment has been read
  core = new RustCore({ onEvent: onCoreEvent, log: logLine });
  titlesToCore(); // 세션 제목 (#99): the core reads no title until told it's on
  const envT0 = since();
  ready = agents.prepareEnv().then((env) => {
    const homes = Object.fromEntries(["CODEX_HOME", "CLAUDE_CONFIG_DIR"].filter((k) => env[k] && !process.env[k]).map((k) => [k, env[k]]));
    if (Object.keys(homes).length) core.request("set_env", homes).catch((e) => logLine(`core set_env error ${e}`));
    logLine(`env ready (${Object.keys(agents.loginEnv()).length} vars) +${since()}ms (shell env took ${since() - envT0}ms)${agents.envFailed() ? " — READ FAILED: agents get PATH only" : ""}`);
  });
  appMenu();
  powerMonitor.on("shutdown", () => { systemShutdown = true; logLine("system shutdown: keeping the session"); });
  // tests: quit by itself like ⌘Q (never quit other instances by app name)
  if (TEST && process.env.CVIM_DESKTOP_QUIT_AFTER) setTimeout(() => app.quit(), Number(process.env.CVIM_DESKTOP_QUIT_AFTER));
  // no camera / mic / notifications / … for the page (voice will ask for the mic explicitly later)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  // 로그인할 때 열기 (APP-21 rule 7): opened by the login item → the menu bar only, no window
  const atLogin = !TEST && settings.loginOpen && backgroundOn() && (() => { try { return app.getLoginItemSettings().wasOpenedAtLogin; } catch { return false; } })();
  if (atLogin) { logLine("startup at login: menu bar only"); app.dock?.hide(); } else createMain();
  // the questions of a first launch, one after the other — with a window or in the menu bar only:
  // Claude 한도 (#104), then Tamer 밖 작업 (#107)
  setTimeout(() => limitsStart().catch((e) => logLine(`limits start error ${e}`)).then(() => outsideStart()).catch((e) => logLine(`outside start error ${e}`)), 4000);
  trayUpdate(); // 메뉴바 (STA-19)
  wild.setOnEnd((e) => { logLine(`wild end ${e.reason}`); broadcast("wild-end", e); overlayUpdate(); setTimeout(() => (wild.bigPending() ? bigShow() : researchCheck()), 1500); }); // a waiting breakthrough / research after it (#82, #86)
  if (wild.enabled()) wild.prefetch();
  // S1: owner-only data, old hook logs pruned (7 days without changes)
  try {
    const fixed = tighten(CACHE) + (STATE !== CACHE ? tighten(STATE) : 0);
    const pruned = pruneTabs(TABS, 7);
    logLine(`privacy: ${fixed} permissions tightened, ${pruned} old hook files removed`);
  } catch (e) { logLine(`privacy error ${e}`); }
  partner.migrate(); // box.json (first run: from folders.json / pokedex.json, backed up)
  try { const e = economy.init(); logLine(`economy balance=${e.balance}${e.start ? ` start=${e.start.amount}` : ""}`); } catch (e) { logLine(`economy init error ${e}`); } // 🪙 (#72)
  bigShow(); // a breakthrough not caught last time is back (#82)
  loadStarter(); // the first partner's starters (only while the box is empty)
  setInterval(() => { if (workspaces.size) scanShells().catch((e) => logLine(`scan error ${e}`)); }, 1500);
});

// the main window (and its overlay) — at launch, and again from the menu bar after it was closed (#106)
function createMain() {
  if (win && !win.isDestroyed()) return;
  uiReady = false;
  if (!TEST) app.dock?.show();
  win = new BrowserWindow({
    width: 1400, height: 900, title: "Tamer", backgroundColor: "#16161c", show: !QUIET_TEST,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      devTools: TEST, // debugger-driven tests need it; regular runs don't
      // a test window is never in front (an accessory app): Chromium would put off painting it, and a
      // picture could show the scene before (UI scenes, 2026-10-14)
      backgroundThrottling: !TEST,
    },
  });
  if (QUIET_TEST) win.showInactive(); // a test window never takes the keyboard from the user's apps
  // the window only ever shows our page: no navigation, no new windows
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.loadFile(path.join(DIST, "index.html"));
  logLine(`startup window created +${since()}ms`);
  win.webContents.once("did-finish-load", () => logLine(`startup page loaded +${since()}ms`));
  win.on("focus", overlaySync);
  win.on("blur", () => setTimeout(overlaySync, 250)); // focus may be moving to our own dialog
  if (!overlay || overlay.isDestroyed()) createOverlay(); // kept through the menu bar time (#107)
}
// Finder · Dock opened the app again while it sits in the menu bar
app.on("activate", () => { if (app.isReady() && (!win || win.isDestroyed())) createMain(); });

// the main window closed (APP-21, #106): with 백그라운드 on, Tamer stays in the menu bar — terminals end as
// on ⌘Q, the tabs are kept for the next window, the Dock icon goes. Off (or no menu bar icon to come back
// by): every window goes and the app ends as before (a hidden dashboard must not keep it alive — #105 preview)
const backgroundOn = () => settings.background && settings.menubar.on;
app.on("browser-window-created", (_e, w) => w.on("closed", () => {
  if (w !== win) return;
  if (!quitting && backgroundOn()) return toBackground(); // the overlay stays: the party shows there (#107)
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  if (popover && !popover.isDestroyed()) popover.destroy();
}));
function toBackground() {
  sessionKept = true; // closing the tabs below mustn't empty the saved ones
  for (const id of [...workspaces.keys()]) closeWorkspace(id);
  win = null; uiReady = false;
  logLine("window closed: Tamer stays in the menu bar");
  trayUpdateSoon();
  overlaySync(); overlayUpdate(); // no tab now: the party, if there is one (#107, STA-15 rule 11)
  const hideDock = () => { if (!TEST && !win) app.dock?.hide(); };
  if (settings.backgroundSeen) return hideDock();
  // the first time (rule 3): say where it went and how to really quit
  if (TEST) { logLine("background notice"); setSettings({ backgroundSeen: true }); return; }
  dialog.showMessageBox({
    type: "info", buttons: ["알겠어요", "창을 닫으면 종료하기"], defaultId: 0, cancelId: 0,
    message: "Tamer는 메뉴바에 남아 있어요",
    detail: "창을 닫아도 메뉴바 몬스터볼에서 파트너·사용 한도·야생을 볼 수 있어요. 왼쪽 클릭 = 대시보드, 오른쪽 클릭 = 메뉴.\n\n열려 있던 탭은 창을 다시 열 때 돌아와요(터미널은 끝났어요). 완전히 끄려면 ⌘Q 또는 메뉴바 메뉴의 종료.",
  }).then(({ response }) => {
    setSettings({ backgroundSeen: true, ...(response === 1 ? { background: false } : {}) });
    if (response === 1) app.quit(); else hideDock();
  });
}

// same escaping iTerm2 uses for dropped paths (as v1 did)
function shellEscape(p) { return p.replace(/([\s!"#$&'()*,;<=>?[\]\\^`{|}~])/g, "\\$1"); }

// the app menu: Edit (copy / paste for the terminals and text fields), Window, Quit. No Reload,
// no Close Window, no page zoom — ⌘R / ⌘W / ⌘= ⌘- ⌘0 are the app's own keys (relayout, close
// tab, font size), and a default menu would catch them first.
function appMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: "about" }, { type: "separator" },
      // 설정 창 (APP-19) — ⌘, as in every Mac app; the overlay on/off right here too (#59)
      { label: "설정…", accelerator: "Cmd+,", click: () => send("open-settings", {}) },
      { label: "바탕화면 오버레이", type: "checkbox", checked: settings.overlay.on, click: (m) => setSettings({ overlay: { on: m.checked } }) },
      { label: "오른쪽 칸 보이기 (⌘\\)", type: "checkbox", checked: settings.side, click: (m) => setSettings({ side: m.checked }) }, // #97 — the key is the window's (⌘\)
      { type: "separator" }, ...helpItems, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
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
// Quitting ends every terminal process and waits until each one's exit has been heard, then
// quits for real (#54): node-pty reports an exit from its own thread, and one that arrived while
// Node was already being torn down aborted the app ("가끔 닫으면 오류" — SIGABRT in
// ThreadSafeFunction::CallJS, beta.31 and beta.36 crash reports). A shell younger than
// SHELL_SETTLE still gets its rc time (settleKill); whatever hasn't ended after that + 1 s gets
// SIGKILL, and after 1.5 s more the app quits anyway.
function drainPtys() {
  const live = [...livePtys];
  if (!live.length) return Promise.resolve({ ms: 0, left: 0 });
  const t0 = Date.now();
  return new Promise((resolve) => {
    const settle = Math.max(0, ...live.map((p) => SHELL_SETTLE - (t0 - (p.startedAt || 0))));
    const finish = () => { clearInterval(tick); clearTimeout(hard); clearTimeout(giveUp); resolve({ ms: Date.now() - t0, left: livePtys.size }); };
    for (const p of live) settleKill(p);
    const tick = setInterval(() => { if (!live.some((p) => livePtys.has(p))) finish(); }, 20);
    const hard = setTimeout(() => { for (const p of live) if (livePtys.has(p)) { try { p.kill("SIGKILL"); } catch {} } }, settle + 1000);
    const giveUp = setTimeout(finish, settle + 2500);
  });
}
let drained = false, draining = false;
app.on("before-quit", (e) => {
  userQuit();
  if (drained) return;
  e.preventDefault();
  if (draining) return;
  draining = true;
  // looks closed at once (#54): the wait below is invisible, and a Dock click meanwhile doesn't
  // land on a window that is about to go
  try { if (win && !win.isDestroyed()) win.hide(); if (overlay && !overlay.isDestroyed()) overlay.hide(); } catch {}
  logLine("quit: windows hidden, ending terminals");
  // (tabs aren't closed here: a Mac shutdown quits too, and its session must keep the tabs)
  if (core) core.stop(); // the core removes its hook files and exits
  drainPtys().then(({ ms, left }) => {
    logLine(`quit: terminals ended in ${ms}ms${left ? ` (${left} still running)` : ""}`);
    drained = true;
    if (relaunchAfterQuit && !TEST) app.relaunch(); // #110
    app.quit();
  });
});

// closing the window is quitting too — unless Tamer stays in the menu bar (#106)
app.on("window-all-closed", () => {
  if (!quitting && backgroundOn()) return;
  userQuit();
  for (const id of [...workspaces.keys()]) closeWorkspace(id);
  app.quit();
});
