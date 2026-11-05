//! Claude Code's login in the macOS Keychain (STA-21 rules 2 · 9, #115 A1, #136 — POL-AGENT-02 rule 1-3). Two ways, in
//! order: `read_tool` the way Claude Code reads its own item — `/usr/bin/security`, which it keeps on the item's list,
//! so macOS doesn't ask and Claude Code writing the item anew doesn't undo it (an "Always Allow" given to this program
//! goes each time, about hourly); and where that doesn't answer, on a press only, `read` by the core itself through the
//! Security framework: macOS's prompt then names this program, and its "Always Allow" applies to it alone. Only items
//! named "Claude Code-credentials" (with CLAUDE_CONFIG_DIR: that name, "-" and 8 hex); only the access token and its
//! expiry leave this module — the refresh token and the rest of the item are dropped here. Nothing is logged or
//! written. The system frameworks are declared directly (no crate).

pub const SERVICE: &str = "Claude Code-credentials";

/// one of the names Claude Code uses: the plain one, or with CLAUDE_CONFIG_DIR "-" + 8 hex of its path
pub fn allowed(service: &str) -> bool {
    match service.strip_prefix(SERVICE) {
        Some("") => true,
        Some(rest) => rest.len() == 9 && rest.starts_with('-') && rest[1..].bytes().all(|b| b.is_ascii_hexdigit()),
        None => false,
    }
}

#[derive(Debug, PartialEq)]
pub enum Found {
    /// the access token and when it expires (ms), when the item says
    Token { value: String, exp: Option<i64> },
    /// there, but no token in it
    Bad,
    NotFound,
    /// the user said no (Deny / Cancel) or there was no one to ask
    Denied,
    /// `security` didn't answer in time: macOS is asking here — cut off, so no "Always Allow" goes to that command (#136)
    NeedsAsk,
    Error(i32),
}

/// the item's text → its access token: `{"claudeAiOauth": {"accessToken": "…", "expiresAt": ms, …}}`
pub fn token_of(text: &[u8]) -> Option<(String, Option<i64>)> {
    let v: serde_json::Value = serde_json::from_slice(text).ok()?;
    let o = &v["claudeAiOauth"];
    let t = o["accessToken"].as_str().filter(|t| !t.is_empty())?;
    Some((t.to_string(), o["expiresAt"].as_i64().or_else(|| o["expiresAt"].as_f64().map(|f| f as i64))))
}

#[cfg(target_os = "macos")]
mod sys {
    use std::ffi::c_void;
    pub type CFTypeRef = *const c_void;
    pub type CFIndex = isize;
    #[repr(C)]
    pub struct KeyCallBacks { _version: CFIndex, _f: [*const c_void; 5] }
    #[repr(C)]
    pub struct ValueCallBacks { _version: CFIndex, _f: [*const c_void; 4] }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub static kCFTypeDictionaryKeyCallBacks: KeyCallBacks;
        pub static kCFTypeDictionaryValueCallBacks: ValueCallBacks;
        pub static kCFBooleanTrue: CFTypeRef;
        pub fn CFStringCreateWithBytes(alloc: CFTypeRef, bytes: *const u8, len: CFIndex, encoding: u32, external: u8) -> CFTypeRef;
        pub fn CFDictionaryCreate(alloc: CFTypeRef, keys: *const CFTypeRef, values: *const CFTypeRef, n: CFIndex, kcb: *const KeyCallBacks, vcb: *const ValueCallBacks) -> CFTypeRef;
        pub fn CFDataGetLength(d: CFTypeRef) -> CFIndex;
        pub fn CFDataGetBytePtr(d: CFTypeRef) -> *const u8;
        pub fn CFRelease(cf: CFTypeRef);
    }
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        pub static kSecClass: CFTypeRef;
        pub static kSecClassGenericPassword: CFTypeRef;
        pub static kSecAttrService: CFTypeRef;
        pub static kSecMatchLimit: CFTypeRef;
        pub static kSecMatchLimitOne: CFTypeRef;
        pub static kSecReturnData: CFTypeRef;
        pub fn SecItemCopyMatching(query: CFTypeRef, result: *mut CFTypeRef) -> i32;
    }
}

