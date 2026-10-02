//! Path policy: is a path inside a workspace folder? (POLICY.md 11.2 — agent file access, sprites)
//! Symlinks and `..` are resolved before comparing, so a link inside the folder that points
//! outside it is outside. Paths that don't exist yet (a file about to be written) are checked by
//! resolving their nearest existing parent.

use std::path::{Component, Path, PathBuf};

/// Resolved absolute path, or None if it can't be resolved safely.
pub fn resolve(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    if let Ok(p) = std::fs::canonicalize(path) {
        return Some(p);
    }
    // not there yet: canonicalize the existing ancestor, then append the rest (no `..` allowed)
    let mut rest = Vec::new();
    let mut cur = path;
    loop {
        let name = cur.file_name()?;
        rest.push(name.to_owned());
        cur = cur.parent()?;
        if let Ok(base) = std::fs::canonicalize(cur) {
            let mut out = base;
            for part in rest.iter().rev() {
                out.push(part);
            }
            if out.components().any(|c| matches!(c, Component::ParentDir)) {
                return None;
            }
            return Some(out);
        }
    }
}

/// Some(resolved path) when `path` is inside `root` (or is `root`), else None.
pub fn inside(root: &Path, path: &Path) -> Option<PathBuf> {
    let root = std::fs::canonicalize(root).ok()?;
    let real = resolve(path)?;
    real.starts_with(&root).then_some(real)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn inside_and_outside() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        std::fs::create_dir(r.join("src")).unwrap();
        std::fs::write(r.join("src/a.rs"), "").unwrap();
        assert!(inside(r, &r.join("src/a.rs")).is_some());
        assert!(inside(r, &r.join("src/new_file.rs")).is_some(), "not yet existing file inside");
        assert!(inside(r, &r.join("src/../src/a.rs")).is_some());
        assert!(inside(r, &r.join("../escape")).is_none(), "parent traversal");
        assert!(inside(r, &r.join("src/../../escape/x")).is_none());
        assert!(inside(r, Path::new("/etc/hosts")).is_none());
        assert!(inside(r, Path::new("relative/path")).is_none(), "relative paths are refused");
    }

    #[test]
    fn symlink_pointing_outside_is_outside() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "x").unwrap();
        symlink(outside.path(), root.path().join("link")).unwrap();
        assert!(inside(root.path(), &root.path().join("link/secret")).is_none());
        assert!(inside(root.path(), &root.path().join("link/new")).is_none());
    }

    #[test]
    fn sibling_with_common_prefix_is_outside() {
        let base = tempfile::tempdir().unwrap();
        std::fs::create_dir(base.path().join("proj")).unwrap();
        std::fs::create_dir(base.path().join("proj-evil")).unwrap();
        assert!(inside(&base.path().join("proj"), &base.path().join("proj-evil/x")).is_none());
    }
}
