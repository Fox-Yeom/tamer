// CVIM Desktop (v2, Electron) — UI. One tab = one workspace (folder): agent / Neovim / shell panes
// (xterm.js on PTYs owned by the main process) + partner Pokémon + activity. Agent state, usage and
// partner data arrive as events (electron/main.cjs ← cvim-core). X0 findings: docs/PLATFORM.md 3.3c–3.5.
import { invoke, listen } from "./host.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { createWild, josa } from "./wild.js";
import "./poke/poke.css";
import { pkCard } from "./poke/card.js";

// diagnostics: surface JS errors in the footer (release builds have no devtools)
const showErr = (m) => { const h = document.getElementById("hint"); h.textContent = "오류: " + m; h.style.color = "#e5484d"; };
window.addEventListener("error", (e) => showErr(e.message));
window.addEventListener("unhandledrejection", (e) => showErr(String(e.reason?.message || e.reason)));

const THEME = {
  background: "#1b1b22", foreground: "#e6e6e6", cursor: "#e6e6e6", selectionBackground: "#3a3a4a",
  black: "#1b1b1f", red: "#e5484d", green: "#3ddc84", yellow: "#f5c542", blue: "#4f8df7",
  magenta: "#c678dd", cyan: "#56b6c2", white: "#d0d0d0", brightBlack: "#5c5c66",
};
const ICON = {
  idle: "😌", sleep: "💤", thinking: "💭", coding: "⌨️", reading: "📖", searching: "🔍",
  bash: "💻", agent: "🤝", tool: "🛠", waiting: "❓", done: "🎉", compact: "🗜", error: "💥", interrupted: "⏹",
  shell: "🐚",
};
const DOING = {
  idle: "대기", sleep: "쉬는 중", thinking: "생각 중", coding: "편집", reading: "읽는 중", searching: "검색",
  bash: "실행", agent: "하위 에이전트", tool: "도구", waiting: "입력 필요", done: "완료", compact: "압축 중", error: "실패", interrupted: "중단됨",
  shell: "셸",
};
const EVENT_ICON = { UserPromptSubmit: "💬", Notification: "❓", Stop: "✅", StopFailure: "💥", Interrupted: "⏹", PreCompact: "🗜", SessionStart: "🚀", SessionEnd: "🛑" };
const TOOL_ICON = { coding: "✏️", reading: "📖", searching: "🔍", bash: "💻", agent: "🤝", tool: "🛠" };
const TOOL_STATE = { Edit: "coding", MultiEdit: "coding", Write: "coding", NotebookEdit: "coding", WebSearch: "searching",
  WebFetch: "searching", Read: "reading", Grep: "reading", Glob: "reading", LS: "reading", Bash: "bash", Task: "agent", Agent: "agent" };
const DETAIL_STATES = ["coding", "reading", "searching", "bash", "tool", "agent"];
// first type -> attack effect (same as the CVIM.app overlay / native avatar)
const TYPE_FX = {
  electric: "⚡", fire: "🔥", water: "💧", grass: "🍃", ice: "❄️", psychic: "🔮", ghost: "👻", dark: "🌑",
  poison: "☠️", ground: "⛰️", rock: "🪨", fighting: "👊", flying: "🌪️", bug: "🐛", dragon: "🐉", steel: "⚙️", fairy: "✨",
};
const TYPE_ICON = { ...TYPE_FX, normal: "⭐" };

let info;
let lastPick = null; // the last text selected in a terminal { text, from: pane id, tab }
// terminal font size (⌘= ⌘- ⌘0), remembered on this machine
const FONT_DEFAULT = 14;
let fontSize = FONT_DEFAULT;
try { fontSize = Number(localStorage.getItem("cvim.fontSize")) || FONT_DEFAULT; } catch {}
const tabs = []; // ordered Tab objects
const byId = new Map(); // ws id -> Tab
const panes = new Map(); // pane id "<ws>:<kind>" -> Pane
let active = null;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const short = (d) => { d = String(d ?? ""); return d.startsWith("/") ? d.split("/").pop() : d; };
const level = (p) => (p == null ? "dim" : p >= 80 ? "bad" : p >= 50 ? "warn" : "ok");
const base = (p) => p.split("/").filter(Boolean).pop() || p;

function b64bytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 1800);
}

// ── links in the terminal (#19): ⌘-click opens a web address in the browser, like iTerm2. A plain
// click stays a click (selecting text copies). Web pages only (http/https). ─────────────────────
function openLink(e, uri) {
  if (!e.metaKey) return;
  invoke("open_link", { url: uri }).catch((err) => toast(String(err.message || err)));
}

// the text of buffer row y's logical line (wrapped rows joined) and where each character sits
// (1-based cells; Hangul takes 2)
function lineText(term, y) {
  const buf = term.buffer.active;
  let top = y - 1;
  while (top > 0 && buf.getLine(top)?.isWrapped) top--;
  let text = "";
  const at = [];
  for (let row = top; row < buf.length; row++) {
    const line = buf.getLine(row);
    if (!line || (row > top && !line.isWrapped)) break;
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const ch = cell.getChars() || " ";
      for (const c of ch) { text += c; at.push({ x: x + 1, y: row + 1 }); }
    }
  }
  return { text, at };
}
const onRow = (a, b, y) => a && b && (a.y === y || b.y === y || (a.y < y && b.y > y));

