//! cvim-core: the security/state-critical part of CVIM v2, in Rust (docs/PLATFORM.md 3.8).
//! Runs as a separate process next to the Electron main process and talks JSON lines on stdio
//! (see main.rs for the protocol).

pub mod claude;
pub mod codex;
pub mod policy;
pub mod state;
pub mod tail;
pub mod title;
pub mod workspace;
