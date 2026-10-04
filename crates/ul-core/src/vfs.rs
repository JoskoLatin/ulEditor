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
    /// Something that is neither a file nor a folder — a FIFO, a socket, a
    /// device. Opening a FIFO to read it waits for a writer, for ever.
    #[error("not a file: {0}")]
    NotAFile(String),
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
///
/// This list is the difference between a search that answers and one that
/// hangs, and the second half of it was added after measuring rather than
/// guessing. `crates/ul-core/examples/search-timing.rs` over one real
/// `Documents` folder: **114,722 files, of which 90,998 were under
/// `site-packages` and 18,721 under `__pycache__`** — a portable ComfyUI
/// installation living in the same folder as somebody's contracts and
/// photographs. A search took **seventeen seconds in a release build**, and
/// almost all of it was spent reading somebody else's Python.
///
/// The first half of the list covers the JavaScript and Rust worlds, which is
/// where this project's own noise comes from, and it covered nothing where the
/// person using it actually works. The lesson is worth more than the entries:
/// before an index is worth its invalidation, the work has to be worth doing at
/// all. Seventeen seconds of reading `site-packages` is not a case for
/// `tantivy` — it is a case for not reading `site-packages`.
///
/// Every name here has to be unambiguous. `dist`, `target` and `venv` are
/// conventions strong enough to bet on; `build`, `lib` and `env` are not, and a
/// person whose own folder is called `build` would lose it from their own tree.
const NOISE: &[&str] = &[
    // JavaScript, Rust, and this project's own output.
    "node_modules",
    ".git",
    "target",
    "dist",
    ".next",
    ".turbo",
    // Python, which is where the seventeen seconds went.
    ".venv",
    "venv",
    "site-packages",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
];

/// A directory that is never walked — neither in the tree nor in search.
pub(crate) fn is_noise(name: &str) -> bool {
    NOISE.contains(&name)
}

/// A file Office leaves beside a document, which is never a document itself.
///
/// While a `.docx` is open, Word keeps a second file next to it called
/// `~$` plus the name — a hundred and sixty bytes holding the name of whoever
/// has it open, so a colleague opening the same file is told who has it. It is
/// marked hidden, it carries the same extension as the real document, and every
/// reader that opens it can only report that it is damaged.
///
/// Listing them turns a folder of seven documents into a folder of fourteen,
/// half of which cannot be opened. A run of the fidelity harness over one real
/// Documents folder found exactly seven of them and nothing else wrong.
pub(crate) fn is_scratch(name: &str) -> bool {
    name.starts_with("~$")
}

