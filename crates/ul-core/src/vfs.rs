//! Virtual file system sandboxed to the workspace roots.
//!
//! The user opens a folder; everything after that must stay inside it. Without
//! that check, any bug in the UI — or a third-party plugin — turns into reading
//! an arbitrary file off the disk.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use ul_formats::{detect, detect_by_name, Detection, PROBE_LEN};

#[derive(Debug, Error)]
pub enum VfsError {
    #[error("path escapes the workspace: {0}")]
    OutsideWorkspace(String),
    #[error("no workspace is open")]
    NoWorkspace,
    /// An operation the platform does not support — e.g. picking a folder on Android.
    #[error("{0}")]
    Unsupported(String),
    #[error("not a directory: {0}")]
    NotADirectory(String),
    #[error("file system error: {0}")]
    Io(#[from] io::Error),
}

impl Serialize for VfsError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub uri: String,
    pub name: String,
    pub parent: Option<String>,
    /// `"file"` or `"directory"` — matching `FileStat` in the plugin SDK.
    pub kind: String,
    pub size: u64,
    /// Unix ms, `None` when the platform does not provide it.
    pub modified: Option<u64>,
    pub readonly: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    #[serde(flatten)]
    pub stat: Stat,
    pub detection: Detection,
}

/// Directories that never deserve a place in the tree.
const NOISE: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    ".next",
    ".turbo",
    ".venv",
];

/// A directory that is never walked — neither in the tree nor in search.
pub(crate) fn is_noise(name: &str) -> bool {
    NOISE.contains(&name)
}

#[derive(Debug, Default)]
pub struct Workspace {
    roots: Vec<PathBuf>,
    granted: Vec<PathBuf>,
}

impl Workspace {
    pub fn new() -> Self {
        Self::default()
    }

    /// Folders the user explicitly opened. This is what the explorer shows.
    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    pub fn add_root(&mut self, path: impl AsRef<Path>) -> Result<PathBuf, VfsError> {
        let canonical = fs::canonicalize(path.as_ref())?;
        if !canonical.is_dir() {
            return Err(VfsError::NotADirectory(display(&canonical)));
        }
        if !self.roots.contains(&canonical) {
            self.roots.push(canonical.clone());
        }
        Ok(canonical)
    }

    /// A folder the user reached without opening it — permitted, but not shown.
    ///
    /// Kept apart from `roots` for a reason: what is in `roots` is what the
    /// explorer draws. Two things need to pass through `resolve` without
    /// appearing there.
    ///
    /// The library is one: a document it found must be openable, but a single
    /// glance at the library would otherwise drop Documents, Downloads, Desktop
    /// and Pictures among the user's opened folders, which nobody asked for.
    ///
    /// The save dialog is the other. Choosing a file in it is an explicit grant
    /// — the user named the folder to a dialog the operating system drew, which
    /// is a stronger act of permission than anything inside this program — and
    /// without recording it the write that follows is refused by our own
    /// sandbox. The folder still does not belong in the tree: saving a
    /// converted spreadsheet somewhere is not asking to browse there.
    pub fn grant_folder(&mut self, path: impl AsRef<Path>) -> Result<PathBuf, VfsError> {
        let canonical = fs::canonicalize(path.as_ref())?;
        if !canonical.is_dir() {
            return Err(VfsError::NotADirectory(display(&canonical)));
        }
        if !self.granted.contains(&canonical) {
            self.granted.push(canonical.clone());
        }
        Ok(canonical)
    }

    /// Resolves a path and checks that it stays inside one of the roots.
    ///
    /// `..` is removed lexically first, because a file that does not exist yet
    /// (save-as) cannot be resolved by the file system at all — and then as
    /// much of the path as does exist is resolved for real, so a symlink out of
    /// the workspace is caught. See `canonical_prefix`.
    pub fn resolve(&self, path: impl AsRef<Path>) -> Result<PathBuf, VfsError> {
        if self.roots.is_empty() && self.granted.is_empty() {
            return Err(VfsError::NoWorkspace);
        }

        let normalized = normalize(path.as_ref());

        // A symlink can lead outside; the real path is what gets checked.
        let effective = canonical_prefix(&normalized);

        let allowed = self
            .roots
            .iter()
            .chain(self.granted.iter())
            .any(|root| effective.starts_with(root));

        if allowed {
            Ok(effective)
        } else {
            Err(VfsError::OutsideWorkspace(display(&normalized)))
        }
    }

