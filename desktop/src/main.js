// CVIM Desktop (v2, Electron) — UI. One tab = one workspace (folder): agent / Neovim / shell panes
// (xterm.js on PTYs owned by the main process) + partner Pokémon + activity. Agent state, usage and
// partner data arrive as events (electron/main.cjs ← cvim-core). X0 findings: docs/PLATFORM.md 3.3c–3.5.
import { invoke, listen } from "./host.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { createWild, josa } from "./wild.js";
import { timing, dur, MINUTE } from "./elapsed.js";
import { failLabel } from "./fail.js";
import { cardsHtml, sizePokes, applyShow, wildNoteHtml } from "./overlay-view.js";
import "./poke/poke.css";
import { lvLine } from "./poke/card.js";
import { TYPE_FX } from "./poke/types.js";

// diagnostics: surface JS errors in the footer (release builds have no devtools)
const showErr = (m) => { const h = document.getElementById("hint"); h.textContent = "오류: " + m; h.style.color = "#e5484d"; };
window.addEventListener("error", (e) => showErr(e.message));
window.addEventListener("unhandledrejection", (e) => showErr(String(e.reason?.message || e.reason)));

// the terminals' 16 colours per theme (APP-20, #60) — an agent's own screen colours are its own setting
const TERM_THEMES = {
  dark: {
    background: "#1b1b22", foreground: "#e6e6e6", cursor: "#e6e6e6", selectionBackground: "#3a3a4a",
    black: "#1b1b1f", red: "#e5484d", green: "#3ddc84", yellow: "#f5c542", blue: "#4f8df7",
    magenta: "#c678dd", cyan: "#56b6c2", white: "#d0d0d0", brightBlack: "#5c5c66",
  },
  light: { // darker hues on white: every colour stays readable as text
    background: "#ffffff", foreground: "#1d1d22", cursor: "#1d1d22", cursorAccent: "#ffffff", selectionBackground: "#c9ddfb",
    black: "#1d1d22", red: "#c4262e", green: "#17803d", yellow: "#8a6400", blue: "#2563d1",
    magenta: "#9a3cb5", cyan: "#0f7480", white: "#6a6a75", brightBlack: "#8a8a95",
    brightRed: "#d23b40", brightGreen: "#1e9a50", brightYellow: "#a87800", brightBlue: "#3b7ff0",
    brightMagenta: "#b05ad0", brightCyan: "#168f9c", brightWhite: "#3a3a44",
  },
};
// light: the least contrast of text on its background (dim text half of it) — an agent drawing its
// dark-theme colours (light grey) on white stays readable; xterm darkens just that text (#70)
const TERM_CONTRAST = { dark: 1, light: 4.5 };
// 테마: the main process sets macOS's appearance for the app (설정 "시스템 따라가기 / 다크 / 라이트"),
// so the page just follows prefers-color-scheme — and so does the overlay
const darkMedia = matchMedia("(prefers-color-scheme: dark)");
const themeNow = () => (darkMedia.matches ? "dark" : "light");
let THEME = TERM_THEMES[themeNow()];
function applyTheme() {
  const t = themeNow();
  document.documentElement.dataset.theme = t;
  THEME = TERM_THEMES[t];
  for (const p of panes.values()) { p.term.options.theme = THEME; p.term.options.minimumContrastRatio = TERM_CONTRAST[t]; }
}
darkMedia.addEventListener("change", applyTheme);
document.documentElement.dataset.theme = themeNow(); // before the first paint: no dark flash on a light Mac
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
const EVENT_ICON = { UserPromptSubmit: "💬", Notification: "❓", PermissionRequest: "❓", Stop: "✅", StopFailure: "💥", Interrupted: "⏹", PreCompact: "🗜", SessionStart: "🚀", SessionEnd: "🛑" };
const EVENT_LABEL = { PermissionRequest: "승인 요청" }; // #56: the one line that read "· PermissionRequest"
const TOOL_ICON = { coding: "✏️", reading: "📖", searching: "🔍", bash: "💻", agent: "🤝", tool: "🛠" };
const TOOL_STATE = { Edit: "coding", MultiEdit: "coding", Write: "coding", NotebookEdit: "coding", WebSearch: "searching",
  WebFetch: "searching", Read: "reading", Grep: "reading", Glob: "reading", LS: "reading", Bash: "bash", Task: "agent", Agent: "agent" };
const DETAIL_STATES = ["coding", "reading", "searching", "bash", "tool", "agent"];
// first type -> attack effect (same as the CVIM.app overlay / native avatar)

let info;
let lastPick = null; // the last text selected in a terminal { text, from: pane id, tab }
// terminal font size (⌘= ⌘- ⌘0), remembered on this machine
const FONT_DEFAULT = 14;
let fontSize = FONT_DEFAULT;
try { fontSize = Number(localStorage.getItem("cvim.fontSize")) || FONT_DEFAULT; } catch {}
const tabs = []; // ordered Tab objects
let prog = null, progHtml = ""; // 진행 chips (#88) — set before any tab is made
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

