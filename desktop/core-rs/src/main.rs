//! cvim-core process. Protocol: one JSON object per line.
//!
//! stdin (from the Electron main process):
//!   {"id":1,"method":"open","params":{"ws":"<id>","kind":"hooks|codex_log|activity","cwd":"…","tabs":"…/tabs"}}
//!   {"id":2,"method":"restart","params":{"ws":"<id>","kind":"…","cwd":"…"?}}  new agent process in the workspace (cwd: where it runs, for its logs)
//!   {"id":3,"method":"close","params":{"ws":"<id>"}}
//!   {"id":4,"method":"snapshot","params":{"ws":"<id>"}}                -> current state payload
//!   {"id":5,"method":"set_state","params":{"ws":"<id>","state":"sleep"}}  agent process exited
//!   {"id":6,"method":"path_inside","params":{"root":"…","path":"…"}}   -> {"inside":bool,"real":…}
//!   {"method":"output","params":{"ws":"<id>"}}                          agent printed something (no reply)
//!   {"method":"esc","params":{"ws":"<id>"}}                             Esc / Ctrl-C typed into the agent (no reply)
//! stdout (to the main process):
//!   {"id":1,"result":…} / {"id":1,"error":"…"}
//!   {"event":"state","ws":"<id>","payload":{state,tool,detail,usage,log}}
//!   {"event":"transition","ws":"<id>","from":"…","to":"…","guess":bool}  guess: "done" from output only
//! The core polls every 250 ms. It exits when stdin closes (the app quit).

use cvim_core::policy;
use cvim_core::state::Kind;
use cvim_core::workspace::Workspace;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
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
                ws.restart(kind);
                Ok(ws.payload())
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
