//! Claude transcript adapter (A2): follows the conversation log Claude Code writes itself,
//!   $CLAUDE_CONFIG_DIR/projects/<folder with every non-alphanumeric char as "-">/<session>.jsonl
//! (CLAUDE_CONFIG_DIR = ~/.claude) — for a Claude started by hand in the shell pane, which has no
//! CVIM hooks. Read-only, like the Codex adapter; only record kinds, tool names and short tool
//! arguments are used (never message text). What it can't see: waiting for a permission prompt.
//!   prompt → UserPromptSubmit · tool_use → PreToolUse · tool_result → PostToolUse
//!   system/turn_duration → Stop · "[Request interrupted by user…]" → Interrupted
//!   isApiErrorMessage → StopFailure · system/compact_boundary → PreCompact

use crate::state::{Event, Usage};
use crate::tail;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

pub struct ClaudeLog {
    pub dir: PathBuf,
    pub started: SystemTime,
    pub file: Option<PathBuf>,
    pub offset: u64,
    pub scanned: Option<Instant>,
}

pub fn config_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".claude"))
}

/// The folder name Claude Code uses for a project: the path with every non-alphanumeric char as "-".
pub fn project_dir_name(cwd: &Path) -> String {
    let real = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    real.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

impl ClaudeLog {
    pub fn new(cwd: &Path) -> Self {
        ClaudeLog {
            dir: config_dir().join("projects").join(project_dir_name(cwd)),
            started: SystemTime::now() - Duration::from_secs(2),
            file: None,
            offset: 0,
            scanned: None,
        }
    }
}

/// Newest unclaimed conversation of this folder written since the agent started.
pub fn find_log(c: &ClaudeLog, claimed: &HashMap<PathBuf, String>) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, SystemTime)> = None;
    for e in std::fs::read_dir(&c.dir).ok()?.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if modified < c.started || (claimed.contains_key(&path) && c.file.as_ref() != Some(&path)) {
            continue;
        }
        let born = meta.created().unwrap_or(modified);
        if best.as_ref().is_none_or(|(_, t)| born > *t) {
            best = Some((path, born));
        }
    }
    best.map(|(p, _)| p)
}

fn short(s: &str) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(200).collect()
}

fn ev(e: &str, tool: Option<&str>, detail: Option<String>) -> Option<Event> {
    Some(Event::new(e, tool, detail))
}

/// One transcript record -> normalized event (or None).
pub fn translate(rec: &Value) -> Option<Event> {
    if rec["isSidechain"] == true || rec["isMeta"] == true {
        return None; // a subagent's own conversation / injected context
    }
    let content = &rec["message"]["content"];
    match rec["type"].as_str()? {
        "system" => match rec["subtype"].as_str()? {
            "turn_duration" => ev("Stop", None, None),
            "compact_boundary" => ev("PreCompact", None, Some("compact".into())),
            _ => None,
        },
        "assistant" => {
            if rec["isApiErrorMessage"] == true {
                return ev("StopFailure", None, Some("api_error".into()));
            }
            let tool = content.as_array()?.iter().find(|b| b["type"] == "tool_use")?;
            let name = tool["name"].as_str().unwrap_or("?");
            let i = &tool["input"];
            let detail = ["file_path", "notebook_path", "path", "command", "pattern", "url", "query", "description"]
                .iter()
                .find_map(|k| i[*k].as_str())
                .map(short);
            ev("PreToolUse", Some(name), detail)
        }
        "user" => {
            // the text of a prompt is only checked for the interrupt marker, never kept
            let text = match content {
                Value::String(s) => Some(s.as_str()),
                Value::Array(a) => {
                    if a.iter().any(|b| b["type"] == "tool_result") {
                        return ev("PostToolUse", None, None);
                    }
                    a.iter().find(|b| b["type"] == "text").and_then(|b| b["text"].as_str())
                }
                _ => None,
            }?;
            let t = text.trim_start();
            if t.starts_with("[Request interrupted by user") {
                ev("Interrupted", None, Some("Esc".into()))
            } else if t.starts_with("<command-") || t.starts_with("<local-command") {
                None // slash commands and their output: no turn
            } else {
                ev("UserPromptSubmit", None, None)
            }
        }
        _ => None,
    }
}

/// "claude-opus-5-5" / "claude-haiku-4-5-20251001" -> "Opus 5.5" / "Haiku 4.5"
pub fn model_name(id: &str) -> String {
    let mut parts = id.trim_start_matches("claude-").split('-').filter(|p| !(p.len() == 8 && p.chars().all(|c| c.is_ascii_digit())));
    let family = parts.next().unwrap_or(id);
    let mut name: String = family.chars().take(1).flat_map(char::to_uppercase).chain(family.chars().skip(1)).collect();
    let version: Vec<&str> = parts.collect();
    if !version.is_empty() {
        name.push(' ');
        name.push_str(&version.join("."));
    }
    name
}