    pub fn stat(&self, path: impl AsRef<Path>) -> Result<Stat, VfsError> {
        let resolved = self.resolve(path)?;
        stat_of(&resolved)
    }

    pub fn read_dir(&self, path: impl AsRef<Path>) -> Result<Vec<DirEntry>, VfsError> {
        let resolved = self.resolve(path)?;
        if !resolved.is_dir() {
            return Err(VfsError::NotADirectory(display(&resolved)));
        }

        let mut entries = Vec::new();
        for entry in fs::read_dir(&resolved)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

            if is_noise(&name) {
                continue;
            }
            if is_dir && name.starts_with('.') {
                continue;
            }

            let stat = stat_of(&entry.path())?;
            let detection = if is_dir {
                detect_by_name("")
            } else {
                detect_by_name(&name)
            };
            entries.push(DirEntry { stat, detection });
        }

        // Directories first, then alphabetically — without this the tree is unreadable.
        entries.sort_by(|a, b| {
            let dir_a = a.stat.kind == "directory";
            let dir_b = b.stat.kind == "directory";
            dir_b
                .cmp(&dir_a)
                .then_with(|| a.stat.name.to_lowercase().cmp(&b.stat.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub fn read(&self, path: impl AsRef<Path>) -> Result<Vec<u8>, VfsError> {
        let resolved = self.resolve(path)?;
        Ok(fs::read(resolved)?)
    }

    /// Reads only the start of a file — enough for format detection without
    /// loading a hundred-page PDF into memory.
    pub fn detect_at(&self, path: impl AsRef<Path>) -> Result<Detection, VfsError> {
        use std::io::Read;

        let resolved = self.resolve(path)?;
        let name = resolved
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        let mut file = fs::File::open(&resolved)?;
        let mut probe = vec![0u8; PROBE_LEN];
        let read = file.read(&mut probe)?;
        probe.truncate(read);

        Ok(detect(&name, &probe))
    }

    /// Writes atomically: first to a neighbouring temporary file, then a
    /// rename. A power cut mid-save therefore leaves no truncated document.
    pub fn write(&self, path: impl AsRef<Path>, data: &[u8]) -> Result<(), VfsError> {
        let resolved = self.resolve(path)?;
        let temp = resolved.with_extension(format!(
            "{}.ultmp",
            resolved
                .extension()
                .map(|e| e.to_string_lossy().into_owned())
                .unwrap_or_default()
        ));

        fs::write(&temp, data)?;
        if let Err(err) = fs::rename(&temp, &resolved) {
            let _ = fs::remove_file(&temp);
            return Err(err.into());
        }
        Ok(())
    }
}

/* ── helpers ─────────────────────────────────────────────────────────── */

/// The path as the user sees it.
///
/// `fs::canonicalize` on Windows returns the verbatim form (`\\?\C:\...`), which is
/// a Win32 API detail with no business in a tab title or a search result.
/// `resolve` still returns it when needed, so stripping it at the boundary
/// towards the UI is safe.
pub(crate) fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned(),
    }
}

/// Canonicalises as much of a path as exists, keeping the rest as it was written.
///
/// A file that is not there yet cannot be canonicalised, and on Windows that is
/// not a cosmetic difference: `fs::canonicalize` hands back the extended-length
/// form, `\\?\C:\Users\…`, which is what the roots are stored as — while a path
/// to something that does not exist stays plain `C:\Users\…`. Comparing the two
/// never matches.
///
/// Every write until now went to a file that was already there, so the two
/// forms always agreed and this stayed invisible. The first save that creates a
/// file — the `.xls` and `.ods` conversions, which write a new `.xlsx` beside
/// the original — was refused as an escape from the very folder it was being
/// written into.
///
/// Walking up to the nearest ancestor that does exist and re-attaching the rest
/// puts both sides in the same form. It does not weaken the check: the part
/// that exists is still resolved through the file system, symlinks included,
/// and the part that does not cannot be a symlink to anywhere.
fn canonical_prefix(path: &Path) -> PathBuf {
    if let Ok(real) = fs::canonicalize(path) {
        return real;
    }

    let mut tail = Vec::new();
    let mut cursor = path;
    while let (Some(parent), Some(name)) = (cursor.parent(), cursor.file_name()) {
        tail.push(name.to_owned());
        if let Ok(real) = fs::canonicalize(parent) {
            let mut out = real;
            out.extend(tail.iter().rev());
            return out;
        }
        cursor = parent;
    }

    path.to_path_buf()
}

/// Lexical normalisation: drops `.` and resolves `..` without touching the disk.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub(crate) fn stat_of(path: &Path) -> Result<Stat, VfsError> {
    let meta = fs::metadata(path)?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    Ok(Stat {
        uri: display(path),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        parent: path.parent().map(display),
        kind: if meta.is_dir() {
            "directory".into()
        } else {
            "file".into()
        },
        size: meta.len(),
        modified,
        readonly: meta.permissions().readonly(),
    })
}

/* ── tests ───────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_resolves_parent_segments() {
        assert_eq!(normalize(Path::new("a/b/../c")), PathBuf::from("a/c"));
        assert_eq!(normalize(Path::new("./a/./b")), PathBuf::from("a/b"));
    }

    #[test]
    fn resolve_without_workspace_fails() {
        let workspace = Workspace::new();
        assert!(matches!(
            workspace.resolve("anything/at-all"),
            Err(VfsError::NoWorkspace)
        ));
    }

    #[test]
    fn escape_attempt_is_rejected() {
        let mut workspace = Workspace::new();
        let dir = std::env::temp_dir();
        workspace.add_root(&dir).expect("temp has to exist");

        // The classic sandbox escape attempt.
        let escaped = dir.join("..").join("..").join("etc").join("passwd");
        assert!(matches!(
            workspace.resolve(escaped),
            Err(VfsError::OutsideWorkspace(_))
        ));
    }

    /// The case that was broken: saving a file that does not exist yet, into a
    /// folder that is open. On Windows the root is stored as `\\?\C:\…` and a
    /// path to something not on disk stays `C:\…`, so the two never matched and
    /// the write was refused as leaving the folder it was going into.
    #[test]
    fn a_file_that_does_not_exist_yet_resolves_inside_a_root() {
        let mut workspace = Workspace::new();
        let dir = std::env::temp_dir();
        workspace.add_root(&dir).expect("temp has to exist");

        let fresh = dir.join("ul-nothing-here-yet.xlsx");
        assert!(!fresh.exists(), "the test needs a name nothing uses");
        assert!(workspace.resolve(&fresh).is_ok());
    }

    /// And it must not have opened a door: a path that does not exist *outside*
    /// the roots is still refused, however far up its first real ancestor is.
    #[test]
    fn a_file_that_does_not_exist_yet_is_still_kept_inside() {
        let mut workspace = Workspace::new();
        let dir = std::env::temp_dir();
        workspace.add_root(&dir).expect("temp has to exist");

        let outside = dir
            .join("..")
            .join("ul-not-here-either")
            .join("deep")
            .join("file.xlsx");
        assert!(matches!(
            workspace.resolve(outside),
            Err(VfsError::OutsideWorkspace(_))
        ));
    }

    #[test]
    fn root_itself_resolves() {
        let mut workspace = Workspace::new();
        let dir = std::env::temp_dir();
        let root = workspace.add_root(&dir).expect("temp has to exist");
        assert!(workspace.resolve(&root).is_ok());
    }

    #[test]
    fn read_dir_skips_noise() {
        assert!(NOISE.contains(&"node_modules"));
        assert!(NOISE.contains(&".git"));
    }
}