#[derive(Debug, Default, Clone)]
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

    /// One file, and nothing beside it.
    ///
    /// A definition a language server points at — in the standard library, or
    /// in somebody else's crate — has to open, and adopting it used to make its
    /// whole folder a root: in the tree, searched, written to. A server's answer
    /// is not a person's gesture, and nobody asked for the folder. So only the
    /// file is let in — and not through a link: a link in a project pointing out
    /// of it is refused when it is opened, and a definition that names the link
    /// must not let in what it points at.
    pub fn grant_file(&mut self, path: impl AsRef<Path>) -> Result<PathBuf, VfsError> {
        if fs::symlink_metadata(path.as_ref())?
            .file_type()
            .is_symlink()
        {
            return Err(VfsError::NotAFile(display(path.as_ref())));
        }
        let canonical = fs::canonicalize(path.as_ref())?;
        if !canonical.is_file() {
            return Err(VfsError::NotAFile(display(&canonical)));
        }
        if !self.granted.contains(&canonical) {
            self.granted.push(canonical.clone());
        }
        Ok(canonical)
    }

    /// Takes a folder out of the roots.
    ///
    /// Taking it off the tree used to leave it in the sandbox until the program
    /// was closed — still searched, still listed by Ctrl+P, still open to read
    /// and write. Matched by the folder itself and by how it was shown, since a
    /// folder that is gone cannot be resolved any more.
    ///
    /// The roots only. A folder inside one the library or a save dialog let in
    /// (`grant_folder`) leaves the tree, the search and Ctrl+P, and can still be
    /// read and written through that grant — which is the library's to answer
    /// for (card 470).
    pub fn forget_root(&mut self, path: impl AsRef<Path>) {
        let path = path.as_ref();
        let canonical = fs::canonicalize(path).ok();
        let shown = display(path);
        self.roots
            .retain(|root| canonical.as_ref() != Some(root) && display(root) != shown);
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
            /* Dotfiles stay: `.gitignore` and `.editorconfig` are files somebody
            opens on purpose. An Office owner file is not. */
            if !is_dir && is_scratch(&name) {
                continue;
            }

            /* One entry that cannot be looked at — a link to something that is
            gone, most often — is left out. It used to fail the whole folder,
            and the tree then dropped the folder as if it had disappeared. */
            let Ok(stat) = stat_of(&entry.path()) else {
                continue;
            };
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
        openable(&resolved)?;
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

        openable(&resolved)?;
        let mut file = fs::File::open(&resolved)?;
        let mut probe = vec![0u8; PROBE_LEN];
        let read = file.read(&mut probe)?;
        probe.truncate(read);

        Ok(detect(&name, &probe))
    }

    /// Writes atomically: first to a neighbouring temporary file, then a
    /// rename. A power cut mid-save therefore leaves no truncated document.
    ///
    /// The temporary file is **made new, never opened**. `fs::write` opens
    /// whatever already has the name, and follows a symbolic link to do it: a
    /// folder that came with `notes.md.ultmp` pointing at `~/.bashrc` had the
    /// next save of `notes.md` written into `.bashrc`. Made with `create_new`,
    /// a name somebody has taken — a file, a link, a link to nothing — is
    /// refused, and the next name is tried.
    pub fn write(&self, path: impl AsRef<Path>, data: &[u8]) -> Result<(), VfsError> {
        use std::io::Write;

        let resolved = self.resolve(path)?;
        let (mut file, temp) = create_beside(&resolved)?;

        let written = carry_over(&resolved, &file, &temp).and_then(|()| file.write_all(data));
        drop(file);
        if let Err(err) = written {
            let _ = fs::remove_file(&temp);
            return Err(err.into());
        }
        let was_there = fs::symlink_metadata(&resolved).is_ok();
        if let Err(err) = put_in_place(&temp, &resolved) {
            /* Where the document was there and is gone — `ReplaceFileW` can
            take it away and then fail to move the new version in — the new
            version is the only copy there is, and it stays, under the name the
            error gives. A first save that failed leaves nothing behind. */
            if !was_there || fs::symlink_metadata(&resolved).is_ok() {
                let _ = fs::remove_file(&temp);
                return Err(err.into());
            }
            return Err(VfsError::Io(std::io::Error::new(
                err.kind(),
                format!("{err} — the saved text is in {}", display(&temp)),
            )));
        }
        sweep_leftovers(&resolved);
        Ok(())
    }
}

/// Refuses, before it is opened, what is neither a file nor a folder. A
/// folder is left to the read to refuse, as it always was.
fn openable(path: &Path) -> Result<(), VfsError> {
    let kind = fs::metadata(path)?.file_type();
    if kind.is_file() || kind.is_dir() {
        Ok(())
    } else {
        Err(VfsError::NotAFile(display(path)))
    }
}

/// What a save must not take from the document: who may read it, and on
/// Windows the mark that says it came from the internet.
///
/// A save writes a new file and renames it over the old one, and a new file
/// starts with the defaults — on Linux and macOS readable by everybody on the
/// machine where the document was `0600`; on Windows without its
/// `Zone.Identifier` stream, so a `.docx` from an email, saved once here, opened
/// in Word without Protected View. Both go to the new file before it takes the
/// old one's place. A document saved for the first time has neither.
fn carry_over(original: &Path, temp_file: &fs::File, temp: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let _ = temp;
        /* Who may read and write, and nothing more: setuid, setgid and sticky
        are not carried, or a file somebody planted would keep its setuid bit
        through a save by root. */
        // The document's own, not whatever a link put in its place points at.
        if let Some(meta) = fs::symlink_metadata(original)
            .ok()
            .filter(|meta| meta.is_file())
        {
            temp_file.set_permissions(fs::Permissions::from_mode(meta.mode() & 0o777))?;
        }
    }
    #[cfg(windows)]
    {
        let _ = temp_file;
        /* One that was read and cannot be written fails the save rather than
        dropping it. */
        if let Some(mark) = mark_of(original) {
            fs::write(zone_stream(temp), mark)?;
        }
    }
    #[cfg(not(any(unix, windows)))]
    let _ = (original, temp_file, temp);
    Ok(())
}

