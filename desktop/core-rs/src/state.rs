//! Per-workspace agent state machine (port of nvim/lua/cvim/state.lua and desktop/electron/core/state.cjs).
//! Every agent is reduced to the same states, fed by normalized events named after Claude's hooks.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::time::{Duration, Instant, SystemTime};

/// States in which a turn is running (Esc / Ctrl-C can interrupt it).
pub const WORKING: [&str; 8] = ["thinking", "coding", "reading", "searching", "bash", "agent", "tool", "compact"];

/// Where a workspace's events come from (see desktop/electron/core/agents.cjs `state`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Hooks,
    CodexLog,
    /// Claude's own conversation log (a Claude started by hand, without CVIM hooks)
    ClaudeLog,
    Activity,
}

/// A normalized event: { event, ts (unix seconds), tool, detail }.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub event: String,
    #[serde(default)]
    pub ts: i64,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "empty_as_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "empty_as_none")]
    pub detail: Option<String>,
}

// hook lines write "" for missing fields
fn empty_as_none<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let v: Option<String> = Option::deserialize(d)?;
    Ok(v.filter(|s| !s.is_empty()))
}

impl Event {
    pub fn new(event: &str, tool: Option<&str>, detail: Option<String>) -> Self {
        Event { event: event.into(), ts: now_secs(), tool: tool.map(Into::into), detail }
    }
}

pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Window {
    pub pct: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
}

/// Usage in one shape for every agent.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Usage {
    pub model: Option<String>,
    pub ctx: Option<f64>,
    pub five_hour: Option<Window>,
    pub seven_day: Option<Window>,
    pub cost: Option<f64>,
    /// the model's id (claude-opus-5-5), its context window, and the context in tokens when only
    /// the conversation log is there (no statusLine): the UI turns tokens into % with a window it
    /// saw before for that model
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctx_window: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctx_tokens: Option<f64>,
    /// tokens used so far by model, from the conversation log: [input, cache write (5 min),
    /// cache write (1 hour), cache read, output] — the UI turns them into an estimated cost when
    /// the agent gives none (#23). Claude Code writes 1-hour caches, priced higher
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<BTreeMap<String, [f64; 5]>>,
}

/// Claude's "waiting for your input" reminder (notification_type idle_prompt; older versions: the message)
pub fn is_idle_reminder(detail: Option<&str>) -> bool {
    detail.is_some_and(|d| d == "idle_prompt" || d.contains("waiting for your input"))
}

pub fn tool_state(tool: Option<&str>) -> &'static str {
    match tool.unwrap_or("") {
        // Claude names, then Gemini CLI's (A2), then OpenCode's (lower case)
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" | "write_file" | "replace" | "edit" | "write" | "patch" | "multiedit" => "coding",
        "WebSearch" | "WebFetch" | "web_fetch" | "google_web_search" | "webfetch" | "websearch" => "searching",
        "Read" | "Grep" | "Glob" | "LS" | "read_file" | "read_many_files" | "glob" | "search_file_content" | "list_directory" | "read" | "grep" | "list" => "reading",
        "Bash" | "BashOutput" | "KillShell" | "run_shell_command" | "bash" => "bash",
        "Task" | "Agent" | "task" => "agent",
        _ => "tool",
    }
}

pub const LOG_MAX: usize = 300;

pub struct State {
    pub state: &'static str,
    pub since: Instant,
    pub tool: Option<String>,
    pub detail: Option<String>,
    pub log: VecDeque<Event>,
}

impl Default for State {
    fn default() -> Self {
        State { state: "idle", since: Instant::now(), tool: None, detail: None, log: VecDeque::new() }
    }
}

impl State {
    pub fn set(&mut self, state: &'static str, ev: Option<&Event>, now: Instant) {
        self.state = state;
        self.since = now;
        if let Some(ev) = ev {
            if ev.tool.is_some() {
                self.tool = ev.tool.clone();
            }
            self.detail = ev.detail.clone();
        }
    }

