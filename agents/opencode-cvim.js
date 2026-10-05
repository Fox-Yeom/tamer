// CVIM ↔ OpenCode (A2): an OpenCode plugin that writes one line per lifecycle event to
//   $CVIM_STATE_DIR/tabs/$CVIM_TAB_ID.log   (same lines as claude/hooks/event.sh)
// Loaded for CVIM's run only (OPENCODE_CONFIG_CONTENT {"plugin":["file://…"]}) — the user's
// OpenCode config is never touched. Writes nothing to the model; never blocks anything.
//   session.status busy → UserPromptSubmit · tool.execute.before → PreToolUse · after → PostToolUse
//   permission.asked / question.asked → Notification · session.idle → Stop
//   session.error MessageAbortedError → Interrupted, other errors → StopFailure (that idle: no Stop)
import fs from "node:fs";
import path from "node:path";

const TAB = process.env.CVIM_TAB_ID;
const DIR = path.join(process.env.CVIM_STATE_DIR || path.join(process.env.HOME || "", ".cache/cvim"), "tabs");

function line(event, tool = "", detail = "") {
  if (!TAB) return;
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const rec = { event, ts: Math.floor(Date.now() / 1000), tool, detail: String(detail).replace(/\s+/g, " ").slice(0, 200) };
    fs.appendFileSync(path.join(DIR, `${TAB}.log`), JSON.stringify(rec) + "\n", { mode: 0o600 });
  } catch {}
}

// OpenCode tool names → the ones CVIM knows (state icons)
const TOOL = { edit: "Edit", write: "Write", read: "Read", grep: "Grep", glob: "Glob", list: "LS", bash: "Bash", webfetch: "WebFetch", task: "Task" };

export const CvimEvents = async () => {
  let busy = false;
  let ended = null; // "error" / "abort": the idle after it isn't a finished task
  return {
    event: async ({ event }) => {
      const p = event?.properties || {};
      switch (event?.type) {
        case "session.status":
          if (p.status?.type === "busy" && !busy) { busy = true; ended = null; line("UserPromptSubmit"); }
          break;
        case "session.idle":
          if (busy && !ended) line("Stop");
          busy = false;
          break;
        case "session.error":
          ended = p.error?.name === "MessageAbortedError" ? "abort" : "error";
          line(ended === "abort" ? "Interrupted" : "StopFailure", "", p.error?.name || "error");
          busy = false;
          break;
        case "permission.asked":
        case "question.asked":
          line("Notification", "", "input"); // that it asks, not what
          break;
      }
    },
    // the tool's name only — never its file path, command, pattern or URL (POL-DATA-02, 2026-10-05)
    "tool.execute.before": async (input) => line("PreToolUse", TOOL[input?.tool] || input?.tool || "tool"),
    "tool.execute.after": async () => line("PostToolUse"),
  };
};
