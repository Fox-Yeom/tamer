//! Session titles (#99, TAB-20, POL-DATA-02 rule 3): the one line an agent writes to name a
//! conversation — never the conversation itself. Only lines that carry a title are parsed; every
//! other line is skipped unread, and the title lives in memory only.
//!
//!   Claude Code transcript:  {"type":"custom-title","customTitle":…}  (/rename)
//!                            {"type":"agent-name","agentName":…}
//!                            {"type":"ai-title","aiTitle":…}          (its own, rewritten as it goes)
//!   Codex:                   $CODEX_HOME/session_index.jsonl  {"id":…,"thread_name":…,"updated_at":…}

use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Longest title kept (a title, not a paragraph).
pub const TITLE_MAX: usize = 80;

fn clean(s: &str) -> Option<String> {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return None;
    }
    Some(t.chars().take(TITLE_MAX).collect())
}

/// Calls `f` for each complete line appended since `*offset` that contains one of `marks`, and
/// advances the offset past the last complete line. Lines without a mark aren't parsed.
fn scan(path: &Path, offset: &mut u64, marks: &[&str], mut f: impl FnMut(&Value)) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if meta.len() < *offset {
        *offset = 0; // replaced: start over
    }
    if meta.len() == *offset {
        return false;
    }
    let Ok(mut file) = File::open(path) else { return false };
    if file.seek(SeekFrom::Start(*offset)).is_err() {
        return false;
    }
    let mut r = BufReader::new(file);
    let mut line = Vec::new();
    let mut found = false;
    loop {
        line.clear();
        match r.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if line.last() != Some(&b'\n') {
                    break; // still being written: read it next time
                }
                *offset += n as u64;
                let text = String::from_utf8_lossy(&line);
                if marks.iter().any(|m| text.contains(m)) {
                    if let Ok(v) = serde_json::from_str::<Value>(&text) {
                        f(&v);
                        found = true;
                    }
                }
            }
        }
    }
    found
}

/// A Claude Code conversation's title, followed as the transcript grows.
pub struct ClaudeTitle {
    pub path: PathBuf,
    offset: u64,
    custom: Option<String>,
    agent: Option<String>,
    ai: Option<String>,
}

impl ClaudeTitle {
    pub fn new(path: &Path) -> Self {
        ClaudeTitle { path: path.into(), offset: 0, custom: None, agent: None, ai: None }
    }

    /// Reads what was appended; true when the title changed.
    pub fn poll(&mut self) -> bool {
        let before = self.title();
        let (custom, agent, ai) = (&mut self.custom, &mut self.agent, &mut self.ai);
        scan(&self.path, &mut self.offset, &["\"custom-title\"", "\"agent-name\"", "\"ai-title\""], |v| {
            let s = |k: &str| v[k].as_str().and_then(clean);
            match v["type"].as_str() {
                Some("custom-title") => *custom = s("customTitle"),
                Some("agent-name") => *agent = s("agentName"),
                Some("ai-title") => *ai = s("aiTitle").or(ai.take()),
                _ => {}
            }
        });
        self.title() != before
    }

    /// The name the user gave it (/rename) first, then Claude's own.
    pub fn title(&self) -> Option<String> {
        self.custom.clone().or_else(|| self.agent.clone()).or_else(|| self.ai.clone())
    }
}

/// A Codex session's name, from the index Codex keeps of its sessions.
pub struct CodexTitle {
    pub id: String,
    index: PathBuf,
    offset: u64,
    title: Option<String>,
}

/// The session id in a Codex log's name: rollout-2026-10-19T10-00-00-<uuid>.jsonl
pub fn codex_id(file: &Path) -> Option<String> {
    let stem = file.file_stem()?.to_str()?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    (id.len() == 36 && id.chars().filter(|&c| c == '-').count() == 4).then(|| id.to_string())
}

impl CodexTitle {
    pub fn new(home: &Path, id: &str) -> Self {
        CodexTitle { id: id.into(), index: home.join("session_index.jsonl"), offset: 0, title: None }
    }

    pub fn poll(&mut self) -> bool {
        let before = self.title.clone();
        let (id, title) = (&self.id, &mut self.title);
        let mark = format!("\"{id}\"");
        scan(&self.index, &mut self.offset, &[&mark], |v| {
            if v["id"].as_str() == Some(id.as_str()) {
                if let Some(t) = v["thread_name"].as_str().and_then(clean) {
                    *title = Some(t);
                }
            }
        });
        self.title != before
    }

    pub fn title(&self) -> Option<String> {
        self.title.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn append(path: &Path, text: &str) {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    #[test]
    fn title_claude_latest_ai_title_and_rename_wins() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        append(&p, "{\"type\":\"user\",\"message\":{\"content\":\"secret prompt ai-title\"}}\n");
        let mut t = ClaudeTitle::new(&p);
        assert!(!t.poll());
        assert_eq!(t.title(), None);
        append(&p, "{\"type\":\"ai-title\",\"aiTitle\":\"Fix login\",\"sessionId\":\"x\"}\n");
        assert!(t.poll());
        assert_eq!(t.title().as_deref(), Some("Fix login"));
        append(&p, "{\"type\":\"ai-title\",\"aiTitle\":\"Fix login  bug\",\"sessionId\":\"x\"}\n");
        assert!(t.poll());
        assert_eq!(t.title().as_deref(), Some("Fix login bug"));
        append(&p, "{\"type\":\"custom-title\",\"customTitle\":\"auth\",\"sessionId\":\"x\"}\n");
        assert!(t.poll());
        assert_eq!(t.title().as_deref(), Some("auth"));
        // a later AI title doesn't replace the user's name
        append(&p, "{\"type\":\"ai-title\",\"aiTitle\":\"Other\",\"sessionId\":\"x\"}\n");
        assert!(!t.poll());
        assert_eq!(t.title().as_deref(), Some("auth"));
    }

    #[test]
    fn title_claude_waits_for_a_whole_line_and_caps_length() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        append(&p, "{\"type\":\"ai-title\",\"aiTitle\":\"half");
        let mut t = ClaudeTitle::new(&p);
        assert!(!t.poll());
        append(&p, &format!("{}\"}}\n", "x".repeat(200)));
        assert!(t.poll());
        assert_eq!(t.title().unwrap().chars().count(), TITLE_MAX);
    }

    #[test]
    fn title_codex_from_its_index() {
        let dir = tempfile::tempdir().unwrap();
        let id = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b";
        assert_eq!(codex_id(&dir.path().join(format!("rollout-2026-10-19T10-00-00-{id}.jsonl"))).as_deref(), Some(id));
        assert_eq!(codex_id(&dir.path().join("rollout-a.jsonl")), None);
        let idx = dir.path().join("session_index.jsonl");
        append(&idx, "{\"id\":\"other\",\"thread_name\":\"Nope\",\"updated_at\":\"x\"}\n");
        let mut t = CodexTitle::new(dir.path(), id);
        assert!(!t.poll());
        append(&idx, &format!("{{\"id\":\"{id}\",\"thread_name\":\"Add tests\",\"updated_at\":\"x\"}}\n"));
        assert!(t.poll());
        assert_eq!(t.title().as_deref(), Some("Add tests"));
    }
}