    /// Applies a normalized event; returns the previous state.
    pub fn apply(&mut self, ev: Event, now: Instant) -> &'static str {
        let prev = self.state;
        match ev.event.as_str() {
            "SessionStart" => self.set("idle", Some(&ev), now),
            "UserPromptSubmit" => self.set("thinking", Some(&ev), now),
            "PreToolUse" => self.set(tool_state(ev.tool.as_deref()), Some(&ev), now),
            // back to thinking only inside a turn: Claude also sends SubagentStop *after* Stop (and
            // on its own, e.g. background helpers) — that must not undo "done" (seen 2026-10-01)
            "PostToolUse" | "SubagentStop" => {
                if WORKING.contains(&self.state) || self.state == "waiting" {
                    self.set("thinking", None, now);
                }
            }
            // a real "needs you" (permission, question) — not Claude's reminder that it is idle and
            // waiting for the next prompt (it sends that one after a while of nothing): that one
            // turned a resting shell into "입력 필요" and hid other shells' "완료" (2026-10-02)
            "Notification" if is_idle_reminder(ev.detail.as_deref()) => {}
            "Notification" => self.set("waiting", Some(&ev), now),
            "Stop" => self.set("done", None, now),
            // how a turn ended: done (EXP, wild encounters) / interrupted (Esc) / error (API error,
            // rate limit …) — the partner reacts to each, then all three settle to idle
            "Interrupted" => self.set("interrupted", Some(&ev), now), // cancelled: no "done" (no EXP)
            "StopFailure" => self.set("error", Some(&ev), now),
            "PreCompact" => self.set("compact", Some(&ev), now),
            "SessionEnd" => self.set("sleep", None, now),
            _ => {}
        }
        if ev.event != "PostToolUse" {
            self.log.push_back(ev);
            if self.log.len() > LOG_MAX {
                self.log.pop_front();
            }
        }
        prev
    }

    /// done / interrupted / error -> idle after 6 s, idle -> sleep after 3 min.
    pub fn tick(&mut self, now: Instant) -> bool {
        let age = now.saturating_duration_since(self.since);
        if matches!(self.state, "done" | "interrupted" | "error") && age >= Duration::from_secs(6) {
            self.set("idle", None, now);
            return true;
        }
        if self.state == "idle" && age >= Duration::from_secs(180) {
            self.set("sleep", None, now);
            return true;
        }
        false
    }
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64()
}

