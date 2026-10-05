// Unattended runs (STA-20): how long the task has run, how long it has waited for you, how long a
// finished one took, and whether it looks stalled — read from the core's wall-clock times (turn_at,
// state_at, event_at, took). Facts only, never a prediction; a stall is a suspicion and says so.
// Shared by the main window and the overlay.
export const WORKING = ["thinking", "coding", "reading", "searching", "bash", "agent", "tool", "compact"];
export const MINUTE = 60000;
export const STALL_MS = 10 * MINUTE; // new events none for this long while working (bash excluded)

// 12분 · 1시간 5분 · 2시간
export function dur(ms) {
  const m = Math.floor(ms / MINUTE);
  return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ""}`;
}

// { run, wait, took, stall } — each a duration text, or absent (under a minute: nothing)
export function timing(st, { now = Date.now(), stallMs = STALL_MS } = {}) {
  const out = {};
  if (!st) return out;
  const working = WORKING.includes(st.state);
  if (working && st.turn_at && now - st.turn_at >= MINUTE) out.run = dur(now - st.turn_at);
  if (st.state === "waiting" && st.state_at && now - st.state_at >= MINUTE) out.wait = dur(now - st.state_at);
  if (st.state === "done" && st.took >= MINUTE) out.took = dur(st.took);
  // a long command (tests, a build) is normal; an agent followed by its output has no events to miss
  if (working && st.watch && st.state !== "bash" && st.event_at && now - st.event_at >= stallMs) out.stall = dur(now - st.event_at);
  return out;
}