/// The `Zone.Identifier` stream of a file, by its name.
#[cfg(windows)]
fn zone_stream(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(":Zone.Identifier");
    PathBuf::from(name)
}

/// The longest mark read as it is. Windows writes a few lines; one far longer
/// was made by somebody else, and reading it whole would hold this save — and
/// every other, behind the sandbox's lock — for as long as it took.
#[cfg(windows)]
const LONGEST_MARK: u64 = 64 * 1024;

/// The mark a file from the internet carries, for its next version.
///
/// None where there is none: no stream, or a volume with no streams at all
/// (FAT on a stick). A mark that cannot be taken as it is — too long, or
/// unreadable — becomes the plain mark of the internet zone: a document must
/// not come out of a save trusted because its mark was odd.
#[cfg(windows)]
fn mark_of(original: &Path) -> Option<Vec<u8>> {
    use std::io::Read;

    const INTERNET: &[u8] = b"[ZoneTransfer]\r\nZoneId=3\r\n";
    let file = match fs::File::open(zone_stream(original)) {
        Ok(file) => file,
        // Not found, path not found, or a name this volume has no streams for.
        Err(err) if matches!(err.raw_os_error(), Some(2 | 3 | 123)) => return None,
        Err(_) => return Some(INTERNET.to_vec()),
    };
    let mut mark = Vec::new();
    match file.take(LONGEST_MARK + 1).read_to_end(&mut mark) {
        Ok(_) if mark.len() as u64 <= LONGEST_MARK => Some(mark),
        _ => Some(INTERNET.to_vec()),
    }
}

/// Puts the new version in the document's place.
///
/// On Windows through `ReplaceFileW` when the document is already there. A
/// rename gives the document the new file's security, inherited from its
/// folder: a document somebody had closed to other accounts was open to them
/// again after one save, and one encrypted with EFS in an unencrypted folder was
/// written in the clear. `ReplaceFileW` keeps the document's ACL, attributes,
/// encryption and streams. Where it will not — another file system, a share
/// without it — the rename is what there is; whatever state a refusal leaves,
/// the new version is still under its temporary name and the rename finishes
/// the job.
///
/// Only over a plain file, asked without following a link. A document swapped
/// for a link since it was resolved would have the new version written through
/// the link, wherever it points; a rename replaces the link itself. A swap in
/// the instant between this look and the call is not covered — that needs a
/// process writing in the folder while the save runs, and on Windows the right
/// to make a file link.
fn put_in_place(temp: &Path, original: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    if fs::symlink_metadata(original).is_ok_and(|meta| meta.is_file()) {
        match replace_file(original, temp) {
            Ok(()) => return Ok(()),
            /* Somebody else holds the new version or the document open —
            another program, or another account waiting for exactly this
            moment. The rename would hand the document the folder's security
            in place of its own, so the save is refused instead, and says
            why. */
            Err(err) if matches!(err.raw_os_error(), Some(32 | 33)) => return Err(err),
            Err(_) => {}
        }
    }
    fs::rename(temp, original)
}