/// Usage from Claude's statusLine JSON snapshot.
pub fn usage_from_status(st: &Value) -> Usage {
    let win = |k: &str| {
        let w = &st["rate_limits"][k];
        num(&w["used_percentage"]).map(|pct| Window { pct, resets_at: w["resets_at"].as_i64() })
    };
    Usage {
        model: st["model"]["display_name"].as_str().map(Into::into),
        ctx: num(&st["context_window"]["used_percentage"]),
        five_hour: win("five_hour"),
        seven_day: win("seven_day"),
        cost: num(&st["cost"]["total_cost_usd"]),
        model_id: st["model"]["id"].as_str().map(Into::into),
        ctx_window: num(&st["context_window"]["context_window_size"]),
        ctx_tokens: None,
        tokens: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(e: &str, tool: Option<&str>) -> Event {
        Event::new(e, tool, None)
    }

    #[test]
    fn tools_map_to_states() {
        let t0 = Instant::now();
        let mut s = State::default();
        s.apply(ev("UserPromptSubmit", None), t0);
        assert_eq!(s.state, "thinking");
        for (tool, want) in [("Edit", "coding"), ("Grep", "reading"), ("WebFetch", "searching"), ("Bash", "bash"), ("Task", "agent"), ("mcp__x", "tool")] {
            s.apply(ev("PreToolUse", Some(tool)), t0);
            assert_eq!(s.state, want, "{tool}");
        }
        for (tool, want) in [("read_file", "reading"), ("replace", "coding"), ("run_shell_command", "bash"), ("google_web_search", "searching")] {
            s.apply(ev("PreToolUse", Some(tool)), t0);
            assert_eq!(s.state, want, "gemini {tool}");
        }
        for (tool, want) in [("edit", "coding"), ("read", "reading"), ("bash", "bash"), ("webfetch", "searching"), ("task", "agent"), ("todowrite", "tool")] {
            s.apply(ev("PreToolUse", Some(tool)), t0);
            assert_eq!(s.state, want, "opencode {tool}");
        }
        // Claude's idle reminder is not "needs you"
        let before = s.state;
        s.apply(Event::new("Notification", None, Some("idle_prompt".into())), t0);
        s.apply(Event::new("Notification", None, Some("Claude is waiting for your input".into())), t0);
        assert_eq!(s.state, before);
        s.apply(Event::new("Notification", None, Some("permission_prompt".into())), t0);
        assert_eq!(s.state, "waiting");
        s.apply(ev("Notification", None), t0);
        assert_eq!(s.state, "waiting");
        assert_eq!(s.apply(ev("Stop", None), t0), "waiting");
        assert_eq!(s.state, "done");
    }

    #[test]
    fn interrupted_is_not_done_and_post_tool_use_is_not_logged() {
        let t0 = Instant::now();
        let mut s = State::default();
        s.apply(ev("UserPromptSubmit", None), t0);
        s.apply(ev("PostToolUse", None), t0);
        s.apply(ev("Interrupted", None), t0);
        assert_eq!(s.state, "interrupted");
        assert!(s.tick(t0 + Duration::from_secs(6)));
        assert_eq!(s.state, "idle");
        assert_eq!(s.log.iter().map(|e| e.event.as_str()).collect::<Vec<_>>(), ["UserPromptSubmit", "Interrupted"]);
    }

    #[test]
    fn subagent_stop_after_stop_keeps_done() {
        let t0 = Instant::now();
        let mut s = State::default();
        s.apply(ev("UserPromptSubmit", None), t0);
        s.apply(ev("PreToolUse", Some("Task")), t0);
        s.apply(ev("SubagentStop", None), t0);
        assert_eq!(s.state, "thinking", "a subagent finishing mid-turn");
        s.apply(ev("Stop", None), t0);
        s.apply(ev("SubagentStop", None), t0);
        assert_eq!(s.state, "done");
        s.tick(t0 + Duration::from_secs(6));
        s.apply(ev("SubagentStop", None), t0 + Duration::from_secs(7));
        assert_eq!(s.state, "idle");
    }

    #[test]
    fn failure_is_error_then_idle() {
        let t0 = Instant::now();
        let mut s = State::default();
        s.apply(ev("UserPromptSubmit", None), t0);
        assert_eq!(s.apply(ev("StopFailure", None), t0), "thinking");
        assert_eq!(s.state, "error");
        assert!(!s.tick(t0 + Duration::from_secs(5)));
        assert!(s.tick(t0 + Duration::from_secs(6)));
        assert_eq!(s.state, "idle");
    }

    #[test]
    fn timeouts() {
        let t0 = Instant::now();
        let mut s = State::default();
        s.apply(ev("Stop", None), t0);
        assert!(!s.tick(t0 + Duration::from_secs(5)));
        assert!(s.tick(t0 + Duration::from_secs(6)));
        assert_eq!(s.state, "idle");
        assert!(s.tick(t0 + Duration::from_secs(6 + 180)));
        assert_eq!(s.state, "sleep");
    }

    #[test]
    fn log_is_bounded() {
        let t0 = Instant::now();
        let mut s = State::default();
        for _ in 0..(LOG_MAX + 50) {
            s.apply(ev("UserPromptSubmit", None), t0);
        }
        assert_eq!(s.log.len(), LOG_MAX);
    }

    #[test]
    fn hook_line_with_empty_fields() {
        let e: Event = serde_json::from_str(r#"{"event":"Stop","ts":1,"tool":"","detail":""}"#).unwrap();
        assert_eq!(e.tool, None);
        assert_eq!(e.detail, None);
    }

    #[test]
    fn status_usage() {
        let st = serde_json::json!({
            "model": {"display_name": "Opus"}, "context_window": {"used_percentage": 42},
            "rate_limits": {"five_hour": {"used_percentage": 55, "resets_at": 100}, "seven_day": {"used_percentage": 81}},
            "cost": {"total_cost_usd": 1.5}
        });
        let u = usage_from_status(&st);
        assert_eq!(u.model.as_deref(), Some("Opus"));
        assert_eq!(u.ctx, Some(42.0));
        assert_eq!(u.five_hour, Some(Window { pct: 55.0, resets_at: Some(100) }));
        assert_eq!(u.seven_day, Some(Window { pct: 81.0, resets_at: None }));
        assert_eq!(u.cost, Some(1.5));
    }
}