function toast(msg, ms = 1800) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
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
    fontSize, theme: THEME, minimumContrastRatio: TERM_CONTRAST[themeNow()], macOptionIsMeta: true, scrollback: 100000, allowProposedApi: true,
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
  // the title an agent gives its terminal (#99, TAB-20 rule 1): Claude Code names the conversation there
  // at once (its log's title line comes later) — memory only, shown as the shell's name
  term.onTitleChange((t) => {
    const v = termTitle(t);
    if (v === p.agentTitle) return;
    p.agentTitle = v;
    if (tab === active) requestAnimationFrame(() => renderRail(tab));
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
    tag.style.background = bare ? "var(--raised-hi)" : a.color; // the theme's grey (#60)
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
  if (tab === active) p.term.focus();
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
// fixed: the list to show instead of this Mac's (ui:shots — the same picture on any machine)
async function openAgents(fixed = null) {
  const { list } = fixed || await invoke("agents_status");
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
  if (tab === active) p.term.focus();
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
  $(".poke-prog", view).innerHTML = progHtml; // 🥚 ⭐ ✦ (#88)
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
// find highlights per theme (#60): on white, a pale yellow — the dark one's olive hid dark text
const TSEARCH_DECOS = {
  dark: { matchBackground: "#6b5a2a", matchOverviewRuler: "#c9a227", activeMatchBackground: "#e5a33a", activeMatchColorOverviewRuler: "#ff9e3d" },
  light: { matchBackground: "#fbe7a1", matchOverviewRuler: "#c9a227", activeMatchBackground: "#ffb84d", activeMatchColorOverviewRuler: "#e08a1a" },
};
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
  const opts = { decorations: TSEARCH_DECOS[themeNow()], incremental };
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
  refreshChanges(tab);
  bigPane(tab)?.term.focus();
  invoke("tab_active", { ws: tab.id }); // the Pokémon window's "this tab" follows (APP-22 rule 2)
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
  const tm = timing(urgentStateOf(t), { stallMs: info.stallMs }); // STA-20
  const many = t.sessions?.length > 1 ? `<span class="sess-count">×${t.sessions.length}</span>` : "";
  const waiting = st === "waiting";
  b.classList.toggle("active", t === active);
  b.classList.toggle("attention", waiting || st === "error");
  b.classList.toggle("working", WORKING.includes(st) && !tm.stall); // #61: a gradient runs round the tab while its agent works
  const doing = waiting ? "❗ 입력 필요" : tm.stall ? `변화 없음 ${tm.stall}` : st && st !== "idle" && st !== "sleep" ? DOING[st] : "";
  b.innerHTML = `<span class="num">${i < 9 ? i + 1 : ""}</span><span>${tm.stall ? "⏳" : ICON[st] || "·"}</span>`
    + `<span class="name">${esc(base(t.cwd))}</span>${many}<span class="doing">${esc(doing)}</span><span class="close" title="닫기 (⌘W)">✕</span>`;
  const when = tm.stall ? ` · ${tm.stall} 동안 새 이벤트 없음(멈췄을 수 있어요)` : tm.run ? ` · 작업 ${tm.run}` : tm.wait ? ` · 입력 기다린 지 ${tm.wait}` : "";
  b.title = `${t.cwd}${t.agent ? ` — ${t.agent.label}` : ""}${when}`;
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
// the state object (times too) of the session urgentOf picks
function urgentStateOf(t) {
  if (!(t.sessions?.length > 1)) return t.state;
  const own = t.sessions.map((x) => (x.id === t.sid ? t.state : x.state)).filter(Boolean);
  return own.sort((a, b) => URG(a.state) - URG(b.state))[0] || null;
}
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
// a shell's name (#99, TAB-20): the one the user gave it, else the title its agent gave the
// conversation (while 설정 "세션 제목" is on), else none (the rail shows 셸 N)
function sessTitle(tab, x) {
  if (x.name) return x.name;
  if (settingsNow?.titles === false) return null;
  // its own agent's state; an agent typed in that shell shows through the tab's state while it's in front
  const so = x.id === tab.sid && x.hostAgent ? tab.state : x.state;
  // then the title its agent gave the terminal — not a plain shell's (a prompt's folder)
  return so?.title || (x.host && !x.hostAgent ? null : x.pane?.agentTitle) || null;
}
// a terminal title worth showing: the spinner / ✳ in front dropped; an agent's bare name, a shell's, a
// path or user@host isn't a conversation's title
function termTitle(t) {
  const v = String(t || "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!v || /^(claude( code)?|codex|gemini( cli)?|opencode|aider|-?(zsh|bash|fish|sh))$/i.test(v) || /^[~/]|[\w.-]+@[\w.-]+:/.test(v)) return null;
  return v;
}
function renderRail(tab) {
  const rail = $(".rail", tab.view);
  const multi = tab.sessions?.length > 1;
  rail.hidden = !multi;
  tab.view.classList.toggle("multi", !!multi);
  if (!multi) {
    const t = tab.sessions?.[0] && sessTitle(tab, tab.sessions[0]);
    $(".agent-name", tab.view).innerHTML = titleHTML(paneTitle(tab, tab.agent), tab.hostAgent && curSession(tab)?.hostWhere) + (t ? ` <span class="sess-title">· ${esc(t)}</span>` : "");
    return;
  }
  if (rail.querySelector(".nm-edit")) return; // a name being typed: not redrawn under it
  rail.innerHTML = tab.sessions.map((x) => {
    const so = x.id === tab.sid ? tab.state : x.state, st = so?.state, tm = timing(so, { stallMs: info.stallMs });
    const dot = st === "waiting" || st === "error" ? "bad" : tm.stall ? "stall" : WORKING.includes(st) ? "work" : st === "done" ? "ok" : "idle";
    const no = sessNo(tab, x);
    const when = tm.stall ? ` · ⏳ 변화 없음 ${tm.stall}` : tm.run ? ` · ${tm.run}` : tm.wait ? ` · ${tm.wait}째` : tm.took ? ` · ${tm.took} 걸림` : "";
    const who = x.host && !x.hostAgent ? "셸" : x.agent?.label || "", t = sessTitle(tab, x);
    return `<button class="sess${x.id === tab.sid ? " cur" : ""}" data-sid="${esc(x.id)}" title="셸 ${no} (⌃⌘${no})${t ? ` · ${esc(t)}` : ""} — ${esc(who)} · ${esc(DOING[st] || "대기")}${esc(when)}">`
      + `<span class="ic">${esc(x.host && !x.hostAgent ? "🐚" : x.agent?.icon || "▸")}</span><span class="n">${no}</span><i class="dot ${dot}"></i>`
      // shown when the rail opens (#99): the name, then who · what · how long
      + `<span class="nm"><b>${esc(t || `셸 ${no}`)}</b><small>${esc(`${who} · ${DOING[st] || "대기"}${when}`)}</small></span>`
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
  items.push(["✏️", "이름 바꾸기", () => renameSession(tab, sess)]); // #99
  if (sess.id !== tab.id) items.push(["✕", "셸 닫기", () => closeSession(tab, sess.id)]);
  showMenu(items, e.clientX, e.clientY);
}, true);

// sessions survive a restore (their agents start fresh): main saves them; nothing to do here
function saveRail() {}

// the rail opens over the agent's screen while the pointer rests on it (#99, TAB-13 rule 4): 0.3 s in,
// 0.2 s out — over it, so the terminals keep their size (the agents don't redraw); not while dragging
let railT = null;
// closing: it shrinks back with the rows as they were (.closing), then the narrow rail again
const railOpen = (rail, on) => {
  clearTimeout(railT);
  railT = setTimeout(() => {
    if (on) { rail.classList.remove("closing"); rail.classList.add("open"); return; }
    if (rail.querySelector(".nm-edit") || !rail.classList.contains("open")) return;
    rail.classList.replace("open", "closing");
    railT = setTimeout(() => rail.classList.remove("closing"), 160);
  }, on ? 300 : 200);
};
$("#views").addEventListener("mouseover", (e) => {
  const rail = e.target.closest?.(".rail");
  if (!rail || rail.contains(e.relatedTarget) || e.buttons) return;
  railOpen(rail, true);
});
$("#views").addEventListener("mouseout", (e) => {
  const rail = e.target.closest?.(".rail");
  if (!rail || rail.contains(e.relatedTarget)) return;
  railOpen(rail, false);
});
// 이름 바꾸기 (#99, TAB-20): typed over the shell's row in the open rail — Enter keeps it, Esc leaves it,
// empty = the agent's title again
function renameSession(tab, sess) {
  const rail = $(".rail", tab.view), b = $(`.rail .sess[data-sid="${CSS.escape(sess.id)}"]`, tab.view);
  if (!rail || !b || rail.querySelector(".nm-edit")) return;
  clearTimeout(railT);
  rail.classList.add("open");
  const input = document.createElement("input");
  input.className = "nm-edit";
  input.maxLength = 40;
  input.value = sess.name || "";
  input.placeholder = sessTitle(tab, { ...sess, name: null }) || `셸 ${sessNo(tab, sess)}`;
  input.style.top = `${b.offsetTop}px`;
  rail.append(input);
  input.focus();
  let done = false;
  const finish = async (keep) => {
    if (done) return;
    done = true;
    input.remove();
    if (keep) sess.name = (await invoke("session_name", { session: sess.id, name: input.value }).catch(() => sess.name)) || undefined;
    renderRail(tab);
    if (!rail.matches(":hover")) railOpen(rail, false);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}


$("#views").addEventListener("click", (e) => {
  if (e.target.closest(".sess-add, .sess-new")) return newSession(active);
  const b = e.target.closest(".rail .sess");
  if (!b) return;
  if (e.target.closest(".x")) return closeSession(active, b.dataset.sid);
  // a double-click in the open rail: rename (#99) — by the click count, as the first click redraws the rail
  if (e.detail >= 2 && b.closest(".rail.open")) { const sess = active.sessions.find((x) => x.id === b.dataset.sid); if (sess) return renameSession(active, sess); }
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
  const detail = DETAIL_STATES.includes(st.state) ? ` ${short(st.detail).slice(0, 32)}` : st.state === "error" && failLabel(st.detail) ? ` · ${failLabel(st.detail)}` : ""; // #53 how it failed
  // unattended runs (STA-20): · 12분 working, · 4분째 waiting for you, 23분 걸림 when done, ⏳ no change
  const tm = timing(st, { stallMs: info.stallMs });
  const when = tm.run ? ` · ${tm.run}` : tm.wait ? ` · ${tm.wait}째` : tm.took ? ` · ${tm.took} 걸림` : "";
  doing.className = st.state === "waiting" || st.state === "error" ? "bad" : tm.stall ? "stall" : "dim";
  // narrow windows keep the icon only (the tab shows the state too) (#38)
  doing.innerHTML = st.state === "waiting" ? `❗<span class="doing-text"> ${esc(what + when)}</span>`
    : tm.stall ? `⏳<span class="doing-text"> 변화 없음 ${esc(tm.stall)} · 마지막 ${esc(what + detail)}${esc(when)}</span>`
    : `${ICON[st.state] || ""}<span class="doing-text"> ${esc(what + detail + when)}</span>`;
  doing.title = tm.stall ? `${tm.stall} 동안 새 이벤트가 없어요 — 멈췄을 수 있어요(추정). 마지막: ${what}${detail}${when}` : `${what}${detail}${when}`;
  document.title = `${tm.stall ? "⏳" : ICON[st.state] || ""} ${base(tab.cwd)} — Tamer`;
  const u = withLast(st, tab), parts = [];
  const old = (k) => (u.stale?.includes(k) ? ' title="지난번 값 — 첫 응답 뒤에 새로 고쳐져요" style="opacity:.55"' : "");
  // 5h · 7d: pressed = 한도 새로 고침 (#104 — the agents' limits read now, Claude's only if turned on)
  const lim = (k) => (u.stale?.includes(k) ? ' class="u-lim" title="지난번 값 — 눌러서 한도 새로 고침" style="opacity:.55"' : ' class="u-lim" title="눌러서 한도 새로 고침"');
  // gauges and the model name give way first on a narrow window: the numbers stay (#38)
  const gauge = (p) => `<span class="gauge">${bar(p)} </span>`;
  if (u?.model) parts.push(`<span class="dim u-model"${old("model")}>${esc(u.model)}</span>`);
  if (u?.ctx != null) parts.push(`<span class="${level(u.ctx)}"${u.ctxEst ? ' title="모델의 최대 입력 크기로 계산한 추정치"' : ""}>ctx ${gauge(u.ctx)}${u.ctxEst ? "≈" : ""}${Math.round(u.ctx)}%</span>`);
  else if (u?.ctx_tokens != null) parts.push(`<span class="dim">ctx ${Math.round(u.ctx_tokens / 1000)}k</span>`);
  if (u?.five_hour) parts.push(`<span${lim("five_hour")}><span class="${level(u.five_hour.pct)}">5h ${gauge(u.five_hour.pct)}${Math.round(u.five_hour.pct)}%${untilReset(u.five_hour.resets_at)}</span></span>`);
  if (u?.seven_day) parts.push(`<span${lim("seven_day")}><span class="${level(u.seven_day.pct)}">7d ${gauge(u.seven_day.pct)}${Math.round(u.seven_day.pct)}%</span></span>`);
  // a Claude typed in the shell without the opt-in line: no 5h · 7d (only its status line has them) (#45)
  const typedClaude = (st.shellKey || tab.hostAgent?.key) === "claude" && st.state !== "shell";
  // #49: always in view while such a Claude is the one shown — the 1.8-6 s toast is easy to miss
  const unlinked = st.shellKey === "claude" ? tab.shellUnlinked : tab.hostAgent?.key === "claude" ? curSession(tab)?.hostUnlinked : null;
  if (typedClaude && unlinked) parts.unshift(`<button class="u-link" title="${unlinked === "stale" ? "연결은 켜져 있지만 이 셸은 그 전에 열렸어요 — 새 셸(⌘⇧T)이나 새 탭에서 claude를 다시 실행하면 '입력 필요'·한도가 보여요" : "셸에서 직접 친 Claude는 '입력 필요'·한도를 알 수 없어요 — 눌러서 에이전트 연결 창에서 \'셸에서 친 Claude도 연결\'을 켜세요(새 셸부터)"}">🔗 ${unlinked === "stale" ? "새 셸에서 다시" : "연결 안 됨"}</button>`);
  if (typedClaude && !u?.five_hour && !u?.seven_day) parts.push('<span class="dim u-hint" title="셸에서 직접 친 Claude는 한도와 \'입력 필요\'를 알려 주지 않아요 — ⌘G → ⚙ 에이전트 연결 상태 → \'셸에서 친 Claude도 연결\'을 켜거나 ⌘G로 띄우면 보여요 (Pro·Max 구독, 첫 응답 뒤)">5h·7d ?</span>');
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
  const next = { model: u.model || l.model, five_hour: newerWin(l.five_hour, u.five_hour), seven_day: newerWin(l.seven_day, u.seven_day), windows };
  try { localStorage.setItem(lastKey(key), JSON.stringify(next)); } catch {}
  tellUsage(key, next);
  // another tab learned newer limits: the tab in view shows them now, not at its own next report (#96)
  if (JSON.stringify([l.five_hour, l.seven_day]) !== JSON.stringify([next.five_hour, next.seven_day]) && active?.state) {
    const st = active.state;
    if ((st.shellKey || st.agent?.key || active.agent?.key) === key) renderBar(active);
  }
}
// 메뉴바 (STA-19, #64): the menu bar shows the same remembered limits — the main process keeps them in memory
function tellUsage(key, l = lastUsage(key)) {
  if (l.five_hour || l.seven_day) invoke("usage_seen", { key, five_hour: l.five_hour || null, seven_day: l.seven_day || null, model: l.model || null }).catch(() => {});
}
for (const k of ["claude", "codex"]) tellUsage(k);
// 채팅 없이 한도 (STA-21, #104): read by the main process — merged like an agent's report (newer window wins)
listen("limits", (e) => rememberUsage(e.payload.key, { five_hour: e.payload.five_hour, seven_day: e.payload.seven_day }));
$("#usage").addEventListener("click", (e) => {
  if (!e.target.closest(".u-lim")) return;
  toast("한도를 새로 읽는 중…");
  invoke("limits_refresh", { user: true }).then((v) => {
    const err = v?.claude && v.state?.claude?.error;
    if (err) toast(err === "login" ? "Claude 로그인 정보를 찾지 못했어요 — Claude Code에 로그인해 주세요" : err === "denied" ? "키체인 확인 창에서 거부했어요 — 다시 누르면 다시 물어요('항상 허용'이면 다음부터 안 물어요)" : err === "asking" ? "키체인 확인 창이 열려 있어요 — 답하면 읽어요" : err === "expired" ? "Claude 로그인이 만료됐어요 — Claude Code를 한 번 쓰고 다시 눌러 주세요" : "Claude 한도를 읽지 못했어요 — 응답할 때 받은 값을 써요");
  }).catch(() => {});
});
const live = (w) => w && (w.resets_at == null || w.resets_at * 1000 > Date.now());
// 5h · 7d are the account's (STA-09 rule 5, #96): each tab's status line keeps sending what its own last reply
// said, so of two reports of a window the newer wins — a later reset is a newer window; the same window
// (resets within 2 min): the one received later (`at`, from the core — a limit reset lowers the use, #103),
// the higher use when neither says (remembered before #103); no reset time: the one just in (b)
function newerWin(a, b) {
  if (!live(a)) return live(b) ? b : null;
  if (!live(b)) return a;
  if (a.resets_at == null || b.resets_at == null) return b;
  if (Math.abs(a.resets_at - b.resets_at) >= 120) return b.resets_at > a.resets_at ? b : a;
  if (a.at != null || b.at != null) return (b.at ?? 0) >= (a.at ?? 0) ? b : a;
  return b.pct >= a.pct ? b : a;
}
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
  for (const k of ["five_hour", "seven_day"]) {
    if (!u[k] && live(l[k])) { u[k] = l[k]; if (!(l[k].at && Date.now() - l[k].at < 20 * MINUTE)) stale.push(k); } // not reported by this tab yet: the last value, dimmed — unless read just now (#104)
    else if (u[k]) u[k] = newerWin(l[k], u[k]); // another tab may know newer (#96)
  }
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
  const ms = (ev) => (ev.ts > 1e12 ? ev.ts : ev.ts * 1000);
  const log = st.log || [];
  $(".activity", tab.view).innerHTML = log.slice().reverse().map((ev, ri) => {
    const t = new Date(ms(ev)).toTimeString().slice(0, 8);
    const icon = ev.event === "PreToolUse" ? TOOL_ICON[TOOL_STATE[ev.tool] || "tool"] : EVENT_ICON[ev.event] || "·";
    const label = ev.event === "PreToolUse" ? ev.tool : EVENT_LABEL[ev.event] || ev.event;
    // how long the task took (STA-20): back to its prompt, when that's still in the list
    let took = "";
    if (["Stop", "Interrupted", "StopFailure"].includes(ev.event)) {
      const i = log.length - 1 - ri, p = log.slice(0, i).findLast((x) => x.event === "UserPromptSubmit");
      if (p && ms(ev) - ms(p) >= MINUTE) took = ` · ${dur(ms(ev) - ms(p))} 걸림`;
    }
    const detail = ev.event === "StopFailure" ? failLabel(ev.detail) || ev.detail || "" : short(ev.detail).slice(0, 60); // #53
    return `<li><span class="dim">${t}</span> ${icon} ${esc(label)} <span class="dim">${esc(detail)}${esc(took)}</span></li>`;
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
  eggShow(tab, pk?.egg ? pk : null);
  if (pk?.egg) { label.textContent = pk.name; return showProgress(tab, pk); } // 🥚 an egg in this folder (#84)
  if (!pk?.gif) { label.textContent = "(파트너를 불러오지 못했어요)"; return; }
  const img = $(".poke", tab.view);
  await loadImg(img, pk.gif);
  img.hidden = false;
  $(".pokeball", tab.view).hidden = true;
  label.textContent = `${pk.grad ? "🎓 " : ""}${pk.shiny ? "✨" : ""}${pk.name ?? ""}`;
  showProgress(tab, pk);
  gradBand(tab, pk.gradAsk ? pk : null);
}
// 🥚 the egg in the partner's place (#84, SCREENS_P3 S6): drawn here, no picture to fetch
function eggShow(tab, pk) {
  const stage = $(".pane-avatar .stage", tab.view);
  let el = $(".pk-egg", stage);
  if (!pk) { el?.remove(); return; }
  if (!el) { el = document.createElement("i"); stage.append(el); }
  el.className = `pk-egg big${pk.egg.kind === "egg2" ? " rare" : ""}`;
  $(".poke", tab.view).hidden = true;
  $(".pokeball", tab.view).hidden = true;
}
// 🎓 the graduation band (#84, SCREENS_P3 S8): stays until answered — 계속 함께 / 새 파트너 데려오기
function gradBand(tab, pk) {
  const box = $(".avatar-box", tab.view);
  let el = $(".pk-grad", box);
  if (!pk) { el?.remove(); return; }
  if (!el) { el = document.createElement("div"); el.className = "pk-grad"; box.prepend(el); }
  el.innerHTML = `<b>🎓 ${esc(josa(pk.name, "이", "가"))} 졸업했어요!</b><span>+${coinTxt(300)} · 🥚 알 +1</span><span class="pk-grad-do"><button data-grad="keep">계속 함께</button><button data-grad="new">새 파트너 데려오기</button></span>`;
}
$("#views").addEventListener("click", async (e) => {
  const g = e.target.closest("[data-grad]");
  if (g && active) {
    await invoke("partner_grad", { ws: active.id, keep: g.dataset.grad === "keep" }); gradBand(active, null); if (active.partner) active.partner.gradAsk = false;
    if (g.dataset.grad === "new") pokeOpen("choose"); // 새 파트너 데려오기: pressed, so 파트너 고르기 opens (PKM-11 rule 1)
  }
});
// 🐣 the egg hatches (#84, S8): it shakes, goes white, then the Pokémon
async function hatch(tab, sp, p) {
  const el = $(".pane-avatar .pk-egg", tab.view);
  if (el && !document.body.classList.contains("ui-test")) { el.classList.add("hatching"); await new Promise((r) => setTimeout(r, 1800)); el.classList.add("white"); await new Promise((r) => setTimeout(r, 500)); }
  await showPartner(tab, { ...sp, ...p, egg: null });
  burst(tab, "✨", 10);
  toast(`알에서 ${josa(sp.name, "이", "가")} 태어났다!${p.coins ? ` +${coinTxt(p.coins)} · 새 종` : ""}`);
}

// "+5₽" rising by the partner for 1.2 s (pk-float, #72) — never in UI scenes (same picture every run)
function coinFloat(tab, n) {
  const stage = $(".pane-avatar .stage", tab.view);
  if (!stage || document.body.classList.contains("ui-test")) return;
  const f = document.createElement("span");
  f.className = "pk-float";
  f.textContent = `+${n}`; // just the number, briefly (#75)
  stage.append(f);
  setTimeout(() => f.remove(), 1300);
}
function showProgress(tab, p) {
  if (p.pinned != null) tab.pinned = p.pinned;
  $(".poke-exp", tab.view).textContent = lvLine(p);
  incenseShow();
}
// every 10 levels: "Lv 30! 🪙 +₽20" over the partner for 2 s (#74, PKM-21 rule 7) — not in UI scenes
function mileBubble(tab, lv, coins) {
  const stage = $(".pane-avatar .stage", tab.view);
  if (!stage || document.body.classList.contains("ui-test")) return;
  const b = document.createElement("span");
  b.className = "pk-mile";
  b.textContent = `Lv ${lv}!${coins ? ` +${coinTxt(coins)}` : ""}`;
  stage.append(b);
  setTimeout(() => b.remove(), 2000);
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
  toast(`축하합니다! ${from?.name ?? ""}는 ${to.name}(으)로 진화했다!${to.coins ? ` +${coinTxt(to.coins)}${to.newCoins ? " · 새 종" : ""}` : ""}`); // #72, 표기 #75 · 새 종 #94
}

// 파트너 고르기 · 도감 · 내 포켓몬 … are the Pokémon window's (poke.html, src/poke/window.js — APP-22 rule 10, #113 P2):
// this window opens it (⌘P · ⌘D · the menu · the pane's button · its chips) and shows what it took (partner-taken)
const pokeOpen = (view, sel) => invoke("poke_open", { view, sel }).catch(() => {});

// a tab without a partner: the avatar pane says so — 파트너 고르기 opens only when asked (#113 A8, PKM-11 rule 1)
function needPartner(tab, freed) {
  tab.partner = null;
  tab.partnerChecked = true;
  showEmpty(tab, freed);
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
$("#views").addEventListener("click", (e) => { if (e.target.closest(".need-partner")) pokeOpen("choose"); });

// taken for a tab (here, or in the Pokémon window): its pane shows it, a cute reaction, the toast
async function partnerTaken(tab, from) {
  const shown = await invoke("partner_state", { ws: tab.id }).catch(() => null);
  if (!shown || shown.choose) return;
  await showPartner(tab, shown); react(tab, "cute");
  toast(`${josa(shown.name, "과", "와")} 함께해요!${from ? ` (${from}에서 데려옴)` : ""}`);
}
// a caught one → this tab's partner (the wild card's [이 탭의 파트너로]): a resting one of that species, else say where it is
async function takeSpecies(tab, id) {
  const o = await invoke("partner_options", { ws: tab.id });
  const rest = o.resting.findLast((m) => m.id === id); // the newest (e.g. just caught)
  const other = o.others.find((m) => m.id === id);
  if (rest) { const pk = await invoke("partner_take", { ws: tab.id, uid: rest.uid }).catch((e) => { toast(String(e.message || e).replace(/^.*Error: /, "")); return null; }); if (pk) await partnerTaken(tab, null); return; }
  if (other) { toast(`쉬는 ${other.name}가 없어요 — ${other.folderName} 폴더의 파트너예요 (도감에서 데려올 수 있어요)`); return; }
  toast("박스에 없는 포켓몬이에요 (만나기만 했어요)");
}

// ── right-click menu ────────────────────────────────────────────────────────
function openMenu(tab, x, y) {
  const items = [
    ["🔄", "파트너 바꾸기 (첫 파트너 · 박스)", () => pokeOpen("choose")], // the Pokémon window (#113 P2)
    ["⚔️", "공격", () => react(tab, "attack")],
    ["💕", "애교", () => react(tab, "cute")],
    ["📕", "도감", () => pokeOpen("dex")],
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
  dexButton: (e) => pokeOpen("dex", e.id), // #9 — the Pokémon window (#113 P2)
});

// ── 📝 changes panel (E1b): the folder's changed files (git), refreshed when a turn ends, the tab
// is selected, every 10 s while on screen, or ↻. A file → side-by-side diff, "revert this file". ──
const STATUS = { modified: ["M", "mod"], added: ["A", "add"], new: ["N", "add"], deleted: ["D", "del"], renamed: ["R", "mod"] };

async function refreshChanges(tab) {
  if (tab?.changesFrozen) return; // a UI scene's fixed list (ui:shots) — the real one mustn't replace it mid-picture
  if (!tab || tab.changesBusy) return;
  tab.changesBusy = true;
  try {
    const r = await invoke("changes_list", { ws: tab.id });
    tab.changes = r;
    renderChanges(tab);
  } catch {} finally { tab.changesBusy = false; }
}
setInterval(() => { if (active && document.hasFocus()) refreshChanges(active); }, 10000);

// ── 설정 (APP-19): the 설정 창 is a window of its own now (settings.html, APP-22 rule 9 #113 P1) — this window only
// follows the settings it uses: theme, the working-tab border, the right column, the session titles
let settingsNow = null;
function applySettings(s) {
  settingsNow = s;
  applyTheme();
  document.body.classList.toggle("no-tab-glow", !s.tabGlow);
  sideShow(s.side !== false);
  if (typeof renderRail === "function") for (const t of tabs) renderRail(t); // 세션 제목 on / off (#99)
}
listen("settings", (e) => applySettings(e.payload));
invoke("settings_get").then(applySettings).catch(() => {});

// ── the right column folded or shown (#97): ⌘\, the top bar's last button, 설정 · menu — kept in settings.json
// (the main process shows the overlay while it's folded)
function sideShow(on) {
  document.body.classList.toggle("side-closed", !on);
  const b = $("#side-toggle");
  b.textContent = on ? "▸" : "◂";
  b.title = on ? "오른쪽 칸 접기 (⌘\\) — 접으면 파트너는 바탕화면 오버레이로" : "오른쪽 칸 펴기 (⌘\\)";
}
function sideToggle(on = settingsNow ? settingsNow.side === false : false) {
  sideShow(on); // at once — ⌘⌥2·3 focus in it right after
  invoke("settings_set", { patch: { side: on } }).then(applySettings).catch(() => {});
}
const sideUnfold = () => { if (document.body.classList.contains("side-closed")) sideToggle(true); };
$("#side-toggle").addEventListener("click", () => sideToggle());
// ── the right column's width (#58): drag the border, double-click for 40% again; one width for every
// tab, kept in this Mac's page storage (a per-viewer convenience — the app works without it)
const SIDE_KEY = "tamer.side", SIDE_DEFAULT = 40;
function setSide(pct, keep = true) {
  const w = innerWidth, min = Math.max(20, (260 / w) * 100), max = Math.min(60, 100 - (360 / w) * 100);
  const v = Math.round(Math.min(max, Math.max(min, Number(pct) || SIDE_DEFAULT)) * 10) / 10;
  document.documentElement.style.setProperty("--side", `${v}%`);
  if (keep) { try { localStorage.setItem(SIDE_KEY, String(v)); } catch {} }
  return v;
}
try { const v = localStorage.getItem(SIDE_KEY); if (v) setSide(v, false); } catch {}
function sideSplit(e) {
  const grid = e.target.closest(".grid"), box = grid.getBoundingClientRect();
  document.body.classList.add("side-drag");
  let moved = false; // a plain press (no move) keeps the width
  const move = (ev) => { moved = true; setSide(((box.right - ev.clientX) / box.width) * 100, false); };
  const up = (ev) => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); document.body.classList.remove("side-drag"); if (moved) setSide(((box.right - ev.clientX) / box.width) * 100); };
  addEventListener("mousemove", move); addEventListener("mouseup", up);
  e.preventDefault();
}
// the second press of a double-click resets (a dblclick event doesn't come: the drag owns the presses)
$("#views").addEventListener("mousedown", (e) => {
  if (!e.target.classList?.contains("side-split") || e.button !== 0) return;
  if (e.detail >= 2) { e.preventDefault(); setSide(SIDE_DEFAULT); return; }
  sideSplit(e);
});
// git's state changed in that folder (branch, commit, staging, fetch — #52): read again now
listen("changes-dirty", (e) => { const t = byId.get(e.payload.ws); if (t) refreshChanges(t); });

function renderChanges(tab) {
  const ul = $(".changes", tab.view), r = tab.changes;
  // a redraw (every 10 s) must not take the keyboard away from the list
  const had = document.activeElement?.closest?.(".changes li[data-i]") && ul.contains(document.activeElement)
    ? document.activeElement.title : null;
  $(".changes-count", tab.view).textContent = r?.repo && r.items.length ? `(${r.items.length})` : "";
  // the branch the list is measured against (TRM-18): ⎇ main ↑2 — git's own idea of the remote (no fetch)
  const b = r?.repo ? r.branch : null, bEl = $(".changes-branch", tab.view);
  // a long name shrinks to … — the ↑↓ counts stay
  bEl.innerHTML = b?.name ? `<span class="bn">⎇ ${esc(b.name)}${b.unborn ? " (첫 커밋 전)" : ""}</span>${b.ahead || b.behind ? `<span class="ab">${[b.ahead && `↑${b.ahead}`, b.behind && `↓${b.behind}`].filter(Boolean).join(" ")}</span>` : ""}` : "";
  bEl.title = !b?.name ? "" : b.detached ? `브랜치가 아닌 커밋 ${b.name}` : b.unborn ? `${b.name} — 아직 커밋이 없어요`
    : b.upstream ? `${b.name} → ${b.upstream}${b.gone ? " (원격 브랜치 없어짐)" : ""} · 올릴 커밋 ${b.ahead} · 받을 커밋 ${b.behind} (마지막으로 받아 온 원격 기준)` : `${b.name} — 원격 브랜치와 연결 안 됨`;
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

// 🪙 포켓코인 (#72, PKM-18): the balance as the main process last told (economy_state / "economy") — the partner
// pane's "+5₽" and 🪔 line, the toasts; the 🛒 상점 · 👜 가방 are the Pokémon window's (src/poke/window.js, #113 P2)
let coins = null;
const won = (n) => Number(n || 0).toLocaleString("en-US");
const coinTxt = (n) => `${won(n)}코인`; // the coin amount in words — the 🪙 picture is only on the chip (#75)
// 🪔 향 burning: a line under each tab's partner, minutes left (#79)
const incenseLeft = () => (coins?.incenseUntil > Date.now() ? Math.ceil((coins.incenseUntil - Date.now()) / 60000) : 0);
// ── 진행 (#88, PKM-30, SCREENS_P3 S12): 🥚 ⭐ ✦ chips (pk-chip-prog) under every partner pane's level line — the
// app's progress, so a folder without a partner shows them too. "곧" = one more to go. A click opens that screen ──
const progChip = (k, icon, n, m, soon, title) => `<button class="pk-chip-prog${soon ? " soon" : ""}" data-prog="${k}" title="${esc(title)}">${icon}<span class="w">${soon ? " 곧" : ""}</span> ${n}<span class="w">/${m}</span></button>`;
function progShow(v) {
  prog = v || null;
  progHtml = !prog ? "" : [
    prog.inc && progChip("inc", "🥚", prog.inc.have, prog.inc.need, prog.inc.soon, `부화기 — ${prog.inc.name} · 작업 ${prog.inc.need - prog.inc.have}번 남음${prog.inc.waiting ? ` · 대기 ${prog.inc.waiting}` : ""} · 누르면 가방`),
    prog.stamps && progChip("stamps", "⭐", prog.stamps.n, prog.stamps.need, prog.stamps.soon, `연구 스탬프 — 작업을 끝낸 날마다 하나, ${prog.stamps.need}개면 대발견 · 누르면 홈`),
    prog.research && progChip("research", "✦", prog.research.done, prog.research.of, prog.research.soon, `리서치 — ${prog.research.title || ""} · 누르면 홈`),
  ].filter(Boolean).join("");
  for (const el of document.querySelectorAll(".pane-avatar .poke-prog")) el.innerHTML = progHtml;
}
listen("progress", (e) => progShow(e.payload));
invoke("progress_state").then(progShow).catch(() => {});
$("#views").addEventListener("click", (e) => { const c = e.target.closest(".pk-chip-prog"); if (c) invoke("poke_open", { view: c.dataset.prog === "inc" ? "bag" : "home" }); }); // the Pokémon window (#113 P2)

function incenseShow() {
  const n = incenseLeft();
  for (const el of document.querySelectorAll(".pane-avatar .poke-incense")) { el.hidden = !n; el.textContent = n ? `🪔 향 ${n}분 · 야생 ×2` : ""; }
}
setInterval(incenseShow, 30000);
invoke("economy_state").then((c) => { if (c) { coins = c; incenseShow(); } }).catch(() => {});
$("#usage").addEventListener("click", (e) => { if (e.target.closest(".u-link")) openAgents(); }); // #49

// ── start screen ────────────────────────────────────────────────────────────
let startItems = [];
let startSel = 0;
let recentCount = 0;

let startShownOnce = false;
// fixed: the recent list to show instead of this Mac's (ui:shots)
async function showStart(required, fixed = null) {
  const recent = fixed || await invoke("recent_dirs");
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
  if (e.altKey && e.code === "Digit2") return hit(() => { sideUnfold(); $(".changes li[data-i]", active?.view)?.focus(); }); // folded (#97): unfold first
  if (e.altKey && e.code === "Digit3") return hit(() => { sideUnfold(); active?.panes.shell.term.focus(); });
  if (e.altKey && e.code === "Enter") return hit(() => { if (active) { active.autoSwapped = false; swapPanes(active, !active.swapped); } });
  if (e.code === "KeyP" && !e.shiftKey && !e.altKey) return hit(() => pokeOpen("home")); // 🏠 홈 (#44) — the Pokémon window (#113 P2)
  if (e.code === "KeyG" || (e.code === "KeyA" && e.shiftKey)) return hit(() => switchAgent());
  if (e.code === "KeyT" && e.shiftKey) return hit(() => newSession(active)); // S2: a new session is a shell
  if (e.code === "KeyT") return hit(() => showStart(false));
  // ⌃⌘1~9: this tab's sessions (⌘1~9 = tabs; ⇧⌘3/4/5 are macOS screenshots, ⌘⌥arrows window tools)
  const sm = e.ctrlKey && e.code.match(/^Digit([1-9])$/);
  if (sm) return hit(() => { const t = active; const x = t?.sessions[Number(sm[1]) - 1]; if (x) switchSession(t, x.id); });
  if (e.code === "KeyD") return hit(() => pokeOpen("dex"));
  if (e.code === "KeyO") return hit(() => startAction("choose"));
  if (e.code === "KeyE") return hit(() => composerToggle());
  if (e.code === "KeyR") return hit(() => relayout());
  if (e.code === "Equal") return hit(() => setFont(fontSize + 1));
  if (e.code === "Minus") return hit(() => setFont(fontSize - 1));
  if (e.code === "Digit0") return hit(() => setFont(FONT_DEFAULT));
  if (e.code === "KeyB") return hit(() => { if (!wild.throwBall()) toast("🌿 지금은 야생 포켓몬이 없어요"); });
  if (e.code === "Backslash") return hit(() => sideToggle()); // 오른쪽 칸 (#97)
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
        const took = timing(e.payload).took; // STA-20
        const why = e.payload.state === "error" ? failLabel(e.payload.detail) : null; // #53
        if (t === active) toast(`셸 ${sessNo(t, sess)}: ${e.payload.state === "done" ? `🎉 완료${took ? ` · ${took} 걸림` : ""}` : e.payload.state === "waiting" ? "❗ 입력 필요" : `💥 실패${why ? ` · ${why}` : ""}`}`);
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
// taken in the Pokémon window (#113 P2): this window's pane shows it and reacts — it isn't brought forward (APP-22 rule 8)
listen("partner-taken", (e) => { const t = byId.get(e.payload.ws); if (t) partnerTaken(t, e.payload.from); });
listen("partner-progress", (e) => {
  const t = byId.get(e.payload.ws);
  if (!t) return;
  const { lv, final, next, xp, pinned } = e.payload;
  if (e.payload.hatched) return hatch(t, e.payload.hatched, e.payload); // 🐣 (#84)
  if (e.payload.egg) return showProgress(t, e.payload);
  if (e.payload.graduated) { toast(`🎓 졸업! +${coinTxt(e.payload.gradCoins || 300)} · 🥚 알 +1`); if (t.partner) { t.partner.grad = Date.now(); t.partner.gradAsk = true; gradBand(t, t.partner); $(".poke-label", t.view).textContent = `🎓 ${t.partner.shiny ? "✨" : ""}${t.partner.name}`; } }
  if (e.payload.mile) mileBubble(t, e.payload.mile, e.payload.mileCoins); // #74
  if (e.payload.evolved) evolve(t, e.payload.from, { ...e.payload.evolved, xp, lv, final, next, pinned, coins: e.payload.coins, newCoins: e.payload.newCoins });
  else showProgress(t, e.payload);
});
// 🪙 포켓코인 changed (#72): the chip and Home follow; a finish shows "+5₽" by that tab's partner
listen("economy", (e) => {
  const { ws, gained, ...c } = e.payload;
  coins = c;
  incenseShow();
  if (ws && gained) { const t = byId.get(ws); if (t) coinFloat(t, gained); }
});
// 🐣 the incubator hatched an egg (#85): it's in the box now (the Pokémon window hears it too)
listen("hatched", (e) => {
  const h = e.payload;
  toast(`🐣 부화기에서 ${h.shiny ? "✨" : ""}${josa(h.name, "이", "가")} 태어났다! — 내 포켓몬에서 파트너로 데려올 수 있어요${h.coins ? ` · +${coinTxt(h.coins)} 새 종` : ""}`, 5000);
});
listen("open-folder", (e) => openFolder(e.payload.cwd));
listen("toast", (e) => toast(e.payload.text, e.payload.ms || 1800)); // from the main process (a shell environment that couldn't be read …)
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
  sess.hostUnlinked = a ? e.payload.unlinked || null : null; // #49: read from its log — no "입력 필요"
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
listen("claude-link", (e) => { // #49: the link changed while this Claude runs — its chip follows
  const t = byId.get(e.payload.ws);
  if (!t) return;
  if (e.payload.shell) t.shellUnlinked = e.payload.unlinked || null;
  else { const s = t.sessions?.find((x) => x.id === e.payload.session); if (s) s.hostUnlinked = e.payload.unlinked || null; }
  if (t === active && t.state) renderBar(t);
});
listen("shell-agent", (e) => { const t = byId.get(e.payload.ws); if (t) { t.shellUnlinked = e.payload.agent ? e.payload.unlinked || null : null; onShellAgent(t, e.payload.agent, e.payload.where); } });
// in another app the desktop overlay shows the wild card; the window's own copy would be a second one
window.addEventListener("blur", () => document.body.classList.add("away"));
window.addEventListener("focus", () => document.body.classList.remove("away"));
listen("wild", (e) => wild.show(e.payload));
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
  // the Pokédex: the Pokémon window (#113 P2)
  let st = await pokeReady("dex");
  await log(`dex open=${!!st} pos=${st?.pos}`);
  await pokeCall("key", "ArrowUp"); st = await pokeCall("state");
  await log(`dex wrap-up pos=${st?.pos}`);
  await invoke("shot_test", { name: "dex", target: "poke" });
  await pokeShut();
  const pick = (await invoke("dex_list")).entries[0];
  await takeSpecies(tab, pick.id); await wait(500);
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
  $(".wild-dex").click(); // the Pokémon window on it (#113 P2)
  await wait(2000);
  const newCells = () => pokeCall("count", "#dex-grid .cell.new");
  const dd = await pokeCall("d");
  await log(`dex-open open=${!!dd} sel=${dd?.sel} want=${caughtId} recent=${dd?.recent} new-cells=${await newCells()}`);
  await invoke("shot_test", { name: "dex-new", target: "poke" });
  await wait(2000);
  const box = await invoke("dex_list");
  await log(`dex-viewed new-cells=${await newCells()} fresh-left=${box.entries.filter((e) => e.fresh).length} recent-new=${box.recent.filter((m) => m.new).length}`);
  await pokeShut();
  await takeSpecies(tab, caughtId);
  await wait(1500);
  await log(`adopt partner=${tab.partner?.name} want=${caughtName} xp=${tab.partner?.xp}`);
  await encounter("appear-2");
  await throwAs("fled", "fled");
  d = await invoke("dex_list");
  const seen = d.entries.find((e) => !e.caught);
  if (seen) {
    await pokeReady("dex");
    await pokeCall("select", seen.id);
    const before = tab.partner?.id;
    await pokeCall("choose");
    await log(`dex-choose-seen ${seen.name} partner-unchanged=${tab.partner?.id === before} toast=${await pokeCall("text", "#toast")}`);
    await pokeShut();
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
// The Pokémon window (#113 P2) is a window of its own: while it's open, keys · clicks (a selector this page hasn't) ·
// typed text · pictures go there — as macOS gives them to the window in front — and its state joins this one's
// (poke · choose · cards · preview …, from its page's window.lab); { target: "main" } keeps a step here
const pokeCall = (fn, ...args) => invoke("own_call_test", { name: "poke", fn, args }).catch(() => null);
const pokeUp = () => invoke("own_up_test", { name: "poke" }).catch(() => false);
// opened as ⌘P · ⌘D · the menu would, and drawn: its state (null if it didn't come)
async function pokeReady(view, sel) {
  await invoke("poke_open", { view, sel });
  for (let i = 0; i < 80; i++) { const st = await pokeCall("state"); if (st?.poke && (!view || st.poke === view || view === "choose")) return st; await new Promise((r) => setTimeout(r, 100)); }
  return null;
}
const pokeShut = () => invoke("own_close_test", { name: "poke" });
async function labStateAll() {
  const m = labState(), p = await pokeCall("state");
  return p ? { ...m, ...p, toast: p.toast || m.toast, top: m.top === "main" ? "poke" : m.top } : { ...m, poke: null, choose: false, cards: 0, starters: null };
}
function labState() {
  const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  const top = el?.closest("#menu") ? "menu" : el?.closest("#agents") ? "agents" : el?.closest("#diffview") ? "diff"
    : el?.closest("#start") ? "start" : "main";
  return {
    tabs: tabs.map((t) => base(t.cwd)), active: active ? base(active.cwd) : null, start: startOpen(),
    agents: agentsOpen(), menu: !$("#menu").hidden, diff: diffOpen(), top,
    partner: active?.partner?.name || null, choosePending: !!active && !active.partner?.uid, wild: wild.active(),
    partnerKnown: !!active && (!!active.partner || !!active.partnerChecked), // the tab's partner read (or none): #113 A8 — no dialog to wait for
    needPartner: active ? !!$(".need-partner", active.view) : null,
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
    usageLast: (() => { const l = lastUsage("claude"); return l.five_hour ? `${l.five_hour.pct}/${l.seven_day?.pct}` : null; })(), // #96
    usageRaw: (() => { const u = active && shownOf(active)?.usage; return u ? Object.keys(u).filter((k) => u[k] != null).join(",") : null; })(),
    sid: active?.sid ?? null,
    astate: active?.state?.state || null,
    branch: active ? { text: $(".changes-branch", active.view)?.textContent || "", title: $(".changes-branch", active.view)?.title || "" } : null, // TRM-18
    doing: $("#doing")?.textContent || "", // the top bar's state sentence (STA-20 times)
    tabTitle: active ? $(`#tabs .tab[data-ws="${active.id}"]`)?.title || "" : null,
    noTabGlow: document.body.classList.contains("no-tab-glow"), // #59 설정
    theme: document.documentElement.dataset.theme || null, termBg: active ? bigPane(active)?.term.options.theme?.background || null : null, // #60
    bodyBg: getComputedStyle(document.body).backgroundColor,
    // #70: the colour the big pane really drew a lab word in (LABFAINT · LABDIM)
    drawn: active ? Object.fromEntries(["LABFAINT", "LABDIM"].map((w) => { const el = [...$(".xterm-rows", bigPane(active)?.term.element || document)?.querySelectorAll("span") || []].find((x) => x.textContent === w); return [w, el ? getComputedStyle(el).color : null]; })) : null,
    side: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--side")) || null, // #58 the right column's % (null = default)
    sideW: active ? Math.round($(".side", active.view)?.getBoundingClientRect().width || 0) : null,
    sideBtn: $("#side-toggle")?.textContent || null, width: innerWidth, // #97
    rail: active ? [...$(".rail", active.view).querySelectorAll(".sess .nm b")].map((b) => b.textContent) : null, // #99
    railOpen: active ? $(".rail", active.view).classList.contains("open") : null,
    agentTitle: active ? $(".agent-name", active.view)?.textContent || null : null,
    focusPane: document.activeElement?.closest?.(".pane-shell") ? "shell" : document.activeElement?.closest?.(".pane-agent") ? "agent" : null,
    paneW: active ? Math.round($(".pane-agent", active.view)?.getBoundingClientRect().width || 0) : null,
    tabWorking: active ? !!$(`#tabs .tab[data-ws="${active.id}"]`)?.classList.contains("working") : null, // #61
    recent: startOpen() ? [...document.querySelectorAll("#recent li:not(.dim) span:nth-child(2)")].map((x) => x.textContent) : null,
    startSel: startOpen() ? startSel : null,
    menuItems: $("#menu").hidden ? null : [...$("#menu").querySelectorAll("button")].map((b) => b.textContent),
    activity: active ? [...$(".activity", active.view)?.querySelectorAll("li") || []].map((li) => li.textContent.replace(/^\S+ /, "")) : null, // without the time
    sessId: active ? curSession(active)?.id ?? null : null,
    fx: active ? [...$(".fx", active.view).children].map((x) => x.textContent) : null, // the partner's reaction glyphs (PKM-03)
    pokeExp: active ? $(".poke-exp", active.view)?.textContent || null : null,
    pokeLabel: active ? $(".poke-label", active.view)?.textContent?.trim() || null : null, // #84
    gradBand: active ? $(".pk-grad", active.view)?.textContent || null : null,
    eggShown: active ? !!$(".pane-avatar .pk-egg", active.view) : null,
    // 진행 (#88): the partner pane's chips (the bag's incubator section: the Pokémon window's state)
    prog: active ? [...$(".poke-prog", active.view)?.querySelectorAll(".pk-chip-prog") || []].map((c) => `${c.textContent}${c.classList.contains("soon") ? "!" : ""}`) : null,
    progShort: active ? [...$(".poke-prog", active.view)?.querySelectorAll(".pk-chip-prog") || []].map((c) => c.innerText) : null,
    wildBadge: $("#wild .wild-badge:not([hidden])")?.textContent || null,
    agent: active ? (() => { const s = curSession(active); return s?.hostAgent?.key || (s?.running ? s?.agent?.key || s?.agent?.label : null) || null; })() : null, // the agent state the top bar shows (waiting = 입력 필요)
    tsearch: $("#tsearch").hidden ? null : { q: $("#tsearch-q").value, n: $("#tsearch-n").textContent, pane: tsearchPane?.kind || null, alt: !$("#tsearch-alt").hidden },
    // the top bar and the hint line stay one line, nothing pushed out (#38)
    barFits: (() => { const b = $("#bar"); return b.scrollWidth <= b.clientWidth + 1 && [...b.children].every((c) => c.hidden || c.offsetHeight <= b.clientHeight); })(),
    hintFits: (() => { const h = $("#hint"); return h.scrollHeight <= h.clientHeight + 1; })(),
    wildBig: !!$("#wild .wild-card.legend:not([hidden])"), wildText: $("#wild .wild-text")?.textContent || null,
    pokeIncense: active && !$(".poke-incense", active.view)?.hidden ? $(".poke-incense", active.view)?.textContent || null : null,
    wildBalls: [...document.querySelectorAll("#wild .wild-balls .bc")].map((b) => `${b.textContent}${b.classList.contains("on") ? "*" : ""}`),
    wildBtn: $("#wild .wild-throw")?.textContent || null,
  };
}
// tests: the top bar as with an agent waiting, every usage item shown (ui:shots, lab)
function fakeUsage(tab) {
  tab.state = { state: "waiting", detail: "", agent: { key: "claude", short: "Claude" }, state_at: Date.now() - 4 * 60000 - 5000, // waiting 4 min (STA-20)
    usage: { model: "Opus 5.5", ctx: 42, five_hour: { pct: 12, resets_at: Math.floor(Date.now() / 1000) + 7230 }, seven_day: { pct: 2 }, cost: 1.23 } };
  renderBar(tab); renderTab(tab); // the tab too: else the 15 s redraw (STA-20) decides when it changes
}
const LAB_CALLS = { railOver: () => $(".rail", active?.view)?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })), railOut: () => $(".rail", active?.view)?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })), openSettings: () => invoke("own_open_test", { name: "settings" }), settingsOverlay: () => invoke("own_open_test", { name: "settings", page: "overlay" }), settingsGeneral: () => invoke("own_open_test", { name: "settings", page: "general" }), fakeUsage: () => fakeUsage(active), focusShell: () => bigPane(active)?.term.focus(),
  // the Pokémon window (#113 P2): opened on a view and drawn · closed · a view · Esc in it
  home: () => pokeReady("home"), openDex: () => pokeReady("dex"), closeDex: () => pokeShut(), openChoose: () => pokeReady("choose"), box: () => pokeCall("view", "box"), escape: () => invoke("own_key_test", { name: "poke", key: "Escape" }) };
async function labRun(steps) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (line) => invoke("log_line", { line });
  // the native confirm() would block the run: it answers what the case set ({ confirm: true | false }), and says so
  let answer = true;
  window.confirm = (msg) => { log(`lab-confirm ${answer} ${msg}`); return answer; };
  const get = async (path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), await labStateAll());
  const front = async (s) => s.target || (s.target !== "main" && (await pokeUp()) ? "poke" : undefined); // the window in front
  try {
    for (const s of steps) {
      if (s.wait != null) await wait(s.wait);
      else if (s.until) { // match: the value must also contain this text (a toast after another one)
        const hit = async () => { const v = await get(s.until); return s.match ? String(v ?? "").includes(s.match) : !!v; };
        const end = performance.now() + (s.timeout || 15000); while (!(await hit()) && performance.now() < end) await wait(100); if (!(await hit())) await log(`lab-timeout ${s.until}${s.match ? ` ~ ${s.match}` : ""}`);
      }
      else if (s.key) {
        const k = s.key, code = s.code || ({ "[": "BracketLeft", "]": "BracketRight" }[k]) || (/^[0-9]$/.test(k) ? `Digit${k}` : k.length === 1 ? `Key${k.toUpperCase()}` : k);
        const keyCode = { Escape: 27, Enter: 13, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Tab: 9, Backspace: 8 }[k] || k.toUpperCase().charCodeAt(0);
        await invoke("key_test", { key: k, code, keyCode, modifiers: s.mods || 0, ...(s.commands ? { commands: s.commands } : {}), ...(k.length === 1 && !s.mods ? { text: k } : {}), target: await front(s) });
      } else if (s.click) {
        const el = s.target === "poke" ? null : document.querySelector(s.click);
        const at = el ? (() => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })() : s.target !== "main" && (await pokeUp()) ? await pokeCall("rect", s.click) : null;
        if (!at) { await log(`lab-missing ${s.click}`); continue; }
        await invoke("click_test", { ...at, ...(s.button ? { button: s.button } : {}), ...(s.count ? { count: s.count } : {}), ...(el ? {} : { target: "poke" }) });
      } else if (s.dragSplit != null) { // drag the right column's border to this fraction of the window's width (#58)
        const el = $("main.grid:not([hidden]) .side-split"), r = el.getBoundingClientRect(), g = el.closest(".grid").getBoundingClientRect(), y = r.top + 200;
        await invoke("drag_test", { x1: r.left + r.width / 2, y1: y, x2: g.left + g.width * s.dragSplit, y2: y });
      } else if (s.drop) { // Finder paths dropped on an element: { drop: "css", files: ["/abs", …] } ("$dir/x" = the case's sandbox)
        const el = document.querySelector(s.drop);
        if (!el) { await log(`lab-missing ${s.drop}`); continue; }
        const r = el.getBoundingClientRect();
        await invoke("drop_test", { x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2, files: s.files });
      } else if (s.select != null || s.clickText != null) { // the last on-screen run of this text in the big pane:
        // select = drag the mouse over it (TRM-04) · clickText = click its middle, mods 4 = ⌘ (TRM-08)
        const want = s.select ?? s.clickText;
        const t = bigPane(active).term, b = t.buffer.active, scr = t.element.querySelector(".xterm-screen").getBoundingClientRect();
        let at = null;
        for (let y = b.viewportY; y < b.viewportY + t.rows; y++) { const x = (b.getLine(y)?.translateToString(true) || "").indexOf(want); if (x >= 0 && (!at || s.clickText != null)) at = { x, y: y - b.viewportY }; }
        if (!at) { await log(`lab-missing text ${want}`); continue; }
        const cw = scr.width / t.cols, ch = scr.height / t.rows, cy = scr.top + (at.y + 0.5) * ch;
        if (s.select != null) await invoke("drag_test", { x1: scr.left + (at.x + 0.2) * cw, y1: cy, x2: scr.left + (at.x + want.length - 0.2) * cw, y2: cy });
        else { await invoke("click_test", { x: scr.left + (at.x + want.length / 2) * cw, y: cy, modifiers: s.mods || 0 }); await wait(400); }
      } else if (s.probe) await log(`lab-probe ${s.probe} +${Math.round(performance.now())}ms ${JSON.stringify(await labStateAll())}`); // ms since the page began
      else if (s.shot) await invoke("shot_test", { name: s.shot, target: await front(s) }); // target: a window of its own (APP-22)
      else if (s.ime != null) await invoke("ime_compose", { text: s.ime, target: await front(s) }); // Hangul being composed
      else if (s.text != null) await invoke("ime_commit", { text: s.text, target: await front(s) }); // text committed (typed / IME done)
      else if (s.invoke) { // a command (test commands too); "$ws" = the current tab; log: its answer into the log
        const r = await invoke(s.invoke, JSON.parse(JSON.stringify(s.args || {}).replaceAll('"$ws"', JSON.stringify(active?.id || ""))));
        if (s.log) await log(`lab-invoke ${s.invoke} ${JSON.stringify(r)}`);
      }
      else if (s.grep) { // the lines of the big pane's whole buffer (scrollback included) that contain it
        const t = bigPane(active).term, b = t.buffer.active, rows = [];
        for (let y = 0; y < b.length; y++) { const l = b.getLine(y)?.translateToString(true) || ""; if (l.includes(s.grep)) rows.push(y); }
        await log(`lab-grep ${s.grep} rows=${JSON.stringify(rows)} length=${b.length} baseY=${b.baseY} type=${b.type}${rows.length ? ` text=${JSON.stringify((b.getLine(rows[0])?.translateToString(true) || "").slice(0, 160))}` : ""}`);
      } else if (s.resize) { await invoke("win_resize_test", { w: s.resize[0], h: s.resize[1] }); await wait(400); }
      else if (s.confirm != null) answer = !!s.confirm;
      else if (s.call && LAB_CALLS[s.call]) await LAB_CALLS[s.call]();
    }
  } catch (e) { await log(`lab-error ${e?.stack || e}`); }
  await log("lab-done");
}

// A first launch as a new user has it: nothing on this Mac yet (the starters come from PokéAPI), the
// agents dialog first — 파트너 고르기 no longer opens by itself (#113 A8): the pane's [파트너 고르기] opens the
// Pokémon window, where the first partner is picked with real keys and clicks
async function firstRunTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (line) => invoke("log_line", { line: `first-run ${line}` });
  const key = (k, code, keyCode, text, target) => invoke("key_test", { key: k, code, keyCode, ...(text ? { text } : {}), ...(target ? { target } : {}) });
  const clickAt = async (el) => { const r = el.getBoundingClientRect(); await invoke("click_test", { x: r.left + r.width / 2, y: r.top + r.height / 2 }); };
  const clickPoke = async (sel) => { const at = await pokeCall("rect", sel); if (at) await invoke("click_test", { ...at, target: "poke" }); };
  const top = () => { const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return el?.closest("#agents") ? "agents" : el?.tagName; };
  try {
    const tab = active;
    for (let i = 0; i < 40 && !agentsOpen(); i++) await wait(500);
    await log(`open agents=${agentsOpen()} on-top=${top()} poke=${await pokeUp()} need-partner=${!!$(".need-partner", tab.view)}`);
    await invoke("shot_test", { name: "first-1-agents" });
    await key("Escape", "Escape", 27); await wait(500);
    await log(`esc agents=${agentsOpen()} on-top=${top()}`);
    await clickAt($(".need-partner", tab.view)); // the pane's button: the Pokémon window on 파트너 고르기
    for (let i = 0; i < 40 && (await pokeCall("state"))?.poke !== "choose"; i++) await wait(250);
    await invoke("shot_test", { name: "first-2-choose", target: "poke" });
    const t0 = Date.now();
    for (let i = 0; i < 120 && !(await pokeCall("d"))?.choose?.starter?.ready; i++) await wait(500);
    await wait(800);
    let d = await pokeCall("d"), st = await pokeCall("state");
    await log(`starters ready=${d?.choose?.starter?.ready} after=${Math.round((Date.now() - t0) / 1000)}s set=${d?.choose?.starter?.set.map((x) => `${x.name}:${x.types?.[0]}`).join(",")} sel=${d?.bi} button=${st?.takeBtn}`);
    await invoke("shot_test", { name: "first-3-ready", target: "poke" });
    await key("ArrowRight", "ArrowRight", 39, null, "poke"); await wait(300);
    d = await pokeCall("d"); st = await pokeCall("state");
    await log(`arrow sel=${d?.bi} button=${st?.takeBtn} preview=${st?.dexName}`);
    await clickPoke('#box-grid .pk-card[data-key="s2"]'); await wait(300);
    d = await pokeCall("d"); st = await pokeCall("state");
    await log(`click card3 sel=${d?.bi} button=${st?.takeBtn}`);
    const want = d?.list?.[d?.bi];
    await clickPoke("#dex-take"); await wait(2000);
    await log(`took partner=${tab.partner?.name}#${tab.partner?.id} want=${want?.name}#${want?.id} window=${await pokeUp()} toast=${$("#toast").textContent} avatar-label=${$(".poke-label", tab.view)?.textContent}`);
    await invoke("shot_test", { name: "first-4-partner" });
    await pokeReady("choose"); await wait(800);
    d = await pokeCall("d");
    await log(`reopen starter=${!!d?.choose?.starter} title=${await pokeCall("text", "#dex-title .pk-sub")} cards=${await pokeCall("count", "#box-grid .pk-card[data-i]")}`);
    await key("Escape", "Escape", 27, null, "poke"); await wait(500);
    await log(`closed window=${await pokeUp()}`);
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
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // painted, not just laid out
  // the fake usage's reset time counts down while the scenes run (2h00m → 1h59m): set it again each picture
  const fresh = () => { const f = active?.state?.usage?.five_hour; if (f?.resets_at) { f.resets_at = Math.floor(Date.now() / 1000) + 7230; renderBar(active); } };
  const shot = async (name) => { await invoke("mouse_park_test"); fresh(); await wait(700); await frame(); const r = await invoke("ui_shot", { name }); await log(`shot ${r.name} diff=${r.diff == null ? "-" : r.diff.toFixed(5)} block=${(r.block ?? 0).toFixed(3)}${r.note ? ` ${r.note}` : ""}`); };
  // the 설정 창 (#113 P1): its own window, opened on a kind, captured, closed
  const settingsShot = async (name, page) => {
    await invoke("own_open_test", { name: "settings", page }); await wait(1400);
    const r = await invoke("ui_shot", { name, target: "settings" });
    await log(`shot ${r.name} diff=${r.diff == null ? "-" : r.diff.toFixed(5)} block=${(r.block ?? 0).toFixed(3)}${r.note ? ` ${r.note}` : ""}`);
    await invoke("own_close_test", { name: "settings" }); await wait(200);
  };
  // the Pokémon window (#113 P2): its own window — opened on a view (as ⌘P · ⌘D · the pane's button), captured
  const pokeShot = async (name) => {
    await invoke("mouse_park_test", { target: "poke" }); await wait(700);
    const r = await invoke("ui_shot", { name, target: "poke" });
    await log(`shot ${r.name} diff=${r.diff == null ? "-" : r.diff.toFixed(5)} block=${(r.block ?? 0).toFixed(3)}${r.note ? ` ${r.note}` : ""}`);
  };
  const search = (q) => pokeCall("search", q);
  try {
    const tab = active;
    for (let i = 0; i < 40 && !(tab.partner || tab.partnerChecked); i++) await wait(500); // the folder's partner read (none: the pane's button)
    if (set === "newuser") {
      await pokeReady("choose");
      for (let i = 0; i < 40 && !(await pokeCall("d"))?.choose?.starter?.ready; i++) await wait(500);
      await pokeShot("choose-starter"); await pokeShut();
    } else {
      await pokeReady("choose"); await wait(500); await pokeShot("choose-box"); await pokeShut();
      await pokeReady("dex"); await pokeShot("dex-grid");
      await search("불꽃,물"); await pokeShot("dex-search");
      await search("불꽃&전설"); await pokeShot("dex-empty");
      await search("");
      // 🏠 홈 (#44): partner, today, limits — the limits as Claude last reported them (the top bar untouched)
      const soon = Math.floor(Date.now() / 1000);
      rememberUsage("claude", { model: "Opus 5.5", five_hour: { pct: 35, resets_at: soon + 5430 }, seven_day: { pct: 86, resets_at: soon + 3 * 86400 + 7200 } });
      // 🪙 (#72): six finishes today (₽30 + the day's first ₽20 = ₽50, ₽270 left of ₽300), the 시작 코인 band, then closed
      await invoke("economy_earn_test", { n: 6 });
      await pokeCall("view", "home"); await pokeShot("home-start-coins");
      await pokeCall("click", "#box-grid .pk-band-x"); await wait(400);
      await pokeShot("home");
      // 🛒 상점 · 👜 가방 (#76): 104 coins (some cards too dear), then a Great Ball and two candies bought
      await pokeCall("view", "shop"); await pokeShot("shop");
      await invoke("shop_buy", { item: "great", n: 1 }); await invoke("shop_buy", { item: "candy", n: 2 });
      await pokeCall("view", "bag"); await pokeShot("bag");
      await pokeCall("pick", true); await wait(300); await pokeShot("bag-use-candy");
      await pokeCall("pick", "stone"); await wait(1200); await pokeShot("bag-stone"); // 💎 who a stone can evolve, the first one's stages (#93)
      if (await pokeCall("stoneDone")) { await wait(800); await pokeShot("bag-stone-done"); } // 💎 the result in place (#94): its card marked, the preview's message and buttons (the end state)
      await pokeCall("unpick");
      await pokeCall("view", "box"); await pokeShot("box-cards");
      await search("age0"); await pokeShot("box-search");
      await search("zzz"); await pokeShot("box-empty");
      await search(""); await pokeCall("view", "dex"); await pokeShut();
      // the top bar and the hint line at four window widths (#38): an agent waiting, with usage
      fakeUsage(tab);
      for (const w of [1400, 1100, 900, 720]) { await invoke("win_resize_test", { w, h: 600 }); await shot(`bar-${w}`); }
      // the right column folded (#97): the big pane takes the width, the button turns to ◂
      await invoke("win_resize_test", { w: 1100, h: 600 }); sideToggle(false); await wait(400); await shot("side-folded"); sideToggle(true); await wait(300);
      // find in the terminal (#40): the search line on the big pane, a query typed
      await invoke("win_resize_test", { w: 1400, h: 900 });
      openTermSearch(bigPane(tab)); $("#tsearch-q").value = "proj"; termFind(1, true); await shot("term-search"); closeTermSearch();
      // 에이전트 연결 창 (AGT-04): every level and button once — a fixed list, not this Mac's agents
      await invoke("win_resize_test", { w: 1100, h: 700 });
      await openAgents({ list: [
        { key: "claude", icon: "✳", name: "Claude Code", level: "full", path: "~/.local/bin/claude", fix: "claude_link" },
        { key: "codex", icon: "◎", name: "Codex", level: "full", path: "/opt/homebrew/bin/codex" },
        { key: "gemini", icon: "✦", name: "Gemini CLI", level: "basic", path: "/opt/homebrew/bin/gemini", fix: "gemini_link" },
        { key: "opencode", icon: "◇", name: "OpenCode", level: "none", path: null, install: { cmd: "curl -fsSL https://opencode.ai/install | bash", url: "https://opencode.ai" } },
        { key: "aider", icon: "▸", name: "Aider", level: "basic", path: "~/.local/bin/aider" },
      ] });
      await shot("agents-window"); closeAgents();
      // 시작 화면 (TAB-03), opened with ⌘T: recent folders (fixed, under this home), the actions, Esc
      await showStart(false, ["dev/tamer", "dev/blog", "work/api-server", "Documents/notes"].map((d) => `${info.home}/${d}`));
      startSel = 1; markStart();
      await shot("start-screen"); hideStart();
      // 설정 창 (APP-19, #59): the defaults
      await settingsShot("settings-window", "overlay"); // #101: the overlay page (and its 미리보기) — its own window (#113 P1)
      await settingsShot("settings-general", "general");
      await settingsShot("settings-menubar", "menubar");
      await invoke("settings_set", { patch: { overlay: { alpha: 82 } } }); // the scenes after: the full cards, as before the 0 % default (#100)
      // a working tab (#61): the gradient border (still in scenes — body.ui-test stops animations)
      { const kept = tab.state; tab.state = { ...tab.state, state: "coding", detail: "src/app.ts", turn_at: null, event_at: null, state_at: null }; renderTab(tab); renderBar(tab);
        await shot("tab-working"); tab.state = kept; renderTab(tab); renderBar(tab); }
      // a failed turn (#53): 💥 실패 · 서버 과부하
      const kept = tab.state;
      tab.state = { ...tab.state, state: "error", detail: "server_overloaded" }; renderBar(tab); renderTab(tab);
      await shot("bar-failed");
      // ⭐ 대발견 카드 (#82): gold border, the badge, "도망가지 않아요", the pity — a seeded sprite stands in
      { const m = (await invoke("box_list", { ws: tab.id }))[0];
        await wild.show({ token: "scene", id: m.id, name: m.name, gif: m.gif, shiny: false, big: true, pity: 1.44, balls: {} }); await wait(1500);
        await shot("wild-breakthrough"); wild.hide(); }
      tab.state = kept; renderBar(tab); renderTab(tab);
      // 변경 사항 칸 제목의 브랜치 (TRM-18): a long name (… in the narrow title), ahead/behind, a short list
      const keep = tab.changes;
      tab.changes = { repo: true, branch: { name: "feature/unattended-run-display", upstream: "origin/feature/unattended-run-display", ahead: 2, behind: 1 },
        items: [{ path: "src/elapsed.js", status: "new", add: 27, del: 0 }, { path: "src/main.js", status: "modified", add: 48, del: 12 }] };
      tab.changesFrozen = true; renderChanges(tab); await shot("changes-branch");
      await invoke("win_resize_test", { w: 720, h: 700 }); await shot("changes-branch-720"); await invoke("win_resize_test", { w: 1100, h: 700 });
      tab.changes = keep; tab.changesFrozen = false; renderChanges(tab);
      // 무인 실행 (STA-20): working 32 min, no new event for 12 — the top bar and the overlay card
      const now = Date.now(), times = { turn_at: now - 32 * 60000 - 5000, state_at: now - 12 * 60000 - 5000, event_at: now - 12 * 60000 - 5000, watch: true };
      tab.state = { ...tab.state, state: "coding", detail: "src/app.ts", ...times };
      renderBar(tab); renderTab(tab);
      await shot("bar-stall");
      // the overlay first (a test app shows it only when asked), then the state right before the picture —
      // the core's own idle for this tab may come meanwhile
      await invoke("overlay_show_test", { on: true }); await wait(1000);
      await invoke("agent_state_test", { ws: tab.id, from: "idle", to: "coding", times, hold: true }); await wait(500);
      const r = await invoke("ui_shot", { name: "overlay-stall", target: "overlay" });
      await log(`shot ${r.name} diff=${r.diff == null ? "-" : r.diff.toFixed(5)} block=${(r.block ?? 0).toFixed(3)}${r.note ? ` ${r.note}` : ""}`);
      // the cards' background at 20 % (설정 창, #59)
      await invoke("settings_set", { patch: { overlay: { alpha: 20 } } }); await wait(500);

      const r2 = await invoke("ui_shot", { name: "overlay-clear", target: "overlay" });
      await log(`shot ${r2.name} diff=${r2.diff == null ? "-" : r2.diff.toFixed(5)} block=${(r2.block ?? 0).toFixed(3)}${r2.note ? ` ${r2.note}` : ""}`);
      // the pointer over the partner (#68): the line floats above, the box shows where a click goes
      await invoke("overlay_hover_test", { on: true }); await wait(400);
      const r5 = await invoke("ui_shot", { name: "overlay-hover", target: "overlay" });
      await log(`shot ${r5.name} diff=${r5.diff == null ? "-" : r5.diff.toFixed(5)} block=${(r5.block ?? 0).toFixed(3)}${r5.note ? ` ${r5.note}` : ""}`);
      await invoke("overlay_hover_test", { on: false });
      // no shadow (#65), the background as it was
      await invoke("settings_set", { patch: { overlay: { alpha: 82, shadow: false } } }); await wait(500);
      const r4 = await invoke("ui_shot", { name: "overlay-noshadow", target: "overlay" });
      await log(`shot ${r4.name} diff=${r4.diff == null ? "-" : r4.diff.toFixed(5)} block=${(r4.block ?? 0).toFixed(3)}${r4.note ? ` ${r4.note}` : ""}`);
      await invoke("settings_set", { patch: { overlay: { shadow: true } } });
      await invoke("agent_state_test", { ws: tab.id, from: "coding", to: "idle" }); // let go of the held state
      await invoke("overlay_show_test", { on: false });
      // the 설정 창's 미리보기 with 최소 모드 always (#63 #67): the partner and the sample tabs' balls
      await invoke("settings_set", { patch: { overlay: { minimal: "always" } } }); await wait(300);
      await settingsShot("settings-minimal", "overlay");
      // the cards' background at 0 % (#92): the notice keeps a 75 % background, the partner stays see-through
      await invoke("settings_set", { patch: { overlay: { alpha: 0 } } }); await wait(300);
      await settingsShot("settings-clear", "overlay");
      await invoke("settings_set", { patch: { overlay: { alpha: 82 } } });
      await invoke("settings_set", { patch: { overlay: { minimal: "auto" } } });
      // 라이트 테마 (APP-20, #60): the main window, the 설정 창, the Pokémon window, the overlay
      await invoke("settings_set", { patch: { theme: "light" } }); await wait(700);
      await invoke("win_resize_test", { w: 1400, h: 600 });
      fakeUsage(tab); await shot("light-main");
      await invoke("win_resize_test", { w: 1100, h: 700 });
      await settingsShot("light-settings", "overlay");
      await pokeReady("dex"); await pokeShot("light-dex"); await pokeShut();
      await invoke("overlay_show_test", { on: true }); await wait(800);
      await invoke("agent_state_test", { ws: tab.id, from: "idle", to: "coding", times, hold: true }); await wait(500);
      const r3 = await invoke("ui_shot", { name: "light-overlay", target: "overlay" });
      await log(`shot ${r3.name} diff=${r3.diff == null ? "-" : r3.diff.toFixed(5)} block=${(r3.block ?? 0).toFixed(3)}${r3.note ? ` ${r3.note}` : ""}`);
      await invoke("overlay_show_test", { on: false });
      await invoke("agent_state_test", { ws: tab.id, from: "coding", to: "idle" });
      await invoke("settings_set", { patch: { theme: "dark" } });
      await invoke("overlay_show_test", { on: false });
      // 🥚 · 🎓 the partner pane (#84): an egg 3/10, then a graduate with its band — drawn here only (last, so nothing after it moves)
      await invoke("win_resize_test", { w: 1400, h: 900 }); await wait(400);
      await invoke("incubator_add_test", { kind: "egg", have: 3 }); await invoke("incubator_add_test", { kind: "egg2", have: 0 });
      await pokeReady("home"); await wait(500); await pokeShot("home-incubator"); await pokeShut();
      await pokeReady("bag"); await wait(500); await pokeShot("bag-incubator"); await pokeShut(); // 🥚 the bag's incubator section with its line (#88)
      { const m = (await invoke("box_list", { ws: tab.id }))[0];
        await showPartner(tab, { ...m, lv: 100, final: true, grad: 1, gradAsk: true }); await wait(800); await shot("graduate"); }
      // 진행 on the overlay (#88 #90): the egg 3/10 under the current tab's card, and the minimal mode's chips
      await invoke("overlay_show_test", { on: true }); await wait(800);
      await invoke("agent_state_test", { ws: tab.id, from: "idle", to: "coding", times, hold: true }); await wait(500);
      for (const [name, minimal] of [["overlay-progress", "never"], ["overlay-progress-min", "always"]]) {
        await invoke("settings_set", { patch: { overlay: { minimal } } }); await wait(500);
        const r = await invoke("ui_shot", { name, target: "overlay" });
        await log(`shot ${r.name} diff=${r.diff == null ? "-" : r.diff.toFixed(5)} block=${(r.block ?? 0).toFixed(3)}${r.note ? ` ${r.note}` : ""}`);
      }
      await invoke("settings_set", { patch: { overlay: { minimal: "auto" } } });
      await invoke("agent_state_test", { ws: tab.id, from: "coding", to: "idle" });
      await invoke("overlay_show_test", { on: false });
      // ⭐ 파티 (#107, PKM-31): three of the box in the party, the next in turn marked
      await invoke("party_test", { n: 3 });
      await pokeReady("party"); await wait(700); await pokeShot("party"); await pokeShut();
      // 메뉴바 미니 대시보드 (#105, STA-22): 홈 — the party of three with its pictures (#117), Claude's limits behind the agent
      // chips (no reset time: the picture doesn't move with the clock; #118); 작업 — the incubator's egg, this tab needing you
      await invoke("agent_state_test", { ws: tab.id, from: "idle", to: "waiting", hold: true });
      await invoke("usage_seen", { key: "claude", five_hour: { pct: 42 }, seven_day: { pct: 86 } });
      await invoke("usage_seen", { key: "codex", five_hour: { pct: 70, resets_at: 1000000000 } }); // #115: reset long ago → 초기화됨, no 주간 → —
      await invoke("popover_test", { open: true }); await wait(1500);
      for (const [name, pg] of [["menubar-dashboard", "home"], ["menubar-dashboard-work", "work"]]) {
        await invoke("popover_click_test", { sel: `#pop-nav [data-page='${pg}']` }); await wait(700);
        const r = await invoke("ui_shot", { name, target: "popover" });
        await log(`shot ${r.name} diff=${r.diff == null ? "-" : r.diff.toFixed(5)} block=${(r.block ?? 0).toFixed(3)}${r.note ? ` ${r.note}` : ""}`);
      }
      await invoke("popover_click_test", { sel: "#pop-nav [data-page='home']" });
      await invoke("popover_test", { open: false });
      // 메뉴바 아이콘 (#108, STA-24): the party's lead, the Poké Ball — frame 0 (a test app puts no icon on the menu bar: the
      // picture it would be given; the limits are its title, not in the picture)
      await invoke("settings_set", { patch: { menubar: { icon: "poke", text: "limit" } } }); await wait(300);
      for (const [name, marks] of [["menubar-icon", {}], ["menubar-icon-waiting", { badge: true }]]) {
        const r = await invoke("lead_shot_test", { name, marks });
        await log(`shot ${r.name} diff=${r.diff == null ? "-" : r.diff.toFixed(5)} block=${(r.block ?? 0).toFixed(3)}${r.note ? ` ${r.note}` : ""}`);
      }
      await invoke("settings_set", { patch: { menubar: { icon: "ball" } } }); await wait(300);
      { const r = await invoke("lead_shot_test", { name: "menubar-icon-ball" }); await log(`shot ${r.name} diff=${r.diff == null ? "-" : r.diff.toFixed(5)} block=${(r.block ?? 0).toFixed(3)}${r.note ? ` ${r.note}` : ""}`); }
      await invoke("settings_set", { patch: { menubar: { text: "waiting" } } });
      // 야생 잡기 창 (#119, PKM-08): the card the overlay's notice opens beside it — a seeded sprite stands in, no timer
      { const m = (await invoke("box_list", { ws: tab.id }))[0];
        await invoke("catch_test", { open: true, scene: { token: "scene", id: m.id, name: m.name, gif: m.gif, shiny: false } }); await wait(1800);
        const r = await invoke("ui_shot", { name: "wild-catch", target: "catch" });
        await log(`shot ${r.name} diff=${r.diff == null ? "-" : r.diff.toFixed(5)} block=${(r.block ?? 0).toFixed(3)}${r.note ? ` ${r.note}` : ""}`);
        await invoke("catch_test", { open: false }); }
      await invoke("usage_seen", { key: "codex" });
      await invoke("party_set", { uids: [] });
      await invoke("agent_state_test", { ws: tab.id, from: "waiting", to: "idle" });
      // the shell rail opened by the pointer (#99): one agent's own title, one shell named by hand — last, as a
      // second shell changes what the tab shows
      await invoke("win_resize_test", { w: 1100, h: 600 });
      { await newSession(tab); await wait(800); const [s1, s2] = tab.sessions; s1.state = { ...(s1.state || {}), title: "로그인 오류 고치기" }; s2.name = "api 작업";
        renderRail(tab); $(".rail", tab.view).classList.add("open"); await wait(300); await shot("rail-open"); }
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
  // a new folder (the box isn't empty: no starters): the pane's [파트너 고르기] → the Pokémon window with the box (#113 A8)
  for (let i = 0; i < 60 && !$(".need-partner", tab.view); i++) await wait(500);
  await pokeReady("choose");
  await wait(1500);
  let o = (await pokeCall("d"))?.choose;
  await log(`dialog open=${(await pokeCall("state"))?.choose} starter=${!!o?.starter} resting=${o?.resting.length} others=${o?.others.length}`);
  await invoke("shot_test", { name: "x1e-dialog", target: "poke" });
  const take = async (key) => { await pokeCall("pickKey", key); await pokeCall("enter"); };
  await take("r1"); await wait(1500);
  await log(`rest1 partner=${tab.partner?.name}#${tab.partner?.uid} want=${o.resting[1]?.name}#${o.resting[1]?.uid} open=${await pokeUp()}`);
  await pokeReady("choose"); await wait(500);
  o = (await pokeCall("d"))?.choose;
  await log(`reopen current=${o.current?.name} resting0=${o.resting[0]?.name}`);
  const prev = tab.partner?.uid;
  await take("r0"); await wait(1500);
  o = await invoke("partner_options", { ws: tab.id });
  await log(`rest-take partner=${tab.partner?.name} prev-now-resting=${o.resting.some((m) => m.uid === prev)}`);
  // another folder's partner: twice (confirm), that tab is left without one
  await pokeReady("choose"); await wait(500);
  o = (await pokeCall("d"))?.choose;
  const target = o.others[0];
  await take("o0"); await wait(300);
  const asked = (await pokeCall("state"))?.takeBtn?.includes("(확인)") && (await pokeCall("count", '#box-grid .pk-card[data-key="o0"].confirm')) === 1;
  await pokeCall("enter"); await wait(1500);
  const from = tabs.find((t) => base(t.cwd) === target?.folderName);
  await log(`other-take asked=${asked} partner=${tab.partner?.name}#${tab.partner?.uid} want=${target?.name}#${target?.uid} from=${target?.folderName} from-tab-partner=${from?.partner?.name ?? "none"} from-label=${from && $(".poke-label", from.view).textContent}`);
  await invoke("shot_test", { name: "x1e-freed" });
  await pokeShut();
  // the Pokédex board: cells by state, Enter on an owned species takes a resting one
  await pokeReady("dex"); await wait(1500);
  let d = await pokeCall("d");
  const ownedOne = d.owned.find((id) => id !== tab.partner?.id);
  await log(`dex caught=${await pokeCall("count", "#dex-grid .cell.caught")} seen=${await pokeCall("count", "#dex-grid .cell.seen")} unknown=${await pokeCall("count", "#dex-grid .cell.unknown")} regions=${(await pokeCall("text", "#dex-regions")).replace(/\s+/g, " ")}`);
  await invoke("shot_test", { name: "x1e-dex", target: "poke" });
  await pokeCall("select", ownedOne);
  await pokeCall("key", "ArrowRight"); await pokeCall("key", "ArrowLeft");
  d = await pokeCall("d");
  await log(`dex sel=${d.sel} want=${ownedOne} take-visible=${!!(await pokeCall("state"))?.takeBtn}`);
  await pokeCall("key", "Enter"); await wait(1500);
  await log(`dex-enter partner=${tab.partner?.id} want=${ownedOne} dex-open=${await pokeUp()}`);
  // a species that's only another folder's partner: confirm inside the Pokédex, no other screen
  await pokeReady("dex"); await wait(800);
  d = await pokeCall("d");
  const otherOnly = d.opts.others.find((m) => !d.opts.resting.some((r) => r.id === m.id) && d.opts.current?.id !== m.id);
  if (otherOnly) {
    await pokeCall("select", otherOnly.id);
    const label1 = await pokeCall("text", "#dex-from");
    await pokeCall("key", "Enter"); await wait(300);
    const label2 = await pokeCall("text", "#dex-from button.confirm");
    await log(`dex-other first=${label1} second=${label2} dex-open=${await pokeUp()}`);
    await pokeCall("key", "Enter"); await wait(1500);
    await log(`dex-other-taken partner=${tab.partner?.name}#${tab.partner?.uid} want=${otherOnly.name}#${otherOnly.uid} dex-open=${await pokeUp()}`);
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
    for (let k = 0; k < 40 && !$(".need-partner", first.view); k++) await wait(500);
    await pokeReady("choose"); // the pane's [파트너 고르기] (#113 A8)
    for (let k = 0; k < 120 && !(await pokeCall("d"))?.choose?.starter?.ready; k++) await wait(500);
    let o = (await pokeCall("d"))?.choose;
    await log(`first starter=${o?.starter?.set.map((x) => x.name + ":" + x.types?.[0]).join(",")} note=${(await pokeCall("d"))?.chooseNote || ""}`);
    await wait(800);
    await invoke("shot_test", { name: "newuser-starter", target: "poke" });
    await pokeCall("key", "2");
    await wait(1500);
    await log(`first partner=${first.partner?.name}#${first.partner?.uid}`);
    const empty = tabs[1];
    selectTab(empty);
    await wait(1500);
    await log(`second dialog=${await pokeUp()} need-partner=${!!$(".need-partner", empty.view)}`); // no dialog by itself (#113 A8)
    await log(`second empty-icon=${!$(".empty-ball", empty.view).hidden} label=${$(".poke-label", empty.view).textContent} hint=${$(".poke-exp", empty.view).textContent}`);
    await wait(600);
    await log(`overlays poke=${await pokeUp()} start=${startOpen()} menu=${!$("#menu").hidden} wild=${wild.active()}`);
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
  // the times move on their own (STA-20): the top bar, tabs and rail redraw now and then
  setInterval(() => { if (active?.state) renderBar(active); tabs.forEach((t) => { renderTab(t); if (t === active) renderRail(t); }); }, Math.min(15000, Math.max(1000, info.stallMs / 3)));
  invoke("startup_mark", { what: "ui has app info" });
  if (info.test.lab) labRun(info.test.lab); // the lab watches the start itself
  invoke("wild_state").then((w) => { wildOn = w.enabled; if (w.current) wild.show(w.current); });
  if (info.test.sec_test) secTest();
  // session restore: last time's tabs (agents resume their conversations), then the last active one
  for (const dir of info.open) {
    const tab = await openFolder(dir, { resume: !!info.restored?.tabs.includes(dir) && !info.restored.shell?.includes(dir) });
    // more sessions in that folder last time (M1): started fresh
    for (const key of info.restored?.sessions?.[dir] || []) await newSession(tab, key); // null: was a shell
    // the names given to them (#99): by their place in the folder
    const names = info.restored?.names?.[dir];
    if (tab && names) { tab.sessions.forEach((x, i) => { if (names[i]) { x.name = names[i]; invoke("session_name", { session: x.id, name: names[i] }); } }); renderRail(tab); }
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
  // the Pokédex's own checks run in the Pokémon window (#113 P2 — src/poke/window.js window.lab)
  if (info.test.dexnav_test) setTimeout(async () => { // #17
    await pokeReady("dex");
    const out = await pokeCall("dexnav");
    await new Promise((r) => setTimeout(r, 1000)); // painted before the capture
    await invoke("shot_test", { name: "dexnav", target: "poke" });
    await invoke("log_line", { line: `dexnav-test ${out}` });
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
  if (info.test.dexsearch_test) setTimeout(async () => { // #21 #22 #24 — typed with real keys into its search
    await pokeReady("dex");
    const out = await pokeCall("dexsearch");
    await invoke("shot_test", { name: "dexsearch", target: "poke" });
    await invoke("own_close_test", { name: "poke" });
    await invoke("wild_dex_test", { id: 37 }); // 도감에서 보기: the window again, on #37, the search kept
    await new Promise((r) => setTimeout(r, 1500));
    const d = await pokeCall("d");
    out.overlayDex = `open=${!!d} sel=${d?.sel}`;
    await invoke("log_line", { line: `dexsearch-test ${JSON.stringify(out)}` });
    invoke("log_line", { line: "autotype done" });
  }, 6000);
  if (info.test.cost_test) setTimeout(async () => {
    // #23: Claude typed in the shell (no cost of its own) → "≈$" from its log's tokens × prices
    const tab = active, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await invoke("pty_write_test", { id: tab.panes.agent.id, data: `${info.test.fake_claude}\r` });
    for (let i = 0; i < 50 && !/≈\$/.test($("#usage").textContent); i++) await wait(300);
    await invoke("log_line", { line: `cost-test usage=${$("#usage").textContent} tip=${$("#usage [title]")?.title || ""} tokens=${JSON.stringify(tab.state?.usage?.tokens || null)}` });
    invoke("log_line", { line: "autotype done" });
  }, 3000);
  if (info.test.box_test) setTimeout(async () => { // #27 "내 포켓몬"
    let out = {};
    try {
      await pokeReady("box");
      out = await pokeCall("box");
      await new Promise((r) => setTimeout(r, 1700));
      await invoke("shot_test", { name: "box", target: "poke" });
      await pokeCall("take", 418);
      await new Promise((r) => setTimeout(r, 1500));
      out.took = `partner=${active.partner?.id} dexOpen=${await pokeUp()}`;
    } catch (e) { out.ERROR = String(e?.stack || e); }
    await invoke("log_line", { line: `box-test ${JSON.stringify(out)}` });
    invoke("log_line", { line: "autotype done" });
  }, 5000);
  if (info.test.choose_shot) setTimeout(async () => { // the partner dialog as it looks (UI checks) — opened as the pane's button does (#113 A8)
    await pokeReady("choose"); await new Promise((r) => setTimeout(r, 1500));
    await invoke("shot_test", { name: "choose", target: "poke" });
    invoke("log_line", { line: `choose-shot open=${(await pokeCall("state"))?.choose} cards=${await pokeCall("count", "#box-grid .pk-card[data-i]")}` });
    invoke("log_line", { line: "autotype done" });
  }, 6000);
  if (info.test.ui_scenes) uiScenes(info.test.ui_scenes);
  if (info.test.first_run) firstRunTest();
  // a folder dropped on the app to launch it (#31 follow-up): after the dust settles, what's on screen
  if (info.test.drop_check) setTimeout(async () => {
    await invoke("log_line", { line: `drop-check tabs=${tabs.map((t) => base(t.cwd)).join(",")} start=${startOpen()} poke=${await pokeUp()} agents=${agentsOpen()} active=${active ? base(active.cwd) : "-"}` });
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
