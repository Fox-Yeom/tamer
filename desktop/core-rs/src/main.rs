//! cvim-core process. Protocol: one JSON object per line.
//!
//! stdin (from the Electron main process):
//!   {"id":1,"method":"open","params":{"ws":"<id>","kind":"hooks|codex_log|activity","cwd":"…","tabs":"…/tabs"}}
//!   {"id":2,"method":"restart","params":{"ws":"<id>","kind":"…","cwd":"…"?}}  new agent process in the workspace (cwd: where it runs, for its logs)
//!   {"id":3,"method":"close","params":{"ws":"<id>"}}
//!   {"id":7,"method":"move","params":{"from":"<id>","to":"<id>"}}     an agent moved to another session (keeps its state)
//!   {"id":4,"method":"snapshot","params":{"ws":"<id>"}}                -> current state payload
//!   {"id":5,"method":"set_state","params":{"ws":"<id>","state":"sleep"}}  agent process exited
//!   {"id":6,"method":"path_inside","params":{"root":"…","path":"…"}}   -> {"inside":bool,"real":…}
//!   {"method":"output","params":{"ws":"<id>"}}                          agent printed something (no reply)
//!   {"method":"esc","params":{"ws":"<id>"}}                             Esc / Ctrl-C typed into the agent (no reply)
//!   {"id":8,"method":"claude_login","params":{"services":["Claude Code-credentials"],"read":false}}
//!       Claude Code's login in the Keychain (#115 A1, keychain.rs): read false -> {"found":bool} (no prompt);
//!       read true -> {"token":"…","exp":ms|null} | {"denied":true} | {"found":false} | {"busy":true} — answered
//!       when macOS's prompt is answered (the loop doesn't wait for it); "silent":true -> never a prompt,
//!       {"ask":true} when macOS would have asked (#124)
//! stdout (to the main process):
//!   {"id":1,"result":…} / {"id":1,"error":"…"}
//!   {"event":"state","ws":"<id>","payload":{state,tool,detail,usage,log}}
//!   {"event":"transition","ws":"<id>","from":"…","to":"…","guess":bool}  guess: "done" from output only
//! The core polls every 250 ms. It exits when stdin closes (the app quit).

use cvim_core::keychain;
use cvim_core::policy;
use cvim_core::state::Kind;
use cvim_core::workspace::{self, Workspace};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

struct Core {
    workspaces: HashMap<String, Workspace>,
    claimed: HashMap<PathBuf, String>, // Codex logs already taken by a workspace
}

fn send(v: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn str_param<'a>(p: &'a Value, k: &str) -> Result<&'a str, String> {
    p[k].as_str().ok_or_else(|| format!("missing {k}"))
}

fn kind_param(p: &Value) -> Result<Kind, String> {
    serde_json::from_value(p["kind"].clone()).map_err(|_| "bad kind".to_string())
}

const STATES: [&str; 14] = [
    "idle", "sleep", "thinking", "coding", "reading", "searching", "bash", "agent", "tool", "waiting", "done", "compact", "error",
    "interrupted",
];

impl Core {
    fn handle(&mut self, method: &str, p: &Value) -> Result<Value, String> {
        match method {
            // where the agents keep their logs, as the user's shell sets it (CODEX_HOME,
            // CLAUDE_CONFIG_DIR in their rc files): the app starts the core at once and tells it
            // these when the shell environment has been read (#35). Only these two names.
            "set_env" => {
                for k in ["CODEX_HOME", "CLAUDE_CONFIG_DIR"] {
                    if let Some(v) = p[k].as_str().filter(|v| !v.is_empty()) {
                        std::env::set_var(k, v);
                    }
                }
                Ok(Value::Null)
            }
            // 설정 "세션 제목" (#99): off = no agent's title is read or shown any more
            "titles" => {
                let on = p["on"].as_bool().unwrap_or(false);
                workspace::TITLES.store(on, std::sync::atomic::Ordering::Relaxed);
                if !on {
                    for ws in self.workspaces.values_mut() {
                        ws.drop_titles();
                    }
                }
                Ok(Value::Null)
            }
            "open" => {
                let id = str_param(p, "ws")?;
                let ws = Workspace::new(id, kind_param(p)?, Path::new(str_param(p, "cwd")?), Path::new(str_param(p, "tabs")?));
                if let Some(old) = self.workspaces.insert(id.into(), ws) {
                    self.release(&old);
                }
                Ok(Value::Null)
            }
            "restart" => {
                let kind = kind_param(p)?;
                let ws = self.workspaces.get_mut(str_param(p, "ws")?).ok_or("no such workspace")?;
                if let Some(f) = ws.codex_file() {
                    self.claimed.remove(&f);
                }
                // where the agent really runs (typed after a `cd` in the shell): its logs are there
                if let Some(cwd) = p["cwd"].as_str() {
                    ws.cwd = Path::new(cwd).into();
                }
                // an agent moved over from another shell: its hook log keeps that shell's id
                ws.log_id = p["log_id"].as_str().map(Into::into);
                ws.restart(kind);
                Ok(ws.payload())
            }
            // an agent moved, still running, into another session (#3): its whole state goes along
            // (adapter, read position, log claims); a hook agent keeps writing under its old id
            "move" => {
                let (from, to) = (str_param(p, "from")?, str_param(p, "to")?);
                let mut ws = self.workspaces.remove(from).ok_or("no such workspace")?;
                if let Some(old) = self.workspaces.remove(to) {
                    self.release(&old);
                }
                if ws.log_id.is_none() {
                    ws.log_id = Some(from.into());
                }
                for owner in self.claimed.values_mut() {
                    if owner == from {
                        *owner = to.into();
                    }
                }
                ws.id = to.into();
                ws.last_sent.clear();
                let payload = ws.payload();
                self.workspaces.insert(to.into(), ws);
                Ok(payload)
            }
            "close" => {
                if let Some(ws) = self.workspaces.remove(str_param(p, "ws")?) {
                    self.release(&ws);
                    ws.remove_files();
                }
                Ok(Value::Null)
            }
            "snapshot" => Ok(self.workspaces.get(str_param(p, "ws")?).ok_or("no such workspace")?.payload()),
            "set_state" => {
                let want = str_param(p, "state")?;
                let state = STATES.iter().find(|s| **s == want).ok_or("bad state")?;
                let ws = self.workspaces.get_mut(str_param(p, "ws")?).ok_or("no such workspace")?;
                ws.st.set(state, None, Instant::now());
                Ok(Value::Null)
            }
            "esc" => {
                if let Some(ws) = self.workspaces.get_mut(str_param(p, "ws")?) {
                    ws.esc(Instant::now());
                }
                Ok(Value::Null)
            }
            "output" => {
                if let Some(ws) = self.workspaces.get_mut(str_param(p, "ws")?) {
                    ws.output();
                }
                Ok(Value::Null)
            }
            // is there a Claude Code login (its attributes only — no prompt)
            "claude_login" => {
                let found = services(p).iter().any(|s| keychain::exists(s) == Some(true));
                Ok(json!({ "found": found }))
            }
            "path_inside" => {
                let real = policy::inside(Path::new(str_param(p, "root")?), Path::new(str_param(p, "path")?));
                Ok(json!({ "inside": real.is_some(), "real": real }))
            }
            _ => Err(format!("unknown method {method}")),
        }
    }