// web addresses in the text
const URL_RE = /https?:\/\/[^\s<>"'`\u3000-\u9fff\uac00-\ud7af]+/g;
function urlsIn(text) {
  const out = [];
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0].replace(/[.,;:!?'"]+$/, "");
    // a ")" that closes "(… url)" isn't part of it; one that's opened inside the url is
    while (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
    out.push({ index: m.index, url });
  }
  return out;
}
function webLinks(term) {
  return {
    provideLinks(y, done) {
      const { text, at } = lineText(term, y), links = [];
      for (const { index, url } of urlsIn(text)) {
        const a = at[index], b = at[index + url.length - 1];
        if (onRow(a, b, y)) links.push({ range: { start: a, end: b }, text: url, activate: (e) => openLink(e, url) });
      }
      done(links.length ? links : undefined);
    },
  };
}

// file paths in the text (#26): "src/a.ts:12", "./x", "/abs/y.md:3:5", "~/z", "Update(src/main.js)" —
// a word with a "/" or a file extension, kept only if it exists from the pane's folders. ⌘-click
// opens it in the editor at that line (a folder: Finder)
const PATH_RE = /[\w.~\/@+-]*[\w\/@+-](?::\d+(?::\d+)?)?/g;
function fileLinks(term, paneId, tab) {
  return {
    provideLinks(y, done) {
      const { text, at } = lineText(term, y);
      const urls = urlsIn(text).map((u) => [u.index, u.index + u.url.length]);
      const cands = [];
      for (const m of text.matchAll(PATH_RE)) {
        let tok = m[0].replace(/[.,;:]+$/, "");
        const lc = tok.match(/:(\d+)(?::(\d+))?$/);
        const file = lc ? tok.slice(0, lc.index) : tok;
        if (!file || file === "/" || file === "~" || /^[.\/~]+$/.test(file)) continue;
        if (!file.includes("/") && !/\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(file)) continue; // a plain word
        if (/^\d/.test(file) && !file.includes("/")) continue; // 1.5, 3.14
        if (urls.some(([s, e]) => m.index < e && m.index + tok.length > s)) continue; // part of a web address
        const a = at[m.index], b = at[m.index + tok.length - 1];
        if (!onRow(a, b, y)) continue;
        cands.push({ file, line: lc?.[1], col: lc?.[2], range: { start: a, end: b }, text: tok });
        if (cands.length >= 40) break;
      }
      if (!cands.length) return done(undefined);
      invoke("file_links", { id: paneId, cwd: tab?.cwd, cands: cands.map((c) => c.file) }).then((found) => {
        const links = [];
        cands.forEach((c, i) => {
          const f = found?.[i];
          if (!f) return;
          links.push({ range: c.range, text: c.text, activate: (e) => {
            if (!e.metaKey) return;
            invoke("open_file", { abs: f.abs, line: c.line, col: c.col }).catch((err) => toast(String(err.message || err)));
          } });
        });
        done(links.length ? links : undefined);
      }).catch(() => done(undefined));
    },
  };
}

// ── panes (xterm.js) ────────────────────────────────────────────────────────
// opts.id / opts.el: an agent session's terminal (M1) — its own element inside the agent pane
function makePane(tab, kind, opts = {}) {
  const id = opts.id || `${tab.id}:${kind}`;
  const section = $(`.pane-${kind}`, tab.view);
  const el = opts.el || $(".term", section);
  const term = new Terminal({
    fontFamily: '"Fira Code", "CVIM Hangul", Menlo, monospace',
    fontSize, theme: THEME, macOptionIsMeta: true, scrollback: 100000, allowProposedApi: true,
    // links a program marks itself (OSC 8, e.g. an agent's "출처" list): ⌘-click opens (#19)
    linkHandler: { activate: (e, uri) => openLink(e, uri) },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // character widths like the shell's (Unicode 11: emoji such as 🦊 are 2 cells). With the default
  // (Unicode 6) zsh and xterm disagree on the prompt width, and long lines wrap/erase wrongly.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(el);
  term.registerLinkProvider(webLinks(term)); // plain web addresses in the output: ⌘-click opens (#19)
  term.registerLinkProvider(fileLinks(term, id, tab)); // file paths: ⌘-click opens the editor (#26)
  // ⌘ shortcuts belong to the app, never to the program in the terminal — except the iTerm2
  // ("Natural Text Editing") editing keys: ⇧↵ = a new line in the prompt (ESC CR, what Claude
  // Code's /terminal-setup binds; zsh inserts a newline too) (#7), ⌘⌫ = delete to the line start
  // (Ctrl-U) (#8), ⌘← / ⌘→ = line start / end (Ctrl-A / Ctrl-E) (#14). ⌘↑ / ⌘↓ do nothing. Not
  // while composing Hangul: that Enter commits the syllable.
  // These must never reach the hidden textarea either: there they move its caret off the end, and
  // xterm reads the next Hangul syllable from the end — old text came out instead (#13).
  // A key pressed on an unfinished Hangul syllable first commits it (compositionend), and xterm
  // sends the syllable a moment later (setTimeout 0). xterm sends it first only for keys it handles
  // itself — not for ⌥ keys (macOptionIsMeta skips that step) nor for the ⌘ keys handled here, so
  // "ESC b" / Ctrl-A went before the syllable and it landed a word / the line back (#15 #16). One
  // rule for every key: the pending syllable goes first. And like iTerm2, a key that moves or
  // deletes (arrows, Home/End, Page Up/Down, Delete, ⌘⌫ ⌥⌫ — any modifier) only finishes the
  // syllable; the next press moves.
  const EDIT_KEYS = { "S:Enter": "\x1b\r", "M:Backspace": "\x15", "M:ArrowLeft": "\x01", "M:ArrowRight": "\x05", "M:ArrowUp": "", "M:ArrowDown": "" };
  const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Delete"]);
  let composing = false, committed = 0;
  term.textarea.addEventListener("compositionstart", () => { composing = true; }, true);
  term.textarea.addEventListener("compositionend", () => { composing = false; committed = performance.now(); }, true);
  term.attachCustomKeyEventHandler((e) => {
    const ime = e.isComposing || e.keyCode === 229; // the IME takes this key
    if (e.type === "keydown" && !ime && !p.noCommitGuard && (composing || performance.now() - committed < 50)) {
      committed = 0;
      // the syllable first: xterm's own step for its keys (CompositionHelper.keydown → sent now)
      term._core?._compositionHelper?.keydown(e);
      if (NAV_KEYS.has(e.key) || (e.key === "Backspace" && (e.metaKey || e.altKey))) {
        e.preventDefault();
        imeLog(id, "commit-only", e.key);
        return false;
      }
    }
    const mods = (e.shiftKey ? "S" : "") + (e.metaKey ? "M" : "") + (e.ctrlKey ? "C" : "") + (e.altKey ? "A" : "");
    const seq = EDIT_KEYS[`${mods}:${e.key}`];
    if (seq == null) return !e.metaKey;
    if (e.type === "keydown" && !ime) {
      e.preventDefault();
      if (seq) term.input(seq, true);
    }
    return false;
  });
  // the same guard for anything else that moves the textarea caret (⌘A, a click …): before a key
  // starts a new composition, put the caret back at the end, where xterm reads from (#13)
  term.textarea.addEventListener("keydown", () => {
    const t = term.textarea, n = t.value.length;
    if (composing || p.noCaretGuard || (t.selectionStart === n && t.selectionEnd === n)) return;
    imeLog(id, "caret-reset", `${t.selectionStart}-${t.selectionEnd}/${n}`);
    t.setSelectionRange(n, n);
  }, true);
  const p = { id, kind, tab, term, fit, el, section, bytes: 0, discard: false, search: new SearchAddon() };
  term.loadAddon(p.search);
  term.buffer.onBufferChange(() => { if (tsearchPane === p) tsearchAlt(); });
  p.search.onDidChangeResults(({ resultIndex, resultCount }) => { if (tsearchPane === p) tsearchCount(resultIndex, resultCount); });
  term.onData((data) => {
    imeLog(id, "onData", JSON.stringify(data));
    // drop only the text a cancelled composition commits — never terminal replies (ESC …), e.g. the
    // answer to Codex's background-colour query that arrives right after a switch
    if (p.discard && !data.startsWith("\x1b")) {
      p.discard = false;
      return imeLog(id, "dropped", JSON.stringify(data));
    }
    invoke("pty_write", { id, data });
  });
  // iTerm-style: selecting copies; typing keeps going to the program
  term.onSelectionChange(() => {
    const s = term.getSelection();
    if (!s) return;
    invoke("copy_text", { text: s }).then(() => toast(`복사됨 (${s.length}자)`));
    lastPick = { text: s, from: id, tab }; // M2: can be handed to another session from the rail
  });
  term.textarea.addEventListener("focus", () => focusMark(tab, section));
  watchIme(id, term.textarea);
  // while composing Hangul, the terminal cursor stays at the start of the composing syllable;
  // hide it and draw a caret after the composition instead (style.css .composing)
  term.textarea.addEventListener("compositionstart", () => term.element.classList.add("composing"));
  term.textarea.addEventListener("compositionend", () => term.element.classList.remove("composing"));
  term.textarea.addEventListener("blur", () => term.element.classList.remove("composing"));
  new ResizeObserver(() => resize(p)).observe(el);
  panes.set(id, p);
  return p;
}

// hidden tabs have no size: fit only what is on screen
function fitPane(p) {
  if (!p.el.offsetParent) return false;
  try { p.fit.fit(); } catch { return false; }
  return true;
}

function resize(p) {
  if (fitPane(p)) invoke("pty_resize", { id: p.id, cols: p.term.cols, rows: p.term.rows }).catch(() => {});
}

function focusMark(tab, section) {
  tab.view.querySelectorAll(".pane").forEach((s) => s.classList.toggle("focus", s === section));
}

// editor / shell: the main process decides what runs (the page never names a program)
function startPane(p) {
  fitPane(p);
  p.term.reset();
  return invoke("pane_start", { ws: p.tab.id, kind: p.kind, cols: p.term.cols, rows: p.term.rows })
    .catch((err) => p.term.write(`\x1b[31m실행 실패: ${err}\x1b[0m\r\n`));
}

// ── tabs ────────────────────────────────────────────────────────────────────
// the agent pane's title: the agent, or (S2) the shell it runs and an agent typed into it
const paneTitle = (tab, a) => (tab.shellOnly ? (tab.hostAgent ? `🐚 Shell · ${tab.hostAgent.label}` : "🐚 Shell") : a?.label || "Agent");

// an agent typed after a `cd` (#3): where it runs, next to the pane's title — a subfolder of the
// tab's folder, or another folder (⚠, a button opens it as its own tab; the tab's changes and
// partner stay with the tab's folder)
function titleHTML(text, where) {
  if (!where) return esc(text);
  return esc(text) + (where.outside
    ? ` <span class="where out" title="다른 폴더에서 실행 중: ${esc(where.full)}">⚠ ${esc(where.label)}</span>`
    : ` <span class="where" title="${esc(where.cwd)}">📁 ${esc(where.rel)}</span>`);
}

// #3: an agent running in another folder — a banner over its pane: move it (still running) into
// that folder's tab, the shell here gets its own folder back; or keep it here
function renderWhere(tab) {
  const host = curSession(tab);
  const rows = [["agent", tab.hostAgent && host?.hostWhere], ["shell", tab.shellAgent && tab.shellWhere]];
  for (const [pane, where] of rows) {
    const el = $(`.where-banner[data-pane="${pane}"]`, tab.view);
    if (!el) continue;
    const show = !!(where?.outside && !where.dismissed);
    el.hidden = !show;
    if (!show) continue;
    el.innerHTML = `<span class="msg">⚠ 이 에이전트는 다른 폴더 <b>${esc(where.label)}</b>에서 실행 중이에요 — 이 탭(${esc(base(tab.cwd))})의 변경 사항과는 따로예요(경험치는 이 탭 파트너가 받아요)</span>`
      + `<button class="move" title="${esc(where.full)}">새 탭으로 옮기기</button><button class="ghost keep">그대로 두기</button>`;
    el.querySelector(".move").onclick = () => moveAgent(tab, pane);
    el.querySelector(".keep").onclick = () => { where.dismissed = true; renderWhere(tab); };
  }
}

async function moveAgent(tab, pane) {
  const host = curSession(tab);
  const where = pane === "shell" ? tab.shellWhere : host?.hostWhere;
  if (!where?.outside) return;
  toast(`${where.label} 탭으로 옮기는 중…`);
  const target = byId.get([...byId.values()].find((t) => t.cwd === where.cwd)?.id) || (await openFolder(where.cwd));
  if (!target) return;
  // the target tab's session: its first one if free, else one more shell there
  let ts = target.sessions[0];
  if (ts.running || !ts.host) ts = await newSession(target);
  try {
    const r = await invoke("pty_move", { from: tab.id, pane, session: host?.id, to: target.id, toSession: ts.id });
    // the source gets its own folder back
    if (pane === "shell") { onShellAgent(tab, null); startPane(tab.panes.shell); }
    else await startHost(tab, host);
    renderWhere(tab);
    // the moved program redraws in its new terminal (a size change = SIGWINCH)
    selectTab(target);
    switchSession(target, ts.id);
    const p = ts.pane;
    p.term.reset();
    fitPane(p);
    await invoke("pty_resize", { id: r.id, cols: p.term.cols, rows: Math.max(2, p.term.rows - 1) });
    setTimeout(() => invoke("pty_resize", { id: r.id, cols: p.term.cols, rows: p.term.rows }), 150);
    toast(`${r.agent.label}을(를) ${base(target.cwd)} 탭으로 옮겼어요 — 원래 탭은 다시 ${base(tab.cwd)} 셸`);
  } catch (e) {
    toast(`옮기지 못했어요: ${e?.message || e}`);
  }
}

function showAgent(tab, a) {
  tab.agent = a;
  $(".agent-name", tab.view).innerHTML = titleHTML(tab.sessions?.length > 1 ? `${paneTitle(tab, a)} · 셸 ${sessNo(tab, curSession(tab)) || 1}` : paneTitle(tab, a), tab.hostAgent && curSession(tab)?.hostWhere);
  if (tab === active) {
    const tag = $("#agent"), bare = tab.shellOnly && !tab.hostAgent; // S2: no agent yet
    tag.innerHTML = bare ? '🐚 셸<span class="bar-wide"> · ⌘G 에이전트</span>' : esc(a.label);
    tag.style.background = bare ? "#33333f" : a.color;
    tag.style.color = bare ? "var(--fg)" : "";
  }
  renderTab(tab);
}

async function startAgent(tab, cmd = "agent_start", resume = false) {
  const sess = curSession(tab);
  const p = tab.panes.agent;
  fitPane(p);
  p.term.reset();
  const a = await invoke(cmd, { ws: tab.id, session: sess.id, cols: p.term.cols, rows: p.term.rows, resume });
  sess.agent = a;
  sess.running = true;
  showAgent(tab, a);
  renderRail(tab);
  // the choose dialog keeps the keyboard (Esc there = "later", not "cancel the agent")
  if (tab === active && !chooseOpen()) p.term.focus();
  return a;
}

// A half-typed syllable must not follow the user into the next agent: blurring ends the IME
// composition, and whatever it commits is dropped instead of being typed into the new process.
function cancelComposition(p) {
  if (!p.term.element.classList.contains("composing")) return;
  p.discard = true;
  p.term.textarea.blur();
  setTimeout(() => { p.discard = false; }, 300);
}

// ⌘G: pick the agent for this session (S2). Installed ones by number, Enter = this folder's last
// one; replacing a running agent asks first.
async function switchAgent(tab = active) {
  if (!tab) return;
  const sess = curSession(tab);
  // running: the agent pane's agent, or one typed into its shell; otherwise the folder's last one
  // (picked or typed) comes first
  const { current, running, last, list } = await invoke("agents_list", { ws: tab.id, session: sess.id });
  const first = running ? current : last || current;
  const items = list.map((a) => [a.icon, `${a.name}${!a.installed ? " (설치 안 됨)" : running && a.key === current ? " · 실행 중" : !running && a.key === last ? " · 이 폴더에서 지난번" : ""}`,
    () => (!a.installed ? toast(`${a.name}이(가) 설치돼 있지 않아요`) : running && a.key === current ? stayAgent(tab, a) : pickAgent(tab, a, running))]);
  items.push(["⚙", "에이전트 연결 상태…", () => openAgents()]);
  const box = tab.panes.agent.el.getBoundingClientRect();
  showMenu(items, box.left + box.width / 2 - 120, box.top + 40, { def: Math.max(0, list.findIndex((a) => a.key === first)), title: "에이전트 선택 (↑↓ · 숫자 · Enter · Esc)" });
}

// the agent already running in this session: keep it (no restart — that would end its conversation)
function stayAgent(tab, a) {
  if (tab.swapped) { tab.autoSwapped = false; swapPanes(tab, false); }
  tab.panes.agent.term.focus();
  toast(`${a.name}은(는) 이미 실행 중이에요`);
}

async function pickAgent(tab, a, running) {
  const sess = curSession(tab), typed = sess.hostAgent;
  if (running && !confirm(typed ? `셸에서 실행 중인 ${typed.name}을(를) 끝내고 ${a.name}(으)로 바꿀까요?` : `지금 에이전트를 끝내고 ${a.name}(으)로 바꿀까요?`)) return;
  // the agent replaces the pane's shell (and whatever runs in it)
  sess.host = false;
  sess.hostAgent = null;
  // the agent pane goes back to the big slot (an agent run in the shell keeps running there, small)
  if (tab.swapped) { tab.autoSwapped = false; swapPanes(tab, false); }
  cancelComposition(tab.panes.agent);
  const p = tab.panes.agent;
  fitPane(p);
  p.term.reset();
  const info2 = await invoke("agent_pick", { ws: tab.id, session: sess.id, agent: a.key, cols: p.term.cols, rows: p.term.rows });
  sess.agent = info2;
  sess.running = true;
  showAgent(tab, info2);
  renderRail(tab);
  if (tab === active) p.term.focus();
  toast(`에이전트: ${info2.label}`);
}

// ── agent connections: what CVIM sees of each agent, one-click fixes, how to install ───────────
const agentsOpen = () => !$("#agents").hidden;
const LEVEL = { full: "🟢 전체", basic: "🟡 기본", none: "⚪ 없음" };
async function openAgents() {
  const { list } = await invoke("agents_status");
  const ul = $("#agents-list");
  ul.innerHTML = "";
  for (const a of list) {
    const li = document.createElement("li");
    const note = a.level === "none" ? "설치 안 됨" : a.fix === "gemini_link" ? "확장을 연결하면 전체"
      : a.fix === "claude_link" ? "⌘G는 전체 · 셸에서 친 Claude는 연결하면 전체" : a.fix === "claude_linked" ? `${a.path} · 셸에서 친 Claude도 연결됨` : a.path;
    li.innerHTML = `<span>${esc(a.icon)}</span><b>${esc(a.name)}</b><span class="lv">${LEVEL[a.level]}</span><span class="where" title="${esc(a.path || "")}">${esc(note || "")}</span><span class="act"></span>`;
    const act = li.querySelector(".act");
    const button = (label, fn) => { const b = document.createElement("button"); b.textContent = label; b.addEventListener("click", fn); act.appendChild(b); };
    if (a.fix === "gemini_link") button("확장 연결", async () => { const r = await invoke("agent_fix", { key: a.key }); if (!r.cancelled) toast(r.msg); openAgents(); });
    if (a.fix === "claude_link") button("셸에서 친 Claude도 연결", async () => { const r = await invoke("agent_fix", { key: a.key }); if (!r.cancelled) toast(r.msg); openAgents(); }); // #45
    if (a.fix === "claude_linked") button("연결 해제", async () => { const r = await invoke("agent_unfix", { key: a.key }); if (!r.cancelled) toast(r.msg); openAgents(); });
    if (a.level === "none" && a.install) {
      button("설치 명령 복사", () => invoke("copy_text", { text: a.install.cmd }).then(() => toast(`복사됨 — 터미널에 붙여넣어 실행: ${a.install.cmd}`)));
      button("공식 안내", () => invoke("open_url", { url: a.install.url }));
    }
    ul.appendChild(li);
  }
  $("#agents").hidden = false;
  $("#agents").focus();
  invoke("agents_seen");
}
function closeAgents() { $("#agents").hidden = true; focusBig(active); }
$("#agents-close").addEventListener("click", closeAgents);
$("#agents").addEventListener("mousedown", (e) => { if (e.target.id === "agents") closeAgents(); });

// tests: the next installed agent without the picker (the old ⌘G)
async function nextAgent(tab) {
  const { current, list } = await invoke("agents_list", { ws: tab.id, session: curSession(tab).id });
  const ok = list.filter((a) => a.installed);
  return pickAgent(tab, ok[(ok.findIndex((a) => a.key === current) + 1) % ok.length], false);
}

// S2 shell first: a folder opens with a shell in the agent pane (the big slot; the shell pane stays
// bottom right) until an agent is picked with ⌘G. An agent typed into that shell is the session's
// agent (tracked, remembered); when it ends the shell is back. The composer goes to the big slot.
const SHELL_STATE = { state: "shell", log: [] };
async function startHost(tab, sess = curSession(tab)) {
  sess.host = true;
  sess.hostAgent = null;
  sess.running = false;
  sess.hostAt = Date.now();
  const p = sess.pane;
  fitPane(p);
  p.term.reset();
  await invoke("host_shell", { ws: tab.id, session: sess.id, cols: p.term.cols, rows: p.term.rows });
  if (tab.sid !== sess.id) return;
  if (!(tab.swapped && tab.shellAgent)) renderState(tab, SHELL_STATE, { quiet: true });
  if (tab.agent) showAgent(tab, tab.agent);
  if (tab === active && !chooseOpen()) p.term.focus();
}
// an agent is on in this tab's big slot (the agent pane's, one typed into its shell, or one run in
// the shell pane and swapped in) — what the microphone (voice input, later) needs
const agentOn = (tab) => !!tab && ((tab.swapped && !!tab.shellAgent) || !!curSession(tab)?.running);

// resume: session restore — the agent picks up the folder's last conversation
let opening = 0; // folders being opened (the start screen mustn't come up over them)
async function openFolder(cwd, { resume = false } = {}) {
  hideStart();
  opening++;
  try { return await openFolderNow(cwd, { resume }); } finally { opening--; }
}
async function openFolderNow(cwd, { resume }) {
  const ws = await invoke("workspace_open", { cwd });
  if (ws.existing && byId.has(ws.id)) {
    selectTab(byId.get(ws.id));
    toast(`이미 열려 있어요: ${base(ws.cwd)}`);
    return byId.get(ws.id);
  }
  const view = $("#ws-template").content.firstElementChild.cloneNode(true);
  $("#views").appendChild(view);
  const tab = { id: ws.id, cwd: ws.cwd, agent: ws.agent, view, state: null, partner: null, panes: {} };
  // S2: the current session's agent pane runs a shell / the agent typed into that shell
  Object.defineProperties(tab, {
    shellOnly: { get() { return !!curSession(this)?.host; } },
    hostAgent: { get() { return curSession(this)?.hostAgent || null; } },
  });
  tabs.push(tab);
  byId.set(tab.id, tab);
  // the first agent session (same id as the tab); more come with ⌘⇧T (M1)
  const first = { id: tab.id, n: 1, el: sessionEl(tab, tab.id) };
  first.pane = makePane(tab, "agent", { id: `${tab.id}:agent`, el: first.el });
  tab.sessions = [first];
  tab.sid = tab.id;
  tab.panes.agent = first.pane;
  tab.panes.shell = makePane(tab, "shell");
  selectTab(tab);
  // panes need their size before the processes start
  await new Promise((r) => setTimeout(r, 30));
  if (resume || info.autostart) await startAgent(tab, "agent_start", resume);
  else await startHost(tab, first);
  refreshChanges(tab);
  if (info.test.perf) perfTest(tab);
  else startPane(tab.panes.shell).then(() => { if (info.test.shell_input) autoType(tab, info.test.shell_input); });
  if (!tab.shellOnly) invoke("agent_state", { ws: tab.id });
  invoke("partner_state", { ws: tab.id }).then((pk) => { if (pk?.choose) needPartner(tab); else if (pk) showPartner(tab, pk); });
  return tab;
}

// ── find in the terminal (#40): ⌘F in a pane (the big one when no terminal has the keyboard) — a
// search line at the pane's top right; every match marked, the current one brighter, "3/12".
// ↵ next · ⇧↵ previous · Esc closes (back to the terminal). The Pokémon window keeps its own ⌘F.
let tsearchPane = null;
const TSEARCH_DECO = { matchBackground: "#6b5a2a", matchOverviewRuler: "#c9a227", activeMatchBackground: "#e5a33a", activeMatchColorOverviewRuler: "#ff9e3d" };
function tsearchCount(i, n) { $("#tsearch-n").textContent = !$("#tsearch-q").value ? "" : n ? `${i >= 0 ? i + 1 : "?"}/${n}` : "없음"; tsearchAlt(); }
// a full-screen program (alternate screen — e.g. Claude Code scrolling its own view): the terminal
// holds only the screen you see, so only that can be found; say so (iTerm2 is the same)
function tsearchAlt() { $("#tsearch-alt").hidden = tsearchPane?.term.buffer.active.type !== "alternate"; }
function openTermSearch(p) {
  if (!p) return;
  if (tsearchPane && tsearchPane !== p) closeTermSearch(false);
  tsearchPane = p;
  const box = $("#tsearch"), q = $("#tsearch-q");
  p.section.append(box);
  box.hidden = false;
  const sel = p.term.getSelection();
  if (sel && !sel.includes("\n")) q.value = sel;
  q.focus(); q.select();
  tsearchAlt();
  if (q.value) termFind(1, true);
}
function closeTermSearch(refocus = true) {
  const p = tsearchPane;
  tsearchPane = null;
  $("#tsearch").hidden = true;
  if (!p) return;
  p.search.clearDecorations();
  p.term.clearSelection();
  if (refocus) p.term.focus();
}
function termFind(dir, incremental = false) {
  const p = tsearchPane, q = $("#tsearch-q").value;
  if (!p) return;
  if (!q) { p.search.clearDecorations(); tsearchCount(-1, 0); return; }
  const opts = { decorations: TSEARCH_DECO, incremental };
  if (dir < 0) p.search.findPrevious(q, opts); else p.search.findNext(q, opts);
}
$("#tsearch-q").addEventListener("input", () => termFind(1, true));
$("#tsearch-q").addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return; // Hangul being composed: Enter commits it first
  if (e.key === "Enter") { e.preventDefault(); termFind(e.shiftKey ? -1 : 1); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeTermSearch(); }
});
$("#tsearch").addEventListener("click", (e) => {
  const d = e.target.closest("button")?.dataset.dir;
  if (d === "close") closeTermSearch(); else if (d) { termFind(d === "prev" ? -1 : 1); $("#tsearch-q").focus(); }
});

function selectTab(tab) {
  if (tsearchPane && tsearchPane.tab !== tab) closeTermSearch(false);
  if (!tab) return;
  active = tab;
  for (const t of tabs) t.view.hidden = t !== tab;
  for (const p of Object.values(tab.panes)) resize(p);
  // the folder name always shows; its parent folders give way first on a narrow window (#38)
  const shown = tab.cwd.replace(info.home, "~"), cut = shown.lastIndexOf("/") + 1;
  $("#cwd").innerHTML = `<span class="cwd-parent">${esc(shown.slice(0, cut))}</span>${esc(shown.slice(cut))}`;
  $("#cwd").title = shown;
  if (tab.agent) showAgent(tab, tab.agent);
  if (tab.state) renderBar(tab);
  renderTabs();
  if (chooseOpen()) closeChoose(false); // the dialog belongs to the tab it was opened for
  refreshChanges(tab);
  bigPane(tab)?.term.focus();
  if (!tab.partner?.uid && tab.partnerChecked && !tab.askedOnce) openChoose(tab, true); // no partner yet: ask once
  invoke("tab_active", { ws: tab.id });
}

async function closeTab(tab = active) {
  if (!tab) return;
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  byId.delete(tab.id);
  for (const p of [...tab.sessions.map((x) => x.pane), tab.panes.shell]) { panes.delete(p.id); p.term.dispose(); }
  tab.view.remove();
  renderSummary();
  await invoke("workspace_close", { ws: tab.id });
  if (tabs.length) selectTab(tabs[Math.min(i, tabs.length - 1)]);
  else { active = null; renderTabs(); showStart(true); }
}

function renderTabs() {
  const nav = $("#tabs");
  nav.querySelectorAll(".tab").forEach((b) => b.remove());
  tabs.forEach((t, i) => {
    const b = document.createElement("button");
    b.className = "tab";
    b.dataset.ws = t.id;
    nav.insertBefore(b, $("#new-tab"));
    renderTab(t, b, i);
  });
}

// one tab button: number · state icon · folder · what it's doing; red when it needs you
function renderTab(t, b = $(`#tabs .tab[data-ws="${t.id}"]`), i = tabs.indexOf(t)) {
  if (!b) return;
  const st = urgentOf(t); // several sessions: the one that needs you most
  const many = t.sessions?.length > 1 ? `<span class="sess-count">×${t.sessions.length}</span>` : "";
  const waiting = st === "waiting";
  b.classList.toggle("active", t === active);
  b.classList.toggle("attention", waiting || st === "error");
  const doing = waiting ? "❗ 입력 필요" : st && st !== "idle" && st !== "sleep" ? DOING[st] : "";
  b.innerHTML = `<span class="num">${i < 9 ? i + 1 : ""}</span><span>${ICON[st] || "·"}</span>`
    + `<span class="name">${esc(base(t.cwd))}</span>${many}<span class="doing">${esc(doing)}</span><span class="close" title="닫기 (⌘W)">✕</span>`;
  b.title = `${t.cwd}${t.agent ? ` — ${t.agent.label}` : ""}`;
}

$("#tabs").addEventListener("click", (e) => {
  if (e.target.id === "new-tab") return showStart(false);
  const b = e.target.closest(".tab");
  if (!b) return;
  const tab = byId.get(b.dataset.ws);
  if (e.target.classList.contains("close")) closeTab(tab);
  else selectTab(tab);
});

// ── all tabs at a glance (top bar): needs you → working → finished → failed ──
const WORKING = ["thinking", "coding", "reading", "searching", "bash", "agent", "tool", "compact"];
function renderSummary() {
  // per session (M1): every agent counts
  const all = tabs.flatMap((t) => (t.sessions?.length > 1 ? t.sessions.map((x) => x.state?.state) : [t.state?.state]));
  const n = (f) => all.filter(f).length;
  const parts = [
    ["bad", "❗", n((s) => s === "waiting")], ["", "⌨️", n((s) => WORKING.includes(s))],
    ["ok", "✅", n((s) => s === "done")], ["bad", "💥", n((s) => s === "error")],
  ].filter(([, , c]) => c > 0);
  // one tab says it all in its own status; the summary is for several
  $("#summary").innerHTML = all.length > 1 ? parts.map(([cls, icon, c]) => `<span class="${cls}">${icon}${c}</span>`).join(" ") : "";
}

// ── M1: several agent sessions in one folder ──────────────────────────────────
// Each session: its own agent process and terminal (an element inside the agent pane, one shown).
// Shared per folder: the partner, the changes panel, the shell. The rail lists them (2 or more).
const URG = (st) => (st === "waiting" ? 0 : st === "error" ? 1 : WORKING.includes(st) ? 2 : st === "done" ? 3 : st === "interrupted" ? 4 : st === "sleep" ? 6 : 5);
const curSession = (tab) => tab.sessions?.find((x) => x.id === tab.sid);
// a session's number = its place in the rail (closing 4 and opening one gives 4 again)
const sessNo = (tab, x) => tab.sessions.indexOf(x) + 1;
function urgentOf(t) {
  if (!(t.sessions?.length > 1)) return t.state?.state;
  const own = t.sessions.map((x) => (x.id === t.sid ? t.state?.state : x.state?.state));
  return own.sort((a, b) => URG(a) - URG(b))[0];
}

function sessionEl(tab, sid) {
  const el = document.createElement("div");
  el.className = "sterm";
  el.dataset.sid = sid;
  $(".pane-agent .term", tab.view).appendChild(el);
  return el;
}

async function newSession(tab = active, agentKey = null) {
  if (!tab) return;
  const r = await invoke("session_new", { ws: tab.id, agent: agentKey });
  const sess = { id: r.id, n: r.n, agent: r.agent, el: sessionEl(tab, r.id) };
  sess.pane = makePane(tab, "agent", { id: `${r.id}:agent`, el: sess.el });
  tab.sessions.push(sess);
  switchSession(tab, sess.id, { quiet: true });
  await new Promise((res) => setTimeout(res, 30)); // its size before the process starts
  // S2: a new session is a shell (⌘G / typed there for an agent); restored ones with an agent and
  // CVIM_DESKTOP_AUTOSTART start their agent
  if (agentKey || info.autostart) {
    await startAgent(tab, "agent_start");
    invoke("agent_state", { ws: tab.id, session: sess.id });
    toast(`셸 ${sessNo(tab, sess)} — ${r.agent.label} (⌃⌘${sessNo(tab, sess)}로 이동)`);
  } else {
    await startHost(tab, sess);
    renderRail(tab);
    toast(`새 셸 ${sessNo(tab, sess)} (⌘G 에이전트 · ⌃⌘${sessNo(tab, sess)}로 이동)`);
  }
  saveRail(tab);
  return sess;
}

function switchSession(tab, sid, { quiet = false } = {}) {
  const sess = tab.sessions.find((x) => x.id === sid);
  if (!sess) return;
  if (tab.composer && !tab.composer.box.hidden) composerClose(tab);
  tab.sid = sid;
  for (const x of tab.sessions) x.el.style.display = x === sess ? "" : "none";
  tab.panes.agent = sess.pane;
  resize(sess.pane);
  if (sess.agent) showAgent(tab, sess.agent);
  renderWhere(tab);
  tab.agentState = sess.state || null;
  if (sess.state && !(tab.swapped && tab.shellAgent)) renderState(tab, sess.state, { quiet: true });
  renderRail(tab);
  renderTab(tab);
  if (tab === active && !quiet) sess.pane.term.focus();
}

function stepSession(d) {
  const tab = active;
  if (!(tab?.sessions.length > 1)) return;
  const i = tab.sessions.findIndex((x) => x.id === tab.sid);
  switchSession(tab, tab.sessions[(i + d + tab.sessions.length) % tab.sessions.length].id);
}

async function closeSession(tab, sid) {
  const sess = tab.sessions.find((x) => x.id === sid);
  if (!sess || sess.id === tab.id) return toast("첫 셸은 탭과 함께 닫혀요 (⌘W)");
  await invoke("session_close", { ws: tab.id, session: sid });
  panes.delete(sess.pane.id);
  sess.pane.term.dispose();
  sess.el.remove();
  const i = tab.sessions.indexOf(sess);
  tab.sessions.splice(i, 1);
  if (tab.sid === sid) switchSession(tab, tab.sessions[Math.max(0, i - 1)].id);
  renderRail(tab);
  renderTab(tab);
  renderSummary();
}

// the rail: one button per session (agent icon, number, state dot), ✕ (not the first), ＋
function renderRail(tab) {
  const rail = $(".rail", tab.view);
  const multi = tab.sessions?.length > 1;
  rail.hidden = !multi;
  tab.view.classList.toggle("multi", !!multi);
  if (!multi) { $(".agent-name", tab.view).innerHTML = titleHTML(paneTitle(tab, tab.agent), tab.hostAgent && curSession(tab)?.hostWhere); return; }
  rail.innerHTML = tab.sessions.map((x) => {
    const st = x.id === tab.sid ? tab.state?.state : x.state?.state;
    const dot = st === "waiting" || st === "error" ? "bad" : WORKING.includes(st) ? "work" : st === "done" ? "ok" : "idle";
    const no = sessNo(tab, x);
    return `<button class="sess${x.id === tab.sid ? " cur" : ""}" data-sid="${esc(x.id)}" title="셸 ${no} (⌃⌘${no}) — ${esc(x.host && !x.hostAgent ? "셸" : x.agent?.label || "")} · ${esc(DOING[st] || "대기")}">`
      + `<span class="ic">${esc(x.host && !x.hostAgent ? "🐚" : x.agent?.icon || "▸")}</span><span class="n">${no}</span><i class="dot ${dot}"></i>`
      + `${x.id === tab.id ? "" : '<span class="x" title="셸 닫기">✕</span>'}</button>`;
  }).join("") + '<button class="sess-new" title="새 셸 (⌘⇧T)">＋</button>';
}

// ── M2 (1단계): handing text between sessions by hand ─────────────────────────
// a session's label for a "where it came from" line
const sessLabel = (tab, x) => `셸 ${sessNo(tab, x)}(${x.host && !x.hostAgent ? "에이전트 없음" : x.agent?.short || x.agent?.name || "에이전트"})`;

// paste (and maybe send) text into a session's agent: bracketed paste, then Enter separately
async function pasteTo(sess, text, enter) {
  await invoke("pty_write", { id: sess.pane.id, data: `\x1b[200~${text}\x1b[201~` });
  if (enter) setTimeout(() => invoke("pty_write", { id: sess.pane.id, data: "\r" }), 120);
}

// the last selection, from another session of this tab, into `sess` (with a line saying where from)
async function handPick(tab, sess, enter) {
  const from = tab.sessions.find((x) => x.pane.id === lastPick?.from);
  if (!lastPick?.text || !from || from === sess) return toast("다른 셸에서 먼저 글을 끌어 선택하세요");
  await pasteTo(sess, `[${sessLabel(tab, from)}에서 가져온 내용]\n${lastPick.text}`, enter);
  toast(`${sessLabel(tab, from)} → ${sessLabel(tab, sess)}: ${lastPick.text.length}자 ${enter ? "보냄" : "붙임"}`);
}

$("#views").addEventListener("contextmenu", (e) => {
  const b = e.target.closest(".rail .sess");
  if (!b || !active) return;
  e.preventDefault();
  e.stopPropagation();
  const tab = active, sess = tab.sessions.find((x) => x.id === b.dataset.sid);
  if (!sess) return;
  const from = tab.sessions.find((x) => x.pane.id === lastPick?.from && x !== sess);
  const items = [];
  if (from) {
    const n = lastPick.text.length;
    items.push(["📋", `선택한 글 붙여넣기 (${sessLabel(tab, from)}, ${n}자)`, () => handPick(tab, sess, false)]);
    items.push(["📨", `선택한 글 보내기 (${sessLabel(tab, from)}, ${n}자)`, () => handPick(tab, sess, true)]);
  }
  items.push(["✍", "작성 창으로 이 셸에 쓰기", () => { switchSession(tab, sess.id); composerToggle(tab); }]);
  items.push(["↪", "이 셸로 이동", () => switchSession(tab, sess.id)]);
  if (sess.id !== tab.id) items.push(["✕", "셸 닫기", () => closeSession(tab, sess.id)]);
  showMenu(items, e.clientX, e.clientY);
}, true);

// sessions survive a restore (their agents start fresh): main saves them; nothing to do here
function saveRail() {}

$("#views").addEventListener("click", (e) => {
  if (e.target.closest(".sess-add, .sess-new")) return newSession(active);
  const b = e.target.closest(".rail .sess");
  if (!b) return;
  if (e.target.closest(".x")) return closeSession(active, b.dataset.sid);
  switchSession(active, b.dataset.sid);
});

// ── an agent started in the shell pane → swap it into the big slot (P0+) ─────
// tab.swapped: the shell pane sits where the agent pane was (and the other way round)
function swapPanes(tab, on) {
  if (!!tab.swapped === on) return;
  const a = tab.panes.agent.section, b = tab.panes.shell.section;
  const mark = document.createComment("");
  a.replaceWith(mark);
  b.replaceWith(a);
  mark.replaceWith(b);
  tab.swapped = on;
  for (const p of Object.values(tab.panes)) resize(p);
  invoke("pane_swap", { ws: tab.id, on });
  const shown = shownOf(tab);
  if (shown) renderState(tab, shown);
}

// which state the tab shows: the agent in the big slot (the shell's while it's swapped in)
const shownOf = (tab) => (tab.swapped && tab.shellAgent ? tab.shellState : tab.shellOnly && !tab.hostAgent ? SHELL_STATE : tab.agentState);

function onShellAgent(tab, agent, where = null) {
  tab.shellAgent = agent;
  tab.shellWhere = agent ? where : null;
  tab.shellState = null;
  if (!agent && tab.shellOnly && !tab.hostAgent && tab.autoSwapped) renderState(tab, SHELL_STATE); // the agent run in the shell pane ended
  else if (!agent && tab.agentState && !tab.autoSwapped) renderState(tab, tab.agentState); // back to the agent pane's state
  const title = $(".pane-shell .title", tab.view);
  title.innerHTML = titleHTML(agent ? `🐚 Shell · ${agent.label}` : "🐚 Shell", tab.shellWhere);
  renderWhere(tab);
  if (agent && !tab.swapped) {
    swapPanes(tab, true);
    tab.autoSwapped = true;
    if (tab === active) { tab.panes.shell.term.focus(); toast(`셸에서 ${agent.name} 실행 → 큰 칸으로 (⌘⌥↵ 되돌리기)`); }
  } else if (!agent && tab.autoSwapped) {
    tab.autoSwapped = false;
    swapPanes(tab, false);
  }
}

// ── agent state → tab, top bar, avatar, activity ────────────────────────────
function untilReset(epoch) {
  if (typeof epoch !== "number") return "";
  const s = epoch - Date.now() / 1000;
  if (s <= 0) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h >= 24) return ` ↻${Math.floor(h / 24)}d${h % 24}h`;
  return h > 0 ? ` ↻${h}h${String(m).padStart(2, "0")}m` : ` ↻${m}m`;
}

// prices for "≈$" (#23): asked for once a day, only when an agent shows tokens without a cost
let PRICES = null, WINDOWS = {}, pricesAt = 0; // WINDOWS: each model's context window (#45)
function estCost(tokens) {
  if (Date.now() - pricesAt > 24 * 3600 * 1000) {
    pricesAt = Date.now();
    const again = () => { pricesAt = Date.now() - 23.5 * 3600 * 1000; }; // offline: try again in 30 min
    invoke("prices").then((p) => { if (p?.models) { PRICES = p.models; WINDOWS = p.windows || {}; if (active) renderBar(active); } else again(); }).catch(again);
  }
  if (!PRICES) return null;
  let sum = 0, priced = false;
  for (const [model, t] of Object.entries(tokens)) {
    const p = PRICES[model] || PRICES[model.replace(/-\d{8}$/, "")]; // claude-haiku-4-5-20251001 → claude-haiku-4-5
    if (!p) continue;
    priced = true;
    for (let i = 0; i < 5; i++) sum += (t[i] || 0) * p[i];
  }
  return priced ? sum : null;
}

const bar = (p, n = 8) => { const fill = Math.round(((p || 0) / 100) * n); return "█".repeat(fill) + "░".repeat(n - fill); };

function renderBar(tab) {
  const st = tab.state;
  const doing = $("#doing");
  const what = DOING[st.state] || "";
  const detail = DETAIL_STATES.includes(st.state) ? ` ${short(st.detail).slice(0, 32)}` : "";
  doing.className = st.state === "waiting" || st.state === "error" ? "bad" : "dim";
  // narrow windows keep the icon only (the tab shows the state too) (#38)
  doing.innerHTML = st.state === "waiting" ? `❗<span class="doing-text"> ${esc(what)}</span>` : `${ICON[st.state] || ""}<span class="doing-text"> ${esc(what + detail)}</span>`;
  doing.title = `${what}${detail}`;
  document.title = `${ICON[st.state] || ""} ${base(tab.cwd)} — Tamer`;
  const u = withLast(st, tab), parts = [];
  const old = (k) => (u.stale?.includes(k) ? ' title="지난번 값 — 첫 응답 뒤에 새로 고쳐져요" style="opacity:.55"' : "");
  // gauges and the model name give way first on a narrow window: the numbers stay (#38)
  const gauge = (p) => `<span class="gauge">${bar(p)} </span>`;
  if (u?.model) parts.push(`<span class="dim u-model"${old("model")}>${esc(u.model)}</span>`);
  if (u?.ctx != null) parts.push(`<span class="${level(u.ctx)}"${u.ctxEst ? ' title="모델의 최대 입력 크기로 계산한 추정치"' : ""}>ctx ${gauge(u.ctx)}${u.ctxEst ? "≈" : ""}${Math.round(u.ctx)}%</span>`);
  else if (u?.ctx_tokens != null) parts.push(`<span class="dim">ctx ${Math.round(u.ctx_tokens / 1000)}k</span>`);
  if (u?.five_hour) parts.push(`<span class="${level(u.five_hour.pct)}"${old("five_hour")}>5h ${gauge(u.five_hour.pct)}${Math.round(u.five_hour.pct)}%${untilReset(u.five_hour.resets_at)}</span>`);
  if (u?.seven_day) parts.push(`<span class="${level(u.seven_day.pct)}"${old("seven_day")}>7d ${gauge(u.seven_day.pct)}${Math.round(u.seven_day.pct)}%</span>`);
  // a Claude typed in the shell without the opt-in line: no 5h · 7d (only its status line has them) (#45)
  const typedClaude = (st.shellKey || tab.hostAgent?.key) === "claude" && st.state !== "shell";
  if (typedClaude && !u?.five_hour && !u?.seven_day) parts.push('<span class="dim u-hint" title="셸에서 직접 친 Claude는 한도를 알려 주지 않아요 — ⌘G → ⚙ 에이전트 연결 상태 → \'셸에서 친 Claude도 연결\'을 켜거나 ⌘G로 띄우면 보여요 (Pro·Max 구독, 첫 응답 뒤)">5h·7d ?</span>');
  if (u?.cost != null) parts.push(`<span class="dim">$${u.cost.toFixed(2)}</span>`);
  else if (u?.tokens) { // no cost of its own (Claude typed in the shell, Codex): tokens × API prices (#23)
    const c = estCost(u.tokens);
    if (c != null) parts.push(`<span class="dim" title="토큰 수 × API 가격으로 계산한 추정치 — 실제 청구 금액이 아니에요">≈$${c.toFixed(2)}</span>`);
  }
  $("#usage").innerHTML = parts.length ? parts.join('<span class="dim sep"> │ </span>') : `<span class="dim">${esc(st.agent?.short)}</span>`;
  $("#usage").title = u?.model || "";
}

// ── usage before the first reply (and for a Claude started in the shell, which has no statusLine)
// The 5h / 7d limits are the account's, the model is the last one used: shown from the last
// values seen for that agent (dimmed) until the agent reports its own. A context size in tokens
// (conversation log) becomes % with the window last seen for that model. Kept in localStorage.
const lastKey = (k) => `cvim.usage.${k}`;
function lastUsage(key) {
  try { return JSON.parse(localStorage.getItem(lastKey(key)) || "null") || {}; } catch { return {}; }
}
function rememberUsage(key, u) {
  if (!key || !u) return;
  const l = lastUsage(key), windows = { ...(l.windows || {}) };
  if (u.model_id && u.ctx_window) windows[u.model_id] = u.ctx_window;
  const next = { model: u.model || l.model, five_hour: u.five_hour || l.five_hour, seven_day: u.seven_day || l.seven_day, windows };
  try { localStorage.setItem(lastKey(key), JSON.stringify(next)); } catch {}
}
const live = (w) => w && (w.resets_at == null || w.resets_at * 1000 > Date.now());
function withLast(st, tab) {
  const key = st.shellKey || st.agent?.key || tab.agent?.key;
  if (!key || st.state === "shell") return st.usage || {};
  const u = { ...(st.usage || {}) }, l = lastUsage(key), stale = [];
  if (u.ctx == null && u.ctx_tokens != null && l.windows?.[u.model_id]) u.ctx = (u.ctx_tokens / l.windows[u.model_id]) * 100;
  // no window learned from a status line yet (a Claude only ever typed in the shell): the price list's
  // max input for that model — an estimate, shown with ≈ (#45)
  else if (u.ctx == null && u.ctx_tokens != null) {
    if (!PRICES) estCost({}); // loads the list (and its windows) once
    const w = WINDOWS[u.model_id] || WINDOWS[String(u.model_id || "").replace(/-\d{8}$/, "")];
    if (w) { u.ctx = (u.ctx_tokens / w) * 100; u.ctxEst = true; }
  }
  if (!u.model && l.model) { u.model = l.model; stale.push("model"); }
  for (const k of ["five_hour", "seven_day"]) if (!u[k] && live(l[k])) { u[k] = l[k]; stale.push(k); }
  u.stale = stale;
  return u;
}

// quiet: showing another session's state (M1 switch) — not a change that happened just now
function renderState(tab, st, { quiet = false } = {}) {
  const prev = quiet ? null : tab.state?.state;
  tab.state = st;
  if (st.agent && st.agent.key !== tab.agent?.key) showAgent(tab, st.agent);
  renderTab(tab);
  if (tab === active) renderBar(tab);
  const what = DOING[st.state] || "";
  pokeClass(tab);
  // how the turn ended: finished = type attack, interrupted (Esc) = flinch, failed = hurt
  if (prev && prev !== st.state && ["done", "interrupted", "error"].includes(st.state)) refreshChanges(tab); // the agent may have changed files
  if (prev && prev !== st.state) {
    if (st.state === "done") react(tab, "attack");
    else if (st.state === "interrupted") react(tab, "flinch");
    else if (st.state === "error") react(tab, "hurt");
  }
  renderSummary();
  $(".state-line", tab.view).textContent = `${ICON[st.state] || ""} ${what}`;
  $(".activity", tab.view).innerHTML = (st.log || []).slice().reverse().map((ev) => {
    const t = new Date(ev.ts > 1e12 ? ev.ts : ev.ts * 1000).toTimeString().slice(0, 8);
    const icon = ev.event === "PreToolUse" ? TOOL_ICON[TOOL_STATE[ev.tool] || "tool"] : EVENT_ICON[ev.event] || "·";
    const label = ev.event === "PreToolUse" ? ev.tool : ev.event;
    return `<li><span class="dim">${t}</span> ${icon} ${esc(label)} <span class="dim">${esc(short(ev.detail).slice(0, 60))}</span></li>`;
  }).join("");
}

// ── partner Pokémon ─────────────────────────────────────────────────────────
// state motion (st-*) + a short one-off action (act-*) on top of it
function pokeClass(tab) {
  const img = $(".poke", tab.view);
  img.className = `poke st-${tab.state?.state || "idle"}${tab.act ? ` act-${tab.act}` : ""}${tab.evolving ? " evolving" : ""}`;
}

async function loadImg(img, gif) {
  img.src = `data:image/gif;base64,${await invoke("sprite_b64", { path: gif })}`;
  await img.decode().catch(() => {});
  const box = img.closest(".avatar-box").getBoundingClientRect();
  const k = Math.max(1, Math.min(3, Math.floor(Math.min(box.width / img.naturalWidth, (box.height - 90) / img.naturalHeight)) || 1));
  img.style.width = `${img.naturalWidth * k}px`; // integer scale only: crisp pixels
}

async function showPartner(tab, pk) {
  tab.partner = pk;
  $(".empty-ball", tab.view).hidden = true;
  const label = $(".poke-label", tab.view);
  if (!pk?.gif) { label.textContent = "(파트너를 불러오지 못했어요)"; return; }
  const img = $(".poke", tab.view);
  await loadImg(img, pk.gif);
  img.hidden = false;
  $(".pokeball", tab.view).hidden = true;
  label.textContent = `${pk.shiny ? "✨" : ""}${pk.name ?? ""}`;
  showProgress(tab, pk);
}

function showProgress(tab, p) {
  if (p.pinned != null) tab.pinned = p.pinned;
  $(".poke-exp", tab.view).textContent = `EXP ${p.xp ?? 0}${p.toEvolve != null ? ` · 진화까지 ${p.toEvolve}` : " · 최종 진화"}`;
}

function loading(tab) {
  $(".poke", tab.view).hidden = true;
  $(".pokeball", tab.view).hidden = false;
}

// click: attack (type effect) or cute (hearts)
function react(tab, kind) {
  if (!tab.partner) return;
  tab.act = kind;
  pokeClass(tab);
  const glyph = { cute: "💕", flinch: "💦", hurt: "💢" }[kind] || TYPE_FX[tab.partner.types?.[0]] || "💥";
  burst(tab, glyph, kind === "attack" ? 8 : kind === "hurt" ? 4 : 5);
  clearTimeout(tab.actTimer);
  tab.actTimer = setTimeout(() => { tab.act = null; pokeClass(tab); }, 1000);
}

function burst(tab, glyph, n) {
  const fx = $(".fx", tab.view);
  for (let i = 0; i < n; i++) {
    const s = document.createElement("span");
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
    const r = 45 + Math.random() * 25;
    s.textContent = glyph;
    s.style.setProperty("--dx", `${Math.cos(a) * r}px`);
    s.style.setProperty("--dy", `${Math.sin(a) * r}px`);
    fx.appendChild(s);
    setTimeout(() => s.remove(), 800);
  }
}

// evolution: white silhouette flicker between the old and new sprite, then the new one
async function evolve(tab, from, to) {
  const img = $(".poke", tab.view);
  tab.evolving = true;
  pokeClass(tab);
  toast(`어라…!? ${from?.name ?? tab.partner?.name ?? ""}의 모습이…!`);
  const frames = [from?.gif || tab.partner?.gif, to.gif].filter(Boolean);
  for (let i = 0; i < 8; i++) { await loadImg(img, frames[i % frames.length]); await new Promise((r) => setTimeout(r, 120 + i * 40)); }
  tab.evolving = false;
  await showPartner(tab, to);
  pokeClass(tab);
  burst(tab, "✨", 10);
  toast(`축하합니다! ${from?.name ?? ""}는 ${to.name}(으)로 진화했다!`);
}

// ── choosing a partner (#29: a view of the Pokémon window — 🌟 파트너 고르기; box rules in
// electron/core/partner.cjs): the first partner's starters (once, empty box) · a resting one from the
// box · another folder's partner. Same cards, preview and button as 내 포켓몬.
let chooseFor = null; // the tab it's choosing for
let chooseSlow = null;

// auto: opened by the app (new folder / tab selected), not by the user — skipped if the user has
// closed it for this tab meanwhile, the tab isn't on screen, or there is nothing to choose
async function openChoose(tab = active, auto = false) {
  if (!tab) return;
  closeMenu();
  const o = await invoke("partner_options", { ws: tab.id });
  if (auto && (tab.askedOnce || tab !== active || chooseOpen() || dexOpen() || tab.partner?.uid || !(o.starter || o.resting.length || o.others.length))) return;
  chooseFor = tab;
  await openDex(undefined, "choose", o);
  clearTimeout(chooseSlow);
  if (o.starterLoading) chooseSlow = setTimeout(() => { if (chooseOpen()) { dexState.chooseNote = "PokéAPI 응답이 느려요 — 박스의 포켓몬을 고르거나, 나중에 다시 열어도 돼요"; boxRender(); } }, 30000);
}

const chooseOpen = () => dexOpen() && dexState?.view === "choose";
// byUser: the user closed it (Esc / ✕ / took one) — don't ask that tab again on its own
function closeChoose(byUser = true) {
  clearTimeout(chooseSlow);
  const tab = chooseFor;
  if (tab && byUser) tab.askedOnce = true;
  chooseFor = null;
  if (dexOpen()) closeDex(); else focusBig(tab);
}
// new options while open (today's starters arriving)
function renderChoose(tab, o) {
  if (!chooseOpen() || chooseFor !== tab) return;
  dexState.chooseOpts = o;
  if (o.starter?.ready) dexState.chooseNote = "";
  boxRender();
  dexTitle();
}
// the cards of 🌟 파트너 고르기, in its three groups
function chooseItems(o) {
  const items = [];
  if (o.starter) {
    o.starter.set.forEach((c, i) => items.push({ ...c, kind: "starter", group: "starter", key: `s${i}`, n: i + 1 }));
    for (let i = o.starter.set.length; i < o.starter.total; i++) items.push({ kind: "loading", group: "starter" });
  }
  o.resting.forEach((m, i) => items.push({ ...m, kind: "rest", group: "rest", key: `r${i}`, folder: null }));
  o.others.forEach((m, i) => items.push({ ...m, kind: "other", group: "other", key: `o${i}`, folder: m.folderName }));
  return items;
}

// sprite data URLs, kept (the dialog redraws while today's candidates arrive)
const sprites = new Map();
function spriteUrl(gif) {
  if (!sprites.has(gif)) sprites.set(gif, invoke("sprite_b64", { path: gif }).then((b) => `data:image/gif;base64,${b}`).then(stillFrame).catch(() => null));
  return sprites.get(gif);
}
// UI scenes: the first frame only, so a capture is the same picture every run
async function stillFrame(url) {
  if (!info?.test?.ui_scenes) return url;
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  return c.toDataURL("image/png");
}

// a tab without a partner: the avatar pane says so (the dialog opens on its own for the tab on screen)
function needPartner(tab, freed) {
  tab.partner = null;
  tab.partnerChecked = true;
  showEmpty(tab, freed);
  openChoose(tab, true);
}

// no partner: an empty Poké Ball (drawn here, nothing to download) and how to get one
function showEmpty(tab, freed) {
  $(".poke", tab.view).hidden = true;
  $(".pokeball", tab.view).hidden = true;
  $(".empty-ball", tab.view).hidden = false;
  $(".poke-label", tab.view).innerHTML = `파트너가 없어요 <button class="need-partner">파트너 고르기</button>`;
  $(".poke-exp", tab.view).textContent = freed ? "파트너가 다른 폴더로 갔어요 · 작업을 끝내면 야생 포켓몬이 더 자주 나타나요"
    : "작업을 끝내면 야생 포켓몬이 더 자주 나타나요 — 잡아서 파트너로";
}
$("#views").addEventListener("click", (e) => { if (e.target.closest(".need-partner")) openChoose(active); });

// a Pokédex entry → this tab's partner: a resting one of that species, else another folder's
async function takeSpecies(tab, id) {
  const o = await invoke("partner_options", { ws: tab.id });
  const rest = o.resting.findLast((m) => m.id === id); // the newest (e.g. just caught)
  const other = o.others.find((m) => m.id === id);
  if (rest) return pkTake({ ...rest, kind: "rest", folder: null }, tab);
  if (other) { toast(`쉬는 ${other.name}가 없어요 — ${other.folderName} 폴더의 파트너예요 (도감에서 데려올 수 있어요)`); return; }
  toast("박스에 없는 포켓몬이에요 (만나기만 했어요)");
}

// ── right-click menu ────────────────────────────────────────────────────────
function openMenu(tab, x, y) {
  const items = [
    ["🔄", "파트너 바꾸기 (첫 파트너 · 박스)", () => openChoose(tab)],
    ["⚔️", "공격", () => react(tab, "attack")],
    ["💕", "애교", () => react(tab, "cute")],
    ["📕", "도감", () => openDex()],
    ["🌿", wildOn ? "야생 포켓몬 끄기" : "야생 포켓몬 켜기", async () => {
      wildOn = await invoke("wild_toggle");
      toast(wildOn ? "🌿 작업이 끝나면 가끔 야생 포켓몬이 나타나요" : "🌿 야생 포켓몬이 나타나지 않아요");
    }],
  ];
  showMenu(items, x, y);
}

// a small menu at (x, y): [icon, label, fn] — number keys pick
function showMenu(items, x, y, { def = -1, title = "" } = {}) {
  const m = $("#menu");
  m.innerHTML = title ? `<div class="menu-title">${esc(title)}</div>` : "";
  items.forEach(([icon, label, fn], i) => {
    const b = document.createElement("button");
    if (i === def) b.classList.add("sel");
    b.innerHTML = `<span class="k">${i + 1}</span><span>${icon}</span><span>${esc(label)}</span>`;
    b.addEventListener("click", () => { closeMenu(); fn(); });
    m.appendChild(b);
  });
  m.hidden = false;
  m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - m.offsetHeight - 8)}px`;
  m.items = items;
  m.def = def;
  // keys go to the menu, not the focused terminal (IME too); focus comes back on close
  m.prevFocus = document.activeElement;
  m.prevFocus?.blur();
}
// ↑↓: the highlighted item (Enter runs it)
function menuSel(i) {
  const m = $("#menu");
  m.def = i;
  m.querySelectorAll("button").forEach((b, j) => b.classList.toggle("sel", j === i));
}
function closeMenu() {
  const m = $("#menu");
  if (m.hidden) return;
  m.hidden = true;
  if (document.activeElement === document.body || !document.activeElement) m.prevFocus?.focus();
}
window.addEventListener("mousedown", (e) => { if (!$("#menu").hidden && !e.target.closest("#menu")) closeMenu(); }, true);

$("#views").addEventListener("click", (e) => {
  const img = e.target.closest(".poke");
  if (img) react(active, Math.random() < 0.5 ? "attack" : "cute");
});
$("#views").addEventListener("contextmenu", (e) => {
  if (!e.target.closest(".pane-avatar") || !active) return;
  e.preventDefault();
  openMenu(active, e.clientX, e.clientY);
});

// ── wild Pokémon (a finished task sometimes brings one; ⌘B / click throws a Poké Ball) ──
let wildOn = true;
const wild = createWild($("#wild"), {
  invoke,
  log: (line) => invoke("log_line", { line }),
  // caught (it rests in the box): make it this tab's partner right away
  partnerButton: (e) => active && takeSpecies(active, e.id),
  dexButton: (e) => openDex(e.id), // #9
});

// ── 📝 changes panel (E1b): the folder's changed files (git), refreshed when a turn ends, the tab
// is selected, every 10 s while on screen, or ↻. A file → side-by-side diff, "revert this file". ──
const STATUS = { modified: ["M", "mod"], added: ["A", "add"], new: ["N", "add"], deleted: ["D", "del"], renamed: ["R", "mod"] };

async function refreshChanges(tab) {
  if (!tab || tab.changesBusy) return;
  tab.changesBusy = true;
  try {
    const r = await invoke("changes_list", { ws: tab.id });
    tab.changes = r;
    renderChanges(tab);
  } catch {} finally { tab.changesBusy = false; }
}
setInterval(() => { if (active && document.hasFocus()) refreshChanges(active); }, 10000);

function renderChanges(tab) {
  const ul = $(".changes", tab.view), r = tab.changes;
  // a redraw (every 10 s) must not take the keyboard away from the list
  const had = document.activeElement?.closest?.(".changes li[data-i]") && ul.contains(document.activeElement)
    ? document.activeElement.title : null;
  $(".changes-count", tab.view).textContent = r?.repo && r.items.length ? `(${r.items.length})` : "";
  if (!r) return;
  if (!r.repo) { ul.innerHTML = '<li class="dim">git 저장소가 아니에요</li>'; return; }
  if (!r.items.length) { ul.innerHTML = '<li class="dim">바뀐 파일이 없어요</li>'; return; }
  ul.innerHTML = r.items.map((x, i) => {
    const [mark, cls] = STATUS[x.status] || ["?", ""];
    const nums = x.binary ? '<span class="dim">바이너리</span>'
      : `${x.add ? `<span class="add">+${x.add}</span>` : ""} ${x.del ? `<span class="del">−${x.del}</span>` : ""}`;
    const slash = x.path.lastIndexOf("/");
    return `<li data-i="${i}" tabindex="0" title="${esc(x.path)}"><b class="st ${cls}">${mark}</b>`
      + `<span class="file">${esc(x.path.slice(slash + 1))}</span><span class="dir dim">${esc(slash > 0 ? x.path.slice(0, slash) : "")}</span><span class="nums">${nums}</span></li>`;
  }).join("");
  if (had != null) [...ul.querySelectorAll("li[data-i]")].find((li) => li.title === had)?.focus();
}

// after the diff closes: back to the file's line in the list; if that file was reverted (gone),
// the line now at its place (or the one above); an empty list → the agent pane
function focusAfterDiff(tab, path, index) {
  if (tab !== active) return;
  const items = tab.changes?.items || [];
  let i = items.findIndex((x) => x.path === path);
  if (i < 0) i = Math.min(index, items.length - 1);
  const li = i >= 0 && $(`.changes li[data-i="${i}"]`, tab.view);
  if (li) li.focus();
  else focusBig(tab);
}

$("#views").addEventListener("click", (e) => {
  if (e.target.closest(".changes-refresh")) { refreshChanges(active); toast("변경 사항을 새로 읽었어요"); return; }
  const li = e.target.closest(".changes li[data-i]");
  if (li) openDiff(active, active.changes.items[Number(li.dataset.i)], Number(li.dataset.i));
});
$("#views").addEventListener("keydown", (e) => {
  const li = e.target.closest?.(".changes li[data-i]");
  if (!li) return;
  if (e.key === "Enter") { e.preventDefault(); openDiff(active, active.changes.items[Number(li.dataset.i)], Number(li.dataset.i)); }
  else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); li.nextElementSibling?.focus(); }
  else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); li.previousElementSibling?.focus(); }
  else if (e.key === "Escape") { e.preventDefault(); focusBig(active); }
});

// unified diff → rows for a side-by-side table (removed lines pair up with the added ones after them)
function sideBySide(diff) {
  const rows = [];
  let a = 0, b = 0, dels = [], adds = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ l: dels[i], r: adds[i] });
    dels = []; adds = [];
  };
  for (const line of diff.split("\n")) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (h) { flush(); a = Number(h[1]); b = Number(h[2]); rows.push({ hunk: line }); continue; }
    if (!rows.length || line === "" || line.startsWith("\\")) continue; // header lines, the text's last newline, "\ No newline"
    if (line.startsWith("-")) dels.push({ n: a++, t: line.slice(1), k: "del" });
    else if (line.startsWith("+")) adds.push({ n: b++, t: line.slice(1), k: "add" });
    else { flush(); const t = line.slice(1); rows.push({ l: { n: a++, t, k: "" }, r: { n: b++, t, k: "" } }); }
  }
  flush();
  return rows;
}

let diffFor = null;
async function openDiff(tab, item, index = 0) {
  if (!tab || !item) return;
  diffFor = { tab, item, index };
  const [mark] = STATUS[item.status] || ["?"];
  $("#diff-title").innerHTML = `<b class="st">${mark}</b> ${esc(item.path)} <span class="add">${item.add ? `+${item.add}` : ""}</span> <span class="del">${item.del ? `−${item.del}` : ""}</span>`;
  const btn = $("#diff-revert");
  btn.className = "";
  btn.textContent = item.status === "new" || item.status === "added" ? "이 파일 지우기(휴지통)" : "이 파일 되돌리기";
  const body = $("#diff-body");
  body.innerHTML = '<p class="dim">불러오는 중…</p>';
  $("#diffview").hidden = false;
  $("#diffview").focus();
  let r;
  try { r = await invoke("changes_diff", { ws: tab.id, path: item.path }); } catch (e) { body.innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
  if (r.binary) { body.innerHTML = '<p class="dim">바이너리 파일이라 비교할 수 없어요</p>'; return; }
  const rows = sideBySide(r.diff);
  const cell = (c) => (c ? `<td class="ln">${c.n}</td><td class="tx ${c.k}">${esc(c.t)}</td>` : '<td class="ln"></td><td class="tx none"></td>');
  body.innerHTML = rows.length ? `<table class="sbs"><colgroup><col class="c-ln"><col><col class="c-ln"><col></colgroup>${rows.map((x) => x.hunk
    ? `<tr class="hunk"><td colspan="4">${esc(x.hunk)}</td></tr>` : `<tr>${cell(x.l)}${cell(x.r)}</tr>`).join("")}</table>${r.truncated ? '<p class="dim">(너무 길어서 일부만)</p>' : ""}`
    : '<p class="dim">내용 변경 없음(권한·이름만 바뀜)</p>';
}

function closeDiff() {
  $("#diffview").hidden = true;
  const d = diffFor;
  diffFor = null;
  if (d) focusAfterDiff(d.tab, d.item.path, d.index);
  else focusBig(active);
}
const diffOpen = () => !$("#diffview").hidden;

// revert: press twice (new files go to the Trash, never deleted)
$("#diff-revert").addEventListener("click", async () => {
  const btn = $("#diff-revert"), d = diffFor;
  if (!d) return;
  if (!btn.classList.contains("confirm")) {
    btn.classList.add("confirm");
    btn.textContent = d.item.status === "new" || d.item.status === "added" ? "한 번 더 누르면 휴지통으로" : "한 번 더 누르면 되돌려요 (바뀐 내용 사라짐)";
    return;
  }
  const r = await invoke("changes_revert", { ws: d.tab.id, path: d.item.path }).catch((e) => { toast(String(e.message || e)); return null; });
  if (!r) return;
  // the list without it first, then close (focus goes to the line now at its place)
  d.tab.changes = await invoke("changes_list", { ws: d.tab.id }).catch(() => d.tab.changes);
  renderChanges(d.tab);
  closeDiff();
  toast(r.status === "new" || r.status === "added" ? `${d.item.path}를 휴지통으로 옮겼어요` : `${d.item.path}를 되돌렸어요`);
});
$("#diff-close").addEventListener("click", () => closeDiff());
$("#diffview").addEventListener("click", (e) => { if (e.target === $("#diffview")) closeDiff(); });

// ── Pokédex (⌘D): every Pokémon of Gen I–V as a grid by region — caught in colour, seen as a
// silhouette, never met as "?" (no downloads for those). Like a "name them all" quiz board. ──
const REGIONS = [["관동", 1, 151], ["성도", 152, 251], ["호연", 252, 386], ["신오", 387, 493], ["하나", 494, 649]];
let dexState = null;

// "3분 전" for a catch time (epoch s)
function ago(at) {
  const s = Math.max(0, Date.now() / 1000 - (at || 0));
  return s < 60 ? "방금" : s < 3600 ? `${Math.floor(s / 60)}분 전` : s < 86400 ? `${Math.floor(s / 3600)}시간 전` : `${Math.floor(s / 86400)}일 전`;
}

// sel: the species to show first (a wild one just caught → "도감에서 보기", #9)
// view: "dex" | "box" | "choose" (with the choose options); default the last of 도감 / 내 포켓몬
async function openDex(sel, view, chooseOpts) {
  closeMenu();
  const d = await invoke("dex_list");
  const byNo = new Map(d.entries.map((e) => [e.id, e]));
  // where this tab could take each species from: resting / other folders / already its partner
  const opts = active ? await invoke("partner_options", { ws: active.id }) : null;
  // a new catch you haven't looked at comes first — in the "새로 잡은" row (zone "recent", ri = its
  // place there); otherwise the grid. The arrows move inside the zone the selection is in (#17)
  const ri = sel ? d.recent?.findIndex((m) => m.id === sel) ?? -1 : d.recent?.findIndex((m) => m.new) ?? -1;
  dexState = { ...d, byNo, opts, chooseOpts, view: "dex", zone: ri >= 0 ? "recent" : "grid", ri: Math.max(0, ri),
    sel: sel || d.recent?.[ri]?.id || active?.partner?.id || d.entries[0]?.id || 1 };
  dexTitle();
  $("#dex-regions").innerHTML = (d.recent?.length ? `<button data-a="new" class="new-tab">🆕 새로 잡은 <span class="dim">${d.recent.length}</span></button>` : "")
    + REGIONS.map(([name, a, b]) => {
      const got = d.entries.filter((e) => e.caught && e.id >= a && e.id <= b).length;
      return `<button data-a="${a}">${name} <span class="dim">${got}/${b - a + 1}</span></button>`;
    }).join("")
    + `<span class="dex-search"><input id="dex-search" type="search" spellcheck="false" placeholder="🔍 검색 ( / )" value="${esc(dexQuery)}"
        title="${esc(DEX_SEARCH_HELP)}" /><span id="dex-found" class="dim"></span></span>`;
  const grid = $("#dex-grid");
  // the last 24 hours' catches, newest first (#10 #18): blue that fades with time (Pokémon GO);
  // yellow + NEW = not looked at yet
  const day = (d.recentHours || 24) * 3600;
  const recent = d.recent?.length ? `<h4 id="region-new">🆕 새로 잡은 포켓몬</h4><div class="cells recent">`
    + d.recent.map((m, i) => {
      const e = byNo.get(m.id);
      const fade = Math.max(0, Math.min(1, (Date.now() / 1000 - (m.at || 0)) / day)).toFixed(2);
      return `<div class="cell caught${m.new ? " new" : ""}" style="--age:${fade}" data-n="${m.id}" data-ri="${i}" title="${esc(e?.name || `#${m.id}`)} · ${ago(m.at)}${m.folder ? " · 파트너" : ""}">`
        + (e?.gif ? `<img data-gif="${esc(e.gif)}" alt="" />` : `<span class="q"></span>`) + `<i class="no">${m.id}</i>${m.shiny ? '<i class="shiny">✨</i>' : ""}${m.new ? '<i class="pk-newb">NEW</i>' : ""}</div>`;
    }).join("") + "</div>" : "";
  grid.innerHTML = recent + REGIONS.map(([name, a, b]) => {
    const cells = [];
    for (let n = a; n <= b; n++) {
      const e = byNo.get(n);
      const cls = !e ? "unknown" : e.caught ? "caught" : "seen";
      const mark = e?.owned > 1 ? `<i class="cnt">×${e.owned}</i>` : "";
      const star = e?.caught && e.shiny ? '<i class="shiny">✨</i>' : "";
      const me = active?.partner?.id === n ? " partner" : "";
      const fresh = e?.fresh ? " new" : "";
      cells.push(`<div class="cell ${cls}${me}${fresh}" data-n="${n}" title="#${String(n).padStart(3, "0")}${e ? " " + esc(e.name) : ""}">`
        + (e?.gif ? `<img data-gif="${esc(e.gif)}" alt="" />` : `<span class="q">${e ? "" : "?"}</span>`) + `<i class="no">${n}</i>${mark}${star}${fresh ? '<i class="pk-newb">NEW</i>' : ""}</div>`);
    }
    return `<h4 id="region-${a}" data-name="${name}">${name}</h4><div class="cells" data-a="${a}">${cells.join("")}</div>`;
  }).join("") + `<div id="dex-empty" class="pk-empty" hidden></div>`;
  grid.querySelectorAll("img[data-gif]").forEach((img) => spriteUrl(img.dataset.gif).then((u) => { if (u) img.src = u; }));
  $("#dex").hidden = false;
  const want = view || (dexLastView === "box" && !sel ? "box" : "dex");
  if (want !== "dex") return dexView(want);
  viewChrome("dex");
  dexFilter();
  const d0 = dexState;
  if (d0.hits && !d0.hits.includes(d0.sel)) { d0.zone = "grid"; if (d0.hits.length) d0.sel = d0.hits[0]; }
  if (d0.zone === "recent") dexRecent(d0.ri); else dexSelect(d0.sel);
}

// while searching, ↑↓ go to the nearest shown cell above / below (the layout has gaps); null = none
function dexGeo(from, cells, dir) {
  const r = from.getBoundingClientRect();
  let best = null, score = Infinity;
  for (const c of cells) {
    const b = c.getBoundingClientRect();
    const dy = dir > 0 ? b.top - r.top : r.top - b.top;
    if (dy < r.height / 2) continue;
    const sc = dy * 1000 + Math.abs(b.left - r.left);
    if (sc < score) { score = sc; best = c; }
  }
  return best;
}
const shownCells = (sel) => [...document.querySelectorAll(sel)].filter((c) => !c.classList.contains("nomatch") && c.offsetParent);
// arrows while searching (only shown cells); false = not handled here
function dexKeyFiltered(k, e) {
  const d = dexState;
  const row = shownCells("#dex-grid .cells.recent .cell"), grid = shownCells("#dex-grid .cells:not(.recent) .cell");
  const cur = d.zone === "recent" ? $(`#dex-grid .cells.recent .cell[data-ri="${d.ri}"]`) : $(`#dex-grid .cells:not(.recent) .cell[data-n="${d.sel}"]`);
  const left = k === "ArrowLeft" || k === "h", right = k === "ArrowRight" || k === "l", up = k === "ArrowUp" || k === "k", down = k === "ArrowDown" || k === "j";
  if (!(left || right || up || down || k === "Home" || k === "End" || k === "Tab")) return false;
  if (d.zone === "recent" && row.length) {
    const i = Math.max(0, row.indexOf(cur));
    if (left || right) return dexRecent(Number(row[Math.max(0, Math.min(row.length - 1, i + (right ? 1 : -1)))].dataset.ri)), true;
    if (k === "Home" || k === "End") return dexRecent(Number(row[k === "Home" ? 0 : row.length - 1].dataset.ri)), true;
    const to = cur && dexGeo(cur, row, up ? -1 : 1);
    if (to) return dexRecent(Number(to.dataset.ri)), true;
    if (down) dexSelect(d.sel);
    return true;
  }
  if (!grid.length) return true;
  if (left || right || k === "Tab") return dexStep(right || (k === "Tab" && !e?.shiftKey) ? 1 : -1), true;
  if (k === "Home" || k === "End") return dexSelect(Number(grid[k === "Home" ? 0 : grid.length - 1].dataset.n)), true;
  const to = cur && dexGeo(cur, grid, up ? -1 : 1);
  if (to) dexSelect(Number(to.dataset.n));
  else if (up && row.length) { const back = row.find((c) => Number(c.dataset.ri) === d.ri) || row[0]; dexRecent(Number(back.dataset.ri)); $("#region-new")?.scrollIntoView({ block: "start" }); }
  return true;
}

