// 오늘 사용량 (STA-23 rule 9, #115 A5 — POL-DATA-02 rule 3): with "Tamer 밖 작업도 포켓몬에" on, today's tokens per
// agent from the logs outside.cjs watches (Tamer's tabs' work is in them too) — of a line only its time, model id and
// token counts, never its text:
//   Claude  an assistant line's message.usage — [input, cache write 5 min, cache write 1 h, cache read, output] —
//           each message id once (a reply is written once per content block)
//   Codex   a session's total_token_usage (it keeps the running total): today's last minus the last before today,
//           at the model of its last turn_context
// At the start the files changed today are read from their beginning (a few MB per look, so the app doesn't
// stall); after that, new lines only. Sums and where reading got to stay in memory; at midnight all from 0.
const fs = require("node:fs");
const { roots, claudeFiles, codexFiles } = require("./outside.cjs");

const BUDGET = 8 << 20; // bytes read per look (the start's catching up spreads over a few looks)
const midnight = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t.getTime(); };
const stat = (f) => { try { return fs.statSync(f); } catch { return null; } };
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// a Codex total → [input, cache write, -, cache read, output] (as the core counts a tab's: core-rs codex.rs)
function codexSplit(t) {
  const input = n(t.input_tokens), cached = n(t.cached_input_tokens), write = n(t.cache_write_input_tokens);
  const out = Math.max(t.total_tokens != null ? n(t.total_tokens) - input : 0, n(t.output_tokens));
  return [Math.max(0, input - cached - write), write, 0, cached, out];
}
const minus = (a, b) => a.map((x, i) => Math.max(0, x - (b?.[i] || 0)));

function createSpend(env) {
  const r = roots(env);
  let day = midnight(), files = new Map(), claude = new Map(), seen = new Set();
  const reset = () => { day = midnight(); files = new Map(); claude = new Map(); seen = new Set(); };

  function claudeLine(d) {
    const m = d?.message, model = m?.model;
    if (d?.type !== "assistant" || typeof model !== "string" || !model.startsWith("claude-") || !m.id || seen.has(m.id)) return;
    if (!(Date.parse(d.timestamp) >= day)) return;
    seen.add(m.id);
    const u = m.usage || {}, cw = n(u.cache_creation_input_tokens), hour = Math.min(n(u.cache_creation?.ephemeral_1h_input_tokens), cw);
    const add = [n(u.input_tokens), cw - hour, hour, n(u.cache_read_input_tokens), n(u.output_tokens)];
    const cur = claude.get(model) || [0, 0, 0, 0, 0];
    claude.set(model, cur.map((x, i) => x + add[i]));
  }
  function codexLine(st, d) {
    const p = d?.payload;
    if (d?.type === "turn_context" && typeof p?.model === "string") { st.model = p.model; return; }
    const tot = p?.type === "token_count" && p.info?.total_token_usage;
    if (!tot) return;
    if (Date.parse(d.timestamp) >= day) st.last = { model: st.model, t: codexSplit(tot) };
    else st.base = codexSplit(tot);
  }
  // read what's new in a file, up to the budget left — whole lines only
  function read(f, st, size, left) {
    const len = Math.min(size - st.off, left);
    if (len <= 0) return 0;
    let buf;
    try { const fd = fs.openSync(f, "r"); buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.off); fs.closeSync(fd); } catch { return 0; }
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) {
      if (len === BUDGET) { st.off += len; return len; } // one line longer than a whole look: skipped
      return 0; // a half-written line, or too little budget left: the next look
    }
    st.off += end + 1;
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      if (st.kind === "claude" ? !line.includes('"usage"') : !line.includes('"token_count"') && !line.includes('"turn_context"')) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (st.kind === "claude") claudeLine(d); else codexLine(st, d);
    }
    return end + 1;
  }
  function poll() {
    if (midnight() !== day) reset();
    let left = BUDGET;
    for (const [kind, f] of [...claudeFiles(r.claude).map((f) => ["claude", f]), ...codexFiles(r.codex).map((f) => ["codex", f])]) {
      const s = stat(f);
      if (!s) continue;
      let st = files.get(f);
      // not written today: nothing of today in it — from its end (a Codex session gone on past midnight is read from
      // its beginning when it grows, for its total before today)
      if (!st) { st = { kind, off: s.mtimeMs < day && kind === "claude" ? s.size : 0, model: null, base: null, last: null, idle: s.mtimeMs < day && kind === "codex" ? s.size : null }; files.set(f, st); }
      if (st.idle != null) { if (s.size === st.idle) continue; st.idle = null; }
      if (s.size < st.off) st.off = 0; // rewritten
      if (left > 0 && s.size > st.off) left -= read(f, st, s.size, left);
    }
  }
  // { claude: { tokens, models: { id: [5] } }, codex: … } — agents with none today left out
  function totals() {
    const out = {}, put = (agent, model, t) => {
      const a = (out[agent] ||= { tokens: 0, models: {} }), cur = a.models[model] || [0, 0, 0, 0, 0];
      a.models[model] = cur.map((x, i) => x + t[i]); a.tokens += t.reduce((x, y) => x + y, 0);
    };
    for (const [model, t] of claude) put("claude", model, t);
    for (const st of files.values()) if (st.kind === "codex" && st.last?.model) put("codex", st.last.model, minus(st.last.t, st.base));
    for (const k of Object.keys(out)) if (!out[k].tokens) delete out[k];
    return out;
  }
  return { poll, totals };
}

// tokens × prices (prices.cjs: USD per token, [input, write 5 min, write 1 h, read, output]) — null when no model is priced
function costOf(models, prices) {
  if (!prices) return null;
  let sum = 0, priced = false;
  for (const [model, t] of Object.entries(models || {})) {
    const p = prices[model] || prices[model.replace(/-\d{8}$/, "")]; // claude-haiku-4-5-20251001 → claude-haiku-4-5 (STA-10 rule 3)
    if (!p) continue;
    priced = true;
    for (let i = 0; i < 5; i++) sum += (t[i] || 0) * p[i];
  }
  return priced ? sum : null;
}

module.exports = { createSpend, costOf, codexSplit };