    fn release(&mut self, ws: &Workspace) {
        if let Some(f) = ws.codex_file() {
            self.claimed.remove(&f);
        }
    }

    fn poll(&mut self) {
        let now = Instant::now();
        for ws in self.workspaces.values_mut() {
            let polled = ws.poll(&mut self.claimed, now);
            for (from, to) in polled.transitions {
                send(&json!({ "event": "transition", "ws": ws.id, "from": from, "to": to, "guess": polled.guessed && to == "done" }));
            }
            let payload = ws.payload();
            let key = payload.to_string();
            if key != ws.last_sent {
                ws.last_sent = key;
                send(&json!({ "event": "state", "ws": ws.id, "payload": payload }));
            }
        }
    }
}

// the Keychain item names asked for — only Claude Code's (keychain::allowed)
fn services(p: &Value) -> Vec<String> {
    p["services"].as_array().into_iter().flatten().filter_map(|s| s.as_str()).filter(|s| keychain::allowed(s)).map(String::from).collect()
}

// one prompt at a time
static ASKING: AtomicBool = AtomicBool::new(false);

// the login's access token, on its own thread: macOS may ask the user first, and the answer can take a while.
// The token goes into the reply and nowhere else (never logged)
fn read_login(id: Value, p: &Value) {
    if ASKING.swap(true, Ordering::SeqCst) {
        send(&json!({ "id": id, "result": { "busy": true } }));
        return;
    }
    let list = services(p);
    let silent = p["silent"] == true; // #124: without a prompt — { "ask": true } when macOS would have asked
    std::thread::spawn(move || {
        let mut out = json!({ "found": false });
        for s in &list {
            match keychain::read(s, silent) {
                keychain::Found::Token { value, exp } => {
                    out = json!({ "token": value, "exp": exp });
                    break;
                }
                keychain::Found::Denied => {
                    out = json!({ "denied": true });
                    break;
                }
                keychain::Found::NeedsAsk => {
                    out = json!({ "ask": true });
                    break;
                }
                keychain::Found::Bad => out = json!({ "found": true }),
                keychain::Found::Error(code) => out = json!({ "error": code }),
                keychain::Found::NotFound => {}
            }
        }
        ASKING.store(false, Ordering::SeqCst);
        send(&json!({ "id": id, "result": out }));
    });
}

fn main() {
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(l) => { if tx.send(Some(l)).is_err() { return; } }
                Err(_) => break,
            }
        }
        let _ = tx.send(None); // stdin closed: the app is gone
    });

    let mut core = Core { workspaces: HashMap::new(), claimed: HashMap::new() };
    let tick = Duration::from_millis(250);
    let mut next = Instant::now() + tick;
    loop {
        let wait = next.saturating_duration_since(Instant::now());
        match rx.recv_timeout(wait) {
            Ok(Some(line)) => {
                let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
                if req["method"] == "claude_login" && req["params"]["read"] == true {
                    if let Some(id) = req.get("id") {
                        read_login(id.clone(), &req["params"]);
                    }
                    continue;
                }
                let res = core.handle(req["method"].as_str().unwrap_or(""), &req["params"]);
                if let Some(id) = req.get("id") {
                    send(&match res {
                        Ok(v) => json!({ "id": id, "result": v }),
                        Err(e) => json!({ "id": id, "error": e }),
                    });
                }
            }
            Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if Instant::now() >= next {
            core.poll();
            next = Instant::now() + tick;
        }
    }
    for ws in core.workspaces.values() {
        ws.remove_files();
    }
}
