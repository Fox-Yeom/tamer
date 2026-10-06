//! Codex adapter (port of nvim/lua/cvim/adapters/codex.lua): tails the session log Codex writes,
//!   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl   (CODEX_HOME = ~/.codex)
//! A workspace claims the newest log whose session_meta.cwd is its folder and that was written after
//! its Codex process started; a later conversation (/new) in the same folder takes over.
//! Codex's own config (notify, hooks) is never touched.

use crate::state::{Event, Usage, Window};
use crate::tail;
use chrono::{Duration as CDuration, Local};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

pub struct Codex {
    pub cwd: PathBuf,
    pub started: SystemTime,
    pub file: Option<PathBuf>,
    pub offset: u64,
    pub scanned: Option<Instant>,
    pub window: Option<f64>,
    /// the model of the current turn (gpt-5.5), for the tokens' estimated cost
    pub model_id: Option<String>,
    /// the tool call waiting for the user's approval (#50), until its output comes
    pub asking: Option<String>,
}

impl Codex {
    pub fn new(cwd: &Path) -> Self {
        Codex {
            cwd: real(cwd),
            started: SystemTime::now() - Duration::from_secs(2),
            file: None,
            offset: 0,
            scanned: None,
            window: None,
            model_id: None,
            asking: None,
        }
    }
}

fn real(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

pub fn home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".codex"))
}

fn first_line(p: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let f = std::fs::File::open(p).ok()?;
    let mut line = String::new();
    BufReader::new(f).read_line(&mut line).ok()?;
    Some(line)
}

/// Newest unclaimed log for this folder written since the agent started.
pub fn find_log(c: &Codex, claimed: &HashMap<PathBuf, String>, home: &Path) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, SystemTime)> = None;
    for back in [0, 1] {
        // today and yesterday: a session can cross midnight
        let day = Local::now() - CDuration::days(back);
        let dir = home.join("sessions").join(day.format("%Y/%m/%d").to_string());
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !(name.starts_with("rollout-") && name.ends_with(".jsonl")) {
                continue;
            }
            let path = e.path();
            let Ok(meta) = e.metadata() else { continue };
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let born = meta.created().unwrap_or(modified);
            if modified < c.started || (claimed.contains_key(&path) && c.file.as_ref() != Some(&path)) {
                continue;
            }
            if best.as_ref().is_some_and(|(_, t)| born <= *t) {
                continue;
            }
            let Some(meta) = first_line(&path).and_then(|l| serde_json::from_str::<Value>(&l).ok()) else { continue };
            if meta["type"] == "session_meta" && meta["payload"]["cwd"].as_str().map(|d| real(Path::new(d))) == Some(c.cwd.clone()) {
                best = Some((path, born));
            }
        }
    }
    best.map(|(p, _)| p)
}

fn short(s: &str) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(200).collect()
}

fn read_cmd_tool(cmd: &str) -> &'static str {
    match cmd.split_whitespace().next().unwrap_or("") {
        "rg" | "grep" => "Grep",
        "cat" | "sed" | "head" | "tail" | "nl" | "wc" => "Read",
        "ls" => "LS",
        "find" | "fd" => "Glob",
        _ => "Bash",
    }
}

/// The command in the new `exec` tool's input — code like `text(await exec_command({cmd:"npm test", …}))`
fn exec_cmd(code: &str) -> Option<String> {
    let rest = &code[code.find("cmd:")? + 4..];
    let rest = rest.trim_start().strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => out.extend(chars.next()),
            '"' => return Some(out),
            _ => out.push(ch),
        }
    }
    None
}

/// The kind of a failed turn from `codex_error_info`: "server_overloaded" (a unit variant) or
/// {"http_connection_failed": {"http_status_code": 401}} → "http_connection_failed 401"
fn fail_kind(error: &Value) -> Option<String> {
    let info = &error["codex_error_info"];
    let clean = |s: &str| s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(48).collect::<String>();
    match info {
        Value::String(s) => Some(clean(s)),
        Value::Object(m) => m.iter().next().map(|(k, v)| match v.get("http_status_code").and_then(Value::as_u64) {
            Some(code) => format!("{} {code}", clean(k)),
            None => clean(k),
        }),
        _ => None,
    }
}