// ── dex search (#21), Pokémon GO's search terms: "&" and, "," or, "!" not ─────────────────────
const DEX_SEARCH_HELP = "이름 일부 · 번호 25 · 범위 1-151 · 타입(불꽃/fire) · 지역(관동…) · new(안 본 것) · ✨/이로치 · 잡음 · 만남 · 못만남 · 파트너 · 전설 · 환상 · age0(24시간 안에 잡음)·age0-7\n& 그리고 · , 또는 · ! 제외  예) 불꽃,물&!잡음";
const TYPE_KO = { 노말: "normal", 불꽃: "fire", 물: "water", 풀: "grass", 전기: "electric", 얼음: "ice", 격투: "fighting", 독: "poison", 땅: "ground",
  비행: "flying", 에스퍼: "psychic", 벌레: "bug", 바위: "rock", 고스트: "ghost", 드래곤: "dragon", 악: "dark", 강철: "steel", 페어리: "fairy" };
let dexQuery = ""; // kept while the app runs (like GO), cleared with Esc in the box
// legendary / mythical numbers #1–649 (PokéAPI is_legendary / is_mythical, 2026-10-04) — numbers only,
// so even ones never met can be found, like GO's "legendary" / "mythical" (#22)
const LEGENDARY = new Set([144, 145, 146, 150, 243, 244, 245, 249, 250, 377, 378, 379, 380, 381, 382, 383, 384, 480, 481, 482, 483, 484, 485, 486, 487, 488, 638, 639, 640, 641, 642, 643, 644, 645, 646]);
const MYTHICAL = new Set([151, 251, 385, 386, 489, 490, 491, 492, 493, 494, 647, 648, 649]);

