//! One workspace = one agent process in one folder, with its state source (Kind).

use crate::claude::{self, ClaudeLog};
use crate::codex::{self, Codex};
use crate::state::{self, Event, Kind, State, Usage};
use crate::tail;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

pub struct Workspace {
    pub id: String,
    pub kind: Kind,
    pub cwd: PathBuf,
    tabs: PathBuf,
    pub st: State,
    offset: u64,
    status: Option<Value>,
    status_mtime: Option<SystemTime>,
    usage: Option<Usage>,
    codex: Option<Codex>,
    claude: Option<ClaudeLog>,
    hits: VecDeque<u8>,
    output_seen: bool,
    last_output: Option<Instant>,
    /// Esc / Ctrl-C typed into a working Claude (it has no interrupt hook — code.claude.com/docs/en/hooks:
    /// Stop "does not run if the stoppage occurred due to a user interrupt")
    esc_at: Option<Instant>,
    pub last_sent: String,
    /// activity: when the current stretch of output began (a long one that goes quiet = "done", guessed)
    busy_since: Option<Instant>,
    /// an agent moved here from another shell keeps writing its hook log under that shell's id
    /// (its CVIM_TAB_ID can't change): read that log instead of this workspace's
    pub log_id: Option<String>,
    /// hooks: an event has arrived since the agent started (none for a while = fall back to output)
    any_event: bool,
    started: Instant,
}

/// Output for this long, then quiet: an agent without events finished something (EXP, no wild).
pub const GUESS_DONE_AFTER: Duration = Duration::from_secs(15);
/// An agent that should report events (hooks) but hasn't for this long is followed by its output.
pub const HOOKS_GRACE: Duration = Duration::from_secs(20);

/// A hook log is only read once (the state keeps the last events): past this size it starts over.
pub const LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// CVIM's data is the user's alone (POLICY 11.3): the tabs folder is 700.
fn private_dir(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
}

/// How long a working Claude may stay silent after Esc / Ctrl-C before it counts as interrupted.
pub const ESC_GRACE: Duration = Duration::from_millis(1500);

pub struct Polled {
    pub changed: bool,
    /// state changes that matter to the main process (e.g. -> "done": partner EXP)
    pub transitions: Vec<(&'static str, &'static str)>,
    /// the "done" among them was guessed from output (no event said so)
    pub guessed: bool,
}

impl Workspace {
    pub fn new(id: &str, kind: Kind, cwd: &Path, tabs: &Path) -> Self {
        let mut ws = Workspace {
            id: id.into(), kind, cwd: cwd.into(), tabs: tabs.into(), st: State::default(),
            offset: 0, status: None, status_mtime: None, usage: None, codex: None, claude: None,
            hits: VecDeque::new(), output_seen: false, last_output: None, esc_at: None, last_sent: String::new(),
            busy_since: None, any_event: false, started: Instant::now(), log_id: None,
        };
        ws.restart(kind);
        ws
    }

    fn files(&self) -> [PathBuf; 2] {
        let id = self.log_id.as_deref().unwrap_or(&self.id);
        [self.tabs.join(format!("{id}.log")), self.tabs.join(format!("{id}.status.json"))]
    }

    /// A new agent process (start / ⌘G switch): fresh state, start clean.
    pub fn restart(&mut self, kind: Kind) {
        let _ = std::fs::create_dir_all(&self.tabs);
        private_dir(&self.tabs);
        self.remove_files();
        self.kind = kind;
        self.st = State::default();
        self.offset = 0;
        self.status = None;
        self.status_mtime = None;
        self.usage = None;
        self.hits.clear();
        self.output_seen = false;
        self.esc_at = None;
        self.busy_since = None;
        self.any_event = false;
        self.started = Instant::now();
        self.codex = (kind == Kind::CodexLog).then(|| Codex::new(&self.cwd));
        self.claude = (kind == Kind::ClaudeLog).then(|| ClaudeLog::new(&self.cwd));
        self.last_sent.clear();
    }

    pub fn remove_files(&self) {
        for f in self.files() {
            let _ = std::fs::remove_file(f);
        }
    }

    pub fn codex_file(&self) -> Option<PathBuf> {
        self.codex.as_ref().and_then(|c| c.file.clone()).or_else(|| self.claude.as_ref().and_then(|c| c.file.clone()))
    }

