// CVIM Desktop (X0 PoC) backend: PTYs for the xterm.js panes, plus read-only access to cvim's
// data (last folder, the folder's partner Pokémon). Nothing here writes to ~/.cache/cvim.
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter, State};

struct Pty {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
struct Ptys(Mutex<HashMap<String, Pty>>);

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
}

fn cache_dir() -> PathBuf {
    std::env::var("CVIM_CACHE_DIR").map(PathBuf::from).unwrap_or_else(|_| home().join(".cache/cvim"))
}

/// Runs `cmd` through the user's login shell (an app started from Finder has no PATH),
/// output streamed to the window as `pty-<id>` events (base64 bytes; xterm.js reassembles UTF-8).
#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    ptys: State<Ptys>,
    id: String,
    cmd: String,
    cwd: String,
    cols: u16,
    rows: u16,
    env: HashMap<String, String>,
) -> Result<(), String> {
    if let Some(mut old) = ptys.0.lock().unwrap().remove(&id) {
        let _ = old.child.kill();
    }
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut c = CommandBuilder::new(&shell);
    c.args(["-l", "-c", &cmd]);
    c.cwd(&cwd);
    c.env("TERM", "xterm-256color");
    c.env("COLORTERM", "truecolor");
    if std::env::var("LANG").is_err() {
        c.env("LANG", "ko_KR.UTF-8");
    }
    for (k, v) in env {
        c.env(k, v);
    }
    let child = pair.slave.spawn_command(c).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let (ev, ev_exit) = (format!("pty-{id}"), format!("pty-exit-{id}"));
    thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let b64 = base64::engine::general_purpose::STANDARD;
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = app.emit(&ev_exit, ());
                    break;
                }
                Ok(n) => {
                    let _ = app.emit(&ev, b64.encode(&buf[..n]));
                }
            }
        }
    });
    ptys.0.lock().unwrap().insert(id, Pty { writer, master: pair.master, child });
    Ok(())
}

#[tauri::command]
fn pty_write(ptys: State<Ptys>, id: String, data: String) -> Result<(), String> {
    let mut map = ptys.0.lock().unwrap();
    let p = map.get_mut(&id).ok_or("no such pty")?;
    p.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(ptys: State<Ptys>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = ptys.0.lock().unwrap();
    let p = map.get(&id).ok_or("no such pty")?;
    p.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// iTerm-style copy on select (pbcopy: no clipboard permission dance in the WebView)
#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    let mut p = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    p.stdin.take().unwrap().write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    p.wait().map_err(|e| e.to_string())?;
    Ok(())
}

/// PoC diagnostics: append a line to $CVIM_DESKTOP_LOG
#[tauri::command]
fn log_line(line: String) {
    if let Ok(log) = std::env::var("CVIM_DESKTOP_LOG") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
            let _ = writeln!(f, "{line}");
        }
    }
}

#[tauri::command]
fn read_file_b64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// folder to open (CVIM_DESKTOP_DIR, else cvim's last folder, else home) and its partner GIF
#[tauri::command]
fn home_info() -> serde_json::Value {
    let home_s = home().to_string_lossy().to_string();
    let cache = cache_dir();
    let cwd = std::env::var("CVIM_DESKTOP_DIR").ok().or_else(|| {
        std::fs::read_to_string(cache.join("last_dir")).ok().map(|s| s.lines().next().unwrap_or("").to_string())
    });
    let cwd = cwd.filter(|d| !d.is_empty() && PathBuf::from(d).is_dir()).unwrap_or(home_s.clone());
    let mut partner_gif = serde_json::Value::Null;
    let mut partner_name = serde_json::Value::Null;
    if let Ok(raw) = std::fs::read_to_string(cache.join("folders.json")) {
        if let Ok(folders) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(rec) = folders.get(&cwd) {
                if let Some(id) = rec.get("id").and_then(|v| v.as_i64()) {
                    let shiny = rec.get("shiny").and_then(|v| v.as_bool()).unwrap_or(false);
                    let base = cache.join("pokemon").join(format!("{id}{}", if shiny { "s" } else { "" }));
                    let gif = base.with_extension("gif");
                    if gif.exists() {
                        partner_gif = gif.to_string_lossy().to_string().into();
                    }
                    if let Ok(j) = std::fs::read_to_string(base.with_extension("json")) {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&j) {
                            partner_name = v.get("name_ko").cloned().unwrap_or(serde_json::Value::Null);
                        }
                    }
                }
            }
        }
    }
    serde_json::json!({
        "home": home_s,
        "cwd": cwd,
        "shell": std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()),
        "partner_gif": partner_gif,
        "partner_name": partner_name,
        // tests: run a stand-in instead of real agents (same rule as CVIM_CLAUDE_CMD)
        "agent_cmd": std::env::var("CVIM_DESKTOP_AGENT_CMD").ok(),
        "perf": std::env::var("CVIM_DESKTOP_PERF").is_ok(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Ptys::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            copy_text,
            read_file_b64,
            home_info,
            log_line
        ])
        .run(tauri::generate_context!())
        .expect("error while running CVIM Desktop");
}