#[cfg(target_os = "macos")]
fn copy_matching(service: &str, data: bool) -> (i32, Option<Vec<u8>>) {
    use sys::*;
    const UTF8: u32 = 0x0800_0100;
    unsafe {
        let name = CFStringCreateWithBytes(std::ptr::null(), service.as_ptr(), service.len() as CFIndex, UTF8, 0);
        if name.is_null() {
            return (-1, None);
        }
        let mut keys = vec![kSecClass, kSecAttrService, kSecMatchLimit];
        let mut values = vec![kSecClassGenericPassword, name, kSecMatchLimitOne];
        if data {
            keys.push(kSecReturnData);
            values.push(kCFBooleanTrue);
        }
        let query = CFDictionaryCreate(std::ptr::null(), keys.as_ptr(), values.as_ptr(), keys.len() as CFIndex, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        CFRelease(name);
        if query.is_null() {
            return (-1, None);
        }
        let mut out: CFTypeRef = std::ptr::null();
        // with data: macOS may ask the user first — this waits for the answer
        let status = SecItemCopyMatching(query, if data { &mut out } else { std::ptr::null_mut() });
        CFRelease(query);
        if status != 0 || out.is_null() {
            return (status, None);
        }
        let bytes = std::slice::from_raw_parts(CFDataGetBytePtr(out), CFDataGetLength(out) as usize).to_vec();
        CFRelease(out);
        (0, Some(bytes))
    }
}

const NOT_FOUND: i32 = -25300; // errSecItemNotFound
const DENIED: [i32; 3] = [-128, -25293, -25308]; // errSecUserCanceled · errSecAuthFailed · errSecInteractionNotAllowed

/// is the item there? Its attributes only — no prompt. None: couldn't tell
#[cfg(target_os = "macos")]
pub fn exists(service: &str) -> Option<bool> {
    if !allowed(service) {
        return Some(false);
    }
    match copy_matching(service, false).0 {
        0 => Some(true),
        NOT_FOUND => Some(false),
        _ => None,
    }
}

// the item's text → what leaves this module; the text itself (refresh token too) doesn't stay around
#[cfg(target_os = "macos")]
fn token_in(mut bytes: Vec<u8>) -> Found {
    let t = token_of(&bytes);
    bytes.iter_mut().for_each(|b| *b = 0);
    match t {
        Some((value, exp)) => Found::Token { value, exp },
        None => Found::Bad,
    }
}

/// the item's access token — macOS may ask the user (this waits for the answer)
#[cfg(target_os = "macos")]
pub fn read(service: &str) -> Found {
    if !allowed(service) {
        return Found::NotFound;
    }
    match copy_matching(service, true) {
        (0, Some(bytes)) => token_in(bytes),
        (NOT_FOUND, _) => Found::NotFound,
        (s, _) if DENIED.contains(&s) => Found::Denied,
        (s, _) => Found::Error(s),
    }
}

/// how long `security` gets: it answers at once when it may read; past this, macOS is asking
pub const TOOL_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
const TOOL_NOT_FOUND: i32 = 44; // `security`'s exit code for errSecItemNotFound

/// the item's access token, the way Claude Code reads it: no prompt where it can (#136), cut off after `wait` where
/// it can't. No shell, and the secret comes on its output — never in an argument
#[cfg(target_os = "macos")]
pub fn read_tool(service: &str, wait: std::time::Duration) -> Found {
    if !allowed(service) {
        return Found::NotFound;
    }
    run_tool("/usr/bin/security", &["find-generic-password", "-s", service, "-w"], wait)
}

#[cfg(target_os = "macos")]
fn run_tool(program: &str, args: &[&str], wait: std::time::Duration) -> Found {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let Ok(mut child) = Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else {
        return Found::NeedsAsk;
    };
    let Some(mut out) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Found::NeedsAsk;
    };
    let reader = std::thread::spawn(move || {
        let mut text = Vec::new();
        let _ = out.read_to_end(&mut text);
        text
    });
    let start = std::time::Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if start.elapsed() < wait => std::thread::sleep(std::time::Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let Some(code) = code else { return Found::NeedsAsk }; // cut off: its output isn't waited for
    let text = reader.join().unwrap_or_default();
    match code {
        0 => token_in(text),
        TOOL_NOT_FOUND => Found::NotFound,
        _ => Found::Denied,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn exists(_: &str) -> Option<bool> {
    Some(false)
}
#[cfg(not(target_os = "macos"))]
pub fn read(_: &str) -> Found {
    Found::NotFound
}
#[cfg(not(target_os = "macos"))]
pub fn read_tool(_: &str, _: std::time::Duration) -> Found {
    Found::NotFound
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_claude_code_items() {
        assert!(allowed("Claude Code-credentials"));
        assert!(allowed("Claude Code-credentials-0a1b2c3d"));
        assert!(!allowed("Claude Code-credentials-0a1b2c3"));
        assert!(!allowed("Claude Code-credentials-zz1b2c3d"));
        assert!(!allowed("Claude Code-credentials2"));
        assert!(!allowed("github.com"));
        assert_eq!(read("github.com"), Found::NotFound);
        assert_eq!(read_tool("github.com", TOOL_WAIT), Found::NotFound); // never gets as far as the command
        assert_eq!(exists("Chrome Safe Storage"), Some(false));
    }

    #[test]
    fn the_access_token_only() {
        let t = br#"{"claudeAiOauth":{"accessToken":"tok","refreshToken":"ref","expiresAt":1760000000000,"scopes":["x"]}}"#;
        assert_eq!(token_of(t), Some(("tok".into(), Some(1760000000000))));
        assert_eq!(token_of(br#"{"claudeAiOauth":{"accessToken":"tok"}}"#), Some(("tok".into(), None)));
        assert_eq!(token_of(br#"{"claudeAiOauth":{"accessToken":""}}"#), None);
        assert_eq!(token_of(b"not json"), None);
    }

    // a name no one uses: not there, and no prompt (attributes only / nothing to ask about)
    #[cfg(target_os = "macos")]
    #[test]
    fn missing_item() {
        assert_eq!(exists("Claude Code-credentials-00000000"), Some(false));
        assert_eq!(read("Claude Code-credentials-00000000"), Found::NotFound);
        assert_eq!(read_tool("Claude Code-credentials-00000000", TOOL_WAIT), Found::NotFound);
    }

    // what the command answers → what leaves here, with a stand-in for it: no Keychain involved
    #[cfg(target_os = "macos")]
    #[test]
    fn the_command_s_answers() {
        use std::time::{Duration, Instant};
        let sh = |script: &str, ms: u64| run_tool("/bin/sh", &["-c", script], Duration::from_millis(ms));
        let item = r#"echo '{"claudeAiOauth":{"accessToken":"tok","refreshToken":"ref","expiresAt":5}}'"#;
        assert_eq!(sh(item, 3000), Found::Token { value: "tok".into(), exp: Some(5) });
        assert_eq!(sh("echo not-json", 3000), Found::Bad);
        assert_eq!(sh("exit 44", 3000), Found::NotFound);
        assert_eq!(sh("exit 51", 3000), Found::Denied);
        let start = Instant::now();
        assert_eq!(sh("sleep 30", 100), Found::NeedsAsk); // macOS asking: cut off, even with a child holding its output
        assert!(start.elapsed() < Duration::from_secs(3));
        assert_eq!(run_tool("/no/such/program", &[], Duration::from_millis(100)), Found::NeedsAsk);
    }
}
