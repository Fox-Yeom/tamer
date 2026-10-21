// Tamer 밖에서 끝낸 작업 (STA-23, #107 — POL-FUT-05): Claude Code and Codex write their own logs on this
// Mac wherever they run (another terminal, the Claude app's Code, the Codex app). With the user's yes, the
// lines that say a turn finished are read — their kind, folder (cwd), source and length only, never the
// conversation — and fed to the same game as a tab's finish.
//   Claude  <CLAUDE_CONFIG_DIR|~/.claude>/projects/*/*.jsonl — `type: system, subtype: turn_duration`
//           (cwd · durationMs · entrypoint · isSidechain on that line)
//   Codex   <CODEX_HOME|~/.codex>/sessions/**/*.jsonl — `event_msg / task_complete` without an error
//           (duration_ms); where it came from: the file's first line, `session_meta` (originator · source · cwd)
// Not counted (rule 3): scripts and headless runs (Claude entrypoint sdk-*, `codex_exec`), sub-agents
// (isSidechain, Codex source.subagent), a Codex started by another agent (originator "Claude Code").
// Where reading got to is kept in memory only (no paths written); every start begins at the files' current
// size — work done while Tamer was off isn't counted (POL-FUT-05 rule 8).
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const MAX_READ = 1 << 20; // a burst of new lines is read in steps of 1 MB

function roots(env = process.env) {
  return {
    claude: path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects"),
    codex: path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions"),
  };
}
const exists = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
// are there any logs to read at all (asked only then)
const hasLogs = (env) => { const r = roots(env); return exists(r.claude) || exists(r.codex); };

function claudeFiles(root) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let fsx = [];
    try { fsx = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
    for (const f of fsx) if (f.endsWith(".jsonl")) out.push(path.join(root, d.name, f));
  }
  return out;
}
function codexFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };
function firstLine(f) {
  try {
    const fd = fs.openSync(f, "r"), buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const s = buf.subarray(0, n).toString("utf8"), i = s.indexOf("\n");
    return i < 0 ? null : s.slice(0, i);
  } catch { return null; }
}
// a Codex session's source: { counted, cwd } from its session_meta line (null: not written yet)
function codexMeta(f) {
  const l = firstLine(f);
  if (!l) return null;
  let d; try { d = JSON.parse(l); } catch { return { counted: false, cwd: null }; }
  const p = d?.type === "session_meta" ? d.payload || {} : null;
  if (!p) return { counted: false, cwd: null };
  const by = String(p.originator || ""), src = p.source;
  const sub = src && typeof src === "object" && "subagent" in src;
  return { counted: !sub && by !== "Claude Code" && by !== "codex_exec" && src !== "exec", cwd: typeof p.cwd === "string" ? p.cwd : null };
}

// one finished turn out of a line, or null
function claudeDone(d) {
  if (d?.type !== "system" || d.subtype !== "turn_duration" || d.isSidechain) return null;
  if (String(d.entrypoint || "").startsWith("sdk")) return null; // scripts · headless (claude -p, the SDK)
  if (typeof d.cwd !== "string" || !d.cwd) return null;
  return { agent: "claude", cwd: d.cwd, took: Number.isFinite(d.durationMs) ? d.durationMs : null };
}
function codexDone(d, meta) {
  const p = d?.payload;
  if (d?.type !== "event_msg" || p?.type !== "task_complete" || p.error) return null;
  if (!meta?.counted || !meta.cwd) return null;
  return { agent: "codex", cwd: meta.cwd, took: Number.isFinite(p.duration_ms) ? p.duration_ms : null };
}

function createWatch(env) {
  const r = roots(env);
  const files = new Map(); // path → { kind, off, meta } — memory only
  const list = () => [...claudeFiles(r.claude).map((f) => ["claude", f]), ...codexFiles(r.codex).map((f) => ["codex", f])];
  // from now on: every file as big as it is
  for (const [kind, f] of list()) files.set(f, { kind, off: Math.max(0, sizeOf(f)), meta: kind === "codex" ? codexMeta(f) : null });
  function poll() {
    const out = [];
    for (const [kind, f] of list()) {
      let st = files.get(f);
      if (!st) { st = { kind, off: 0, meta: null }; files.set(f, st); } // a file new since the start: from its beginning
      const size = sizeOf(f);
      if (size < 0) continue;
      if (size < st.off) { st.off = size; continue; } // rewritten / truncated: from here on
      if (size === st.off) continue;
      if (kind === "codex" && !st.meta) st.meta = codexMeta(f);
      let buf;
      try {
        const n = Math.min(size - st.off, MAX_READ), fd = fs.openSync(f, "r");
        buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, st.off); fs.closeSync(fd);
      } catch { continue; }
      const end = buf.lastIndexOf(0x0a); // whole lines only: a half-written one waits for the next poll
      if (end < 0) { if (buf.length === MAX_READ) st.off += buf.length; continue; }
      st.off += end + 1;
      for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
        // only lines that can be a finish are parsed at all
        if (kind === "claude" ? !line.includes('"turn_duration"') : !line.includes('"task_complete"')) continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        const done = kind === "claude" ? claudeDone(d) : codexDone(d, st.meta);
        if (done) out.push(done);
      }
    }
    for (const f of files.keys()) if (sizeOf(f) < 0) files.delete(f); // gone
    return out;
  }
  return { poll, size: () => files.size };
}

module.exports = { createWatch, hasLogs, roots, claudeFiles, codexFiles, claudeDone, codexDone, codexMeta };