#[cfg(windows)]
fn replace_file(original: &Path, replacement: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }

    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<u16>>()
    };
    let (original, replacement) = (wide(original), wide(replacement));
    // SAFETY: both are NUL-terminated wide strings that outlive the call, no
    // backup is asked for, and the two reserved pointers are null as required.
    let done = unsafe {
        ReplaceFileW(
            original.as_ptr(),
            replacement.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if done != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// A temporary file beside `path` that did not exist until now.
fn create_beside(path: &Path) -> std::io::Result<(fs::File, PathBuf)> {
    let mut taken = None;
    for attempt in 0..16 {
        let temp = temp_beside(path, attempt);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        /* Nobody else opens it while it is being written: it starts with the
        folder's security, not the document's. */
        #[cfg(windows)]
        std::os::windows::fs::OpenOptionsExt::share_mode(&mut options, 0);
        match options.open(&temp) {
            Ok(file) => return Ok((file, temp)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => taken = Some(err),
            /* On Windows a folder or a junction under the name is not "already
            exists" but "access denied". It is taken all the same. */
            Err(err)
                if err.kind() == std::io::ErrorKind::PermissionDenied
                    && fs::symlink_metadata(&temp).is_ok() =>
            {
                taken = Some(err)
            }
            Err(err) => return Err(err),
        }
    }
    Err(taken.expect("sixteen names were tried"))
}

/// Takes away the temporary files an earlier run left beside this document —
/// ended, or killed, in the middle of a save. Only what this program names so
/// (`notes.md.<process>-<attempt>.ultmp`, and `notes.md.ultmp` from before the
/// process was in the name), only regular files, and never this run's own.
fn sweep_leftovers(path: &Path) {
    let (Some(folder), Some(name)) = (path.parent(), path.file_name()) else {
        return;
    };
    let name = name.to_string_lossy();
    let prefix = format!("{name}.");
    let ours = std::process::id().to_string();
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let found = entry.file_name().to_string_lossy().into_owned();
        let Some(middle) = found
            .strip_prefix(&prefix)
            .and_then(|rest| rest.strip_suffix("ultmp"))
        else {
            continue;
        };
        let left_over = if middle.is_empty() {
            true
        } else {
            let numbered = middle.strip_suffix('.').and_then(|m| m.split_once('-'));
            let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
            numbered.is_some_and(|(process, attempt)| {
                digits(process) && digits(attempt) && process != ours
            })
        };
        if left_over && entry.file_type().is_ok_and(|kind| kind.is_file()) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// `notes.md` → `notes.md.<process>-<attempt>.ultmp`.
fn temp_beside(path: &Path, attempt: u32) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}-{attempt}.ultmp", std::process::id()));
    path.with_file_name(name)
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

    /// Word's owner file is not a Word document, and a folder holding seven
    /// open documents should not read as fourteen.
    #[test]
    fn office_owner_files_are_not_documents() {
        assert!(is_scratch("~$Ugovor o najmu.docx"));
        assert!(is_scratch("~$racun.xlsx"));

        // A dotfile is something somebody opens on purpose, and stays.
        assert!(!is_scratch(".gitignore"));
        assert!(!is_scratch("Ugovor o najmu.docx"));
        assert!(!is_scratch("proracun~1.xlsx"));
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

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ul-vfs-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Whatever already has the temporary name is left as it was.
    #[test]
    fn a_save_leaves_a_temporary_name_somebody_took_alone() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("taken")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "before").unwrap();
        let taken = temp_beside(&file, 0);
        fs::write(&taken, "somebody else's").unwrap();

        workspace.write(&file, b"after").unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "after");
        assert_eq!(fs::read_to_string(&taken).unwrap(), "somebody else's");
    }

    /// A folder under the temporary name is taken too. On Windows that is
    /// "access denied" rather than "already exists", and was the end of the save.
    #[test]
    fn a_save_goes_round_a_folder_under_its_temporary_name() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("folder")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "before").unwrap();
        let taken = temp_beside(&file, 0);
        fs::create_dir(&taken).unwrap();

        workspace.write(&file, b"after").unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "after");
        assert!(taken.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn a_save_does_not_follow_a_link_left_where_its_temporary_file_goes() {
        let base = scratch("link");
        let outside = base.join("outside.txt");
        fs::write(&outside, "untouched").unwrap();
        let inside = base.join("ws");
        fs::create_dir_all(&inside).unwrap();

        let mut workspace = Workspace::new();
        let root = workspace.add_root(&inside).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "before").unwrap();
        std::os::unix::fs::symlink(&outside, temp_beside(&file, 0)).unwrap();

        workspace.write(&file, b"after").unwrap();

        assert_eq!(fs::read_to_string(&outside).unwrap(), "untouched");
        assert_eq!(fs::read_to_string(&file).unwrap(), "after");
        assert!(!fs::symlink_metadata(&file)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(windows)]
    #[test]
    fn a_save_keeps_the_mark_of_a_file_from_the_internet() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("zone")).unwrap();
        let file = root.join("downloaded.docx");
        fs::write(&file, "before").unwrap();
        let mut mark = file.as_os_str().to_os_string();
        mark.push(":Zone.Identifier");
        let mark = PathBuf::from(mark);
        fs::write(&mark, "[ZoneTransfer]\r\nZoneId=3\r\n").unwrap();

        workspace.write(&file, b"after").unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "after");
        assert_eq!(
            fs::read_to_string(&mark).ok().as_deref(),
            Some("[ZoneTransfer]\r\nZoneId=3\r\n"),
            "the save took the mark away"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_save_keeps_who_may_read_the_document() {
        use std::os::unix::fs::PermissionsExt;

        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("mode")).unwrap();
        let file = root.join("private.md");
        fs::write(&file, "before").unwrap();
        /* 0604 rather than 0600: under `umask 077` a new file is 0600 by
        itself, and the test would pass with nothing carried over. */
        fs::set_permissions(&file, fs::Permissions::from_mode(0o604)).unwrap();

        workspace.write(&file, b"after").unwrap();

        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o604, "the save made it {mode:o}");
    }

    /// A document closed to everybody else stays closed after a save. A
    /// rename gave it the security of the folder it is in.
    #[cfg(windows)]
    #[test]
    fn a_save_keeps_who_may_read_the_document_on_windows() {
        let icacls = |path: &Path, args: &[&str]| {
            let out = std::process::Command::new("icacls")
                .arg(display(path))
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("acl")).unwrap();
        let file = root.join("closed.md");
        fs::write(&file, "before").unwrap();
        let me = std::env::var("USERNAME").unwrap();
        icacls(&file, &["/inheritance:r", "/grant:r", &format!("{me}:(F)")]);
        assert!(
            !icacls(&file, &[]).contains("(I)"),
            "the test could not close the file"
        );

        workspace.write(&file, b"after").unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "after");
        let after = icacls(&file, &[]);
        assert!(
            !after.contains("(I)"),
            "the save opened it to the folder: {after}"
        );
    }

    /// A mark too long to be one Windows wrote is replaced by the plain mark of
    /// the internet zone, not copied whole and not dropped.
    #[cfg(windows)]
    #[test]
    fn an_outsized_mark_becomes_the_plain_internet_one() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("big-mark")).unwrap();
        let file = root.join("downloaded.docx");
        fs::write(&file, "before").unwrap();
        fs::write(zone_stream(&file), vec![b'x'; 128 * 1024]).unwrap();

        workspace.write(&file, b"after").unwrap();

        assert_eq!(
            fs::read(zone_stream(&file)).unwrap(),
            b"[ZoneTransfer]\r\nZoneId=3\r\n"
        );
    }

    /// One link to something that is gone, and the rest of the folder is still
    /// there to see.
    #[test]
    fn a_link_to_something_gone_does_not_hide_the_folder() {
        let mut links = crate::testing::Links::default();
        let base = scratch("dangling");
        let gone = base.join("gone");
        fs::create_dir_all(&gone).unwrap();
        let inside = base.join("ws");
        fs::create_dir_all(&inside).unwrap();
        fs::write(inside.join("kept.txt"), "here").unwrap();
        links.folder(&inside.join("broken"), &gone);
        fs::remove_dir(&gone).unwrap();

        let mut workspace = Workspace::new();
        let root = workspace.add_root(&inside).unwrap();
        let listed = workspace.read_dir(&root).unwrap();

        let names: Vec<&str> = listed.iter().map(|e| e.stat.name.as_str()).collect();
        assert_eq!(names, ["kept.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_is_refused_rather_than_waited_on() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("fifo")).unwrap();
        let fifo = root.join("pipe.txt");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(made.success());

        let (done, outcome) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let read = workspace.read(&fifo).map(|_| ());
            let detected = workspace.detect_at(&fifo).map(|_| ());
            let _ = done.send((read, detected));
        });
        let (read, detected) = outcome
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("opening the FIFO waited for a writer");
        assert!(matches!(read, Err(VfsError::NotAFile(_))));
        assert!(matches!(detected, Err(VfsError::NotAFile(_))));
    }

    /// Only the file a language server pointed at is let in, not its folder.
    #[test]
    fn a_granted_file_lets_in_that_file_and_nothing_beside_it() {
        let base = scratch("grant-file");
        fs::write(base.join("definition.rs"), "fn here() {}").unwrap();
        fs::write(base.join("beside.rs"), "fn not_asked_for() {}").unwrap();

        let mut workspace = Workspace::new();
        let granted = workspace.grant_file(base.join("definition.rs")).unwrap();

        assert!(workspace.read(&granted).is_ok());
        assert!(matches!(
            workspace.read(granted.with_file_name("beside.rs")),
            Err(VfsError::OutsideWorkspace(_))
        ));
        assert!(workspace.roots().is_empty(), "the folder became a root");
        assert!(matches!(
            workspace.grant_file(&base),
            Err(VfsError::NotAFile(_))
        ));
    }

    #[test]
    fn a_forgotten_folder_is_out_of_the_sandbox() {
        let base = scratch("forget");
        fs::write(base.join("note.txt"), "here").unwrap();

        let mut workspace = Workspace::new();
        let root = workspace.add_root(&base).unwrap();
        assert!(workspace.read(root.join("note.txt")).is_ok());

        workspace.forget_root(display(&root));

        assert!(workspace.roots().is_empty());
        assert!(workspace.read(root.join("note.txt")).is_err());
    }

    /// What an interrupted save left beside the document goes with the next
    /// save — and nothing that only looks like it.
    #[test]
    fn a_save_takes_away_what_an_interrupted_one_left() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("leftovers")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "before").unwrap();
        let left = ["notes.md.4294967-0.ultmp", "notes.md.ultmp"];
        let kept = [
            "notes.md.backup",
            "notes.md.12-x.ultmp",
            "other.md.4294967-0.ultmp",
            "notes.md.4294967-0.ultmp.txt",
        ];
        for name in left.iter().chain(kept.iter()) {
            fs::write(root.join(name), "somebody's").unwrap();
        }

        workspace.write(&file, b"after").unwrap();

        for name in left {
            assert!(!root.join(name).exists(), "{name} was left");
        }
        for name in kept {
            assert!(root.join(name).exists(), "{name} was taken");
        }
        assert_eq!(fs::read_to_string(&file).unwrap(), "after");
    }

    /// A definition named through a link does not let in what the link points
    /// at: opening the link from the project is refused, and so is this.
    #[cfg(unix)]
    #[test]
    fn a_granted_file_is_not_let_in_through_a_link() {
        let mut links = crate::testing::Links::default();
        let base = scratch("grant-link");
        fs::write(base.join("outside.rs"), "fn secret() {}").unwrap();
        links.file(&base.join("pointer.rs"), &base.join("outside.rs"));

        let mut workspace = Workspace::new();
        assert!(matches!(
            workspace.grant_file(base.join("pointer.rs")),
            Err(VfsError::NotAFile(_))
        ));
        assert!(workspace.read(base.join("outside.rs")).is_err());
    }

    /// A mark that is there and cannot be read — somebody holds it shut — is
    /// taken as the plain internet one, not as none.
    #[cfg(windows)]
    #[test]
    fn a_mark_that_cannot_be_read_is_taken_as_the_internet_one() {
        use std::os::windows::fs::OpenOptionsExt;

        let base = scratch("locked-mark");
        let file = base.join("downloaded.docx");
        fs::write(&file, "before").unwrap();
        fs::write(zone_stream(&file), "[ZoneTransfer]\r\nZoneId=4\r\n").unwrap();
        let _held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(zone_stream(&file))
            .unwrap();

        assert_eq!(
            mark_of(&file).as_deref(),
            Some(&b"[ZoneTransfer]\r\nZoneId=3\r\n"[..])
        );
    }
}