/// The first file an `apply_patch("*** Begin Patch\\n*** Update File: src/a.ts\\n…")` call in exec
/// code touches — the newlines there are escapes inside a string literal
fn patch_file(code: &str) -> Option<String> {
    for tag in ["*** Update File: ", "*** Add File: ", "*** Delete File: "] {
        if let Some(i) = code.find(tag) {
            let rest = &code[i + tag.len()..];
            let end = rest.find(|c| c == '\\' || c == '"' || c == '\n').unwrap_or(rest.len());
            let f = rest[..end].trim();
            if !f.is_empty() {
                return Some(f.chars().take(200).collect());
            }
        }
    }
    None
}

/// One log record -> normalized event (or None); updates `usage` in place (`changed` = usage moved).
pub fn translate(c: &mut Codex, usage: &mut Option<Usage>, changed: &mut bool, rec: &Value) -> Option<Event> {
    let p = &rec["payload"];
    let ev = |e: &str, tool: Option<&str>, detail: Option<String>| Some(Event::new(e, tool, detail));
    if rec["type"] == "turn_context" {
        if let Some(m) = p["model"].as_str() {
            c.model_id = Some(m.to_string());
            let u = usage.get_or_insert_with(Usage::default);
            u.model = Some(match p["effort"].as_str() {
                Some(e) => format!("{m} {e}"),
                None => m.to_string(),
            });
            *changed = true;
        }
        return None;
    }
    if rec["type"] == "compacted" {
        return ev("PreCompact", None, Some("compact".into()));
    }
    match p["type"].as_str().unwrap_or("") {
        // the next names are already accepted by Codex itself (serde alias) — read both (#55)
        "task_started" | "turn_started" => {
            if let Some(w) = p["model_context_window"].as_f64() {
                c.window = Some(w);
            }
            ev("UserPromptSubmit", None, None)
        }
        // a failed turn ends with task_complete too, its last error in `error` (#53): only the kind is
        // kept — the message carries URLs and request ids. Never the reply text (STA-14)
        "task_complete" | "turn_complete" => match fail_kind(&p["error"]) {
            Some(kind) => ev("StopFailure", None, Some(kind)),
            None if !p["error"].is_null() => ev("StopFailure", None, None),
            None => ev("Stop", None, None),
        },
        "turn_aborted" => ev("Interrupted", None, p["reason"].as_str().map(Into::into)),
        "reasoning" => ev("PostToolUse", None, None),
        "web_search_call" => {
            let a = &p["action"];
            ev("PreToolUse", Some("WebSearch"), Some(short(a["query"].as_str().or(a["url"].as_str()).unwrap_or(""))))
        }
        // the answer to the call that asked for approval: the dialog is gone (approved, denied or ran)
        "function_call_output" | "custom_tool_call_output" => {
            let id = p["call_id"].as_str()?;
            if c.asking.as_deref() != Some(id) {
                return None;
            }
            c.asking = None;
            ev("PostToolUse", None, None)
        }
        "function_call" | "custom_tool_call" => {
            let name = p["name"].as_str().unwrap_or("?");
            let args = p["arguments"].as_str().or(p["input"].as_str()).unwrap_or("");
            // a command to run outside the sandbox: with the on-request policy Codex asks first, and the log
            // has no record of that dialog (#50) — "입력 필요" until this call's output
            if args.contains("require_escalated") {
                c.asking = p["call_id"].as_str().map(Into::into);
                let a: Value = serde_json::from_str(args).unwrap_or(Value::Null);
                let cmd = a["cmd"].as_str().map(Into::into).or_else(|| exec_cmd(args)).unwrap_or_default();
                return ev("PermissionRequest", Some("Bash"), Some(short(&cmd)));
            }
            match name {
                "request_user_input" => ev("Notification", None, Some("입력 요청".into())),
                "apply_patch" => {
                    let file = args.lines().find_map(|l| {
                        let l = l.strip_prefix("*** ")?;
                        let (_, path) = l.split_once(" File: ")?;
                        Some(path.trim().to_string())
                    });
                    ev("PreToolUse", Some("Edit"), Some(file.unwrap_or_else(|| "patch".into())))
                }
                "exec_command" | "write_stdin" => {
                    let a: Value = serde_json::from_str(args).unwrap_or(Value::Null);
                    let cmd = a["cmd"].as_str().or(a["chars"].as_str()).unwrap_or("");
                    ev("PreToolUse", Some(read_cmd_tool(cmd)), Some(short(cmd)))
                }
                // new Codex wraps every tool in `exec` — code calling them (#55): what the code
                // calls decides the state; the code itself is never the detail (patches, queries)
                "exec" => {
                    if args.contains("apply_patch(") {
                        ev("PreToolUse", Some("Edit"), Some(patch_file(args).unwrap_or_else(|| "patch".into())))
                    } else if let Some(cmd) = exec_cmd(args) {
                        ev("PreToolUse", Some(read_cmd_tool(&cmd)), Some(short(&cmd)))
                    } else if args.contains("write_stdin(") {
                        ev("PreToolUse", Some("Bash"), None)
                    } else if args.contains("web__run(") || args.contains("web.run(") {
                        ev("PreToolUse", Some("WebSearch"), None)
                    } else {
                        ev("PreToolUse", Some("tool"), None)
                    }
                }
                other => ev("PreToolUse", Some(other), Some(short(args))),
            }
        }
        "token_count" => {
            let u = usage.get_or_insert_with(Usage::default);
            let window = p["info"]["model_context_window"].as_f64().or(c.window);
            if let (Some(last), Some(w)) = (p["info"]["last_token_usage"]["total_tokens"].as_f64(), window) {
                if w > 0.0 {
                    u.ctx = Some((last / w * 100.0).round());
                }
            }
            // the session's tokens so far (Codex keeps the total): [input, cache write, -, cache read, output]
            let tot = &p["info"]["total_token_usage"];
            if let (Some(model), Some(input)) = (c.model_id.clone(), tot["input_tokens"].as_f64()) {
                let n = |k: &str| tot[k].as_f64().unwrap_or(0.0);
                let (cached, write) = (n("cached_input_tokens"), n("cache_write_input_tokens"));
                // output: whatever the total counts beyond the input (reasoning included), at least output_tokens
                let out = tot["total_tokens"].as_f64().map(|t| t - input).unwrap_or(0.0).max(n("output_tokens"));
                u.tokens = Some([(model, [(input - cached - write).max(0.0), write, 0.0, cached, out])].into_iter().collect());
            }
            for (key, src) in [("five_hour", &p["rate_limits"]["primary"]), ("seven_day", &p["rate_limits"]["secondary"])] {
                if let Some(pct) = src["used_percent"].as_f64() {
                    let w = Some(Window { pct, resets_at: src["resets_at"].as_i64() });
                    if key == "five_hour" { u.five_hour = w } else { u.seven_day = w }
                }
            }
            *changed = true;
            None
        }
        _ => None,
    }
}