    pub fn output(&mut self) {
        self.output_seen = true;
    }

    /// The user pressed Esc / Ctrl-C in the agent pane. Claude (hooks) only: Codex logs its own
    /// `turn_aborted`, activity agents have no turns.
    pub fn esc(&mut self, now: Instant) {
        if self.kind == Kind::Hooks && state::WORKING.contains(&self.st.state) {
            self.esc_at = Some(now);
        }
    }

    pub fn usage(&self) -> Option<Usage> {
        match self.kind {
            Kind::Hooks => self.status.as_ref().map(state::usage_from_status),
            _ => self.usage.clone(),
        }
    }

    pub fn payload(&self) -> Value {
        let log: Vec<&Event> = self.st.log.iter().rev().take(12).rev().collect();
        json!({
            "state": self.st.state, "tool": self.st.tool, "detail": self.st.detail,
            "usage": self.usage(), "log": log,
        })
    }

    fn apply(&mut self, ev: Event, now: Instant, out: &mut Polled) {
        let prev = self.st.apply(ev, now);
        if prev != self.st.state {
            out.transitions.push((prev, self.st.state));
        }
        out.changed = true;
    }

    /// Output in ≥ 3 of the last 8 polls = working; 5 s quiet = idle — or "done" (guessed) after
    /// a stretch of work of GUESS_DONE_AFTER or more.
    fn by_output(&mut self, now: Instant, out: &mut Polled) {
        self.hits.push_back(self.output_seen as u8);
        if self.output_seen {
            self.last_output = Some(now);
        }
        self.output_seen = false;
        if self.hits.len() > 8 {
            self.hits.pop_front();
        }
        let hits: u8 = self.hits.iter().sum();
        if self.st.state != "thinking" && hits >= 3 {
            self.busy_since = Some(now);
            self.apply(Event::new("UserPromptSubmit", None, Some("출력 중".into())), now, out);
        } else if self.st.state == "thinking"
            && self.last_output.is_none_or(|t| now.saturating_duration_since(t) >= Duration::from_secs(5))
        {
            let long = self.busy_since.is_some_and(|t| now.saturating_duration_since(t) >= GUESS_DONE_AFTER + Duration::from_secs(5));
            self.busy_since = None;
            if long {
                self.apply(Event::new("Stop", None, Some("추정".into())), now, out);
                out.guessed = true;
            } else {
                let prev = self.st.state;
                self.st.set("idle", None, now);
                out.transitions.push((prev, "idle"));
                out.changed = true;
            }
        }
    }