// one term (no "!") against number n / entry e (undefined = never met)
function dexTerm(t, n, e) {
  t = t.toLowerCase();
  let m;
  if ((m = t.match(/^#?(\d+)$/))) return n === Number(m[1]);
  if ((m = t.match(/^#?(\d*)-(\d*)$/)) && (m[1] || m[2])) return n >= (Number(m[1]) || 1) && n <= (Number(m[2]) || 9999);
  if ((m = t.match(/^age(\d+)(?:-(\d*))?$/))) {
    if (!e?.caughtAt) return false;
    const age = Math.floor((Date.now() / 1000 - e.caughtAt) / 86400), lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : m[2] === "" ? Infinity : Number(m[2]);
    return age >= lo && age <= hi;
  }
  if (["new", "새", "새로"].includes(t)) return !!e?.fresh;
  if (["shiny", "✨", "이로치"].includes(t)) return !!e?.shiny;
  if (["caught", "잡음", "잡은"].includes(t)) return !!e?.caught;
  if (["seen", "만남", "만나기만"].includes(t)) return !!e && !e.caught;
  if (["unknown", "못만남", "?"].includes(t)) return !e;
  if (["partner", "파트너"].includes(t)) return !!e?.partner;
  if (["legendary", "전설"].includes(t)) return LEGENDARY.has(n);
  if (["mythical", "환상"].includes(t)) return MYTHICAL.has(n);
  const region = REGIONS.find(([name]) => name === t);
  if (region) return n >= region[1] && n <= region[2];
  const type = TYPE_KO[t] || (TYPE_ICON[t] ? t : null);
  if (type) return !!e?.types?.includes(type);
  return !!e?.name && e.name.toLowerCase().includes(t);
}
function dexMatch(q, n, e) {
  return q.split("&").every((group) => {
    const ors = group.split(",").map((x) => x.trim()).filter(Boolean);
    return !ors.length || ors.some((t) => (t.startsWith("!") ? !dexTerm(t.slice(1).trim(), n, e) : dexTerm(t, n, e)));
  });
}
// a search shows only the results (#22, like Pokémon GO): matching cells, the regions that have any
// (with their count), the number on each cell; nothing found → what was searched + how to fix it.
// d.hits = matching numbers (null = no search)
function dexFilter() {
  const d = dexState;
  if (!d) return;
  const q = dexQuery.trim(), grid = $("#dex-grid");
  d.hits = q ? [] : null;
  grid.classList.toggle("filtering", !!q);
  for (let n = 1; n <= d.total; n++) {
    const ok = !q || dexMatch(q, n, d.byNo.get(n));
    if (q && ok) d.hits.push(n);
    for (const c of grid.querySelectorAll(`.cell[data-n="${n}"]`)) c.classList.toggle("nomatch", !ok);
  }
  for (const cells of grid.querySelectorAll(".cells")) {
    const shown = cells.querySelectorAll(".cell:not(.nomatch)").length, h = cells.previousElementSibling;
    cells.hidden = h.hidden = !!q && !shown;
    if (h.dataset.name) h.textContent = q ? `${h.dataset.name} ${shown}` : h.dataset.name;
  }
  const empty = $("#dex-empty");
  empty.hidden = !q || d.hits.length > 0;
  if (!empty.hidden) {
    empty.innerHTML = `<b>"${esc(q)}"</b>에 맞는 포켓몬이 없어요<button id="dex-clear">검색 지우기</button>`
      + `<div class="dim">${q.includes("&") || q.includes("!") ? "&amp; 조건을 하나 줄이거나 ! 를 빼 보세요 · " : ""}예) 불꽃 · 전설 · 잡음 · age0 · 1-151</div>`;
  }
  $(".dex-preview").style.visibility = empty.hidden ? "" : "hidden"; // nothing found: no stale preview
  // the region buttons follow the search: its results in each, none → can't be pressed (#24)
  for (const b of document.querySelectorAll("#dex-regions button[data-a]")) {
    const r = b.dataset.a === "new" ? null : REGIONS.find(([, a]) => String(a) === b.dataset.a);
    const n = !q ? null : r ? d.hits.filter((x) => x >= r[1] && x <= r[2]).length : shownCells("#dex-grid .cells.recent .cell").length;
    b.dataset.label ??= b.innerHTML;
    b.innerHTML = n == null ? b.dataset.label : `${b.dataset.label.replace(/<span class="dim">.*<\/span>/, "")}<span class="dim">${n}</span>`;
    b.disabled = n === 0;
  }
  $("#dex-found").textContent = q ? `${d.hits.length}종` : "";
}

// with a search: ←→ jump between results
function dexStep(dir) {
  const d = dexState, h = d.hits;
  if (!h?.length) return dexSelect(dir > 0 ? d.sel % d.total + 1 : (d.sel - 2 + d.total) % d.total + 1);
  const next = dir > 0 ? h.find((n) => n > d.sel) ?? h[0] : [...h].reverse().find((n) => n < d.sel) ?? h.at(-1);
  dexSelect(next);
}
function dexSearchKey(e) {
  const box = $("#dex-search");
  if (e.isComposing || e.keyCode === 229) return false; // Hangul being typed
  const boxView = dexState?.view !== "dex";
  if (e.key === "Escape") { if (box.value) { box.value = ""; dexQuery = ""; if (boxView) boxRender(); else dexFilter(); } else box.blur(); return true; }
  if (e.key === "Enter" || e.key === "ArrowDown") {
    box.blur();
    if (boxView) { boxSelect(0); return true; }
    if (dexState.hits?.length) dexSelect(dexState.hits.find((n) => n >= dexState.sel) ?? dexState.hits[0]);
    return true;
  }
  return false; // typing: the box gets it
}

function dexTitle() {
  const d = dexState;
  const owned = d.entries.reduce((n, e) => n + (e.owned || 0), 0);
  const fresh = d.entries.reduce((n, e) => n + (e.fresh || 0), 0);
  const n = d.box ? d.box.length : owned, view = d.view || "dex";
  const tab = chooseFor || active, on = (v) => (view === v ? ' class="on"' : "");
  const cur = d.chooseOpts?.current;
  $("#dex-title").innerHTML = `<span class="pk-tabs"><button data-view="home"${on("home")}>🏠 홈</button>${tab ? `<button data-view="choose"${on("choose")}>🌟 파트너 고르기</button>` : ""}`
    + `<button data-view="dex"${on("dex")}>📕 도감</button><button data-view="box"${on("box")}>🎒 내 포켓몬 <span class="dim">${n}</span></button></span>`
    + (view === "choose" && tab ? `<span class="pk-sub">${esc(base(tab.cwd))}의 파트너 — ${cur ? `지금 ${cur.shiny ? "✨" : ""}${esc(cur.name)} · EXP ${cur.xp}` : "아직 없어요"}</span>`
      + '<button class="pk-close" title="닫기 (Esc)">✕</button>' : `<span class="chip">잡음 ${d.caught}</span><span class="chip">만남 ${d.entries.length}</span>`
    + `<span class="chip">/ ${d.total}</span><span class="chip">✨ ${d.shiny}</span><span class="chip">📦 ${owned}마리</span>`
    + (fresh ? `<span class="chip new">NEW ${fresh}</span>` : "") + '<button class="pk-close" title="닫기 (Esc)">✕</button>');
}

// ── "내 포켓몬" (#27): every individual you have — in the box or a folder's partner — as cards,
// sorted (newest catch first by default), searched with the same terms, taken from the preview ──
let dexLastView = "dex";
let boxSort = (() => { try { return localStorage.getItem("tamer.box.sort") || "recent"; } catch { return "recent"; } })();
const BOX_SORTS = [["recent", "최근 잡은 순"], ["no", "번호"], ["name", "이름"], ["exp", "경험치"], ["partner", "파트너 먼저"]];
const HOW = { wild: "야생에서 잡음", starter: "첫 파트너", legacy: "이전 기록에서 옮김" };

const HELP = {
  choose: "←→↑↓ 고르기 · 1·2·3 첫 파트너 · Enter 이 탭의 파트너로 · / 검색 · 한 마리는 한 폴더에만, EXP는 포켓몬을 따라가요 · Esc 닫기",
  dex: "←→↑↓ 이동 · / 검색 · Tab 다음 만난 포켓몬 · Enter 이 탭의 파트너로(박스에 있으면) · M 내 포켓몬 · Esc 닫기",
  box: "←→↑↓ 이동 · / 검색 · Enter 이 탭의 파트너로 · M 도감 · Esc 닫기",
  home: "⌘P 홈 · M 내 포켓몬 · Esc 닫기 — 한도는 각 에이전트가 마지막으로 알려 준 값이에요",
};
// the frame for a view: which list shows, the tool row, the hints
function viewChrome(v) {
  const w = $("#dex");
  w.classList.toggle("cardview", v !== "dex");
  w.classList.toggle("chooseview", v === "choose");
  w.classList.toggle("homeview", v === "home");
  $("#dex-take").hidden = v === "home";
  $("#dex-pos").textContent = "";
  $("#dex-grid").hidden = v !== "dex";
  $("#box-grid").hidden = v === "dex";
  $("#dex-help").textContent = HELP[v];
  $("#dex-from").innerHTML = "";
  $("#dex-take").className = "";
}
async function dexView(v) {
  const d = dexState;
  if (!d) return;
  d.view = v;
  if (v !== "choose") dexLastView = v; // 파트너 고르기 opens for a reason; the window remembers the other two
  viewChrome(v);
  if (v === "home") { dexTitle(); return homeRender(); }
  if (v === "dex") {
    $(".dex-preview").style.visibility = "";
    dexFilter();
    if (d.zone === "recent") dexRecent(d.ri); else dexSelect(d.sel);
  } else {
    if (v === "box" && !d.box) d.box = await invoke("box_list", { ws: active?.id }).catch(() => []);
    if (v === "choose") {
      chooseFor ||= active;
      if (!d.chooseOpts && chooseFor) d.chooseOpts = await invoke("partner_options", { ws: chooseFor.id }).catch(() => null);
    }
    if (!$("#box-sort")) $(".dex-search").insertAdjacentHTML("afterbegin", `<select id="box-sort" title="정렬">${BOX_SORTS.map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select>`);
    $("#box-sort").value = boxSort;
    d.bi = 0;
    d.list = null;
    boxRender();
  }
  dexTitle();
}

// ── 🏠 홈 (#44): this tab's partner (the preview), tasks finished today and in a row, the last 7
// days, and each agent's 5-hour / weekly limit as last reported (nothing new is measured here) ──
const HOME_AGENTS = [["claude", "✻ Claude Code"], ["codex", "◎ Codex"]];
async function homeRender() {
  const d = dexState;
  const [st, box] = await Promise.all([invoke("home_state").catch(() => null), d.box ? d.box : invoke("box_list", { ws: active?.id }).catch(() => [])]);
  if (dexState !== d || d.view !== "home") return;
  d.box = box;
  const mine = box.find((m) => m.folder === "here");
  const max = Math.max(1, ...(st?.week || []).map((x) => x.n));
  const wd = ["일", "월", "화", "수", "목", "금", "토"];
  const week = (st?.week || []).map((x, i, a) => `<div class="pk-day${i === a.length - 1 ? " today" : ""}" title="${x.day} · ${x.n}번"><i style="height:${Math.round((x.n / max) * 100)}%"></i><span>${wd[new Date(`${x.day}T12:00`).getDay()]}</span></div>`).join("");
  const left = (w) => (w && live(w) ? Math.max(0, 100 - Math.round(w.pct)) : null);
  const meter = (label, w) => {
    const p = left(w);
    if (p == null) return `<div class="pk-meter none"><b>${label}</b><span class="dim">아직 값 없음</span></div>`;
    const lv = p <= 20 ? "low" : p <= 50 ? "mid" : "ok";
    return `<div class="pk-meter ${lv}"><b>${label}</b><span class="pk-bar"><i style="width:${p}%"></i></span><span>${p}% 남음</span><span class="dim">${untilReset(w.resets_at).replace(/^\s*↻/, "") ? `${untilReset(w.resets_at).replace(/^\s*↻/, "")} 뒤 회복` : ""}</span></div>`;
  };
  const agentsHtml = HOME_AGENTS.map(([k, name]) => { const l = lastUsage(k); return (l.five_hour || l.seven_day) ? `<div class="pk-agent"><h5>${name}${l.model ? ` <span class="dim">${esc(l.model)}</span>` : ""}</h5>${meter("5시간", l.five_hour)}${meter("주간", l.seven_day)}</div>` : ""; }).join("");
  $("#box-grid").innerHTML = `<div class="pk-home">
    <section class="pk-today"><div><b>${st?.today ?? 0}</b><span>오늘 끝낸 작업</span></div><div><b>${st?.streak ? `🔥 ${st.streak}` : "0"}</b><span>일 연속</span></div>
      <div class="pk-week" title="최근 7일 끝낸 작업">${week}</div></section>
    <section><h4 class="pk-group">사용 한도<span class="dim">남은 비율 · 마지막으로 알려 준 값</span></h4>${agentsHtml || '<p class="pk-note">아직 한도 정보가 없어요 — Claude Code나 Codex가 한 번 응답하면 보여요</p>'}</section>
  </div>`;
  $("#dex-found").textContent = "";
  // the preview: this tab's partner
  const img = $("#dex-img");
  $(".dex-preview").style.visibility = "";
  if (!mine) {
    img.removeAttribute("src");
    $("#dex-name").textContent = active ? "파트너가 없어요" : "열린 탭이 없어요";
    $("#dex-meta").innerHTML = active ? "🌟 파트너 고르기에서 데려오거나, 작업을 끝내면 나타나는 야생 포켓몬을 잡아요" : "폴더를 열면 그 폴더의 파트너가 여기 보여요";
    return;
  }
  if (mine.gif) spriteUrl(mine.gif).then(async (u) => { if (!u || dexState?.view !== "home") return; img.src = u; await img.decode().catch(() => {}); img.style.width = `${img.naturalWidth * Math.max(1, Math.min(4, Math.floor(200 / img.naturalWidth)))}px`; });
  $("#dex-name").textContent = `#${String(mine.id).padStart(3, "0")} ${mine.shiny ? "✨" : ""}${mine.name}`;
  $("#dex-meta").innerHTML = `${esc(base(active.cwd))}의 파트너<br>EXP ${mine.xp} · ${mine.toEvolve == null ? "최종 진화" : `진화까지 ${mine.toEvolve}`}`;
}

function boxMatch(q, m) {
  const e = dexState.byNo.get(m.id);
  return dexMatch(q, m.id, { ...(e || { name: m.name, types: m.types, caught: true }), caughtAt: m.at, fresh: m.new ? 1 : 0, shiny: m.shiny, partner: m.folder ? 1 : 0 });
}
function boxSorted() {
  const d = dexState, q = dexQuery.trim();
  const list = d.box.filter((m) => !q || boxMatch(q, m));
  const recent = (a, b) => (b.at || 0) - (a.at || 0) || b.uid - a.uid;
  const by = {
    recent, no: (a, b) => a.id - b.id || recent(a, b), name: (a, b) => String(a.name).localeCompare(String(b.name), "ko") || recent(a, b),
    exp: (a, b) => b.xp - a.xp || recent(a, b), partner: (a, b) => (a.folder ? (a.folder === "here" ? 0 : 1) : 2) - (b.folder ? (b.folder === "here" ? 0 : 1) : 2) || recent(a, b),
  }[boxSort] || recent;
  return list.sort(by);
}
const CHOOSE_GROUPS = [
  ["starter", "🌟 첫 파트너", "처음 한 번 · 1·2·3"],
  ["rest", "📦 박스에서 쉬는 포켓몬", ""],
  ["other", "🏠 다른 폴더의 파트너", "데려오면 그 폴더는 파트너가 비어요"],
];
function boxRender() {
  const d = dexState, grid = $("#box-grid"), q = dexQuery.trim();
  const prev = d.list?.[d.bi];
  const card = (m) => pkCard(m, d.list.indexOf(m), { icons: TYPE_ICON, ago });
  let html = "";
  if (d.view === "choose") {
    const items = chooseItems(d.chooseOpts || { resting: [], others: [] }).filter((m) => m.kind === "loading" || !q || boxMatch(q, m));
    d.list = items.filter((m) => m.kind !== "loading");
    for (const [g, title, sub] of CHOOSE_GROUPS) {
      const these = items.filter((m) => m.group === g);
      if (g === "starter" && !d.chooseOpts?.starter) continue;
      if (g === "other" && !these.length) continue;
      html += `<h4 class="pk-group">${title}${sub ? `<span class="dim">${sub}</span>` : ""}</h4>`;
      if (g === "starter" && d.chooseNote) html += `<p class="pk-note">${esc(d.chooseNote)}</p>`;
      else if (g === "starter" && !d.chooseOpts.starter.ready) html += `<p class="pk-note">첫 파트너 후보를 받는 중… ${d.chooseOpts.starter.set.length}/${d.chooseOpts.starter.total} (PokéAPI)</p>`;
      html += these.length ? these.map(card).join("")
        : g === "rest" ? '<p class="pk-note">쉬는 포켓몬이 없어요 — 작업을 끝내면 야생 포켓몬이 나타날 수 있어요(파트너 없는 폴더는 더 자주)</p>' : "";
    }
  } else {
    d.list = boxSorted();
    html = d.list.map(card).join("");
  }
  $("#dex-found").textContent = q ? `${d.list.length}마리` : "";
  if (!d.list.length && (q || d.view === "box")) {
    grid.innerHTML = `<div class="pk-empty" id="box-empty">${q ? `<b>"${esc(q)}"</b>에 맞는 포켓몬이 없어요<button id="box-clear">검색 지우기</button>`
      : "아직 잡은 포켓몬이 없어요 — 작업을 끝내면 가끔 야생 포켓몬이 나타나요"}</div>`;
    $(".dex-preview").style.visibility = "hidden";
    return;
  }
  grid.innerHTML = html;
  grid.querySelectorAll("img[data-gif]").forEach((img) => spriteUrl(img.dataset.gif).then((u) => { if (u) img.src = u; }));
  if (!d.list.length) { $(".dex-preview").style.visibility = "hidden"; return; }
  $(".dex-preview").style.visibility = "";
  const keep = prev ? d.list.findIndex((m) => (m.uid != null ? m.uid === prev.uid : m.key === prev.key)) : -1;
  boxSelect(keep >= 0 ? keep : Math.min(d.bi || 0, d.list.length - 1));
}
function boxSelect(i) {
  const d = dexState;
  if (!d?.list?.length) return;
  d.bi = Math.max(0, Math.min(d.list.length - 1, i));
  d.boxAsk = false;
  const m = d.list[d.bi];
  for (const c of document.querySelectorAll("#box-grid .pk-card.sel")) c.classList.remove("sel");
  const card = $(`#box-grid .pk-card[data-i="${d.bi}"]`);
  card?.classList.add("sel");
  card?.scrollIntoView({ block: "nearest" });
  const img = $("#dex-img"), want = m.uid;
  img.className = "";
  if (m.gif) spriteUrl(m.gif).then(async (u) => {
    if (!u || dexState?.list?.[dexState.bi]?.uid !== want) return;
    img.src = u;
    await img.decode().catch(() => {});
    img.style.width = `${img.naturalWidth * Math.max(1, Math.min(4, Math.floor(200 / img.naturalWidth)))}px`;
  });
  else img.removeAttribute("src");
  $("#dex-name").textContent = `#${String(m.id).padStart(3, "0")} ${m.shiny ? "✨" : ""}${m.name}`;
  const types = (m.types || []).map((t) => `${TYPE_ICON[t] || ""} ${t}`).join(" · ");
  if (m.kind === "starter") $("#dex-meta").innerHTML = `${types}<br>첫 파트너 후보 — 처음 한 번만 고를 수 있어요`;
  else {
    const where = m.folder === "here" ? "이 탭의 파트너" : m.folder ? `📁 ${esc(m.folder)}의 파트너${m.folderGone ? " (닫힌 폴더)" : ""}` : "박스에서 쉬는 중";
    $("#dex-meta").innerHTML = `${types}<br>EXP ${m.xp || 0} · ${m.toEvolve == null ? "최종 진화" : `진화까지 ${m.toEvolve}`}<br>${where}`
      + (m.how || m.at ? `<br>${HOW[m.how] || ""}${m.at ? ` · ${ago(m.at)}` : ""}` : "")
      // the catch log (#44): where and during whose task (recorded from beta.29 on), evolutions
      + (m.caughtIn || m.caughtBy ? `<br><span class="dim">${m.caughtIn ? `📁 ${esc(m.caughtIn)}에서` : ""}${m.caughtBy ? ` ${esc(m.caughtBy)} 작업 중` : ""}</span>` : "")
      + (m.evo?.length ? `<br><span class="dim">진화: ${m.evo.map((e) => `${esc(e.from)} → ${esc(e.to)} (${ago(e.at)})`).join(", ")}</span>` : "");
  }
  $("#dex-from").innerHTML = "";
  boxButton();
  $("#dex-pos").textContent = `${d.bi + 1} / ${d.list.length}`;
  // looked at: its NEW goes (like the Pokédex)
  if (m.new) {
    invoke("dex_viewed", { id: m.id });
    for (const x of d.box || []) if (x.id === m.id) x.new = false;
    const e = d.byNo.get(m.id);
    if (e) e.fresh = 0;
    dexTitle();
    const uid = m.uid;
    setTimeout(() => { const c = $(`#box-grid .pk-card.new[data-i="${dexState?.list?.findIndex((x) => x.uid === uid)}"]`); c?.classList.remove("new"); c?.querySelector(".pk-newb")?.remove(); }, 1500);
  }
}
// the take button: a starter / resting → take · this tab's already · another folder's → press twice
function boxButton() {
  const d = dexState, m = d.list[d.bi], b = $("#dex-take");
  b.hidden = !(chooseFor || active);
  b.disabled = m.folder === "here";
  b.className = d.boxAsk ? "confirm" : "";
  b.textContent = m.kind === "starter" ? `첫 파트너로 (${m.n})` : m.folder === "here" ? "이 탭의 파트너예요" : !m.folder ? "이 탭의 파트너로"
    : d.boxAsk ? `한 번 더 누르면 데려오기 (📁 ${m.folder}는 비어요)` : `📁 ${m.folder}에서 데려오기`;
  for (const c of document.querySelectorAll("#box-grid .pk-card.confirm")) c.classList.remove("confirm");
  if (d.boxAsk) $(`#box-grid .pk-card[data-i="${d.bi}"]`)?.classList.add("confirm");
}
async function boxTake() {
  const d = dexState, m = d?.list?.[d.bi];
  if (!m || m.folder === "here") return;
  if (m.folder && m.kind !== "starter" && !d.boxAsk) { d.boxAsk = true; return boxButton(); }
  return pkTake(m);
}
// take a Pokémon for a tab (the window's tab by default): a starter or an individual (uid)
async function pkTake(m, tab = chooseFor || active) {
  if (!tab) return;
  const args = m.kind === "starter" ? { starter: m.id } : { uid: m.uid };
  const pk = await invoke("partner_take", { ws: tab.id, ...args }).catch((e) => { toast(String(e.message || e).replace(/^.*Error: /, "")); return null; });
  if (!pk) return;
  if (chooseOpen()) closeChoose(); else if (dexOpen()) closeDex();
  const shown = pk.pending ? await invoke("partner_state", { ws: tab.id }) : pk;
  if (shown && !shown.choose) {
    await showPartner(tab, shown); react(tab, "cute");
    toast(`${josa(shown.name, "과", "와")} 함께해요!${m.folder && m.folder !== "here" && m.kind !== "starter" ? ` (${m.folder}에서 데려옴)` : ""}`);
  }
}
function boxKey(k) {
  const d = dexState, n = d.list?.length || 0;
  if (d.view === "choose" && /^[1-3]$/.test(k)) { // the first partner, at once (as before)
    const s = d.list?.find((m) => m.kind === "starter" && m.n === Number(k));
    if (s) pkTake(s);
    return !!s;
  }
  const cols = getComputedStyle($("#box-grid")).gridTemplateColumns.split(" ").length || 4;
  const cur = $(`#box-grid .pk-card[data-i="${d.bi}"]`);
  // ↑↓: the card above / below (the groups of 파트너 고르기 break the rows)
  const vert = (dir) => { const to = cur && dexGeo(cur, [...document.querySelectorAll("#box-grid .pk-card[data-i]")].filter((c) => Number(c.dataset.i) >= 0), dir); if (to) boxSelect(Number(to.dataset.i)); };
  if (k === "/") $("#dex-search").focus();
  else if (!n) return k === "Enter" || k.startsWith("Arrow");
  else if (k === "ArrowRight" || k === "l") boxSelect(d.bi + 1);
  else if (k === "ArrowLeft" || k === "h") boxSelect(d.bi - 1);
  else if (k === "ArrowDown" || k === "j") vert(1);
  else if (k === "ArrowUp" || k === "k") vert(-1);
  else if (k === "Home") boxSelect(0);
  else if (k === "End") boxSelect(n - 1);
  else if (k === "Enter") boxTake();
  else return false;
  return true;
}
$("#box-grid").addEventListener("click", (e) => {
  if (e.target.id !== "box-clear") return;
  dexQuery = ""; $("#dex-search").value = ""; boxRender();
});

// a grid cell (the selection moves to the grid)
function dexSelect(n) {
  const d = dexState;
  if (!d) return;
  d.zone = "grid";
  dexShow(n);
}

// the i-th cell of the "새로 잡은" row
function dexRecent(i) {
  const d = dexState;
  if (!d?.recent?.length) return;
  d.zone = "recent";
  d.ri = Math.max(0, Math.min(d.recent.length - 1, i));
  dexShow(d.recent[d.ri].id);
}

// show species n; the outline is on the cell of the zone the selection is in
function dexShow(n) {
  const d = dexState;
  d.sel = Math.max(1, Math.min(d.total, n));
  for (const c of document.querySelectorAll("#dex-grid .cell.sel")) c.classList.remove("sel");
  const cell = d.zone === "recent" ? $(`#dex-grid .cells.recent .cell[data-ri="${d.ri}"]`) : $(`#dex-grid .cells:not(.recent) .cell[data-n="${d.sel}"]`);
  cell?.classList.add("sel");
  cell?.scrollIntoView({ block: "nearest" });
  const e = d.byNo.get(d.sel);
  // looked at: its new ones aren't new any more (the highlight goes once you move on)
  if (e?.fresh) {
    invoke("dex_viewed", { id: d.sel });
    e.fresh = 0;
    for (const m of d.recent || []) if (m.id === d.sel) m.new = false;
    dexTitle();
    const id = d.sel;
    setTimeout(() => {
      for (const c of document.querySelectorAll(`#dex-grid .cell.new[data-n="${id}"]`)) { c.classList.remove("new"); c.querySelector(".pk-newb")?.remove(); }
    }, 1500);
  }
  const no = `#${String(d.sel).padStart(3, "0")}`;
  const img = $("#dex-img");
  img.className = e && !e.caught ? "seen" : "";
  const want = d.sel; // a picture that arrives after you moved on is dropped
  if (e?.gif) spriteUrl(e.gif).then(async (u) => {
    if (!u || dexState?.sel !== want) return;
    img.src = u;
    await img.decode().catch(() => {});
    img.style.width = `${img.naturalWidth * Math.max(1, Math.min(4, Math.floor(200 / img.naturalWidth)))}px`;
  });
  else img.removeAttribute("src");
  $("#dex-name").textContent = e ? `${no} ${e.caught && e.shiny ? "✨" : ""}${e.name}` : `${no} ???`;
  $("#dex-meta").innerHTML = !e ? "아직 만나지 못했어요"
    : `${(e.types || []).map((t) => `${TYPE_ICON[t] || ""} ${t}`).join(" · ")}<br>만난 횟수 ${e.count} · ${e.caught ? `● 잡음 · 📦 ${e.owned || 0}마리` : "○ 만나기만 함"}`;
  // owned: where the individuals are, and what "take" will do (resting → now; another folder's → ask)
  const take = $("#dex-take");
  take.className = "";
  const o = d.opts, rest = o?.resting.filter((m) => m.id === d.sel) || [], others = o?.others.filter((m) => m.id === d.sel) || [];
  const mine = o?.current?.id === d.sel;
  if (e?.owned > 0) {
    const where = [mine ? "이 탭의 파트너" : "", rest.length ? `쉬는 ${rest.length}` : "", ...others.map((m) => `📁 ${esc(m.folderName)}`)].filter(Boolean).join(" · ");
    $("#dex-meta").innerHTML += `<br>${where}`;
  }
  take.hidden = !rest.length;
  take.textContent = "이 탭의 파트너로";
  // none resting: one button per folder that has one (EXP shown) — click twice to take it
  d.fromOthers = rest.length ? [] : others;
  renderFrom(e, -1);
  $("#dex-pos").textContent = `${d.sel} / ${d.total}`;
}

async function dexChoose() {
  if (dexState?.view !== "dex") return boxTake();
  const d = dexState, e = d?.byNo.get(d.sel);
  if (!e || !active) return;
  if (!e.owned) { toast(e.caught ? `박스에 ${e.name}가 없어요` : `${josa(e.name, "은", "는")} 아직 잡지 못했어요`); return; }
  const o = d.opts;
  const rest = o?.resting.findLast((m) => m.id === e.id);
  const other = o?.others.find((m) => m.id === e.id);
  if (!rest && !other) { toast(o?.current?.id === e.id ? "이미 이 탭의 파트너예요" : `박스에 ${e.name}가 없어요`); return; }
  if (!rest) return dexFrom(0); // Enter: the first folder's (asks once)
  return dexTake(rest, null);
}

// take another folder's individual (i in dexState.fromOthers): first press asks, second takes
function dexFrom(i) {
  const m = dexState?.fromOthers?.[i];
  const b = $(`#dex-from button[data-i="${i}"]`);
  if (!m || !b) return;
  if (!b.classList.contains("confirm")) return renderFrom(dexState.byNo.get(dexState.sel), i);
  return dexTake(m, m);
}

// the folders this species can be taken from; `ask` = the one waiting for the second press
function renderFrom(e, ask) {
  const list = dexState?.fromOthers || [];
  $("#dex-from").innerHTML = list.length
    ? `<div class="dim">쉬는 ${esc(e.name)}가 없어요 — 다른 폴더에서 데려오기 (그 폴더는 비어요)</div>`
      + list.map((m, i) => i === ask
        ? `<button data-i="${i}" class="confirm">한 번 더 누르면 ${esc(m.folderName)}의 ${esc(m.name)} 데려오기</button>`
        : `<button data-i="${i}">📁 ${esc(m.folderName)} · EXP ${m.xp}</button>`).join("")
    : "";
}

async function dexTake(m, other) {
  const tab = active;
  closeDex();
  const pk = await invoke("partner_take", { ws: tab.id, uid: m.uid }).catch((err) => { toast(String(err.message || err)); return null; });
  if (!pk) return;
  const shown = pk.pending ? await invoke("partner_state", { ws: tab.id }) : pk;
  if (shown && !shown.choose) { await showPartner(tab, shown); react(tab, "cute"); toast(`${josa(shown.name, "과", "와")} 함께해요!${other ? ` (${other.folderName}에서 데려옴)` : ""}`); }
}

function closeDex() { $("#dex").hidden = true; dexState = null; focusBig(active); $(".dex-preview").style.visibility = ""; }
// Esc / ✕: 파트너 고르기 remembers the user closed it for that tab
const dexEsc = () => (chooseOpen() ? closeChoose(true) : closeDex());
const dexOpen = () => !$("#dex").hidden;

// grid columns right now (for ↑↓)
const dexCols = () => getComputedStyle($("#dex-grid .cells")).gridTemplateColumns.split(" ").length || 10;

function dexKey(e) {
  const d = dexState;
  if (!d) return false;
  const k = e.key, cols = dexCols();
  if (k === "Escape" || k === "q") dexEsc();
  else if (k === "m" || k === "M") dexView(d.view === "box" ? "dex" : "box");
  else if (d.view === "home") return true; // nothing to move on 홈 — keys stay in the window
  else if (d.view !== "dex") return boxKey(k);
  else if (k === "Enter") dexChoose();
  else if (d.hits && dexKeyFiltered(k, e)) { /* searching: shown cells only */ }
  else if (d.zone === "recent" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "h", "l", "k", "j", "Home", "End"].includes(k)) {
    // inside the "새로 잡은" row; ↓ from its last line goes to this Pokémon's place in the grid
    const n = d.recent.length, line = Math.floor(d.ri / cols), last = Math.floor((n - 1) / cols);
    if (k === "ArrowLeft" || k === "h") dexRecent(d.ri - 1);
    else if (k === "ArrowRight" || k === "l") dexRecent(d.ri + 1);
    else if (k === "ArrowUp" || k === "k") dexRecent(line > 0 ? d.ri - cols : d.ri);
    else if (k === "Home") dexRecent(0);
    else if (k === "End") dexRecent(n - 1);
    else if (line < last) dexRecent(Math.min(d.ri + cols, n - 1));
    else dexSelect(d.sel);
  }
  // ↑ from the grid's first line: back to the "새로 잡은" row, where you were
  else if ((k === "ArrowUp" || k === "k") && d.sel <= cols && d.recent?.length) {
    dexRecent(d.ri);
    $("#region-new")?.scrollIntoView({ block: "start" });
  }
  else if (k === "/") $("#dex-search").focus();
  else if (k === "ArrowRight" || k === "l") dexStep(1);
  else if (k === "ArrowLeft" || k === "h") dexStep(-1);
  else if (k === "ArrowDown" || k === "j") dexSelect(d.sel + cols);
  else if (k === "ArrowUp" || k === "k") dexSelect(d.sel - cols);
  else if (k === "PageDown") dexSelect(d.sel + cols * 5);
  else if (k === "PageUp") dexSelect(d.sel - cols * 5);
  else if (k === "Home") dexSelect(1);
  else if (k === "End") dexSelect(d.total);
  else if (k === "Tab") { // next / previous Pokémon you've met
    const met = d.entries.map((x) => x.id);
    const next = e.shiftKey ? [...met].reverse().find((n) => n < d.sel) : met.find((n) => n > d.sel);
    dexSelect(next ?? (e.shiftKey ? met.at(-1) : met[0]) ?? d.sel);
  } else return false;
  return true;
}

$("#dex-grid").addEventListener("click", (e) => {
  const c = e.target.closest(".cell");
  if (c) c.dataset.ri != null ? dexRecent(Number(c.dataset.ri)) : dexSelect(Number(c.dataset.n));
});
$("#dex-grid").addEventListener("dblclick", (e) => { if (e.target.closest(".cell")) dexChoose(); });
$("#dex-regions").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const d = dexState;
  if (b.dataset.a === "new") {
    const first = shownCells("#dex-grid .cells.recent .cell")[0];
    dexRecent(first ? Number(first.dataset.ri) : 0);
  } else if (d?.hits) { // searching: the region's first result
    const r = REGIONS.find(([, a]) => String(a) === b.dataset.a);
    const n = d.hits.find((x) => x >= r[1] && x <= r[2]);
    if (n) dexSelect(n);
  } else dexSelect(Number(b.dataset.a));
  $(`#region-${b.dataset.a}`).scrollIntoView({ block: "start" });
});
$("#dex-take").addEventListener("click", () => dexChoose());
$("#dex-grid").addEventListener("click", (e) => {
  if (e.target.id !== "dex-clear") return;
  dexQuery = ""; $("#dex-search").value = ""; dexFilter();
  dexSelect(dexState.sel);
});
$("#dex-regions").addEventListener("input", (e) => {
  if (e.target.id === "dex-search") { dexQuery = e.target.value; if (dexState?.view !== "dex") boxRender(); else dexFilter(); }
  if (e.target.id === "box-sort") { boxSort = e.target.value; try { localStorage.setItem("tamer.box.sort", boxSort); } catch {} boxRender(); }
});
$("#dex-title").addEventListener("click", (e) => {
  if (e.target.closest(".pk-close")) return dexEsc();
  const b = e.target.closest("button[data-view]");
  if (b) dexView(b.dataset.view);
});
$("#box-grid").addEventListener("click", (e) => { const c = e.target.closest(".pk-card[data-i]"); if (c && Number(c.dataset.i) >= 0) boxSelect(Number(c.dataset.i)); });
$("#box-grid").addEventListener("dblclick", (e) => { if (e.target.closest(".pk-card[data-i]")) boxTake(); });
$("#dex").addEventListener("mousedown", (e) => { if (e.target === $("#dex")) dexEsc(); }); // outside the window
$("#dex-from").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) dexFrom(Number(b.dataset.i)); });

