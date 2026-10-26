//! Claude Code's login in the macOS Keychain (STA-21 rules 2 · 9, #115 A1 — POL-AGENT-02 rule 1-3), read
//! by the core itself through the Security framework: macOS's prompt then names this program, and its
//! "Always Allow" applies to it alone. Never `/usr/bin/security` — an "Always Allow" given to that lets
//! any program on the Mac take the token. Only items named "Claude Code-credentials" (with
//! CLAUDE_CONFIG_DIR: that name, "-" and 8 hex); only the access token and its expiry leave this module —
//! the refresh token and the rest of the item are dropped here. Nothing is logged or written.
//! The system frameworks are declared directly (no crate).

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
    /// read without a prompt (silent) and macOS would have asked: not "Always Allow"ed yet (#124)
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
        pub static kSecUseAuthenticationUI: CFTypeRef;
        pub static kSecUseAuthenticationUIFail: CFTypeRef;
        pub fn SecItemCopyMatching(query: CFTypeRef, result: *mut CFTypeRef) -> i32;
    }
}

// silent: macOS mustn't ask (kSecUseAuthenticationUIFail) — an "Always Allow" already given reads at once, else
// errSecInteractionNotAllowed (#124: read like this first, the prompt only when that fails)
#[cfg(target_os = "macos")]
fn copy_matching(service: &str, data: bool, silent: bool) -> (i32, Option<Vec<u8>>) {
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
        if silent {
            keys.push(kSecUseAuthenticationUI);
            values.push(kSecUseAuthenticationUIFail);
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
const NOT_ALLOWED: i32 = -25308; // errSecInteractionNotAllowed: a silent read that would have prompted

/// is the item there? Its attributes only — no prompt. None: couldn't tell
#[cfg(target_os = "macos")]
pub fn exists(service: &str) -> Option<bool> {
    if !allowed(service) {
        return Some(false);
    }
    match copy_matching(service, false, false).0 {
        0 => Some(true),
        NOT_FOUND => Some(false),
        _ => None,
    }
}

/// the item's access token — macOS may ask the user (this waits for the answer); silent: never asks (NeedsAsk)
#[cfg(target_os = "macos")]
pub fn read(service: &str, silent: bool) -> Found {
    if !allowed(service) {
        return Found::NotFound;
    }
    match copy_matching(service, true, silent) {
        (0, Some(mut bytes)) => {
            let t = token_of(&bytes);
            bytes.iter_mut().for_each(|b| *b = 0); // the item's text (refresh token too) doesn't stay around
            match t {
                Some((value, exp)) => Found::Token { value, exp },
                None => Found::Bad,
            }
        }
        (NOT_FOUND, _) => Found::NotFound,
        (NOT_ALLOWED, _) if silent => Found::NeedsAsk,
        (s, _) if DENIED.contains(&s) => Found::Denied,
        (s, _) => Found::Error(s),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn exists(_: &str) -> Option<bool> {
    Some(false)
}
#[cfg(not(target_os = "macos"))]
pub fn read(_: &str, _: bool) -> Found {
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
        assert_eq!(read("github.com", false), Found::NotFound);
        assert_eq!(read("github.com", true), Found::NotFound);
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
        assert_eq!(read("Claude Code-credentials-00000000", false), Found::NotFound);
        assert_eq!(read("Claude Code-credentials-00000000", true), Found::NotFound); // silent: same, no prompt
    }
}