    pub fn poll(&mut self, claimed: &mut HashMap<PathBuf, String>, now: Instant) -> Polled {
        let mut out = Polled { changed: false, transitions: vec![], guessed: false };
        match self.kind {
            Kind::Hooks => {
                let [log, status] = self.files();
                for line in tail::new_lines(&log, &mut self.offset) {
                    if let Ok(ev) = serde_json::from_str::<Event>(&line) {
                        self.esc_at = None; // it's still talking: the key didn't stop the turn
                        self.any_event = true;
                        self.apply(ev, now, &mut out);
                    }
                }
                // no event at all yet, long after start (an old Gemini, a hook that can't run):
                // follow the output instead, so it doesn't look stuck
                if !self.any_event && now.saturating_duration_since(self.started) >= HOOKS_GRACE {
                    self.by_output(now, &mut out);
                }
                // a long session's log: everything is read, so it can start over (the hook appends)
                if self.offset > LOG_MAX_BYTES {
                    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&log) {
                        let _ = f.set_len(0);
                        self.offset = 0;
                    }
                }
                // Esc / Ctrl-C and then silence while working = the turn was interrupted
                if let Some(t) = self.esc_at {
                    if !state::WORKING.contains(&self.st.state) {
                        self.esc_at = None;
                    } else if now.saturating_duration_since(t) >= ESC_GRACE {
                        self.esc_at = None;
                        self.apply(Event::new("Interrupted", None, Some("Esc".into())), now, &mut out);
                    }
                }
                if let Ok(meta) = std::fs::metadata(&status) {
                    let m = meta.modified().ok();
                    if m != self.status_mtime {
                        self.status_mtime = m;
                        if let Ok(Ok(v)) = std::fs::read_to_string(&status).map(|s| serde_json::from_str(&s)) {
                            self.status = Some(v);
                            out.changed = true;
                        }
                    }
                }
            }
            Kind::CodexLog => {
                let mut changed = false;
                let id = self.id.clone();
                let evs = match self.codex.as_mut() {
                    Some(c) => codex::poll(c, &mut self.usage, &mut changed, claimed, &id, now),
                    None => vec![],
                };
                for ev in evs {
                    self.apply(ev, now, &mut out);
                }
                out.changed |= changed;
            }
            Kind::ClaudeLog => {
                let id = self.id.clone();
                let mut changed = false;
                let evs = match self.claude.as_mut() {
                    Some(c) => claude::poll(c, &mut self.usage, &mut changed, claimed, &id, now),
                    None => vec![],
                };
                for ev in evs {
                    self.apply(ev, now, &mut out);
                }
                out.changed |= changed;
            }
            Kind::Activity => self.by_output(now, &mut out),
        }
        let prev = self.st.state;
        if self.st.tick(now) {
            out.transitions.push((prev, self.st.state));
            out.changed = true;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // output for a while, then quiet: short stretch = idle, long stretch = done (guessed)
    fn run_output(ws: &mut Workspace, claimed: &mut HashMap<PathBuf, String>, t0: Instant, secs: u64) -> (Vec<(&'static str, &'static str)>, bool) {
        let (mut tr, mut guessed) = (vec![], false);
        let step = Duration::from_millis(250);
        let mut t = t0;
        for _ in 0..(secs * 4) {
            ws.output();
            let p = ws.poll(claimed, t);
            tr.extend(p.transitions);
            guessed |= p.guessed;
            t += step;
        }
        for _ in 0..(8 * 4) {
            let p = ws.poll(claimed, t);
            tr.extend(p.transitions);
            guessed |= p.guessed;
            t += step;
        }
        (tr, guessed)
    }

    #[test]
    fn output_only_agents_guess_done_after_long_work() {
        let tabs = tempfile::tempdir().unwrap();
        let mut claimed = HashMap::new();
        let mut ws = Workspace::new("a1", Kind::Activity, Path::new("/tmp"), tabs.path());
        let (tr, guessed) = run_output(&mut ws, &mut claimed, Instant::now(), 3);
        assert_eq!(tr, vec![("idle", "thinking"), ("thinking", "idle")]);
        assert!(!guessed);
        let (tr, guessed) = run_output(&mut ws, &mut claimed, Instant::now() + Duration::from_secs(100), 20);
        assert_eq!(tr, vec![("idle", "thinking"), ("thinking", "done")]);
        assert!(guessed);
    }

    #[test]
    fn hooks_without_any_event_fall_back_to_output() {
        let tabs = tempfile::tempdir().unwrap();
        let mut claimed = HashMap::new();
        let mut ws = Workspace::new("h1", Kind::Hooks, Path::new("/tmp"), tabs.path());
        // within the grace period output means nothing
        let (tr, _) = run_output(&mut ws, &mut claimed, Instant::now(), 3);
        assert!(tr.is_empty(), "{tr:?}");
        // later, still no event: followed by output
        let (tr, guessed) = run_output(&mut ws, &mut claimed, Instant::now() + HOOKS_GRACE + Duration::from_secs(1), 20);
        assert_eq!(tr, vec![("idle", "thinking"), ("thinking", "done")]);
        assert!(guessed);
    }

    #[test]
    fn hooks_workspace_reads_events_and_status() {
        let tabs = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new("t1", Kind::Hooks, Path::new("/tmp"), tabs.path());
        let mut claimed = HashMap::new();
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(tabs.path().join("t1.log")).unwrap();
        writeln!(f, r#"{{"event":"UserPromptSubmit","ts":1,"tool":"","detail":""}}"#).unwrap();
        writeln!(f, r#"{{"event":"PreToolUse","ts":1,"tool":"Edit","detail":"/a/b.lua"}}"#).unwrap();
        std::fs::write(tabs.path().join("t1.status.json"), r#"{"context_window":{"used_percentage":40}}"#).unwrap();
        let t0 = Instant::now();
        let p = ws.poll(&mut claimed, t0);
        assert!(p.changed);
        assert_eq!(ws.st.state, "coding");
        assert_eq!(ws.usage().unwrap().ctx, Some(40.0));
        writeln!(f, r#"{{"event":"Stop","ts":2,"tool":"","detail":""}}"#).unwrap();
        let p = ws.poll(&mut claimed, t0);
        assert_eq!(p.transitions, vec![("coding", "done")]);
        assert_eq!(ws.payload()["log"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn esc_then_silence_is_interrupted_but_not_if_claude_keeps_going() {
        let tabs = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new("t4", Kind::Hooks, Path::new("/tmp"), tabs.path());
        let mut claimed = HashMap::new();
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(tabs.path().join("t4.log")).unwrap();
        let t0 = Instant::now();
        writeln!(f, r#"{{"event":"UserPromptSubmit","ts":1}}"#).unwrap();
        ws.poll(&mut claimed, t0);
        // Esc, but a tool starts right after: not interrupted
        ws.esc(t0);
        writeln!(f, r#"{{"event":"PreToolUse","ts":1,"tool":"Read"}}"#).unwrap();
        ws.poll(&mut claimed, t0 + Duration::from_millis(500));
        let p = ws.poll(&mut claimed, t0 + Duration::from_secs(2));
        assert_eq!(ws.st.state, "reading");
        assert!(p.transitions.is_empty());
        // Esc and then nothing
        ws.esc(t0 + Duration::from_secs(2));
        ws.poll(&mut claimed, t0 + Duration::from_millis(3000));
        assert_eq!(ws.st.state, "reading");
        let p = ws.poll(&mut claimed, t0 + Duration::from_millis(3600));
        assert_eq!(p.transitions, vec![("reading", "interrupted")]);
        // Esc while idle does nothing
        let mut idle = Workspace::new("t5", Kind::Hooks, Path::new("/tmp"), tabs.path());
        idle.esc(t0);
        idle.poll(&mut claimed, t0 + Duration::from_secs(3));
        assert_eq!(idle.st.state, "idle");
    }

    #[test]
    fn big_hook_log_starts_over_and_tabs_dir_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let tabs = tempfile::tempdir().unwrap();
        let dir = tabs.path().join("tabs");
        let mut ws = Workspace::new("t6", Kind::Hooks, Path::new("/tmp"), &dir);
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        let mut claimed = HashMap::new();
        let line = r#"{"event":"PreToolUse","ts":1,"tool":"Read","detail":"x"}"#;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("t6.log")).unwrap();
        for _ in 0..(LOG_MAX_BYTES as usize / line.len() + 10) {
            writeln!(f, "{line}").unwrap();
        }
        ws.poll(&mut claimed, Instant::now());
        assert_eq!(std::fs::metadata(dir.join("t6.log")).unwrap().len(), 0, "read through, then emptied");
        writeln!(f, r#"{{"event":"Stop","ts":2}}"#).unwrap();
        ws.poll(&mut claimed, Instant::now());
        assert_eq!(ws.st.state, "done", "new events after the restart are still read");
    }

    #[test]
    fn restart_starts_clean() {
        let tabs = tempfile::tempdir().unwrap();
        std::fs::write(tabs.path().join("t2.log"), "{\"event\":\"Stop\"}\n").unwrap();
        let ws = Workspace::new("t2", Kind::Hooks, Path::new("/tmp"), tabs.path());
        assert!(!tabs.path().join("t2.log").exists(), "stale hook log from a previous run is removed");
        assert_eq!(ws.st.state, "idle");
    }

    #[test]
    fn activity_busy_then_idle() {
        let tabs = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new("t3", Kind::Activity, Path::new("/tmp"), tabs.path());
        let mut claimed = HashMap::new();
        let t0 = Instant::now();
        for i in 0..3 {
            ws.output();
            ws.poll(&mut claimed, t0 + Duration::from_millis(250 * i));
        }
        assert_eq!(ws.st.state, "thinking");
        ws.poll(&mut claimed, t0 + Duration::from_secs(6));
        assert_eq!(ws.st.state, "idle");
        assert!(ws.st.log.iter().all(|e| e.event != "Stop"), "activity never reports done");
    }
}