// ── start screen ────────────────────────────────────────────────────────────
let startItems = [];
let startSel = 0;
let recentCount = 0;

let startShownOnce = false;
async function showStart(required) {
  const recent = await invoke("recent_dirs");
  // a folder handed to the app (dropped on it to launch it) may be opening meanwhile: not over it
  if (required && (tabs.length || opening)) return void invoke("startup_mark", { what: "start screen skipped (folder opening)" });
  recentCount = recent.length;
  const ol = $("#recent");
  ol.innerHTML = recent.length ? "" : '<li class="dim">아직 최근 폴더가 없어요</li>';
  startItems = recent.map((d, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="k">${i < 9 ? i + 1 : ""}</span><span>${esc(base(d))}</span><span class="parent">${esc(d.replace(info.home, "~"))}</span>`;
    li.addEventListener("click", () => openFolder(d));
    ol.appendChild(li);
    return { el: li, run: () => openFolder(d) };
  });
  for (const b of document.querySelectorAll(".start-actions button")) {
    startItems.push({ el: b, run: () => startAction(b.dataset.action) });
  }
  $("#start").dataset.required = required ? "1" : "";
  $("#start-esc").hidden = !!required;
  $("#start").hidden = false;
  if (required && !startShownOnce) { startShownOnce = true; invoke("startup_mark", { what: "start screen on screen" }); }
  startSel = 0;
  markStart();
}

function hideStart() { $("#start").hidden = true; }
const startOpen = () => !$("#start").hidden;

function markStart() {
  startItems.forEach((it, i) => it.el.classList.toggle("sel", i === startSel));
}

async function startAction(action) {
  if (action === "home") return openFolder(info.home);
  if (action === "choose") {
    const dir = await invoke("choose_folder");
    if (dir) openFolder(dir);
  }
}
document.querySelectorAll(".start-actions button").forEach((b) => b.addEventListener("click", () => startAction(b.dataset.action)));

function startKey(e) {
  const n = Number(e.key);
  if (n >= 1 && n <= 9 && n <= recentCount) { startItems[n - 1].run(); return true; }
  if (e.key === "ArrowDown" || e.key === "j") { startSel = (startSel + 1) % startItems.length; markStart(); return true; }
  if (e.key === "ArrowUp" || e.key === "k") { startSel = (startSel - 1 + startItems.length) % startItems.length; markStart(); return true; }
  if (e.key === "Enter") { startItems[startSel]?.run(); return true; }
  if (e.key === "o") { startAction("choose"); return true; }
  if (e.key === "h") { startAction("home"); return true; }
  if (e.key === "Escape" && !$("#start").dataset.required) { hideStart(); focusBig(active); return true; }
  return false;
}

// ── keys (physical key codes: work with any input source, e.g. Korean) ───────
window.addEventListener("keydown", (e) => {
  // the keys belong to the top layer: the Pokémon window (z 20) only when no dialog / menu is over it
  // (first launch: 에이전트 연결 opens over 파트너 고르기 — Esc there must close that one)
  const pokeOnTop = dexOpen() && !agentsOpen() && !diffOpen() && $("#menu").hidden;
  if (pokeOnTop && e.metaKey && e.code === "KeyF") { e.preventDefault(); $("#dex-search").focus(); return; }
  if (pokeOnTop && e.target === $("#dex-search") && !e.metaKey) {
    if (dexSearchKey(e)) { e.preventDefault(); e.stopPropagation(); }
    return;
  }
  if (pokeOnTop && !(e.metaKey && e.code !== "KeyD")) {
    if (e.metaKey || dexKey(e)) { e.preventDefault(); e.stopPropagation(); if (e.metaKey) closeDex(); }
    return;
  }
  if (!$("#menu").hidden && !e.metaKey) {
    // the menu has the keyboard: nothing reaches the terminal behind it (arrows were shell history)
    e.preventDefault(); e.stopPropagation();
    const m = $("#menu"), len = m.items?.length || 0, n = Number(e.key);
    const run = (i) => { const fn = m.items[i][2]; closeMenu(); fn(); };
    if (n >= 1 && n <= len) run(n - 1);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") menuSel(((m.def ?? -1) + (e.key === "ArrowDown" ? 1 : len - 1 + (m.def < 0 ? 1 : 0))) % len);
    else if (e.key === "Enter" && m.def >= 0) run(m.def);
    else if (e.key === "Escape") closeMenu();
    return;
  }
  if (agentsOpen() && !e.metaKey) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeAgents(); } return; }
  if (diffOpen() && !e.metaKey) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeDiff(); } return; }
  if (startOpen() && !e.metaKey) {
    if (startKey(e)) { e.preventDefault(); e.stopPropagation(); }
    return;
  }
  if (!e.metaKey) return;
  const hit = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
  // ⌘F: find in the terminal that has the keyboard (or the big pane) (#40)
  if (e.code === "KeyF" && !e.shiftKey && !e.altKey) {
    const p = [...panes.values()].find((x) => x.term.textarea === document.activeElement) || (e.target === $("#tsearch-q") ? tsearchPane : active && bigPane(active));
    if (p) return hit(() => openTermSearch(p));
  }
  if (e.altKey && e.code === "Digit1") return hit(() => focusBig(active)); // the agent (the shell while there's none)
  if (e.altKey && e.code === "Digit2") return hit(() => $(".changes li[data-i]", active?.view)?.focus());
  if (e.altKey && e.code === "Digit3") return hit(() => active?.panes.shell.term.focus());
  if (e.altKey && e.code === "Enter") return hit(() => { if (active) { active.autoSwapped = false; swapPanes(active, !active.swapped); } });
  if (e.code === "KeyP" && !e.shiftKey && !e.altKey) return hit(() => (dexOpen() ? dexView("home") : openDex(null, "home"))); // 🏠 홈 (#44)
  if (e.code === "KeyG" || (e.code === "KeyA" && e.shiftKey)) return hit(() => switchAgent());
  if (e.code === "KeyT" && e.shiftKey) return hit(() => newSession(active)); // S2: a new session is a shell
  if (e.code === "KeyT") return hit(() => showStart(false));
  // ⌃⌘1~9: this tab's sessions (⌘1~9 = tabs; ⇧⌘3/4/5 are macOS screenshots, ⌘⌥arrows window tools)
  const sm = e.ctrlKey && e.code.match(/^Digit([1-9])$/);
  if (sm) return hit(() => { const t = active; const x = t?.sessions[Number(sm[1]) - 1]; if (x) switchSession(t, x.id); });
  if (e.code === "KeyD") return hit(() => (dexOpen() ? closeDex() : openDex()));
  if (e.code === "KeyO") return hit(() => startAction("choose"));
  if (e.code === "KeyE") return hit(() => composerToggle());
  if (e.code === "KeyR") return hit(() => relayout());
  if (e.code === "Equal") return hit(() => setFont(fontSize + 1));
  if (e.code === "Minus") return hit(() => setFont(fontSize - 1));
  if (e.code === "Digit0") return hit(() => setFont(FONT_DEFAULT));
  if (e.code === "KeyB") return hit(() => { if (!wild.throwBall()) toast("🌿 지금은 야생 포켓몬이 없어요"); });
  if (e.code === "KeyW") return hit(() => closeTab());
  const m = !e.ctrlKey && e.code.match(/^Digit([1-9])$/);
  if (m) return hit(() => selectTab(m[1] === "9" ? tabs[tabs.length - 1] : tabs[Number(m[1]) - 1]));
  if (e.code === "BracketLeft" || e.code === "BracketRight") {
    return hit(() => {
      if (!tabs.length) return;
      const d = e.code === "BracketRight" ? 1 : -1;
      selectTab(tabs[(tabs.indexOf(active) + d + tabs.length) % tabs.length]);
    });
  }
}, true);

// ── Finder drops onto a pane: paths typed into it (agent: Claude attaches images as [Image #N];
// shell: the path; Neovim: opens the file). Onto the tab bar / start screen: folders → new tabs ──
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("drop-target"); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("drop-target"); } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("drop-target");
  const paths = [...e.dataTransfer.files].map((f) => window.cvimHost.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const section = e.target.closest?.(".pane");
  const kind = section && ["agent", "shell"].find((k) => section.classList.contains(`pane-${k}`));
  // the tab bar / start screen / no tab yet: folders open as tabs
  if (!active || !kind || e.target.closest?.("#tabs, #start")) {
    for (const p of paths) await openFolder(p).catch(() => toast(`폴더만 새 탭으로 열 수 있어요: ${base(p)}`));
    return;
  }
  const pane = kind;
  const r = await invoke("drop_paths", { ws: active.id, pane, paths });
  if (r.files) { active.panes[pane].term.focus(); toast(`${r.files}개 경로를 입력했어요`); }
});

// the pane in the big slot: the agent pane, or the shell while an agent run there is swapped in
const focusBig = (tab) => tab && bigPane(tab).term.focus();
const bigPane = (tab) => (tab.swapped && tab.shellAgent ? tab.panes.shell : tab.panes.agent);

// ⌘V with an image (e.g. a screenshot) and no text: Ctrl+V to the agent, which attaches it from
// the clipboard itself (like the Neovim CVIM)
window.addEventListener("paste", (e) => {
  const p = [...panes.values()].find((x) => x.term.textarea === e.target);
  if (!p || e.clipboardData.getData("text")) return;
  const image = [...e.clipboardData.items].some((i) => i.type.startsWith("image/"));
  const agentHere = p.kind === "agent" || (p.kind === "shell" && p.tab.shellAgent);
  if (!image || !agentHere) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  invoke("pty_write", { id: p.id, data: "\x16" });
  toast("이미지를 붙였어요");
}, true);

// ── prompt composer (⌘E): write long / Korean prompts in a real text field, then send to the
// agent in the big slot (bracketed paste + Enter). One draft per tab, kept when closed. ──
function composer(tab) {
  if (tab.composer) return tab.composer;
  const box = document.createElement("div");
  box.className = "composer";
  box.hidden = true;
  box.innerHTML = '<div class="composer-title">✍ 프롬프트 <span class="composer-to"></span></div><textarea spellcheck="false" placeholder="여기에 길게 쓰고 ⌘⏎로 보내요"></textarea>'
    + '<div class="composer-hint dim">⌘⏎ 보내기 · ⌘⇧⏎ 붙여넣기만 · Esc 닫기(초안 유지)</div>';
  // M2: where to send (2 or more sessions) — this session / one other / all
  $(".composer-to", box).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-to]");
    if (b) { tab.composeTo = b.dataset.to; renderComposeTo(tab); tab.composer.ta.focus(); }
  });
  tab.view.appendChild(box);
  const ta = $("textarea", box);
  const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, tab.view.clientHeight * 0.5)}px`; };
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter" && e.metaKey) { e.preventDefault(); e.stopPropagation(); composerSend(tab, !e.shiftKey); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); composerClose(tab); }
  });
  tab.composer = { box, ta, grow };
  return tab.composer;
}

// the "보낼 곳" chips: hidden with one session
function renderComposeTo(tab) {
  const el = $(".composer-to", tab.view);
  if (!el) return;
  const list = tab.sessions || [];
  if (list.length < 2) { el.innerHTML = ""; return; }
  const to = tab.composeTo || "cur";
  const chip = (key, label) => `<button data-to="${esc(key)}" class="${to === key ? "on" : ""}" tabindex="-1">${esc(label)}</button>`;
  el.innerHTML = "→ " + chip("cur", "지금 셸") + list.filter((x) => x.id !== tab.sid).map((x) => chip(x.id, `셸 ${sessNo(tab, x)}`)).join("") + chip("all", "모든 셸");
}

function composerToggle(tab = active) {
  if (!tab) return;
  const c = composer(tab);
  if (tab.composeTo && tab.composeTo !== "cur" && tab.composeTo !== "all" && !tab.sessions.some((x) => x.id === tab.composeTo)) tab.composeTo = "cur";
  renderComposeTo(tab);
  if (!c.box.hidden && document.activeElement === c.ta) return composerClose(tab);
  c.box.hidden = false;
  c.grow();
  c.ta.focus();
  c.ta.setSelectionRange(c.ta.value.length, c.ta.value.length);
}

function composerClose(tab) {
  const c = tab.composer;
  if (!c) return;
  c.box.hidden = true;
  bigPane(tab).term.focus();
}

async function composerSend(tab, enter) {
  const c = tab.composer;
  const text = c.ta.value.replace(/\s+$/, "");
  if (!text) return;
  // where: the big slot (this session) / another session / every session (M2)
  const to = tab.sessions?.length > 1 ? tab.composeTo || "cur" : "cur";
  const targets = to === "cur" ? [bigPane(tab)] : to === "all" ? tab.sessions.map((x) => x.pane) : [tab.sessions.find((x) => x.id === to)?.pane].filter(Boolean);
  for (const p of targets) {
    await invoke("pty_write", { id: p.id, data: `\x1b[200~${text}\x1b[201~` });
    // a separate Enter after the paste (an Enter inside the paste would be a newline)
    if (enter) setTimeout(() => invoke("pty_write", { id: p.id, data: "\r" }), 120);
  }
  c.ta.value = "";
  composerClose(tab);
  const where = to === "cur" ? "" : to === "all" ? ` (모든 셸 ${targets.length}개)` : ` (셸 ${sessNo(tab, tab.sessions.find((x) => x.id === to))})`;
  toast(`${enter ? "보냈어요" : "붙여넣었어요 (Enter로 보내기)"}${where}`);
}

// ⌘= ⌘- ⌘0: every terminal's font size
function setFont(n) {
  fontSize = Math.max(9, Math.min(28, n));
  try { localStorage.setItem("cvim.fontSize", String(fontSize)); } catch {}
  for (const p of panes.values()) { p.term.options.fontSize = fontSize; resize(p); }
  toast(`글자 크기 ${fontSize}`);
}

// ⌘R: measure everything again (after moving to another monitor, etc.)
function relayout() {
  for (const t of tabs) for (const p of Object.values(t.panes)) resize(p);
  if (active) for (const p of Object.values(active.panes)) { try { p.fit.fit(); } catch {} resize(p); }
  toast("화면을 다시 맞췄어요");
}

// ── events from the main process ────────────────────────────────────────────
listen("pty", (e) => {
  const p = panes.get(e.payload.id);
  if (!p) return;
  const data = b64bytes(e.payload.data);
  p.bytes += data.length;
  p.term.write(data);
});
listen("pty-exit", (e) => {
  const p = panes.get(e.payload.id);
  if (!p) return;
  // the agent pane goes back to a shell (a toast says why): no "[종료됨]" left above its prompt
  if (p.kind !== "agent") p.term.write("\r\n\x1b[2m[종료됨]\x1b[0m\r\n");
  if (p.onExit) p.onExit();
  if (p.kind === "agent") agentExited(p);
});

// an agent pane's process ended (S2): an agent (/exit, crash) → that session's shell again, in
// place; the shell itself (`exit`) → a later session closes, the first one gets a new shell
function agentExited(p) {
  const tab = p.tab, sess = tab?.sessions?.find((x) => x.pane === p);
  if (!sess || !byId.has(tab.id)) return;
  const wasShell = !!sess.host, no = sessNo(tab, sess);
  sess.running = false;
  sess.hostAgent = null;
  if (wasShell && sess.id !== tab.id) {
    closeSession(tab, sess.id).then(() => toast(`셸 ${no} 종료 — 닫았어요`));
    return;
  }
  // a shell that ends right after starting (broken shell config): no restart loop
  if (wasShell && sess.hostAt && Date.now() - sess.hostAt < 2000) {
    sess.host = false;
    p.term.write("\x1b[2m셸이 바로 끝났어요 — ⌘G로 에이전트 시작\x1b[0m\r\n");
    return;
  }
  startHost(tab, sess).then(() => { renderRail(tab); renderTab(tab); });
  toast(tab.sessions.length > 1 ? `셸 ${no}: ${wasShell ? "셸을 다시 열었어요" : "에이전트 종료 — 셸로"}` : wasShell ? "셸을 다시 열었어요" : "에이전트 종료 — 셸로 돌아왔어요 (⌘G 에이전트)");
}
// two sources per tab: the agent pane and an agent run by hand in the shell; the one in the big
// slot (the shell's, while it runs) is what the tab, top bar and partner show
listen("agent-state", (e) => {
  const t = byId.get(e.payload.ws);
  if (!t) return;
  rememberUsage(e.payload.shellKey || e.payload.agent?.key, e.payload.usage);
  if (e.payload.source === "shell") t.shellState = e.payload;
  else {
    const sess = t.sessions?.find((x) => x.id === (e.payload.session || t.id));
    if (!sess) return;
    const prev = sess.state?.state;
    sess.state = e.payload;
    if (e.payload.agent) sess.agent = e.payload.agent;
    if (sess.id !== t.sid) {
      // a session in the background: its dot, the tab icon, the summary — and the partner reacts
      if (prev && prev !== e.payload.state && ["done", "waiting", "error"].includes(e.payload.state)) {
        if (e.payload.state === "done") react(t, "attack");
        if (t === active) toast(`셸 ${sessNo(t, sess)}: ${e.payload.state === "done" ? "🎉 완료" : e.payload.state === "waiting" ? "❗ 입력 필요" : "💥 실패"}`);
      }
      renderRail(t); renderTab(t); renderSummary();
      return;
    }
    t.agentState = e.payload;
  }
  if (shownOf(t) === e.payload) renderState(t, e.payload);
  renderRail(t);
});
listen("partner", (e) => {
  const t = byId.get(e.payload.ws);
  if (!t) return;
  showPartner(t, e.payload);
});
listen("partner-choose", (e) => { const t = byId.get(e.payload.ws); if (t) needPartner(t, e.payload.freed); });
// starters arriving while the dialog is open
listen("partner-today", async () => { if (chooseOpen() && chooseFor) renderChoose(chooseFor, await invoke("partner_options", { ws: chooseFor.id })); });
listen("partner-progress", (e) => {
  const t = byId.get(e.payload.ws);
  if (!t) return;
  if (e.payload.evolved) evolve(t, e.payload.from, { ...e.payload.evolved, xp: e.payload.xp, toEvolve: e.payload.toEvolve, pinned: e.payload.pinned });
  else showProgress(t, e.payload);
});
listen("open-folder", (e) => openFolder(e.payload.cwd));
listen("toast", (e) => toast(e.payload.text)); // from the main process (a shell environment that couldn't be read …)
listen("select-tab", (e) => selectTab(byId.get(e.payload.ws))); // overlay click
// a resumed agent that had nothing to continue: started fresh
listen("agent-restarted", (e) => {
  const t = byId.get(e.payload.ws);
  const sess = t?.sessions.find((x) => x.id === (e.payload.session || t.id));
  if (sess) { sess.pane.term.reset(); toast("이어 할 대화가 없어 새로 시작했어요"); }
});
// S2: an agent typed into the agent pane's shell (or it ended)
listen("host-agent", (e) => {
  const t = byId.get(e.payload.ws);
  const sess = t?.sessions.find((x) => x.id === e.payload.session);
  if (!sess?.host) return;
  const a = e.payload.agent;
  sess.hostAgent = a;
  sess.hostWhere = a ? e.payload.where : null;
  sess.running = !!a;
  renderWhere(t);
  if (a) sess.agent = a;
  if (t.sid === sess.id) {
    if (a) showAgent(t, a);
    else { showAgent(t, t.agent); if (!(t.swapped && t.shellAgent)) renderState(t, SHELL_STATE); }
  }
  renderRail(t);
  renderTab(t);
});
listen("shell-agent", (e) => { const t = byId.get(e.payload.ws); if (t) onShellAgent(t, e.payload.agent, e.payload.where); });
// in another app the desktop overlay shows the wild card; the window's own copy would be a second one
window.addEventListener("blur", () => document.body.classList.add("away"));
window.addEventListener("focus", () => document.body.classList.remove("away"));
listen("wild", (e) => wild.show(e.payload));
listen("open-dex", (e) => { wild.hide(); openDex(e.payload?.id || undefined); }); // from the overlay's wild card (#25)
listen("wild-throw", (e) => wild.play(e.payload));
listen("wild-end", (e) => wild.end(e.payload));

// ── diagnostics & tests (CVIM_DESKTOP_TEST=1) ───────────────────────────────
const T0 = performance.now();
function imeLog(src, what, detail) {
  if (!info?.log) return;
  invoke("log_line", { line: `${String(Math.round(performance.now() - T0)).padStart(7)} ${src.padEnd(6)} ${what.padEnd(17)} ${detail}` }).catch(() => {});
}
function watchIme(src, el) {
  el.addEventListener("keydown", (e) => imeLog(src, "keydown", `key=${JSON.stringify(e.key)} code=${e.code} keyCode=${e.keyCode} isComposing=${e.isComposing}`), true);
  for (const t of ["compositionstart", "compositionupdate", "compositionend"]) {
    el.addEventListener(t, (e) => imeLog(src, t, `data=${JSON.stringify(e.data)}`), true);
  }
}

// time a large burst of output through PTY -> event -> xterm.js (main runs `seq 1 300000`)
function perfTest(tab) {
  const p = tab.panes.shell;
  const t0 = performance.now();
  p.onExit = () => {
    const msg = `PERF seq 1 300000: ${(p.bytes / 1048576).toFixed(1)}MB, ${Math.round(performance.now() - t0)}ms`;
    $("#doing").textContent = msg;
    invoke("log_line", { line: msg });
  };
  startPane(p);
}

// type a string into the shell pane one character at a time ("\b" = Backspace)
function autoType(tab, text) {
  const chars = [...text.replace(/\\b/g, "\x7f")];
  const id = tab.panes.shell.id;
  let i = 0;
  setTimeout(function next() {
    if (i >= chars.length) {
      if (!info.test.ime_text) return invoke("log_line", { line: "autotype done" });
      tab.panes.shell.term.focus();
      return setTimeout(() => invoke("ime_compose", { text: info.test.ime_text })
        .then(() => setTimeout(() => invoke("log_line", { line: "autotype done" }), 300)), 300);
    }
    invoke("pty_write_test", { id, data: chars[i++] });
    setTimeout(next, 30);
  }, 4000);
}

