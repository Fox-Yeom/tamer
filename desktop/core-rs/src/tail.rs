//! Reading appended jsonl files: only complete lines, resuming from a byte offset.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Complete lines appended to `path` since `*offset`; advances the offset past them.
pub fn new_lines(path: &Path, offset: &mut u64) -> Vec<String> {
    let Ok(meta) = std::fs::metadata(path) else { return vec![] };
    if meta.len() < *offset {
        *offset = 0; // truncated / replaced: start over
    }
    if meta.len() == *offset {
        return vec![];
    }
    let Ok(mut f) = File::open(path) else { return vec![] };
    if f.seek(SeekFrom::Start(*offset)).is_err() {
        return vec![];
    }
    let mut buf = Vec::with_capacity((meta.len() - *offset) as usize);
    if f.take(meta.len() - *offset).read_to_end(&mut buf).is_err() {
        return vec![];
    }
    let Some(end) = buf.iter().rposition(|&b| b == b'\n') else { return vec![] };
    *offset += end as u64 + 1;
    String::from_utf8_lossy(&buf[..end])
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn partial_lines_wait_for_newline() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.log");
        let mut f = File::create(&p).unwrap();
        let mut off = 0;
        write!(f, "one\ntw").unwrap();
        assert_eq!(new_lines(&p, &mut off), ["one"]);
        write!(f, "o\n한글\n").unwrap();
        assert_eq!(new_lines(&p, &mut off), ["two", "한글"]);
        assert!(new_lines(&p, &mut off).is_empty());
    }

    #[test]
    fn truncation_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.log");
        std::fs::write(&p, "a\nb\n").unwrap();
        let mut off = 0;
        assert_eq!(new_lines(&p, &mut off).len(), 2);
        std::fs::write(&p, "c\n").unwrap();
        assert_eq!(new_lines(&p, &mut off), ["c"]);
    }
}