/// Events since the last poll (scans for the log every 1 s until found, then every 3 s for /new).
pub fn poll(c: &mut Codex, usage: &mut Option<Usage>, changed: &mut bool, claimed: &mut HashMap<PathBuf, String>, ws: &str, now: Instant) -> Vec<Event> {
    let every = if c.file.is_some() { Duration::from_secs(3) } else { Duration::from_secs(1) };
    if c.scanned.is_none_or(|t| now.saturating_duration_since(t) >= every) {
        c.scanned = Some(now);
        if let Some(found) = find_log(c, claimed, &home()) {
            if c.file.as_ref() != Some(&found) {
                if let Some(old) = c.file.take() {
                    claimed.remove(&old);
                }
                claimed.insert(found.clone(), ws.to_string());
                c.file = Some(found);
                c.offset = 0;
            }
        }
    }
    let Some(file) = c.file.clone() else { return vec![] };
    tail::new_lines(&file, &mut c.offset)
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|rec| translate(c, usage, changed, &rec))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(recs: &[Value]) -> (Vec<Event>, Option<Usage>) {
        let mut c = Codex::new(Path::new("/tmp"));
        let (mut usage, mut changed) = (None, false);
        let evs = recs.iter().filter_map(|r| translate(&mut c, &mut usage, &mut changed, r)).collect();
        (evs, usage)
    }

    #[test]
    fn maps_codex_records() {
        let (evs, usage) = run(&[
            json!({"type":"turn_context","payload":{"model":"gpt-5.5","effort":"high"}}),
            json!({"type":"event_msg","payload":{"type":"task_started","model_context_window":258400}}),
            json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"rg foo src\"}"}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch\n*** Update File: src/app.lua\n@@\n"}}),
            json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"npm test\"}"}}),
            json!({"type":"response_item","payload":{"type":"web_search_call","action":{"type":"search","query":"lua json"}}}),
            json!({"type":"response_item","payload":{"type":"function_call","name":"request_user_input","arguments":"{}"}}),
            json!({"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":64600},"total_token_usage":{"input_tokens":22907,"cached_input_tokens":6912,"cache_write_input_tokens":0,"output_tokens":6,"reasoning_output_tokens":0,"total_tokens":22913},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":12.0,"resets_at":100},"secondary":{"used_percent":30.0}}}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done!"}}),
            json!({"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}),
            json!({"type":"compacted","payload":{}}),
        ]);
        let got: Vec<(String, Option<String>, Option<String>)> = evs.into_iter().map(|e| (e.event, e.tool, e.detail)).collect();
        let s = |x: &str| Some(x.to_string());
        assert_eq!(got, vec![
            ("UserPromptSubmit".into(), None, None),
            ("PreToolUse".into(), s("Grep"), s("rg foo src")),
            ("PreToolUse".into(), s("Edit"), s("src/app.lua")),
            ("PreToolUse".into(), s("Bash"), s("npm test")),
            ("PreToolUse".into(), s("WebSearch"), s("lua json")),
            ("Notification".into(), None, s("입력 요청")),
            ("Stop".into(), None, None),
            ("Interrupted".into(), None, s("interrupted")),
            ("PreCompact".into(), None, s("compact")),
        ]);
        let u = usage.unwrap();
        assert_eq!(u.model.as_deref(), Some("gpt-5.5 high"));
        assert_eq!(u.tokens.as_ref().unwrap()["gpt-5.5"], [15995.0, 0.0, 0.0, 6912.0, 6.0]);
        assert_eq!(u.ctx, Some(25.0));
        assert_eq!(u.five_hour, Some(Window { pct: 12.0, resets_at: Some(100) }));
        assert_eq!(u.seven_day, Some(Window { pct: 30.0, resets_at: None }));
    }

    #[test]
    fn exec_code_is_read_for_what_it_calls_never_shown() {
        let (evs, _) = run(&[
            // the shapes of the user's own logs (2026-10-06), contents made up
            json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"apply_patch(\"*** Begin Patch\\n*** Add File: notes/tmp.txt\\n+secret line\\n*** End Patch\");\ntext(p);\n"}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"const r = await tools.exec_command({cmd:\"rg needle src\"}); text(r);"}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"text(await write_stdin({session_id:1,chars:\"\",yield_time_ms:1000}))"}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"const r=await tools.web__run({search_query:[{\"q\":\"private question\"}]});"}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"const x = await tools.something_new({secret:1});"}}),
            json!({"type":"event_msg","payload":{"type":"turn_started"}}),
            json!({"type":"event_msg","payload":{"type":"turn_complete","last_agent_message":"x"}}),
        ]);
        let got: Vec<(String, Option<String>, Option<String>)> = evs.into_iter().map(|e| (e.event, e.tool, e.detail)).collect();
        let s = |x: &str| Some(x.to_string());
        assert_eq!(got, vec![
            ("PreToolUse".into(), s("Edit"), s("notes/tmp.txt")),
            ("PreToolUse".into(), s("Grep"), s("rg needle src")),
            ("PreToolUse".into(), s("Bash"), None),
            ("PreToolUse".into(), s("WebSearch"), None),
            ("PreToolUse".into(), s("tool"), None),
            ("UserPromptSubmit".into(), None, None),
            ("Stop".into(), None, None),
        ]);
    }

    #[test]
    fn failed_turns_are_failures_with_their_kind_only() {
        let (evs, _) = run(&[
            // as the user's own logs have them (2026-10-06): a unit kind, a struct kind, none, an older Codex
            json!({"type":"event_msg","payload":{"type":"task_complete","last_agent_message":null,"error":{"message":"stream error: https://x/y req_1","codex_error_info":"server_overloaded"}}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","last_agent_message":null,"error":{"message":"unexpected status 401 … url: https://api.openai.com/v1/responses","codex_error_info":{"http_connection_failed":{"http_status_code":401}}}}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","error":{"message":"?"}}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"secret reply text"}}),
        ]);
        let got: Vec<(String, Option<String>)> = evs.into_iter().map(|e| (e.event, e.detail)).collect();
        assert_eq!(got, vec![
            ("StopFailure".into(), Some("server_overloaded".into())),
            ("StopFailure".into(), Some("http_connection_failed 401".into())),
            ("StopFailure".into(), None),
            ("Stop".into(), None), // never the reply text
        ]);
    }

    #[test]
    fn codex_escalation_is_waiting_until_output() {
        let mut c = Codex::new(Path::new("/tmp"));
        let (mut usage, mut changed) = (None, false);
        let mut st = crate::state::State::default();
        let t = Instant::now();
        let mut feed = |rec: Value| {
            if let Some(e) = translate(&mut c, &mut usage, &mut changed, &rec) {
                st.apply(e, t);
            }
            (st.state, st.detail.clone())
        };
        feed(json!({"type":"event_msg","payload":{"type":"task_started"}}));
        // new Codex: the `exec` tool, a sandboxed read — no approval
        assert_eq!(feed(json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"a","name":"exec","input":"text(await exec_command({cmd:\"rg foo\", yield_time_ms:1000}))"}})).0, "reading");
        assert_eq!(feed(json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"a","output":"x"}})).0, "reading", "an output of a call that didn't ask changes nothing");
        // outside the sandbox: Codex asks first
        assert_eq!(feed(json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"b","name":"exec","input":"text(await exec_command({cmd:\"npm view @openai/codex version\", sandbox_permissions:\"require_escalated\", justification:\"?\"}))"}})), ("waiting", Some("npm view @openai/codex version".into())));
        assert_eq!(feed(json!({"type":"event_msg","payload":{"type":"token_count","info":null}})).0, "waiting");
        assert_eq!(feed(json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"b","output":"x"}})).0, "thinking");
        // older Codex: exec_command with JSON arguments
        assert_eq!(feed(json!({"type":"response_item","payload":{"type":"function_call","call_id":"c","name":"exec_command","arguments":"{\"cmd\":\"curl x\",\"sandbox_permissions\":\"require_escalated\"}"}})), ("waiting", Some("curl x".into())));
        assert_eq!(feed(json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"c","output":"x"}})).0, "thinking");
    }

    #[test]
    fn claims_newest_log_for_folder_only() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let dir = home.path().join("sessions").join(Local::now().format("%Y/%m/%d").to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let meta = |cwd: &Path| format!("{}\n", json!({"type":"session_meta","payload":{"cwd": cwd}}));
        std::fs::write(dir.join("rollout-a.jsonl"), meta(other.path())).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.join("rollout-b.jsonl"), meta(proj.path())).unwrap();
        let mut c = Codex::new(proj.path());
        let mut claimed = HashMap::new();
        assert_eq!(find_log(&c, &claimed, home.path()), Some(dir.join("rollout-b.jsonl")));
        // claimed by another workspace: not ours to take
        claimed.insert(dir.join("rollout-b.jsonl"), "other".to_string());
        assert_eq!(find_log(&c, &claimed, home.path()), None);
        // a log written before the agent started is ignored
        claimed.clear();
        c.started = SystemTime::now() + Duration::from_secs(60);
        assert_eq!(find_log(&c, &claimed, home.path()), None);
    }
}