// compose "하" in the agent pane, switch agent mid-composition, report what the new agent got
function switchTest(tab) {
  const p = tab.panes.agent;
  setTimeout(() => {
    p.term.focus();
    invoke("ime_compose", { text: "하" }).then(() => setTimeout(() => {
      nextAgent(tab);
      setTimeout(() => { if (p.term.element.classList.contains("composing")) invoke("ime_commit", { text: "하" }); }, 200);
      setTimeout(() => invoke("log_line", { line: `switch-test agent bytes after switch=${p.bytes} screen=${JSON.stringify(screenText(p.term))}` })
        .then(() => invoke("log_line", { line: "autotype done" })), 3500);
    }, 300));
  }, 2500);
}
function screenText(term) {
  const b = term.buffer.active, out = [];
  for (let i = 0; i < term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
  return out.join("\n").trim();
}

// what a hostile page would try — every call must fail
async function secTest() {
  const tries = {
    pty_spawn: () => invoke("pty_spawn", { id: "x", cmd: "touch /tmp/cvim-pwned", cwd: "/tmp", cols: 80, rows: 24, env: {} }),
    pane_start_other: () => invoke("pane_start", { ws: active?.id, kind: "pwn", cols: 80, rows: 24 }),
    read_file: () => invoke("read_file_b64", { path: "/etc/hosts" }),
    sprite_outside: () => invoke("sprite_b64", { path: "/etc/hosts" }),
    sprite_traversal: () => invoke("sprite_b64", { path: (info.home || "") + "/.cache/cvim/pokemon/../folders.json" }),
    open_not_folder: () => invoke("workspace_open", { cwd: "/etc/hosts" }),
    proto: () => invoke("__proto__", {}),
    overlay_only: () => invoke("overlay_drag", { phase: "move", x: 0, y: 0 }),
    node_require: () => Promise.resolve(typeof require !== "undefined" ? "require exists" : Promise.reject(new Error("no require"))),
  };
  const out = [];
  for (const [name, fn] of Object.entries(tries)) {
    try { await fn(); out.push(`${name}=ALLOWED`); } catch { out.push(`${name}=blocked`); }
  }
  const before = location.href;
  try { location.href = "https://example.com"; } catch {}
  const w = window.open("https://example.com");
  setTimeout(() => invoke("log_line", { line: `sectest ${out.join(" ")} navigate=${location.href === before ? "blocked" : "ALLOWED"} window_open=${w ? "ALLOWED" : "blocked"}` }), 800);
}

// tabs: re-open an open folder (must switch, not duplicate), switching, close the first
async function tabsTest() {
  const log = (line) => invoke("log_line", { line: `tabs-test ${line}` });
  await new Promise((r) => setTimeout(r, 2500));
  await log(`open=${tabs.map((t) => base(t.cwd)).join(",")} active=${base(active.cwd)}`);
  const again = await openFolder(tabs[0].cwd);
  await log(`reopen-first tabs=${tabs.length} active=${base(active.cwd)} same=${again === tabs[0]}`);
  selectTab(tabs[tabs.length - 1]);
  await log(`select-last active=${base(active.cwd)} visible=${tabs.filter((t) => !t.view.hidden).length}`);
  const closing = tabs[0].id;
  await closeTab(tabs[0]);
  const left = await invoke("workspaces_test");
  await log(`closed-first tabs=${tabs.length} main_has_closed=${left.includes(closing)} panes=${panes.size}`);
  await log("autotype done");
}

// partner: click reactions, menu actions, Pokédex, evolution (8 finished tasks)
async function pokemonTest() {
  const log = (line) => invoke("log_line", { line: `poke-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tab = active;
  await wait(2500);
  await log(`partner=${tab.partner?.name} types=${tab.partner?.types} pinned=${tab.pinned}`);
  react(tab, "attack"); await wait(150);
  await log(`attack class=${$(".poke", tab.view).className} fx=${$(".fx", tab.view).children.length} glyph=${$(".fx span", tab.view)?.textContent}`);
  await invoke("shot_test", { name: "attack" });
  await wait(1200);
  openMenu(tab, 900, 200); await wait(100);
  await log(`menu items=${[...$("#menu").children].map((b) => b.textContent.trim()).join("|")}`);
  await invoke("shot_test", { name: "menu" });
  closeMenu();
  tab.pinned = await invoke("partner_pin", { ws: tab.id });
  await log(`pin-toggle pinned=${tab.pinned}`);
  tab.pinned = await invoke("partner_pin", { ws: tab.id });
  await openDex(); await wait(400);
  await log(`dex title=${$("#dex-title").textContent} rows=${$("#dex-list").children.length} pos=${$("#dex-pos").textContent}`);
  dexKey({ key: "ArrowUp" }); await wait(200);
  await log(`dex wrap-up pos=${$("#dex-pos").textContent}`);
  await invoke("shot_test", { name: "dex" });
  dexSelect(0); await wait(200);
  const pick = dexState.entries[0];
  await dexChoose(); await wait(500);
  await log(`dex-choose partner=${tab.partner?.name} id=${tab.partner?.id} want=${pick.id} xp=${tab.partner?.xp}`);
  const before = tab.partner?.id;
  for (let i = 0; i < 7; i++) { await invoke("partner_done_test", { ws: tab.id }); await wait(150); }
  await wait(12000); // tasks take minutes in real use: the next stage is prefetched by now
  await invoke("partner_done_test", { ws: tab.id });
  // the 8th fetches the next stage from PokéAPI (network): wait for the swap, then the flicker
  for (let i = 0; i < 60 && tab.partner?.id === before; i++) await wait(500);
  await invoke("shot_test", { name: "evolving" });
  await wait(4000);
  await log(`after-8-done partner=${tab.partner?.name} id=${tab.partner?.id} exp=${$(".poke-exp", tab.view).textContent}`);
  await invoke("shot_test", { name: "evolved" });
  await log("autotype done");
}

// wild: encounter → broke free → caught (+ partner) → fled → left; overlay with a wild one
// (main runs with CVIM_WILD_CHANCE=1, CVIM_WILD_COOLDOWN=0, a short CVIM_WILD_STAY)
async function wildTest() {
  const log = (line) => invoke("log_line", { line: `wild-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tab = active;
  const text = () => $(".wild-text").textContent;
  // finished tasks until one brings a wild Pokémon (the first is downloaded in the background)
  async function encounter(label) {
    for (let i = 0; i < 40 && !wild.active(); i++) { await invoke("partner_done_test", { ws: tab.id }); await wait(1500); }
    await wait(1500);
    await log(`${label} active=${wild.active()} text=${text()} timer=${$(".wild-timer").textContent}`);
  }
  async function throwAs(result, label) {
    await invoke("wild_rig_test", { result });
    const timer = () => $(".wild-timer").textContent;
    const t = [timer()];
    const ok = wild.throwBall();
    for (const ms of [400, 1500, 2300]) { await wait(ms - (ms === 400 ? 0 : ms === 1500 ? 400 : 1500)); t.push(timer()); }
    await wait(1900);
    t.push(timer());
    // #11: the clock stands still while the ball plays out (before / 0.4 s / 1.5 s / 2.3 s / 4.2 s)
    await log(`${label} thrown=${ok} text=${text()} active=${wild.active()} adopt=${!$(".wild-partner").hidden} dex=${!$(".wild-dex").hidden} timers=${t.join(",")}`);
  }
  await wait(2500);
  await log(`partner=${tab.partner?.name}`);
  await log(`no-wild throw=${wild.throwBall()}`);
  await encounter("appear-1");
  await invoke("shot_test", { name: "wild-appear" });
  await throwAs("broke", "broke");
  await invoke("shot_test", { name: "wild-broke" });
  // throw again right after the first ball's animation (the reported stuck button), and a
  // direct call while a ball is still shaking → "busy", the button comes back
  await invoke("wild_rig_test", { result: "broke" });
  wild.throwBall(); await wait(200);
  const busy = await invoke("wild_throw", { token: wild.token?.() });
  await wait(4200);
  await log(`rethrow busy-result=${busy?.result} text=${text()} button-disabled=${$(".wild-throw").disabled}`);
  await throwAs("caught", "caught");
  await invoke("shot_test", { name: "wild-caught" });
  const caughtName = $(".wild-text b")?.textContent;
  let d = await invoke("dex_list");
  await log(`dex caught=${d.caught} entries=${d.entries.length} seen-only=${d.entries.filter((e) => !e.caught).map((e) => e.name).join(",")}`);
  // #9 #10: 도감에서 보기 → the Pokédex on the caught one, highlighted as new, in the "새로 잡은" row
  const caughtId = Number(d.recent?.[0]?.id);
  $(".wild-dex").click();
  await wait(1200);
  const newCells = () => [...document.querySelectorAll("#dex-grid .cell.new")].map((c) => c.dataset.n).join(",");
  await log(`dex-open open=${dexOpen()} sel=${dexState?.sel} want=${caughtId} recent=${dexState?.recent?.length} new-cells=${newCells()} title=${$("#dex-title").textContent}`);
  await invoke("shot_test", { name: "dex-new" });
  await wait(2000);
  const box = await invoke("dex_list");
  await log(`dex-viewed new-cells=${newCells()} fresh-left=${box.entries.filter((e) => e.fresh).length} recent-new=${box.recent.filter((m) => m.new).length}`);
  closeDex();
  await takeSpecies(tab, caughtId);
  await wait(1500);
  await log(`adopt partner=${tab.partner?.name} want=${caughtName} xp=${tab.partner?.xp}`);
  await encounter("appear-2");
  await throwAs("fled", "fled");
  d = await invoke("dex_list");
  const seen = d.entries.find((e) => !e.caught);
  if (seen) {
    await openDex();
    dexSelect(seen.id);
    const before = tab.partner?.id;
    await dexChoose();
    await log(`dex-choose-seen ${seen.name} partner-unchanged=${tab.partner?.id === before} toast=${$("#toast").textContent}`);
    closeDex();
  }
  // the overlay (as if another app were in front), with a wild one waiting
  await invoke("wild_rig_test", { result: null });
  await encounter("appear-3");
  await invoke("overlay_show_test", { on: true });
  await wait(1500);
  await invoke("overlay_shot_test", { name: "overlay-wild" });
  await log(`overlay bounds=${JSON.stringify(await invoke("overlay_bounds_test"))}`);
  await invoke("overlay_show_test", { on: false }); // it sits on top of the screen: as short as possible
  await wait(14000); // CVIM_WILD_STAY: it goes back to the grass
  await log(`left text=${text()}`);
  await log("autotype done");
}

// ── test lab (npm run lab, docs/TESTING.md) ──────────────────────────────────────────────────────
// A case hands in a list of steps (CVIM_LAB_STEPS, JSON); the app runs them and logs "lab-probe"
// lines — what's on screen, as data — for the runner to check. No test code per case in here.
//   { wait: ms } · { until: "path", timeout } (a labState() value turns truthy) · { key: "Escape" }
//   { click: "css selector" } · { probe: "name" } · { shot: "name" } · { call: "openDex" | … }
function labState() {
  const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  const top = el?.closest("#menu") ? "menu" : el?.closest("#agents") ? "agents" : el?.closest("#diffview") ? "diff"
    : el?.closest("#dex") ? "poke" : el?.closest("#start") ? "start" : "main";
  const st = dexState?.chooseOpts?.starter;
  return {
    tabs: tabs.map((t) => base(t.cwd)), active: active ? base(active.cwd) : null, start: startOpen(),
    poke: dexOpen() ? dexState?.view || "dex" : null, choose: chooseOpen(), agents: agentsOpen(), menu: !$("#menu").hidden, diff: diffOpen(), top,
    starters: st ? { ready: !!st.ready, n: st.set.length } : null, cards: document.querySelectorAll("#box-grid .pk-card[data-i]").length,
    partner: active?.partner?.name || null, choosePending: !!active && !active.partner?.uid, wild: wild.active(),
    toast: $("#toast")?.classList.contains("show") ? $("#toast").textContent : null,
    focus: document.activeElement?.id || document.activeElement?.className?.toString().slice(0, 40) || null,
    sessions: tabs.map((t) => t.sessions?.length || 1),
    line: (() => { // the focused terminal's cursor line
      const p = [...panes.values()].find((x) => x.term.textarea === document.activeElement);
      if (!p) return null;
      const b = p.term.buffer.active;
      return lineText(p.term, b.baseY + b.cursorY + 1).text.trimEnd();
    })(),
    width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
    usage: $("#usage")?.textContent || "",
    usageRaw: (() => { const u = active && shownOf(active)?.usage; return u ? Object.keys(u).filter((k) => u[k] != null).join(",") : null; })(),
    sid: active?.sid ?? null,
    tsearch: $("#tsearch").hidden ? null : { q: $("#tsearch-q").value, n: $("#tsearch-n").textContent, pane: tsearchPane?.kind || null, alt: !$("#tsearch-alt").hidden },
    // the top bar and the hint line stay one line, nothing pushed out (#38)
    barFits: (() => { const b = $("#bar"); return b.scrollWidth <= b.clientWidth + 1 && [...b.children].every((c) => c.hidden || c.offsetHeight <= b.clientHeight); })(),
    hintFits: (() => { const h = $("#hint"); return h.scrollHeight <= h.clientHeight + 1; })(),
    preview: dexOpen() ? $("#dex-meta")?.textContent || null : null,
    pokeTab: dexOpen() ? $("#dex .pk-tabs button.on")?.dataset.view || null : null,
    pokeFits: dexOpen() ? (() => { const r = $("#dex .pk-window")?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })() : null,
  };
}
// tests: the top bar as with an agent waiting, every usage item shown (ui:shots, lab)
function fakeUsage(tab) {
  tab.state = { state: "waiting", detail: "", agent: { key: "claude", short: "Claude" },
    usage: { model: "Opus 5.5", ctx: 42, five_hour: { pct: 12, resets_at: Math.floor(Date.now() / 1000) + 7230 }, seven_day: { pct: 2 }, cost: 1.23 } };
  renderBar(tab);
}
const LAB_CALLS = { home: () => (dexOpen() ? dexView("home") : openDex(null, "home")), fakeUsage: () => fakeUsage(active), focusShell: () => bigPane(active)?.term.focus(), openDex: () => openDex(), closeDex: () => closeDex(), openChoose: () => openChoose(active), box: () => dexView("box"), escape: () => dexEsc() };
async function labRun(steps) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (line) => invoke("log_line", { line });
  const get = (path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), labState());
  try {
    for (const s of steps) {
      if (s.wait != null) await wait(s.wait);
      else if (s.until) { const end = performance.now() + (s.timeout || 15000); while (!get(s.until) && performance.now() < end) await wait(100); if (!get(s.until)) await log(`lab-timeout ${s.until}`); }
      else if (s.key) {
        const k = s.key, code = /^[0-9]$/.test(k) ? `Digit${k}` : k.length === 1 ? `Key${k.toUpperCase()}` : k;
        const keyCode = { Escape: 27, Enter: 13, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Tab: 9, Backspace: 8 }[k] || k.toUpperCase().charCodeAt(0);
        await invoke("key_test", { key: k, code, keyCode, modifiers: s.mods || 0, ...(s.commands ? { commands: s.commands } : {}), ...(k.length === 1 && !s.mods ? { text: k } : {}) });
      } else if (s.click) {
        const el = document.querySelector(s.click);
        if (!el) { await log(`lab-missing ${s.click}`); continue; }
        const r = el.getBoundingClientRect();
        await invoke("click_test", { x: r.left + r.width / 2, y: r.top + r.height / 2 });
      } else if (s.probe) await log(`lab-probe ${s.probe} +${Math.round(performance.now())}ms ${JSON.stringify(labState())}`); // ms since the page began
      else if (s.shot) await invoke("shot_test", { name: s.shot });
      else if (s.ime != null) await invoke("ime_compose", { text: s.ime }); // Hangul being composed
      else if (s.text != null) await invoke("ime_commit", { text: s.text }); // text committed (typed / IME done)
      else if (s.invoke) { // a command (test commands too); "$ws" = the current tab; log: its answer into the log
        const r = await invoke(s.invoke, JSON.parse(JSON.stringify(s.args || {}).replaceAll('"$ws"', JSON.stringify(active?.id || ""))));
        if (s.log) await log(`lab-invoke ${s.invoke} ${JSON.stringify(r)}`);
      }
      else if (s.grep) { // the lines of the big pane's whole buffer (scrollback included) that contain it
        const t = bigPane(active).term, b = t.buffer.active, rows = [];
        for (let y = 0; y < b.length; y++) { const l = b.getLine(y)?.translateToString(true) || ""; if (l.includes(s.grep)) rows.push(y); }
        await log(`lab-grep ${s.grep} rows=${JSON.stringify(rows)} length=${b.length} baseY=${b.baseY} type=${b.type}${rows.length ? ` text=${JSON.stringify((b.getLine(rows[0])?.translateToString(true) || "").slice(0, 160))}` : ""}`);
      } else if (s.resize) { await invoke("win_resize_test", { w: s.resize[0], h: s.resize[1] }); await wait(400); }
      else if (s.call && LAB_CALLS[s.call]) await LAB_CALLS[s.call]();
    }
  } catch (e) { await log(`lab-error ${e?.stack || e}`); }
  await log("lab-done");
}

// A first launch as a new user has it: nothing on this Mac yet (the starters come from PokéAPI), the
// agents dialog opening over 파트너 고르기, then the first partner picked with real keys and clicks
async function firstRunTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (line) => invoke("log_line", { line: `first-run ${line}` });
  const key = (k, code, keyCode, text) => invoke("key_test", { key: k, code, keyCode, ...(text ? { text } : {}) });
  const clickAt = async (el) => { const r = el.getBoundingClientRect(); await invoke("click_test", { x: r.left + r.width / 2, y: r.top + r.height / 2 }); };
  const top = () => { const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return el?.closest("#agents") ? "agents" : el?.closest("#dex") ? "poke" : el?.tagName; };
  try {
    const tab = active;
    for (let i = 0; i < 40 && !(chooseOpen() && agentsOpen()); i++) await wait(500);
    const o = dexState?.chooseOpts;
    await log(`open choose=${chooseOpen()} agents=${agentsOpen()} on-top=${top()} starter=${!!o?.starter} ready=${o?.starter?.ready} loading-cards=${document.querySelectorAll("#box-grid .pk-card.loading").length} note=${$("#box-grid .pk-note")?.textContent || ""}`);
    await invoke("shot_test", { name: "first-1-agents" });
    await key("Escape", "Escape", 27); await wait(500);
    await log(`esc agents=${agentsOpen()} choose=${chooseOpen()} on-top=${top()}`);
    await invoke("shot_test", { name: "first-2-choose" });
    const t0 = Date.now();
    for (let i = 0; i < 120 && !dexState?.chooseOpts?.starter?.ready; i++) await wait(500);
    await wait(800);
    const ready = dexState?.chooseOpts?.starter;
    await log(`starters ready=${ready?.ready} after=${Math.round((Date.now() - t0) / 1000)}s set=${ready?.set.map((x) => `${x.name}:${x.types?.[0]}`).join(",")} cards=${[...document.querySelectorAll("#box-grid .pk-card[data-i]")].map((c) => c.querySelector("b")?.textContent).join(",")} loading-left=${document.querySelectorAll("#box-grid .pk-card.loading").length} sel=${dexState.bi} button=${$("#dex-take").textContent}`);
    await invoke("shot_test", { name: "first-3-ready" });
    await key("ArrowRight", "ArrowRight", 39); await wait(300);
    await log(`arrow sel=${dexState.bi} button=${$("#dex-take").textContent} preview=${$("#dex-name").textContent}`);
    await clickAt($('#box-grid .pk-card[data-key="s2"]')); await wait(300);
    await log(`click card3 sel=${dexState.bi} button=${$("#dex-take").textContent}`);
    const want = dexState.list[dexState.bi];
    await clickAt($("#dex-take")); await wait(2000);
    await log(`took partner=${tab.partner?.name}#${tab.partner?.id} want=${want?.name}#${want?.id} window=${dexOpen()} toast=${$("#toast").textContent} avatar-label=${$(".poke-label", tab.view)?.textContent}`);
    await invoke("shot_test", { name: "first-4-partner" });
    await openChoose(tab); await wait(800);
    await log(`reopen starter=${!!dexState?.chooseOpts?.starter} title=${$("#dex-title .pk-sub")?.textContent} cards=${document.querySelectorAll("#box-grid .pk-card[data-i]").length} notes=${[...document.querySelectorAll("#box-grid .pk-note")].map((n) => n.textContent).join("|")}`);
    await key("Escape", "Escape", 27); await wait(300);
    await log(`closed window=${dexOpen()}`);
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("done");
  invoke("log_line", { line: "autotype done" });
}

// ── UI scenes (npm run ui:shots, docs/UI_SYSTEM.md, src/poke/ui-map.json) ─────────────────────
// Each scene puts one screen in a known state and captures it; ui:shots compares the pictures with
// the baseline. Scene names are what ui-map.json lists under each screen. Two data sets, seeded by
// scripts/ui-shots.cjs: "newuser" (empty box, three starters) and "owner" (six Pokémon, one new,
// one another folder's partner, this folder without one).
async function uiScenes(set) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (line) => invoke("log_line", { line: `ui-scenes ${line}` });
  document.body.classList.add("ui-test"); // no animation, no blinking: same picture every run
  const shot = async (name) => { await wait(700); const r = await invoke("ui_shot", { name }); await log(`shot ${r.name} diff=${r.diff == null ? "-" : r.diff.toFixed(5)}${r.note ? ` ${r.note}` : ""}`); };
  const search = async (q) => { const b = $("#dex-search"); b.value = q; b.dispatchEvent(new Event("input", { bubbles: true })); await wait(200); };
  try {
    const tab = active;
    for (let i = 0; i < 40 && !chooseOpen(); i++) await wait(500); // a folder without a partner asks
    if (set === "newuser") {
      for (let i = 0; i < 40 && !(chooseOpen() && (await invoke("partner_options", { ws: tab.id })).starter?.ready); i++) await wait(500);
      await shot("choose-starter");
    } else {
      await shot("choose-box");
      closeChoose(false);
      await openDex(); await shot("dex-grid");
      await search("불꽃,물"); await shot("dex-search");
      await search("불꽃&전설"); await shot("dex-empty");
      await search("");
      // 🏠 홈 (#44): partner, today, limits — the limits as Claude last reported them (the top bar untouched)
      const soon = Math.floor(Date.now() / 1000);
      rememberUsage("claude", { model: "Opus 5.5", five_hour: { pct: 35, resets_at: soon + 5430 }, seven_day: { pct: 86, resets_at: soon + 3 * 86400 + 7200 } });
      await dexView("home"); await shot("home");
      await dexView("box"); await shot("box-cards");
      await search("age0"); await shot("box-search");
      await search("zzz"); await shot("box-empty");
      await search(""); dexView("dex"); closeDex();
      // the top bar and the hint line at four window widths (#38): an agent waiting, with usage
      fakeUsage(tab);
      for (const w of [1400, 1100, 900, 720]) { await invoke("win_resize_test", { w, h: 600 }); await shot(`bar-${w}`); }
      // find in the terminal (#40): the search line on the big pane, a query typed
      await invoke("win_resize_test", { w: 1400, h: 900 });
      openTermSearch(bigPane(tab)); $("#tsearch-q").value = "proj"; termFind(1, true); await shot("term-search"); closeTermSearch();
    }
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("done");
  invoke("log_line", { line: "autotype done" });
}

// P0+: how a turn ended → reaction, tab, summary; an agent started in the shell → big slot
// (hook lines are written as Claude's hooks would; the shell runs "sleep" = a stand-in agent, and
// the runner writes a Codex session log for it when the log says "shell-agent swapped")
async function resultTest() {
  const log = (line) => invoke("log_line", { line: `p0-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tab = active;
  const hook = (event) => invoke("hook_event_test", { ws: tab.id, event });
  await wait(3000);
  // Claude has no interrupt hook: Esc typed into the agent pane, then silence (core: 1.5 s)
  for (const [end, act] of [["Stop", "act-attack"], ["Esc", "act-flinch"], ["StopFailure", "act-hurt"]]) {
    await hook("UserPromptSubmit"); await wait(700);
    if (end === "Esc") { await invoke("pty_write", { id: tab.panes.agent.id, data: "\x1b" }); await wait(2000); }
    else { await hook(end); await wait(700); }
    const cls = $(".poke", tab.view).className;
    const tb = $(`#tabs .tab[data-ws="${tab.id}"]`);
    await log(`${end} state=${tab.state?.state} reacted=${cls.includes(act)} tab=${tb.textContent.replace(/\s+/g, " ")} attention=${tb.classList.contains("attention")} summary=${$("#summary").textContent} fx=${$(".fx span", tab.view)?.textContent}`);
    if (end === "StopFailure") await invoke("shot_test", { name: "p0-error" });
    await wait(1200);
  }
  await wait(5000);
  await log(`settled state=${tab.state?.state}`);
  // the shell pane runs the stand-in agent (typed here, after the hook cases)
  await invoke("pty_write_test", { id: tab.panes.shell.id, data: "sleep 20\r" });
  for (let i = 0; i < 20 && !tab.swapped; i++) await wait(500);
  const main = tab.view.firstElementChild?.className;
  await log(`shell-agent swapped=${tab.swapped} main-slot=${main} title=${$(".pane-shell .title", tab.view).textContent}`);
  await invoke("shot_test", { name: "p0-swapped" });
  // its own state: the stand-in is a "codex_log" agent; the runner writes a Codex session log
  const seen = [];
  for (let i = 0; i < 30; i++) { const st = tab.state?.state; if (seen.at(-1) !== st) seen.push(st); if (st === "done") break; await wait(500); }
  await log(`shell-agent states=${seen.join(">")} top=${$("#doing").textContent} tab=${$(`#tabs .tab[data-ws="${tab.id}"]`).textContent}`);
  // ⌘G while the shell agent is in the big slot: the agent pane comes back to it and switches
  await nextAgent(tab);
  await wait(1000);
  await log(`cmd-g main-slot=${tab.view.firstElementChild?.className} agent-title=${$(".agent-title", tab.view).textContent} shell-title=${$(".pane-shell .title", tab.view).textContent} shown=${tab.state?.state} shell-still=${!!tab.shellAgent}`);
  for (let i = 0; i < 50 && tab.shellAgent; i++) await wait(500);
  await log(`agent-exited swapped=${tab.swapped} main-slot=${tab.view.firstElementChild?.className}`);
  await log("autotype done");
}

// X1e: a new folder offers 3 partners (key 2), 🎲 offers again (click), compact overlay with many
// tabs (the runner pre-sets partners for the other folders; the first folder is new)
async function x1eTest() {
  try { await x1eSteps(); } catch (e) { await invoke("log_line", { line: `x1e-test ERROR ${e?.stack || e}` }); }
  await invoke("log_line", { line: "x1e-test autotype done" });
}
async function x1eSteps() {
  const log = (line) => invoke("log_line", { line: `x1e-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tab = tabs[0];
  selectTab(tab);
  // a new folder (the box isn't empty: no starters): the dialog opens with the box
  for (let i = 0; i < 60 && !chooseOpen(); i++) await wait(500);
  let o = dexState?.chooseOpts;
  await wait(1500);
  await log(`dialog open=${chooseOpen()} starter=${!!o?.starter} starter-shown=${!!dexState?.chooseOpts?.starter} resting=${o?.resting.length} others=${o?.others.length} focus=${document.activeElement?.id}`);
  await invoke("shot_test", { name: "x1e-dialog" });
  const pickCard = (key) => { boxSelect(dexState.list.findIndex((m) => m.key === key)); return $(`#box-grid .pk-card[data-key="${key}"]`); };
  pickCard("r1"); await boxTake(); await wait(1500);
  await log(`rest1 partner=${tab.partner?.name}#${tab.partner?.uid} want=${o.resting[1]?.name}#${o.resting[1]?.uid} open=${chooseOpen()}`);
  await openChoose(tab); await wait(500);
  o = dexState?.chooseOpts;
  await log(`reopen current=${o.current?.name} resting0=${o.resting[0]?.name}`);
  const prev = tab.partner?.uid;
  pickCard("r0"); await boxTake(); await wait(1500);
  o = await invoke("partner_options", { ws: tab.id });
  await log(`rest-take partner=${tab.partner?.name} prev-now-resting=${o.resting.some((m) => m.uid === prev)}`);
  // another folder's partner: twice (confirm), that tab is left without one
  await openChoose(tab); await wait(500);
  o = dexState?.chooseOpts;
  const target = o.others[0];
  pickCard("o0"); await boxTake(); await wait(300);
  const asked = $("#dex-take").classList.contains("confirm") && $('#box-grid .pk-card[data-key="o0"]')?.classList.contains("confirm");
  await boxTake(); await wait(1500);
  const from = tabs.find((t) => base(t.cwd) === target?.folderName);
  await log(`other-take asked=${asked} partner=${tab.partner?.name}#${tab.partner?.uid} want=${target?.name}#${target?.uid} from=${target?.folderName} from-tab-partner=${from?.partner?.name ?? "none"} from-label=${from && $(".poke-label", from.view).textContent}`);
  await invoke("shot_test", { name: "x1e-freed" });
  if (chooseOpen()) closeChoose();
  // the Pokédex board: cells by state, Enter on an owned species takes a resting one
  await openDex(); await wait(1500);
  const cells = (c) => $("#dex-grid").querySelectorAll(`.cell.${c}`).length;
  const ownedOne = dexState.entries.find((x) => x.owned > 0 && x.id !== tab.partner?.id);
  await log(`dex caught=${cells("caught")} seen=${cells("seen")} unknown=${cells("unknown")} regions=${$("#dex-regions").textContent.replace(/\s+/g, " ")}`);
  await invoke("shot_test", { name: "x1e-dex" });
  dexSelect(ownedOne.id);
  dexKey({ key: "ArrowRight" }); dexKey({ key: "ArrowLeft" });
  await log(`dex sel=${dexState.sel} want=${ownedOne.id} take-visible=${!$("#dex-take").hidden}`);
  dexKey({ key: "Enter" }); await wait(1500);
  await log(`dex-enter partner=${tab.partner?.id} want=${ownedOne.id} dex-open=${dexOpen()}`);
  // a species that's only another folder's partner: confirm inside the Pokédex, no other screen
  await openDex(); await wait(800);
  const otherOnly = dexState.opts.others.find((m) => !dexState.opts.resting.some((r) => r.id === m.id) && dexState.opts.current?.id !== m.id);
  if (otherOnly) {
    dexSelect(otherOnly.id);
    const label1 = $("#dex-from").textContent;
    dexKey({ key: "Enter" }); await wait(300);
    const label2 = $("#dex-from button.confirm")?.textContent;
    await log(`dex-other first=${label1} second=${label2} dex-open=${dexOpen()} choose-open=${chooseOpen()}`);
    dexKey({ key: "Enter" }); await wait(1500);
    await log(`dex-other-taken partner=${tab.partner?.name}#${tab.partner?.uid} want=${otherOnly.name}#${otherOnly.uid} dex-open=${dexOpen()} choose-open=${chooseOpen()}`);
  } else await log("dex-other none");
  // other tabs: needs input / working / done / failed, then the overlay
  const ev = { 1: "Notification", 2: "UserPromptSubmit", 3: "Stop", 4: "StopFailure" };
  for (const [i, e] of Object.entries(ev)) {
    if (e !== "Notification" && e !== "UserPromptSubmit") await invoke("hook_event_test", { ws: tabs[i].id, event: "UserPromptSubmit" });
    await invoke("hook_event_test", { ws: tabs[i].id, event: e });
  }
  await wait(1500);
  const p = await invoke("overlay_payload_test");
  await log(`overlay current=${p.current?.name} urgent=${p.urgent?.name}:${p.urgent?.state} minis=${p.minis.map((t) => t.name + ":" + t.state).join(",")} more=${p.more} counts=${JSON.stringify(p.counts)}`);
  await invoke("overlay_show_test", { on: true });
  await wait(1500);
  await invoke("overlay_shot_test", { name: "x1e-overlay" });
  await invoke("overlay_collapse_test"); await wait(1200);
  await invoke("overlay_shot_test", { name: "x1e-collapsed" });
  const q = await invoke("overlay_payload_test");
  await log(`collapsed=${q.collapsed} urgent=${q.urgent} minis=${q.minis.length} bounds=${JSON.stringify(await invoke("overlay_bounds_test"))}`);
  await invoke("overlay_collapse_test");
  await invoke("overlay_show_test", { on: false });
}

// a first-time user opens several folders: the first partner from 3 starters, the others start
// empty; a wild one (more likely in an empty folder) becomes that folder's partner
async function newUserTest() {
  const log = (line) => invoke("log_line", { line: `newuser-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const first = tabs[0];
    selectTab(first);
    for (let k = 0; k < 120 && !(chooseOpen() && dexState?.chooseOpts?.starter?.ready); k++) { await wait(500); if (chooseOpen()) renderChoose(first, await invoke("partner_options", { ws: first.id })); }
    let o = dexState?.chooseOpts;
    await log(`first starter=${o.starter?.set.map((x) => x.name + ":" + x.types?.[0]).join(",")} note=${dexState?.chooseNote || ""}`);
    await wait(800);
    await invoke("shot_test", { name: "newuser-starter" });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", code: "Digit2", bubbles: true }));
    await wait(1500);
    await log(`first partner=${first.partner?.name}#${first.partner?.uid}`);
    const empty = tabs[1];
    selectTab(empty);
    await wait(1500);
    o = dexState?.chooseOpts;
    await log(`second dialog=${chooseOpen()} starter=${!!o?.starter} resting=${o?.resting.length} others=${o?.others.length}`);
    if (chooseOpen()) closeChoose();
    await log(`second empty-icon=${!$(".empty-ball", empty.view).hidden} label=${$(".poke-label", empty.view).textContent} hint=${$(".poke-exp", empty.view).textContent}`);
    await wait(600);
    await log(`overlays choose=${chooseOpen()} dex=${dexOpen()} start=${startOpen()} menu=${!$("#menu").hidden} wild=${wild.active()}`);
    await invoke("shot_test", { name: "newuser-empty" });
    // a task in the folder with a partner: no wild (normal chance is 0 here); in the empty one: wild
    await invoke("partner_done_test", { ws: first.id }); await wait(1000);
    await log(`done-with-partner wild=${wild.active()}`);
    for (let k = 0; k < 30 && !wild.active(); k++) { await invoke("partner_done_test", { ws: empty.id }); await wait(1500); }
    await log(`done-in-empty wild=${wild.active()} text=${$(".wild-text").textContent}`);
    await invoke("wild_rig_test", { result: "caught" });
    wild.throwBall(); await wait(4200);
    $(".wild-partner").click(); await wait(1500);
    await log(`caught-partner empty=${empty.partner?.name}#${empty.partner?.uid} icon-hidden=${$(".empty-ball", empty.view).hidden}`);
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// E1: composer → agent (bracketed paste + Enter), image paste → Ctrl+V, dropped files → paths,
// font size, relayout, the app menu (the stand-in agent records its input: CVIM_DESKTOP_AGENT_CMD)
async function e1Test() {
  const log = (line) => invoke("log_line", { line: `e1-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const tab = active;
    await wait(2500);
    composerToggle(tab);
    await log(`composer open=${!tab.composer.box.hidden} focus=${document.activeElement === tab.composer.ta}`);
    tab.composer.ta.value = "안녕하세요 CVIM\n둘째 줄";
    tab.composer.ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    await wait(600);
    await log(`composer sent closed=${tab.composer.box.hidden} draft="${tab.composer.ta.value}"`);
    // a draft survives closing
    composerToggle(tab); tab.composer.ta.value = "초안"; tab.composer.ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    composerToggle(tab); await log(`draft kept="${tab.composer.ta.value}"`); composerClose(tab);
    // image on the clipboard (no text) pasted into the agent pane
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
    tab.panes.agent.term.textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await wait(400);
    // dropped files
    const r = await invoke("drop_paths", { ws: tab.id, pane: "agent", paths: info.test.drop_files || [] });
    await log(`drop agent files=${r.files} folders=${r.folders}`);
    await wait(400);
    setFont(17);
    await log(`font=${tab.panes.agent.term.options.fontSize} saved=${localStorage.getItem("cvim.fontSize")}`);
    setFont(FONT_DEFAULT);
    relayout();
    await log(`menu=${(await invoke("menu_test")).join(",")}`);
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// E1b: the changes panel on a scratch git repo — list, side-by-side diff, revert a modified file,
// a new file to the (scratch) Trash
async function e1bTest() {
  const log = (line) => invoke("log_line", { line: `e1b-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const tab = active;
    await wait(2500);
    await refreshChanges(tab);
    const items = tab.changes.items;
    await log(`list repo=${tab.changes.repo} ${items.map((x) => `${x.status}:${x.path}:+${x.add}-${x.del}${x.binary ? ":bin" : ""}`).join(" ")} panel="${$(".changes", tab.view).textContent.slice(0, 120)}"`);
    // Esc → back to the file's line (opened from the 2nd line)
    await openDiff(tab, items[1], 1); await wait(400);
    closeDiff(); await wait(200);
    await log(`esc-focus=${document.activeElement?.title} want=${items[1].path}`);
    const mi = items.findIndex((x) => x.status === "modified");
    const mod = items[mi];
    await openDiff(tab, mod, mi); await wait(600);
    await log(`diff rows=${$("#diff-body").querySelectorAll("tr").length} del=${$("#diff-body").querySelectorAll(".tx.del").length} add=${$("#diff-body").querySelectorAll(".tx.add").length} title=${$("#diff-title").textContent}`);
    await invoke("shot_test", { name: "e1b-diff" });
    $("#diff-revert").click(); await wait(200);
    await log(`revert-ask=${$("#diff-revert").textContent}`);
    $("#diff-revert").click(); await wait(1500);
    await log(`revert-focus=${document.activeElement?.title} (line now at index ${mi}: ${tab.changes.items[Math.min(mi, tab.changes.items.length - 1)]?.path})`);
    const nw = tab.changes.items.find((x) => x.status === "new" && !x.binary);
    await log(`after-revert open=${diffOpen()} items=${tab.changes.items.map((x) => x.status + ":" + x.path).join(" ")}`);
    await openDiff(tab, nw, tab.changes.items.indexOf(nw)); await wait(400);
    await log(`new-diff rows=${$("#diff-body").querySelectorAll("tr").length} button=${$("#diff-revert").textContent}`);
    $("#diff-revert").click(); $("#diff-revert").click(); await wait(1500);
    await log(`after-trash items=${tab.changes.items.map((x) => x.status + ":" + x.path).join(" ")}`);
    await invoke("shot_test", { name: "e1b-panel" });
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// M1: a second session in the same folder — rail, switching, per-session state (hook lines
// written as Claude's hooks would, per session id), tab icon = most urgent, close; overlay count
async function m1Test() {
  const log = (line) => invoke("log_line", { line: `m1-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const tab = active;
    await wait(2500);
    await log(`one session: rail-hidden=${$(".rail", tab.view).hidden} add-button=${!!$(".sess-add", tab.view)}`);
    const s2 = await newSession(tab);
    await wait(800);
    await log(`two: rail-hidden=${$(".rail", tab.view).hidden} items=${$(".rail", tab.view).querySelectorAll(".sess").length} cur=${tab.sid === s2.id} shown-terms=${[...tab.view.querySelectorAll(".sterm")].filter((x) => x.style.display !== "none").length} title=${$(".agent-name", tab.view).textContent} tabbar=${$(`#tabs .tab[data-ws="${tab.id}"]`).textContent}`);
    await invoke("shot_test", { name: "m1-two" });
    // session 2 works, session 1 waits for input
    await invoke("hook_event_test", { ws: s2.id, event: "UserPromptSubmit" });
    await invoke("hook_event_test", { ws: tab.id, event: "Notification" });
    await wait(900);
    await log(`states s1=${tab.sessions[0].state?.state} s2=${tab.sessions[1].state?.state} shown=${tab.state?.state} tab-icon-urgent=${urgentOf(tab)} attention=${$(`#tabs .tab[data-ws="${tab.id}"]`).classList.contains("attention")} summary=${$("#summary").textContent} dots=${[...$(".rail", tab.view).querySelectorAll(".dot")].map((d) => d.className.split(" ")[1]).join(",")}`);
    const ov = await invoke("overlay_payload_test");
    await log(`overlay sessions=${ov.current?.sessions} state=${ov.current?.state}`);
    stepSession(-1); await wait(300);
    await log(`switched cur=${tab.sid} shown=${tab.state?.state} bar=${$("#doing").textContent}`);
    // the background session finishes: the partner reacts, a toast
    await invoke("hook_event_test", { ws: s2.id, event: "Stop" }); await wait(900);
    await log(`bg-done s2=${tab.sessions[1].state?.state} toast=${$("#toast").textContent}`);
    // numbers follow the rail: 3 sessions, close the 2nd, open one → numbers 1·2·3 again
    const s3 = await newSession(tab); await wait(500);
    await closeSession(tab, s2.id); await wait(300);
    const s4 = await newSession(tab); await wait(500);
    await log(`renumber rail=${[...$(".rail", tab.view).querySelectorAll(".sess .n")].map((n) => n.textContent).join(",")} title=${$(".agent-name", tab.view).textContent}`);
    // ⌃⌘1 → session 1, ⌃⌘2 → the second in the rail
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", key: "1", ctrlKey: true, metaKey: true, bubbles: true }));
    await wait(200);
    const at1 = tab.sid === tab.id;
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit2", key: "2", ctrlKey: true, metaKey: true, bubbles: true }));
    await wait(200);
    await log(`ctrl-cmd-1=${at1} ctrl-cmd-2=${tab.sid === s3.id} active-tab-unchanged=${active === tab}`);
    await closeSession(tab, s3.id); await wait(200);
    await closeSession(tab, s4.id); await wait(500);
    await log(`closed sessions=${tab.sessions.length} rail-hidden=${$(".rail", tab.view).hidden} core-has=${(await invoke("workspaces_test")).join(",")}`);
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// M2 step 1: composer → all sessions / one session, a selection handed from session 1 to 2, the
// rail menu (each stand-in agent records its input to <session id>.bin)
async function m2Test() {
  const log = (line) => invoke("log_line", { line: `m2-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const tab = active;
    await wait(2500);
    const s2 = await newSession(tab); await wait(1500);
    switchSession(tab, tab.id, { quiet: true });
    composerToggle(tab);
    await log(`chips=${$(".composer-to", tab.view).textContent}`);
    tab.composeTo = "all"; renderComposeTo(tab);
    tab.composer.ta.value = "모두에게";
    await composerSend(tab, true); await wait(500);
    composerToggle(tab); tab.composeTo = s2.id; renderComposeTo(tab);
    tab.composer.ta.value = "세션2에게만";
    await composerSend(tab, false); await wait(500);
    // a selection made in session 1, handed to session 2 (set directly: no system clipboard in tests)
    lastPick = { text: "선택한 답 일부", from: tab.sessions[0].pane.id, tab };
    $(`.rail .sess[data-sid="${s2.id}"]`, tab.view).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 120 }));
    await wait(200);
    await log(`rail-menu=${[...$("#menu").children].map((b) => b.textContent.trim()).join(" | ")}`);
    closeMenu();
    await handPick(tab, tab.sessions[1], true); await wait(500);
    await log(`toast=${$("#toast").textContent}`);
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// S2 shell first: a new folder is a shell; an agent typed there is followed and ends back in the
// shell; ⌘G picks one (Enter = the folder's last) and the agent pane takes the big slot
async function s2Test() {
  const log = (line) => invoke("log_line", { line: `s2-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (k) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, bubbles: true }));
  const menu = () => [...$("#menu").querySelectorAll("button")].map((b) => b.textContent.trim()).join(" | ") + ` sel=${$("#menu .sel")?.textContent}`;
  const look = (tab) => `shellOnly=${tab.shellOnly} host=${tab.hostAgent?.key || "-"} big=${bigPane(tab).kind} pane-title=${$(".agent-name", tab.view).textContent} tag=${$("#agent").textContent} agentOn=${agentOn(tab)} state=${tab.state?.state} doing=${$("#doing").textContent} shell-pane=${!!tab.panes.shell.el.offsetParent} focus-big=${document.activeElement === bigPane(tab).term.textarea}`;
  const typeIn = (p, text) => invoke("pty_write_test", { id: p.id, data: `${text}\r` });
  try {
    const tab = active;
    await wait(2500);
    if (chooseOpen()) closeChoose(false); // the new folder's partner dialog (not what's tested here)
    await log(`open ${look(tab)}`);
    await invoke("shot_test", { name: "s2-shell" });
    // an agent typed into the big shell: tracked as the session's agent, bottom-right shell stays (5)
    await typeIn(tab.panes.agent, info.test.fake_claude);
    for (let i = 0; i < 20 && !tab.hostAgent; i++) await wait(300);
    await log(`typed ${look(tab)}`);
    await invoke("shot_test", { name: "s2-typed" });
    // ⌘G now: the typed one is "running" (6: picking it again doesn't start a second one)
    await switchAgent(tab);
    await wait(300);
    await log(`menu-typed ${menu()}`);
    key("Enter");
    await wait(500);
    await log(`same-as-typed toast=${$("#toast").textContent} host=${tab.hostAgent?.key}`);
    // it ends: the shell is back; ⌘G offers it first (1)
    for (let i = 0; i < 30 && tab.hostAgent; i++) await wait(300);
    await log(`typed-exit ${look(tab)}`);
    await switchAgent(tab);
    await wait(300);
    await log(`menu-after ${menu()}`);
    key("Escape");
    // typed again, then ⌘G → another agent replaces it (confirm), and when that one ends the shell
    // is back — not the typed one (4)
    await typeIn(tab.panes.agent, info.test.fake_claude);
    for (let i = 0; i < 20 && !tab.hostAgent; i++) await wait(300);
    window.confirm = () => true; // the replace question
    const { list } = await invoke("agents_list", { ws: tab.id, session: tab.id });
    await pickAgent(tab, list.find((a) => a.key === "gemini"), true);
    await wait(1500);
    await log(`replaced ${look(tab)}`);
    await invoke("pty_write_test", { id: tab.panes.agent.id, data: "\x03" }); // the stand-in agent: Ctrl-C ends it
    for (let i = 0; i < 20 && !tab.shellOnly; i++) await wait(300);
    await wait(1500);
    await log(`replaced-exit ${look(tab)} screen=${JSON.stringify(screenText(tab.panes.agent.term).slice(0, 80))} host-agent-after=${tab.hostAgent?.key || "-"}`);
    await invoke("shot_test", { name: "s2-back" });
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// S2: agents ending in sessions (the stand-in runs 6 s in the first session, 2 s in later ones)
async function s2xTest() {
  const log = (line) => invoke("log_line", { line: `s2x-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rail = (tab) => [...$(".rail", tab.view).querySelectorAll(".sess")].map((b) => b.querySelector(".ic").textContent + b.querySelector(".n").textContent).join(",");
  const look = (tab) => `sessions=${tab.sessions.length} cur=${sessNo(tab, curSession(tab))} hosts=${tab.sessions.map((x) => (x.host ? "shell" : x.running ? "agent" : "-")).join(",")} rail=${rail(tab)} title=${$(".agent-name", tab.view).textContent} toast=${$("#toast").textContent}`;
  try {
    const tab = active;
    await wait(2500);
    await log(`start tab=${!!tab}`);
    const claude = (await invoke("agents_list", { ws: tab.id, session: tab.id })).list.find((a) => a.key === "claude");
    await log(`claude=${!!claude}`);
    if (chooseOpen()) closeChoose(false);
    await pickAgent(tab, claude, false); // session 1: an agent (the stand-in runs 6 s)
    await wait(300);
    await newSession(tab); // ⌘⇧T: a shell
    await wait(800);
    await log(`new-session ${look(tab)}`);
    await pickAgent(tab, claude, false); // session 2: an agent (2 s)
    await wait(3000);
    await log(`s2-agent-ended ${look(tab)}`);
    await wait(3500);
    await log(`s1-agent-ended ${look(tab)}`);
    await wait(3000); // its new shell is up (rc files)
    await invoke("pty_write_test", { id: tab.sessions[1].pane.id, data: "exit\r" }); // session 2's shell itself
    await wait(1500);
    await log(`s2-shell-exit ${look(tab)} screen2=${JSON.stringify(screenText(tab.sessions.at(-1).pane.term).slice(-200))}`);
    await invoke("pty_write_test", { id: tab.sessions[0].pane.id, data: "exit\r" }); // session 1's shell: a new one
    await wait(2000);
    await log(`s1-shell-exit ${look(tab)}`);
    // only a bare shell, no other: ⌘⇧T makes another shell (no agent, no picker)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "T", code: "KeyT", metaKey: true, shiftKey: true, bubbles: true }));
    await wait(1500);
    await log(`cmd-shift-t ${look(tab)} menu-open=${!$("#menu").hidden}`);
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// usage: a Claude in the shell (conversation log: model + ctx tokens → %), then the agent pane
// before its first reply (last values, dimmed). The runner's stand-in writes the log.
async function u1Test() {
  const log = (line) => invoke("log_line", { line: `u1-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const bar = () => `usage=${$("#usage").textContent} stale=${$("#usage").querySelectorAll("[title]").length}`;
  try {
    localStorage.setItem("cvim.usage.claude", JSON.stringify({ model: "Opus 5.5", five_hour: { pct: 6, resets_at: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { pct: 13 }, windows: { "claude-opus-5-5": 1000000 } }));
    const tab = active;
    await wait(2500);
    if (chooseOpen()) closeChoose(false);
    await log(`shell ${bar()}`);
    await invoke("pty_write_test", { id: tab.panes.shell.id, data: `${info.test.fake_claude}\r` });
    for (let i = 0; i < 30 && !/ctx/.test($("#usage").textContent); i++) await wait(300);
    await log(`shell-claude state=${tab.state?.state} ${bar()}`);
    for (let i = 0; i < 30 && tab.shellAgent; i++) await wait(300);
    await pickAgent(tab, { key: "claude", name: "Claude Code" }, false);
    await wait(1500);
    await log(`agent-pane-before-reply state=${tab.state?.state} ${bar()}`);
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// other agents typed by hand (stand-ins in CVIM_DESKTOP_FAKE_BIN report like Gemini's extension /
// OpenCode's plugin): in the big shell, then in the shell pane
async function s3Test() {
  const log = (line) => invoke("log_line", { line: `s3-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const tab = active;
    await wait(2500);
    if (chooseOpen()) closeChoose(false);
    for (const [where, name] of [["big", "gemini"], ["big", "opencode"], ["pane", "gemini"], ["pane", "opencode"]]) {
      const p = where === "big" ? tab.panes.agent : tab.panes.shell;
      await invoke("pty_write_test", { id: p.id, data: `${info.test.fake_bin}/${name}\r` });
      const seen = [];
      for (let i = 0; i < 40; i++) {
        const st = tab.state?.state;
        if (seen.at(-1) !== st) seen.push(st);
        if (seen.includes("done") || seen.length > 8) break;
        await wait(250);
      }
      await log(`${where} ${name} title=${$(".agent-name", tab.view).textContent}|${$(".pane-shell .title", tab.view).textContent} states=${seen.join(">")} usage=${$("#usage").textContent}`);
      for (let i = 0; i < 30 && (tab.hostAgent || tab.shellAgent); i++) await wait(300);
      await wait(500);
    }
    await log(`end shellOnly=${tab.shellOnly} state=${tab.state?.state}`);
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// ⌘G while the big shell is still starting (its rc files: pyenv rehash …): the shell is replaced
// at these delays after it started; the runner watches ~/.pyenv/shims/.pyenv-shim meanwhile
async function raceTest() {
  const log = (line) => invoke("log_line", { line: `race-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const tab = active;
    await wait(3000);
    if (chooseOpen()) closeChoose(false);
    const claude = (await invoke("agents_list", { ws: tab.id, session: tab.id })).list.find((a) => a.key === "claude");
    for (const d of [50, 150, 300, 500, 800, 1200, 50, 150, 300, 500, 800, 1200]) {
      await startHost(tab);
      await wait(d);
      await log(`replace after ${d}ms t=${Date.now()}`);
      await pickAgent(tab, claude, false);
      await wait(2500);
    }
    // the agent ends: the shell is back (what's left on screen)
    await invoke("pty_write_test", { id: tab.panes.agent.id, data: "\x03" });
    await wait(2500);
    await log(`after-exit screen=${JSON.stringify(screenText(tab.panes.agent.term).slice(0, 120))}`);
    await invoke("shot_test", { name: "after-exit" });
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// ⌘G: how long until the picker shows, and what it says (the runner can make the shell config hang)
async function pickTest() {
  const log = (line) => invoke("log_line", { line: `pick-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const tab = active;
    await wait(2500);
    if (chooseOpen()) closeChoose(false);
    const t0 = performance.now();
    await switchAgent(tab);
    await log(`picker after ${Math.round(performance.now() - t0)}ms items=${[...$("#menu").querySelectorAll("button")].map((b) => b.textContent.trim()).join(" | ")}`);
    await invoke("shot_test", { name: "picker" });
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// two shells in a folder: shell 1 resting (Claude's idle reminder must not make it "입력 필요"),
// shell 2 finishes in the background → the overlay says so; with shell 1 really waiting, both show
async function multiTest() {
  const log = (line) => invoke("log_line", { line: `multi-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ov = async () => { const p = await invoke("overlay_payload_test"); const c = p.current; return `state=${c?.state} ended=${c?.ended} endedN=${c?.endedN}`; };
  const hook = (ws, event, detail = "") => invoke("hook_event_test", { ws, event, detail });
  try {
    const tab = active;
    await wait(2500);
    if (chooseOpen()) closeChoose(false);
    const s2 = await newSession(tab); // shell 2 (autostart: an agent)
    switchSession(tab, tab.id); // looking at shell 1; shell 2 in the background
    await hook(tab.id, "Stop"); await wait(800);
    await hook(tab.id, "Notification", "idle_prompt"); await wait(800);
    await hook(tab.id, "Notification", "Claude is waiting for your input"); await wait(800);
    await log(`s1 after idle reminders: s1=${tab.sessions[0].state?.state}`);
    await hook(s2.id, "UserPromptSubmit"); await wait(800);
    await hook(s2.id, "Stop"); await wait(1200);
    await log(`s2 done in background: ${await ov()} rail=${$(".rail .sess:nth-child(2) .dot")?.className}`);
    await hook(tab.id, "UserPromptSubmit"); await wait(500);
    await hook(tab.id, "Notification", "permission_prompt"); await wait(800);
    await hook(s2.id, "UserPromptSubmit"); await wait(800);
    await hook(s2.id, "Stop"); await wait(1200);
    await log(`s1 waiting + s2 done: ${await ov()}`);
    const d = await invoke("diag_test");
    await log(`diag lines=${d.split("\n").length} hasHome=${d.includes(info.home)} hasCwd=${d.includes(tab.cwd)} hasBase=${d.includes(base(tab.cwd))}`);
    await log(`diag-head ${JSON.stringify(d.split("\n").slice(0, 14))}`);
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// README screenshots: the ⌘G picker, the agent list, two shells with an agent typed in a subfolder
async function tourTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (k) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, bubbles: true }));
  try {
    const tab = active;
    await wait(3500);
    if (chooseOpen()) closeChoose(false);
    await switchAgent(tab);
    await wait(500);
    await invoke("shot_test", { name: "tour-picker" });
    key("Escape");
    await openAgents();
    await wait(800);
    await invoke("shot_test", { name: "tour-agents" });
    closeAgents();
    await newSession(tab);
    await wait(3500);
    await invoke("pty_write_test", { id: tab.panes.agent.id, data: `export PATH=${info.test.fake_bin}:$PATH; clear\r` });
    await wait(800);
    await invoke("pty_write_test", { id: tab.panes.agent.id, data: "cd src && claude\r" });
    for (let i = 0; i < 40 && tab.state?.state !== "done"; i++) await wait(300);
    await wait(400);
    await invoke("shot_test", { name: "tour-shells" });
  } catch (e) { invoke("log_line", { line: `tour ERROR ${e?.stack || e}` }); }
  invoke("log_line", { line: "autotype done" });
}

// #3: agents typed after a `cd` — a subfolder (Claude) and another folder (Codex): their own logs
// are followed (state, usage), the title says where, "새 탭으로" opens the other folder
async function cdTest() {
  const log = (line) => invoke("log_line", { line: `cd-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const type = (p, text) => invoke("pty_write_test", { id: p.id, data: `${text}\r` });
  const run = async (tab, p, cmd, isHost) => {
    await type(p, cmd);
    const on = () => (isHost ? tab.hostAgent : tab.shellAgent);
    for (let i = 0; i < 30 && !on(); i++) await wait(300);
    const seen = [];
    for (let i = 0; i < 40; i++) { const st = tab.state?.state; if (seen.at(-1) !== st) seen.push(st); if (st === "done") break; await wait(250); }
    const title = isHost ? $(".agent-name", tab.view) : $(".pane-shell .title", tab.view);
    await log(`${cmd.split("&&")[0].trim()} → title=${title.textContent} states=${seen.join(">")} usage=${$("#usage").textContent} toast=${$("#toast").textContent}`);
    for (let i = 0; i < 40 && on(); i++) await wait(300);
  };
  try {
    const tab = active;
    await wait(3000);
    if (chooseOpen()) closeChoose(false);
    const bin = info.test.fake_bin;
    await run(tab, tab.panes.agent, `cd sub && ${bin}/claude`, true);
    await run(tab, tab.panes.agent, `cd ../../other && ${bin}/codex`, true);
    // still in "other": a long-running one — the banner, then moved (running) into other's tab
    await type(tab.panes.agent, `${bin}2/codex`);
    for (let i = 0; i < 30 && !tab.hostAgent; i++) await wait(300);
    await wait(500);
    const banner = $('.where-banner[data-pane="agent"]', tab.view);
    await invoke("shot_test", { name: "cd-outside" });
    await log(`banner shown=${!banner.hidden} text=${banner.textContent}`);
    banner.querySelector(".move").click();
    for (let i = 0; i < 40 && tabs.length < 2; i++) await wait(250);
    const other = tabs.at(-1);
    for (let i = 0; i < 40 && !other.hostAgent; i++) await wait(250);
    await wait(1500);
    await log(`moved: tabs=${tabs.length} target=${base(other.cwd)} target-agent=${other.hostAgent?.key} target-title=${$(".agent-name", other.view).textContent} source-agent=${tab.hostAgent?.key || "-"} source-title=${$(".agent-name", tab.view).textContent} source-banner-hidden=${banner.hidden}`);
    const seen = [];
    for (let i = 0; i < 60; i++) { const st = other.state?.state; if (seen.at(-1) !== st) seen.push(st); if (st === "done") break; await wait(250); }
    await log(`moved agent states in target=${seen.join(">")} usage=${$("#usage").textContent}`);
    await invoke("shot_test", { name: "cd-moved" });
    await run(tabs[0], tabs[0].panes.shell, `cd sub && ${bin}/claude`, false);
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// the agent connection list (no real agent runs: only where they are)
async function agentsTest() {
  const log = (line) => invoke("log_line", { line: `agents-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await wait(2500);
    if (chooseOpen()) closeChoose(false);
    await switchAgent(active);
    await wait(300);
    await log(`menu-last=${[...$("#menu").querySelectorAll("button")].at(-1)?.textContent}`);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "5", code: "Digit5", bubbles: true }));
    await wait(1500);
    await log(`open=${agentsOpen()} rows=${[...$("#agents-list").children].map((li) => li.textContent.replace(/\s+/g, " ").trim()).join(" | ")}`);
    await invoke("shot_test", { name: "agents" });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await wait(300);
    await log(`closed=${!agentsOpen()}`);
    await log(`menu=${JSON.stringify(await invoke("appmenu_test"))}`);
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// A2: a Claude started by hand in the shell (a stand-in named "claude") followed through its
// conversation log (the runner writes it under a scratch CLAUDE_CONFIG_DIR)
async function a2Test() {
  const log = (line) => invoke("log_line", { line: `a2-test ${line}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const tab = active;
    await wait(2500);
    await invoke("pty_write_test", { id: tab.panes.shell.id, data: `${info.test.fake_claude}\r` });
    for (let i = 0; i < 20 && !tab.swapped; i++) await wait(500);
    await log(`shell-claude swapped=${tab.swapped} title=${$(".pane-shell .title", tab.view).textContent}`);
    const seen = [];
    for (let i = 0; i < 40; i++) { const st = tab.state?.state; if (seen.at(-1) !== st) seen.push(st); if (seen.includes("interrupted")) break; await wait(300); }
    await log(`states=${seen.join(">")} exp=${$(".poke-exp", tab.view).textContent}`);
  } catch (e) { await log(`ERROR ${e?.stack || e}`); }
  await log("autotype done");
}

// ── start ───────────────────────────────────────────────────────────────────
async function main() {
  info = await invoke("app_info"); // doesn't wait for the shell environment (#31)
  invoke("startup_mark", { what: "ui has app info" });
  if (info.test.lab) labRun(info.test.lab); // the lab watches the start itself
  invoke("wild_state").then((w) => { wildOn = w.enabled; if (w.current) wild.show(w.current); });
  if (info.test.sec_test) secTest();
  // session restore: last time's tabs (agents resume their conversations), then the last active one
  for (const dir of info.open) {
    const tab = await openFolder(dir, { resume: !!info.restored?.tabs.includes(dir) && !info.restored.shell?.includes(dir) });
    // more sessions in that folder last time (M1): started fresh
    for (const key of info.restored?.sessions?.[dir] || []) await newSession(tab, key); // null: was a shell
    if (tab?.sessions?.length > 1) switchSession(tab, tab.id, { quiet: true });
  }
  if (info.front) { const t = tabs.find((x) => x.cwd === info.front); if (t && t !== active) selectTab(t); } // a dropped folder wins over last time's front tab
  if (info.restored) toast(`지난번 탭 ${info.restored.tabs.length}개를 다시 열었어요 (대화 이어서)`);
  if (!tabs.length) showStart(true);
  invoke("startup_mark", { what: tabs.length ? "ui first tab shown" : "ui start screen shown" });
  // first launch: which agents CVIM sees (once)
  // not in tests (first_run: a first launch as it is)
  invoke("agents_status").then((st) => { if (!st.seen && (!Object.keys(info.test).length || info.test.first_run || info.test.first_launch)) openAgents(); });
  if (info.test.switch_test && active) switchTest(active);
  if (info.test.tabs_test) tabsTest();
  if (info.test.poke_test) pokemonTest();
  if (info.test.wild_test) wildTest();
  if (info.test.p0_test) resultTest();
  if (info.test.x1e_test) x1eTest();
  if (info.test.newuser_test) newUserTest();
  if (info.test.e1_test) e1Test();
  if (info.test.e1b_test) e1bTest();
  if (info.test.m1_test) m1Test();
  if (info.test.m2_test) m2Test();
  if (info.test.a2_test) a2Test();
  if (info.test.s2_test) s2Test();
  if (info.test.s2x_test) s2xTest();
  if (info.test.u1_test) u1Test();
  if (info.test.agents_test) agentsTest();
  if (info.test.diag_test) setTimeout(async () => {
    const d = await invoke("diag_test");
    const leak = tabs.flatMap((t) => [t.cwd, base(t.cwd)]).filter((x) => d.includes(x));
    await invoke("log_line", { line: `diag-test tabs=${tabs.length} leaks=${JSON.stringify(leak)} cwd-lines=${JSON.stringify(d.split("\n").filter((l) => l.includes("cwd=")))}` });
    invoke("log_line", { line: "autotype done" });
  }, 4000);
  if (info.test.keys_test) setTimeout(async () => {
    const p = active.panes.shell;
    p.term.focus();
    const got = [];
    const sub = p.term.onData((d) => got.push(d));
    const ta = p.term.textarea;
    const caret = () => `${ta.selectionStart}/${ta.value.length}`;
    // #13: Hangul typed after the textarea caret left the end (the old ⌘← did that)
    async function hangul(guard) {
      p.noCaretGuard = !guard;
      for (const ch of ["나", "요"]) { await invoke("ime_compose", { text: ch }); await invoke("ime_commit", { text: ch }); await new Promise((r) => setTimeout(r, 80)); }
      ta.setSelectionRange(0, 0);
      got.length = 0;
      // a key before the syllable (Shift: no input of its own) — the guard runs on keydown. The
      // IME's own 229 keydown can't be sent here: through DevTools it lands in another xterm path
      await invoke("key_test", { key: "Shift", code: "ShiftLeft", keyCode: 16, modifiers: 8 });
      await invoke("ime_compose", { text: "가" });
      await invoke("ime_commit", { text: "가" });
      await new Promise((r) => setTimeout(r, 150));
      p.noCaretGuard = false;
      return `${got.join("")} caret=${caret()}`;
    }
    const before = await hangul(false), after = await hangul(true);
    // #15: ⌘← on an unfinished "하" (the IME commits it, then the key arrives)
    async function commitThenKey(guard, k) {
      p.noCommitGuard = !guard;
      p.term.focus();
      await invoke("ime_compose", { text: "하" });
      got.length = 0;
      await invoke("ime_commit_key_test", { text: "하", ...k });
      await new Promise((r) => setTimeout(r, 200));
      p.noCommitGuard = false;
      return got.join("");
    }
    const LEFT = { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, modifiers: 4, commands: ["moveToBeginningOfLine"] };
    // (Enter can't be checked this way: DevTools' Enter puts a newline into the textarea and the
    // syllable is lost even without the guard)
    await invoke("log_line", { line: `keys-test commit-then-key unguarded-left=${JSON.stringify(await commitThenKey(false, LEFT))} guarded-left=${JSON.stringify(await commitThenKey(true, LEFT))}` });
    // #16: every key that moves / deletes, on an unfinished syllable (iTerm2: only finishes it)
    const K = (key, code, keyCode, modifiers = 0, commands) => ({ key, code, keyCode, modifiers, ...(commands ? { commands } : {}) });
    const NAV = {
      "opt-left": K("ArrowLeft", "ArrowLeft", 37, 1, ["moveWordLeft"]), "opt-right": K("ArrowRight", "ArrowRight", 39, 1, ["moveWordRight"]),
      "left": K("ArrowLeft", "ArrowLeft", 37), "right": K("ArrowRight", "ArrowRight", 39), "up": K("ArrowUp", "ArrowUp", 38), "down": K("ArrowDown", "ArrowDown", 40),
      "shift-left": K("ArrowLeft", "ArrowLeft", 37, 8), "ctrl-left": K("ArrowLeft", "ArrowLeft", 37, 2),
      "home": K("Home", "Home", 36), "end": K("End", "End", 35), "pgup": K("PageUp", "PageUp", 33), "fwd-delete": K("Delete", "Delete", 46),
      "opt-backspace": K("Backspace", "Backspace", 8, 1, ["deleteWordBackward"]), "cmd-right": K("ArrowRight", "ArrowRight", 39, 4, ["moveToEndOfLine"]),
      "cmd-backspace": K("Backspace", "Backspace", 8, 4, ["deleteToBeginningOfLine"]),
    };
    const nav = {}, plain = {};
    for (const [name, k] of Object.entries(NAV)) {
      nav[name] = await commitThenKey(true, k);
      got.length = 0; await invoke("key_test", k); await new Promise((r) => setTimeout(r, 120)); plain[name] = got.join(""); // no composition: the key works
    }
    const other = {};
    for (const [name, k] of Object.entries({ "opt-b": K("b", "KeyB", 66, 1), "tab": K("Tab", "Tab", 9), "esc": K("Escape", "Escape", 27), "ctrl-c": K("c", "KeyC", 67, 2) })) {
      for (const g of [false, true]) {
        p.term.focus();
        other[`${name}${g ? "" : "-unguarded"}`] = await commitThenKey(g, k) + (document.activeElement === p.term.textarea ? "" : " (focus moved)");
      }
    }
    await invoke("log_line", { line: `keys-test nav-on-syllable helper=${typeof p.term._core?._compositionHelper?.keydown} ${JSON.stringify(nav)} other=${JSON.stringify(other)}` });
    await invoke("log_line", { line: `keys-test nav-plain ${JSON.stringify(plain)}` });
    await invoke("log_line", { line: `keys-test hangul-after-caret-move unguarded=${JSON.stringify(before)} guarded=${JSON.stringify(after)}` });
    const keys = [
      ["cmd-left", { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, modifiers: 4, commands: ["moveToBeginningOfLine"] }],
      ["cmd-right", { key: "ArrowRight", code: "ArrowRight", keyCode: 39, modifiers: 4, commands: ["moveToEndOfLine"] }],
      ["cmd-up", { key: "ArrowUp", code: "ArrowUp", keyCode: 38, modifiers: 4, commands: ["moveToBeginningOfDocument"] }],
      ["a", { key: "a", code: "KeyA", keyCode: 65, text: "a" }],
      ["shift-enter", { key: "Enter", code: "Enter", keyCode: 13, modifiers: 8, text: "\r" }],
      ["enter", { key: "Enter", code: "Enter", keyCode: 13, text: "\r" }],
      ["cmd-backspace", { key: "Backspace", code: "Backspace", keyCode: 8, modifiers: 4 }],
    ];
    const out = {};
    for (const [name, k] of keys) {
      got.length = 0;
      await invoke("key_test", k);
      await new Promise((r) => setTimeout(r, 150));
      out[name] = got.join("") + (name.startsWith("cmd-") ? ` caret=${caret()}` : "");
    }
    sub.dispose();
    await invoke("log_line", { line: `keys-test ${JSON.stringify(out)}` });
    invoke("log_line", { line: "autotype done" });
  }, 3000);
  if (info.test.dexnav_test) setTimeout(async () => {
    // #17: arrows inside the "새로 잡은" row, ↓ to the grid at that Pokémon, ↑ from the first line back
    await openDex();
    const st = () => `${dexState.zone}:${dexState.zone === "recent" ? dexState.ri : "-"}:#${dexState.sel}:${$("#dex-grid .cell.sel")?.closest(".recent") ? "row" : "grid"}`;
    const out = [`open=${st()} cols=${dexCols()}`];
    for (const k of ["ArrowRight", "ArrowRight", "ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowUp", "End", "ArrowRight", "ArrowDown", "ArrowUp", "ArrowUp", "ArrowLeft", "ArrowDown", "n"]) {
      const handled = dexKey(new KeyboardEvent("keydown", { key: k }));
      out.push(`${k}${handled ? "" : "(unhandled)"}=${st()}`);
    }
    document.querySelector('#dex-grid .cells.recent .cell[data-ri="1"]').click();
    out.push(`click-row-1=${st()}`);
    document.querySelector('#dex-grid .cells:not(.recent) .cell[data-n="7"]').click();
    out.push(`click-grid-7=${st()}`);
    dexRecent(3);
    out.push(`open-at-end=${dexOpen()}`);
    await new Promise((r) => setTimeout(r, 1000)); // painted before the capture
    await invoke("shot_test", { name: "dexnav" });
    await invoke("log_line", { line: `dexnav-test ${out.join(" ")}` });
    invoke("log_line", { line: "autotype done" });
  }, 6000);
  if (info.test.links_test) setTimeout(async () => {
    // #19: web addresses in the output → ranges (Hangul before them, ")" around them, wrapped), and
    // a real ⌘-click opens (logged in tests), a plain click doesn't
    const p = active.panes.shell, t = p.term, buf = () => t.buffer.active;
    const long = "https://long.example/" + "a".repeat(t.cols + 10);
    await invoke("pty_write_test", { id: p.id, data: `clear; echo '출처: https://example.com/a_(b) 끝'; echo '한글 (https://x.y/z).'; echo '[문서](https://docs.example/p?q=1)'; echo '${long}'\r` });
    await new Promise((r) => setTimeout(r, 1500));
    const prov = webLinks(t), found = [];
    for (let y = 1; y <= buf().length; y++) {
      const text = buf().getLine(y - 1)?.translateToString(true) || "";
      if (!/https?:/.test(text) || text.includes("echo")) continue;
      await new Promise((r) => prov.provideLinks(y, (ls) => { for (const l of ls || []) found.push({ y, text: l.text, s: `${l.range.start.x},${l.range.start.y}`, e: `${l.range.end.x},${l.range.end.y}` }); r(); }));
    }
    await invoke("log_line", { line: `links-test cols=${t.cols} found=${JSON.stringify(found)}` });
    // click the first link's 3rd cell: plain, then with ⌘
    const f = found[0];
    const screen = t.element.querySelector(".xterm-screen").getBoundingClientRect();
    const dim = t._core._renderService.dimensions.css.cell;
    const [cx, cy] = f.s.split(",").map(Number);
    const x = screen.left + (cx + 1.5) * dim.width, yy = screen.top + (cy - 1 - buf().viewportY + 0.5) * dim.height;
    await invoke("click_test", { x, y: yy });
    await new Promise((r) => setTimeout(r, 300));
    const plain = await invoke("links_opened_test");
    await invoke("click_test", { x, y: yy, modifiers: 4 });
    await new Promise((r) => setTimeout(r, 300));
    const cmd = await invoke("links_opened_test");
    let bad = "";
    try { await invoke("open_link", { url: "file:///etc/passwd" }); } catch (err) { bad = String(err.message || err); }
    await invoke("log_line", { line: `links-test click plain=${JSON.stringify(plain)} cmd=${JSON.stringify(cmd)} file-url=${JSON.stringify(bad)}` });
    // #26 file paths (the test folder has src/a.ts and docs/x.md)
    await invoke("pty_write_test", { id: p.id, data: `clear; echo '편집: src/a.ts:12 그리고 없는/파일.ts:3 끝'; echo 'Update(docs/x.md) · https://ex.com/src/a.ts'; echo '버전 1.5 와 e.g. 그리고 ./src'\r` });
    await new Promise((r) => setTimeout(r, 1500));
    const fprov = fileLinks(t, p.id, active), files = [];
    for (let y = 1; y <= buf().length; y++) {
      const text = buf().getLine(y - 1)?.translateToString(true) || "";
      if (!text.trim() || text.includes("echo")) continue;
      await new Promise((r) => fprov.provideLinks(y, (ls) => { for (const l of ls || []) files.push({ y, text: l.text, s: `${l.range.start.x},${l.range.start.y}`, e: `${l.range.end.x},${l.range.end.y}` }); r(); }));
    }
    await invoke("log_line", { line: `links-test files=${JSON.stringify(files)}` });
    const ff = files[0], [fx, fy] = ff.s.split(",").map(Number);
    const px = screen.left + (fx + 1.5) * dim.width, py = screen.top + (fy - 1 - buf().viewportY + 0.5) * dim.height;
    await invoke("click_test", { x: px, y: py }); await new Promise((r) => setTimeout(r, 400));
    const fplain = await invoke("links_opened_test");
    await invoke("click_test", { x: px, y: py, modifiers: 4 }); await new Promise((r) => setTimeout(r, 400));
    const fcmd = await invoke("links_opened_test");
    await invoke("log_line", { line: `links-test file-click plain=${JSON.stringify(fplain)} cmd=${JSON.stringify(fcmd.map((x) => x.replace(/\/.*\/proj\//, "…/proj/")))}` });
    invoke("log_line", { line: "autotype done" });
  }, 4000);
  if (info.test.dexsearch_test) setTimeout(async () => {
    // #21: GO-style search terms, typing in the box (letters don't move the dex), Enter → first hit
    await openDex();
    const out = {};
    for (const q of ["전설", "환상", "전설,환상", "전설&!못만남", "p1", "불꽃", "물", "1-5", "new", "age0", "age1", "파트너", "불꽃,물", "잡음&!관동", "!잡음&관동", "못만남", "#37", "성도"]) {
      dexQuery = q; dexFilter(); out[q] = dexState.hits.length <= 3 ? dexState.hits.join("/") : dexState.hits.length;
    }
    dexQuery = ""; dexFilter();
    out.cleared = dexState.hits;
    const sel0 = dexState.sel;
    dexKey(new KeyboardEvent("keydown", { key: "/" }));
    out.focused = document.activeElement?.id;
    for (const [key, code, keyCode] of [["h", "KeyH", 72], ["p", "KeyP", 80], ["1", "Digit1", 49], ["5", "Digit5", 53]]) await invoke("key_test", { key, code, keyCode, text: key });
    await new Promise((r) => setTimeout(r, 200));
    out.typed = `${$("#dex-search").value}|sel-unchanged=${dexState.sel === sel0}|found=${$("#dex-found").textContent}`;
    await invoke("key_test", { key: "Backspace", code: "Backspace", keyCode: 8 });
    await invoke("ime_commit", { text: "" });
    $("#dex-search").value = "p15"; $("#dex-search").dispatchEvent(new Event("input", { bubbles: true }));
    await invoke("key_test", { key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
    await new Promise((r) => setTimeout(r, 200));
    out.enter = `sel=${dexState.sel} focus=${document.activeElement?.id || document.activeElement?.tagName} still-open=${dexOpen()}`;
    dexKey(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    out.right = dexState.sel;
    $("#dex-search").value = "불꽃,물"; $("#dex-search").dispatchEvent(new Event("input", { bubbles: true }));
    dexSelect(1); dexKey(new KeyboardEvent("keydown", { key: "ArrowRight" })); const r1 = dexState.sel;
    dexKey(new KeyboardEvent("keydown", { key: "ArrowRight" })); out.step = `${r1}>${dexState.sel}`;
    // #22: only the results, region counts, ↑↓ among shown cells, nothing found → empty + clear
    const vis = () => shownCells("#dex-grid .cells:not(.recent) .cell").map((c) => c.dataset.n).join(",");
    const heads = () => [...document.querySelectorAll("#dex-grid h4")].filter((h) => !h.hidden).map((h) => h.textContent.trim()).join("|");
    $("#dex-search").value = "불꽃,물"; $("#dex-search").dispatchEvent(new Event("input", { bubbles: true }));
    out.filter = `grid=${vis()} heads=${heads()} row=${shownCells("#dex-grid .cells.recent .cell").length} found=${$("#dex-found").textContent}`;
    await new Promise((r) => setTimeout(r, 600));
    await invoke("shot_test", { name: "dexsearch" });
    $("#dex-search").value = "p1"; $("#dex-search").dispatchEvent(new Event("input", { bubbles: true }));
    dexSelect(1);
    const nav = [];
    for (const k of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "ArrowUp", "ArrowRight", "ArrowDown", "End", "Home"]) {
      dexKey(new KeyboardEvent("keydown", { key: k }));
      nav.push(`${k}=${dexState.zone}:${dexState.zone === "recent" ? dexState.ri : "#" + dexState.sel}`);
    }
    out.nav = `grid=${vis()} row=${shownCells("#dex-grid .cells.recent .cell").map((c) => c.dataset.n).join(",")} ${nav.join(" ")}`;
    $("#dex-search").value = "불꽃&전설"; $("#dex-search").dispatchEvent(new Event("input", { bubbles: true }));
    out.empty = `shown=${!$("#dex-empty").hidden} text=${$("#dex-empty").textContent} heads=${heads()} preview=${$(".dex-preview").style.visibility}`;
    await new Promise((r) => setTimeout(r, 600));
    await invoke("shot_test", { name: "dexempty" });
    $("#dex-clear").click();
    $("#dex-search").value = "불꽃,물"; $("#dex-search").dispatchEvent(new Event("input", { bubbles: true }));
    const btns = () => [...document.querySelectorAll("#dex-regions button[data-a]")].map((b) => `${b.textContent.trim()}${b.disabled ? "(off)" : ""}`).join("|");
    out.regions = btns();
    dexSelect(1); document.querySelector('#dex-regions button[data-a="1"]').click(); out.regionClick = dexState.sel;
    document.querySelector('#dex-regions button[data-a="152"]').click(); out.disabledClick = dexState.sel;
    $("#dex-search").value = ""; $("#dex-search").dispatchEvent(new Event("input", { bubbles: true }));
    out.regionsCleared = btns();
    closeDex();
    await invoke("wild_dex_test", { id: 37 });
    await new Promise((r) => setTimeout(r, 800));
    out.overlayDex = `open=${dexOpen()} sel=${dexState?.sel}`;
    out.cleared2 = `preview=${$(".dex-preview").style.visibility || "shown"} hits=${dexState.hits} filtering=${$("#dex-grid").classList.contains("filtering")} box=${$("#dex-search").value} grid-shown=${vis().split(",").length}`;
    await invoke("log_line", { line: `dexsearch-test ${JSON.stringify(out)}` });
    invoke("log_line", { line: "autotype done" });
  }, 6000);
  if (info.test.cost_test) setTimeout(async () => {
    // #23: Claude typed in the shell (no cost of its own) → "≈$" from its log's tokens × prices
    const tab = active, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (chooseOpen()) closeChoose(false);
    await invoke("pty_write_test", { id: tab.panes.agent.id, data: `${info.test.fake_claude}\r` });
    for (let i = 0; i < 50 && !/≈\$/.test($("#usage").textContent); i++) await wait(300);
    await invoke("log_line", { line: `cost-test usage=${$("#usage").textContent} tip=${$("#usage [title]")?.title || ""} tokens=${JSON.stringify(tab.state?.usage?.tokens || null)}` });
    invoke("log_line", { line: "autotype done" });
  }, 3000);
  if (info.test.box_test) setTimeout(async () => {
    // #27 "내 포켓몬": cards, the five sorts, search, the take button, arrows, taking one
    const out = {}, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
    if (chooseOpen()) closeChoose(false);
    await openDex();
    await dexView("box");
    const ids = () => dexState.list.map((m) => m.id).join(",");
    out.title = $("#dex-title .pk-tabs").textContent.trim();
    out.cards = [...document.querySelectorAll("#box-grid .pk-card")].map((c) => c.textContent.replace(/\s+/g, " ").trim()).join(" | ");
    for (const [k] of BOX_SORTS) { $("#box-sort").value = k; $("#box-sort").dispatchEvent(new Event("input", { bubbles: true })); out[`sort-${k}`] = ids(); }
    $("#box-sort").value = "recent"; $("#box-sort").dispatchEvent(new Event("input", { bubbles: true }));
    for (const q of ["파트너", "age0", "new", "불꽃", "zzz"]) { $("#dex-search").value = q; $("#dex-search").dispatchEvent(new Event("input", { bubbles: true })); out[`q-${q}`] = ids() || $("#box-empty")?.textContent; }
    $("#box-clear")?.click();
    out.cleared = ids();
    const at = (id) => dexState.list.findIndex((m) => m.id === id);
    const btn = () => `${$("#dex-take").textContent}${$("#dex-take").disabled ? "(off)" : ""}`;
    boxSelect(at(134)); out.btnHere = btn();
    boxSelect(at(222)); out.btnOther = btn(); await boxTake(); out.btnOther2 = btn();
    boxSelect(at(418)); out.btnRest = btn(); out.meta = $("#dex-meta").textContent;
    const nav = [];
    boxSelect(0);
    for (const k of ["ArrowRight", "ArrowRight", "ArrowLeft", "End", "Home", "ArrowDown"]) { boxKey(k); nav.push(`${k}=${dexState.bi}`); }
    out.nav = nav.join(" ");
    dexKey(new KeyboardEvent("keydown", { key: "m" })); out.toggled = `${dexState.view} grid-hidden=${$("#dex-grid").hidden}`;
    dexKey(new KeyboardEvent("keydown", { key: "m" })); out.back = dexState.view;
    boxSelect(at(37));
    await wait(1700);
    await invoke("shot_test", { name: "box" });
    boxSelect(at(418)); await boxTake();
    await wait(1500);
    out.took = `partner=${active.partner?.id} dexOpen=${dexOpen()}`;
    } catch (e) { out.ERROR = String(e?.stack || e); }
    await invoke("log_line", { line: `box-test ${JSON.stringify(out)}` });
    invoke("log_line", { line: "autotype done" });
  }, 5000);
  if (info.test.choose_shot) setTimeout(async () => { // the partner dialog as it looks (UI checks)
    await invoke("shot_test", { name: "choose" });
    invoke("log_line", { line: `choose-shot open=${chooseOpen()} cards=${document.querySelectorAll("#box-grid .pk-card[data-i]").length}` });
    invoke("log_line", { line: "autotype done" });
  }, 6000);
  if (info.test.ui_scenes) uiScenes(info.test.ui_scenes);
  if (info.test.first_run) firstRunTest();
  // a folder dropped on the app to launch it (#31 follow-up): after the dust settles, what's on screen
  if (info.test.drop_check) setTimeout(async () => {
    await invoke("log_line", { line: `drop-check tabs=${tabs.map((t) => base(t.cwd)).join(",")} start=${startOpen()} choose=${chooseOpen()} agents=${agentsOpen()} active=${active ? base(active.cwd) : "-"}` });
    await invoke("shot_test", { name: "drop" });
    invoke("log_line", { line: "autotype done" });
  }, 7000);
  if (info.test.multi_test) multiTest();
  if (info.test.cd_test) cdTest();
  if (info.test.tour_test) tourTest();
  if (info.test.s3_test) s3Test();
  if (info.test.race_test) raceTest();
  if (info.test.pick_test) pickTest();
}

main();