/// The model and context size of the conversation (assistant replies carry both); `changed` = moved
pub fn read_usage(usage: &mut Option<Usage>, changed: &mut bool, rec: &Value) {
    if rec["type"] != "assistant" || rec["isSidechain"] == true {
        return;
    }
    let m = &rec["message"];
    let Some(id) = m["model"].as_str().filter(|id| id.starts_with("claude-")) else { return }; // not "<synthetic>"
    let u = &m["usage"];
    let tokens = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].iter().filter_map(|k| u[*k].as_f64()).sum::<f64>();
    let cur = usage.get_or_insert_with(Usage::default);
    let next = Usage { model: Some(model_name(id)), model_id: Some(id.into()), ctx_tokens: (tokens > 0.0).then_some(tokens).or(cur.ctx_tokens), ..cur.clone() };
    if *cur != next {
        *cur = next;
        *changed = true;
    }
}

/// Events since the last poll (looks for the conversation every 1 s, then every 3 s for /clear).
pub fn poll(c: &mut ClaudeLog, usage: &mut Option<Usage>, changed: &mut bool, claimed: &mut HashMap<PathBuf, String>, ws: &str, now: Instant) -> Vec<Event> {
    let every = if c.file.is_some() { Duration::from_secs(3) } else { Duration::from_secs(1) };
    if c.scanned.is_none_or(|t| now.saturating_duration_since(t) >= every) {
        c.scanned = Some(now);
        if let Some(found) = find_log(c, claimed) {
            if c.file.as_ref() != Some(&found) {
                if let Some(old) = c.file.take() {
                    claimed.remove(&old);
                }
                claimed.insert(found.clone(), ws.to_string());
                // a conversation picked up mid-way (resumed): only what's written from now on
                c.offset = std::fs::metadata(&found).map(|m| m.len()).unwrap_or(0);
                if std::fs::metadata(&found).and_then(|m| m.created()).is_ok_and(|b| b >= c.started) {
                    c.offset = 0;
                }
                c.file = Some(found);
            }
        }
    }
    let Some(file) = c.file.clone() else { return vec![] };
    let recs: Vec<Value> = tail::new_lines(&file, &mut c.offset).iter().filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect();
    for r in &recs {
        read_usage(usage, changed, r);
    }
    recs.iter().filter_map(translate).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_transcript_records() {
        let recs = [
            json!({"type":"user","message":{"role":"user","content":"고쳐줘"}}),
            json!({"type":"user","isMeta":true,"message":{"role":"user","content":"<system-reminder>…"}}),
            json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"…"}]}}),
            json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/a/b.rs","old_string":"x"}}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}),
            json!({"type":"assistant","isSidechain":true,"message":{"content":[{"type":"tool_use","name":"Read","input":{}}]}}),
            json!({"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}),
            json!({"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error"}]}}),
            json!({"type":"user","message":{"content":"<command-name>/clear</command-name>"}}),
            json!({"type":"system","subtype":"compact_boundary"}),
            json!({"type":"system","subtype":"turn_duration","durationMs":1200}),
            json!({"type":"attachment"}),
        ];
        let got: Vec<(String, Option<String>, Option<String>)> =
            recs.iter().filter_map(translate).map(|e| (e.event, e.tool, e.detail)).collect();
        let s = |x: &str| Some(x.to_string());
        assert_eq!(got, vec![
            ("UserPromptSubmit".into(), None, None),
            ("PreToolUse".into(), s("Edit"), s("/a/b.rs")),
            ("PostToolUse".into(), None, None),
            ("Interrupted".into(), None, s("Esc")),
            ("StopFailure".into(), None, s("api_error")),
            ("PreCompact".into(), None, s("compact")),
            ("Stop".into(), None, None),
        ]);
    }

    #[test]
    fn model_and_context_from_replies() {
        assert_eq!(model_name("claude-opus-5-5"), "Opus 5.5");
        assert_eq!(model_name("claude-haiku-4-5-20251001"), "Haiku 4.5");
        let (mut u, mut ch) = (None, false);
        read_usage(&mut u, &mut ch, &json!({"type":"assistant","message":{"model":"<synthetic>","usage":{}}}));
        assert!(u.is_none() && !ch);
        read_usage(&mut u, &mut ch, &json!({"type":"assistant","message":{"model":"claude-opus-5-5","usage":{"input_tokens":2,"cache_creation_input_tokens":23911,"cache_read_input_tokens":25147,"output_tokens":33}}}));
        let got = u.clone().unwrap();
        assert!(ch);
        assert_eq!((got.model.as_deref(), got.model_id.as_deref(), got.ctx_tokens), (Some("Opus 5.5"), Some("claude-opus-5-5"), Some(49060.0)));
        ch = false;
        read_usage(&mut u, &mut ch, &json!({"type":"assistant","isSidechain":true,"message":{"model":"claude-haiku-4-5","usage":{"input_tokens":9}}}));
        assert!(!ch);
    }

    #[test]
    fn project_folder_name_like_claude_code() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("my.app_v2");
        std::fs::create_dir(&p).unwrap();
        let name = project_dir_name(&p);
        assert!(name.ends_with("-my-app-v2"), "{name}");
        assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }
}
