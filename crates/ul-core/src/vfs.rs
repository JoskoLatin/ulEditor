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
    /// The file is not what it was when it was opened: replaced by another,
    /// or written by another program. A save over it waits for the person to
    /// say so (`Workspace::save`).
    #[error("{0} was changed outside ulEditor since it was opened")]
    Changed(String),
    #[error("file system error: {0}")]
    Io(#[from] io::Error),
}

/// What a refused save over a changed file begins with when it crosses to the
/// interface, which asks the person and tries once more. A code rather than
/// the sentence: the sentence is for people, and could change.
pub const CHANGED_OUTSIDE: &str = "ul:changed-outside:";

impl Serialize for VfsError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Changed(path) => serializer.serialize_str(&format!("{CHANGED_OUTSIDE}{path}")),
            other => serializer.serialize_str(&other.to_string()),
        }
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
    /// Folders nothing is let into, whatever was opened above them.
    protected: Vec<PathBuf>,
    /// Each document as it was when it was read to be edited, or last saved,
    /// by `record_key`.
    seen: std::collections::HashMap<String, Opened>,
}

/// A document as it was read to be edited: where it was, which file it was,
/// and how it was protected.
#[derive(Debug, Clone)]
struct Opened {
    /// Where it was read from, any link to it followed: where its next
    /// version goes.
    at: PathBuf,
    /// Which file it was, and how; none once a save cannot tell which file
    /// it left there — then no file there is taken for it again.
    print: Option<Fingerprint>,
    protection: Protection,
    /// The file `protection` was read from, or none where it is what a save
    /// here gave a version it then lost sight of. Only a file provably this
    /// one hands its own security to the next version; any other gets
    /// `protection`.
    owner: Option<Fingerprint>,
}

impl Opened {
    /// What a document read from `file` is remembered as.
    fn of(at: PathBuf, print: Fingerprint, protection: Protection) -> Self {
        Self {
            at,
            print: Some(print.clone()),
            protection,
            owner: Some(print),
        }
    }

    /// Whether `now` is provably the file the protection was read from.
    fn is_owner(&self, now: &Fingerprint) -> bool {
        self.owner
            .as_ref()
            .is_some_and(|owner| owner.same_file(now))
    }
}

/// What a document's record is kept under: the path as the page gave it,
/// with nothing on disk asked. Kept under the path the file system resolved
/// it to, the record was lost to a replacement that resolved differently —
/// `NOTES.md` put in place of `notes.md`, which NTFS spells as it is on disk,
/// or a link in its place — and the save went ahead as on a file nobody had
/// read, with the replacement's security. Letters are folded where the file
/// system folds them; on one that does not, two names that differ only so
/// share a record, which costs a question, never a save without one.
fn record_key(path: &Path) -> String {
    let key = display(&normalize(path));
    if cfg!(any(windows, target_vendor = "apple")) {
        key.to_lowercase()
    } else {
        key
    }
}

/// How a document was protected when it was opened — what its next version
/// is given if the file has been replaced meanwhile and the person said to
/// write over it. Neither the replacement's protection (somebody else's,
/// which could open the content to them) nor none at all (the folder's,
/// which could open it wider than the document was): the document's own.
#[derive(Debug, Clone, Default)]
struct Protection {
    #[cfg(windows)]
    dacl: Option<windows::Dacl>,
    #[cfg(windows)]
    mark: Option<Vec<u8>>,
    /// When it was made: a rename would make the next version today.
    #[cfg(windows)]
    created: Option<std::time::SystemTime>,
    /// Encrypted with EFS, or hidden — what it is, its next version is from
    /// the start, encryption being something only a file's creation gives.
    #[cfg(windows)]
    attributes: u32,
    #[cfg(unix)]
    mode: Option<u32>,
    #[cfg(target_os = "macos")]
    quarantine: Option<Vec<u8>>,
}

impl Protection {
    /// Read from the open document. One that cannot be read fails the open:
    /// a save could not then give the document its own protection back.
    fn of(path: &Path, file: &fs::File) -> io::Result<Self> {
        let _ = (path, file);
        #[cfg(any(windows, unix))]
        let meta = file.metadata()?;
        Ok(Self {
            #[cfg(windows)]
            dacl: windows::dacl_of(file)?,
            #[cfg(windows)]
            mark: mark_of(path),
            #[cfg(windows)]
            created: meta.created().ok(),
            #[cfg(windows)]
            attributes: std::os::windows::fs::MetadataExt::file_attributes(&meta)
                & windows::KEPT_ATTRIBUTES,
            #[cfg(unix)]
            mode: {
                use std::os::unix::fs::MetadataExt;
                Some(meta.mode() & 0o777)
            },
            #[cfg(target_os = "macos")]
            quarantine: macos::quarantine_of(path)?,
        })
    }

    /// Gives the new version this protection, before anything is in it.
    fn give(&self, temp_file: &fs::File, temp: &Path) -> io::Result<()> {
        let _ = (temp_file, temp);
        #[cfg(target_os = "macos")]
        if let Some(mark) = &self.quarantine {
            macos::set_quarantine(temp_file, mark)?;
        }
        #[cfg(unix)]
        if let Some(mode) = self.mode {
            use std::os::unix::fs::PermissionsExt;
            temp_file.set_permissions(fs::Permissions::from_mode(mode))?;
        }
        #[cfg(windows)]
        {
            if let Some(dacl) = &self.dacl {
                windows::set_dacl(temp_file, dacl)?;
            }
            if let Some(created) = self.created {
                use std::os::windows::fs::FileTimesExt;
                temp_file.set_times(fs::FileTimes::new().set_created(created))?;
            }
            if let Some(mark) = &self.mark {
                fs::write(zone_stream(temp), mark)?;
            }
        }
        Ok(())
    }

    /// Keeps a mark of the internet `other` carries where this has none: a
    /// file read again that is not the one this was read from does not give
    /// its security, but a mark on it says where its content came from.
    fn keep_marks_of(&mut self, other: &Self) {
        let _ = other;
        #[cfg(windows)]
        if self.mark.is_none() {
            self.mark.clone_from(&other.mark);
        }
        #[cfg(target_os = "macos")]
        if self.quarantine.is_none() {
            self.quarantine.clone_from(&other.quarantine);
        }
    }

    #[cfg(windows)]
    fn has_dacl(&self) -> bool {
        self.dacl.is_some()
    }
}

/// Where the next version takes its protection from.
enum Source<'a> {
    /// The file in the document's place now, read by name as on any write
    /// of a file nobody read here.
    Document,
    /// This: the document's own, read from it the moment it was provably the
    /// document, or remembered from when it was opened.
    Given(&'a Protection),
}

/// A new version as it was written, asked of the file itself before it took
/// the document's place: what a save remembers of it.
struct Written {
    print: Fingerprint,
    protection: Protection,
}

/// Which file a document is, and how it was: what `Workspace::save` compares
/// to tell that somebody else changed it while it was open.
///
/// Which file: the volume and file ID on Windows, the device and inode on
/// Unix — a file replaced under the same name is a different one. How it was:
/// when it was last written and how long it is — a file written in place by
/// another program is the same file, changed.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint {
    #[cfg(windows)]
    id: Option<windows::Identity>,
    #[cfg(unix)]
    id: (u64, u64),
    /// When it was made. With the ID, what tells a file from one made in its
    /// place: a file system that frees an inode gives it to the next file made,
    /// so a document deleted and recreated by somebody else can have its inode
    /// — measured on the Linux runner, every time — but not its birth.
    created: Option<std::time::SystemTime>,
    modified: Option<std::time::SystemTime>,
    len: u64,
}

impl Fingerprint {
    fn of(file: &fs::File) -> io::Result<Self> {
        let meta = file.metadata()?;
        Ok(Self {
            #[cfg(windows)]
            id: windows::identity(file).ok(),
            #[cfg(unix)]
            id: {
                use std::os::unix::fs::MetadataExt;
                (meta.dev(), meta.ino())
            },
            created: meta.created().ok(),
            modified: meta.modified().ok(),
            len: meta.len(),
        })
    }

    fn at(path: &Path) -> Option<Self> {
        open_regular(path)
            .ok()
            .and_then(|file| Self::of(&file).ok())
    }

    /// Whether `other` has this one's ID, where both have one that tells.
    /// Where either does not, there is nothing to tell them apart by and they
    /// are taken for the same — which can let a save go ahead without a
    /// question, never let a file hand on its security: that takes
    /// `same_file`, which an ID that does not tell never passes.
    fn same_id(&self, other: &Self) -> bool {
        #[cfg(windows)]
        {
            match (&self.id, &other.id) {
                (Some(a), Some(b))
                    if *a != windows::Identity::Unknown && *b != windows::Identity::Unknown =>
                {
                    a == b
                }
                _ => true,
            }
        }
        #[cfg(unix)]
        {
            self.id == other.id
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = other;
            true
        }
    }

    /// Whether `other` is the same file, as far as can be told: the same ID
    /// and the same birth. Where either is not known, it is not — what is not
    /// known to be the same file does not get to hand its security to the
    /// next version.
    fn same_file(&self, other: &Self) -> bool {
        let born_together = matches!((self.created, other.created), (Some(a), Some(b)) if a == b);
        #[cfg(windows)]
        {
            born_together
                && matches!((&self.id, &other.id), (Some(a), Some(b)) if a == b && *a != windows::Identity::Unknown)
        }
        #[cfg(unix)]
        {
            born_together && self.id == other.id
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = (other, born_together);
            false
        }
    }
}

impl Workspace {
    pub fn new() -> Self {
        Self::default()
    }

    /// A folder nothing in it is let through, even when a folder above it is
    /// open: the program's own, where it keeps what the page must not be able
    /// to write — the projects a language server may run in, first of all. A
    /// page that opened its user's home folder could otherwise trust a project
    /// for them by writing a file.
    pub fn protect(&mut self, dir: impl AsRef<Path>) {
        let dir = canonical_prefix(&normalize(dir.as_ref()));
        if !self.protected.contains(&dir) {
            self.protected.push(dir);
        }
    }

    /// The folders `protect` shut, for the walks that do not go through
    /// `resolve` file by file — search and Ctrl+P.
    pub(crate) fn protected(&self) -> &[PathBuf] {
        &self.protected
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

        let allowed = !self.protected.iter().any(|dir| effective.starts_with(dir))
            && self
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
            let kind = entry.file_type().ok();
            let is_dir = kind.is_some_and(|t| t.is_dir());
            let is_link = kind.is_some_and(|t| t.is_symlink());

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

            /* A link — a symbolic link, or a junction on Windows — is listed as
            what it is and nothing more. What it points at may be outside every
            folder that was opened, and its size, its time, whether it can be
            written and whether it is a folder at all are that place's; a link
            in somebody's project pointing at a file of yours told them none of
            it, but the tree said it to anybody looking. Whether it can be
            opened is `resolve`'s answer, when it is opened. */
            let stat = if is_link {
                Stat {
                    uri: display(&entry.path()),
                    name: name.clone(),
                    parent: Some(display(&resolved)),
                    kind: "link".into(),
                    size: 0,
                    modified: None,
                    readonly: false,
                }
            } else {
                /* One entry that cannot be looked at is left out. It used to
                fail the whole folder, and the tree then dropped the folder as
                if it had disappeared. */
                let Ok(meta) = fs::symlink_metadata(entry.path()) else {
                    continue;
                };
                stat_from(&entry.path(), &meta)
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
        use std::io::Read;

        let resolved = self.resolve(path)?;
        let mut file = open_regular(&resolved)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    /// Reads a document to edit it, and remembers it as it was — which file,
    /// when it was written, how long — so that a save can tell whether
    /// somebody else changed it in the meantime (`save`). Every other read
    /// (search, a preview) uses `read`, which remembers nothing: reading a
    /// file is not agreeing to whatever is in it now.
    pub fn read_document(&mut self, path: impl AsRef<Path>) -> Result<Vec<u8>, VfsError> {
        use std::io::Read;

        let key = record_key(path.as_ref());
        let resolved = self.resolve(path)?;
        let mut file = open_regular(&resolved)?;
        let print = Fingerprint::of(&file)?;
        let protection = Protection::of(&resolved, &file)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        /* Read again — after a save, or to take in somebody else's change —
        it is what is in it now that is agreed to, not the security of
        whatever file is there: one that is not provably the file the
        protection was read from does not replace it, and only a mark of the
        internet on it is kept. An editor reads its document again after
        every save, and a file put in its place in that moment would
        otherwise hand its security to every save after. */
        let opened = match self.seen.remove(&key) {
            Some(mut before) if !before.is_owner(&print) => {
                before.protection.keep_marks_of(&protection);
                Opened {
                    at: resolved,
                    print: Some(print),
                    ..before
                }
            }
            _ => Opened::of(resolved, print, protection),
        };
        self.seen.insert(key, opened);
        Ok(bytes)
    }

    /// Writes a document, unless somebody else changed it since it was read
    /// with `read_document` or last saved here — then `VfsError::Changed`,
    /// and nothing is written, until the person says to (`overwrite`).
    ///
    /// Overwriting a file that was **replaced** — a different file under the
    /// same name — gives the new version the protection the document had when
    /// it was opened (`Protection`): not the replacement's, which is whoever
    /// put it there's and could make the person's content readable to them,
    /// and not merely the folder's, which could open it wider than the
    /// document was. A file only written in place is the same file, and its
    /// security is carried over as on any save. A file nobody read here is
    /// written as `write` writes it.
    pub fn save(
        &mut self,
        path: impl AsRef<Path>,
        data: &[u8],
        overwrite: bool,
    ) -> Result<(), VfsError> {
        let key = record_key(path.as_ref());
        let resolved = self.resolve(path)?;
        let opened = self.seen.get(&key).cloned();
        /* Whether the file there now is provably the document as it was
        opened — the one case its own security may be taken from it. Every
        other case of a document opened here gives the new version the
        protection remembered from then: a file that cannot be looked at (held
        open without sharing, or closed to reading by whoever put it there),
        one that is gone, which would otherwise come back with the folder's
        security, and one on a volume whose IDs do not tell files apart. */
        let own: Protection;
        let mut held = None;
        let (target, source) = match &opened {
            None => (resolved, Source::Document),
            /* The name no longer leads where the document was read from: its
            letters, or a link, changed under it. Asked about; written over,
            the new version goes where the document was — whatever has its
            name there now replaced, not written through — with the document's
            own protection. */
            Some(before) if resolved != before.at => {
                if !overwrite {
                    return Err(VfsError::Changed(display(&before.at)));
                }
                (
                    self.where_it_was(&before.at)?,
                    Source::Given(&before.protection),
                )
            }
            Some(before) => {
                /* Opened once, and everything taken from that one open file:
                a name leads to one file a moment and to another the next, so
                asking it twice — whether it changed, then for its security —
                could have the second answer from a file put there between
                the two. On Windows it is held, too, until the new version
                takes its place: nobody may write to it or take it away in the
                meantime, and what was checked is what is replaced. */
                held = open_held(&resolved).ok();
                let now = held.as_ref().and_then(|file| Fingerprint::of(file).ok());
                let source = match (&held, now) {
                    (Some(file), Some(now)) => {
                        if before.print.as_ref() != Some(&now) && !overwrite {
                            return Err(VfsError::Changed(display(&resolved)));
                        }
                        if before.is_owner(&now) {
                            own = Protection::of(&resolved, file)?;
                            Source::Given(&own)
                        } else {
                            Source::Given(&before.protection)
                        }
                    }
                    _ => {
                        /* There, and not to be looked at: changed, as far as
                        anybody can tell. Gone: nothing to ask about. */
                        if fs::symlink_metadata(&resolved).is_ok() && !overwrite {
                            return Err(VfsError::Changed(display(&resolved)));
                        }
                        Source::Given(&before.protection)
                    }
                };
                (resolved, source)
            }
        };
        let written = self.write_resolved(&target, data, &source, held)?;

        /* What the next save compares against: the new version, so long as
        the file in its place now is it — asked by which file it is, since
        between the rename and this the name is anybody's. One that is not,
        or cannot be looked at, is never taken for it; the protection kept is
        what this save gave, read from the new version before it was let go. */
        let now = Fingerprint::at(&target).filter(|now| now.same_id(&written.print));
        self.seen.insert(
            key,
            Opened {
                at: target,
                print: now.clone(),
                protection: written.protection,
                owner: now,
            },
        );
        Ok(())
    }

    /// Where a document read from `at` is written when its name no longer
    /// leads there: `at` itself, so long as its folder is still that folder
    /// and still let in.
    fn where_it_was(&self, at: &Path) -> Result<PathBuf, VfsError> {
        let (Some(folder), Some(name)) = (at.parent(), at.file_name()) else {
            return Err(VfsError::NotAFile(display(at)));
        };
        if self.resolve(folder)? != folder {
            return Err(VfsError::OutsideWorkspace(display(at)));
        }
        Ok(folder.join(name))
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

        let mut file = open_regular(&resolved)?;
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
        let resolved = self.resolve(path)?;
        self.write_resolved(&resolved, data, &Source::Document, None)
            .map(|_| ())
    }

    /// `write`, for a path already resolved, with the protection the new
    /// version is to have from `source` (see `save`). `held` is the document,
    /// let go only just before the new version takes its place.
    fn write_resolved(
        &self,
        resolved: &Path,
        data: &[u8],
        source: &Source<'_>,
        held: Option<fs::File>,
    ) -> Result<Written, VfsError> {
        use std::io::Write;

        let resolved = resolved.to_path_buf();
        let folder = resolved
            .parent()
            .ok_or_else(|| VfsError::NotADirectory(display(&resolved)))?;
        /* The folder is checked to be the one that was resolved, and on
        Windows held so until the save is over: swapped for a junction in the
        meantime, it would have the new version written wherever the junction
        pointed. See `hold_folder`. */
        #[cfg(windows)]
        let _held = windows::hold_folder(folder)?;
        let (mut file, temp) = create_beside(&resolved, source)?;

        let carried = match source {
            Source::Document => carry_over(&resolved, &file, &temp),
            Source::Given(protection) => protection.give(&file, &temp),
        };
        let written = carried.and_then(|()| file.write_all(data));
        /* Sharing is decided stream by stream: until its security was set, a
        new version shut to every other opener of its content could still be
        given a stream of somebody else's, which the rename would then carry
        into the document's place. Any stream but its content and the mark
        written here fails the save. */
        #[cfg(windows)]
        let written = written.and_then(|()| match windows::foreign_streams(&file) {
            Ok(foreign) if foreign.is_empty() => Ok(()),
            Ok(foreign) => Err(std::io::Error::other(format!(
                "a stream was added to the new version while it was written: {}",
                foreign.join(", ")
            ))),
            Err(err) => Err(err),
        });
        /* What the new version is and how it is protected, asked of it while
        it is still this program's alone. */
        let written = written.and_then(|()| {
            Ok(Written {
                print: Fingerprint::of(&file)?,
                protection: Protection::of(&temp, &file)?,
            })
        });
        drop(file);
        let written = match written {
            Ok(written) => written,
            Err(err) => {
                let _ = fs::remove_file(&temp);
                return Err(err.into());
            }
        };
        #[cfg(unix)]
        if let Err(err) = still_the_folder(folder) {
            let _ = fs::remove_file(&temp);
            return Err(err);
        }
        /* Let go only now: held, the document could not be replaced by the
        rename either. */
        drop(held);
        /* A rename replaces a link in the document's place rather than
        writing through it, and takes the document away only by putting the
        new version there. */
        if let Err(err) = fs::rename(&temp, &resolved) {
            let _ = fs::remove_file(&temp);
            return Err(err.into());
        }
        sweep_leftovers(&resolved);
        Ok(written)
    }
}

/// Whether the folder a save goes into is still the one that was resolved.
///
/// Asked just before the rename. What is left is the moment between this and
/// the rename itself: closing it needs the `*at` calls (`openat`,
/// `renameat`) on a handle of the folder, which the standard library does not
/// offer. Windows holds the folder instead — see `hold_folder`.
#[cfg(unix)]
fn still_the_folder(folder: &Path) -> Result<(), VfsError> {
    if fs::canonicalize(folder)? == folder {
        Ok(())
    } else {
        Err(VfsError::OutsideWorkspace(display(folder)))
    }
}

/// `O_NONBLOCK`, as the libc crate's own tables have it (0.2.189): 2048 on
/// Linux for the architectures this is built for and on Android, 4 on macOS
/// and the BSDs. Elsewhere it is not guessed — see `open_regular`.
#[cfg(any(
    target_os = "android",
    all(
        target_os = "linux",
        any(
            target_arch = "x86_64",
            target_arch = "aarch64",
            target_arch = "arm",
            target_arch = "x86"
        )
    )
))]
const O_NONBLOCK: Option<i32> = Some(0o4000);
#[cfg(any(
    target_vendor = "apple",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd",
    target_os = "dragonfly"
))]
const O_NONBLOCK: Option<i32> = Some(0x4);
#[cfg(all(
    unix,
    not(any(
        target_os = "android",
        all(
            target_os = "linux",
            any(
                target_arch = "x86_64",
                target_arch = "aarch64",
                target_arch = "arm",
                target_arch = "x86"
            )
        ),
        target_vendor = "apple",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd",
        target_os = "dragonfly"
    ))
))]
const O_NONBLOCK: Option<i32> = None;

/// Opens a file to read it — and only a file.
///
/// Opening a FIFO to read it waits for somebody to write into it, for ever,
/// and holding the sandbox's lock while it waits. Asking first and opening
/// after left a moment in which the file could be swapped for one. So it is
/// opened without waiting (`O_NONBLOCK`, which changes nothing for a regular
/// file), the open file is asked what it is, and anything but a regular file is
/// refused before a byte is read — a folder included, which a read refused
/// anyway. Where the flag's value is not known here, the question is asked of
/// the path before opening, as before.
/// The document a save is about to replace, opened to be looked at and held
/// until the new version takes its place: on Windows nobody else may write
/// to it, rename it or delete it while it is held, so the file checked is the
/// file replaced. A program that has it open to write meanwhile makes it one
/// that cannot be looked at, which is asked about. Unix has no such hold, and
/// the moment between the look and the rename stays.
fn open_held(path: &Path) -> Result<fs::File, VfsError> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let file = fs::OpenOptions::new()
            .read(true)
            .share_mode(windows::FILE_SHARE_READ)
            .open(path)?;
        if file.metadata()?.is_file() {
            Ok(file)
        } else {
            Err(VfsError::NotAFile(display(path)))
        }
    }
    #[cfg(not(windows))]
    open_regular(path)
}

pub(crate) fn open_regular(path: &Path) -> Result<fs::File, VfsError> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    match O_NONBLOCK {
        Some(flag) => {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(flag);
        }
        None => {
            if !fs::metadata(path)?.is_file() {
                return Err(VfsError::NotAFile(display(path)));
            }
        }
    }
    let file = options.open(path)?;
    if file.metadata()?.is_file() {
        Ok(file)
    } else {
        Err(VfsError::NotAFile(display(path)))
    }
}

/// What a save must not take from the document: who may read it, and on
/// Windows the mark that says it came from the internet and when it was made.
///
/// A save writes a new file and renames it over the old one, and a new file
/// starts with the defaults — on Linux and macOS readable by everybody on the
/// machine where the document was `0600`; on Windows with the folder's security
/// instead of the document's, and without its `Zone.Identifier` stream, so a
/// `.docx` from an email, saved once here, opened in Word without Protected
/// View. All of it goes to the new file **before anything is written into it**,
/// while it is empty — on Windows open to nobody else, on Unix readable by its
/// owner alone — so there is no moment in which the new version is less
/// protected than the old one. A document saved for the first time has none of
/// it.
fn carry_over(original: &Path, temp_file: &fs::File, temp: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let _ = temp;
        /* Who may read and write, and nothing more: setuid, setgid and sticky
        are not carried, or a file somebody planted would keep its setuid bit
        through a save by root. */
        // The document's own, not whatever a link put in its place points at.
        /* macOS's own mark of a file from the internet, which Gatekeeper and
        the apps that open it read as Windows' programs read Zone.Identifier.
        Set before the mode: a document that was read-only would leave a file
        nobody may set an attribute on. */
        #[cfg(target_os = "macos")]
        macos::carry_quarantine(original, temp_file)?;
        if let Some(meta) = fs::symlink_metadata(original)
            .ok()
            .filter(|meta| meta.is_file())
        {
            temp_file.set_permissions(fs::Permissions::from_mode(meta.mode() & 0o777))?;
        }
    }
    #[cfg(windows)]
    {
        if let Some(document) = windows::open_for_its_security(original)? {
            windows::copy_dacl(&document, temp_file)?;
            /* When it was made is the document's too: a rename would make it
            today. */
            if let Ok(created) = document.metadata().and_then(|meta| meta.created()) {
                use std::os::windows::fs::FileTimesExt;
                temp_file.set_times(fs::FileTimes::new().set_created(created))?;
            }
        }
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

/// `com.apple.quarantine`, the extended attribute macOS marks a file from the
/// internet with, carried to the document's next version.
#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_void, CString};
    use std::fs;
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::AsRawFd;
    use std::path::Path;

    /* From the libc crate's tables (0.2.189), for macOS. */
    const XATTR_NOFOLLOW: i32 = 0x0001;
    const ENOENT: i32 = 2;
    const ERANGE: i32 = 34;
    const ENOTSUP: i32 = 45;
    const ENOATTR: i32 = 93;

    const QUARANTINE: &[u8] = b"com.apple.quarantine\0";
    /// Far more than a mark macOS writes, which is a line of a few dozen
    /// bytes. A longer one fails the save, rather than be held in memory or
    /// left off the next version.
    const LONGEST: usize = 1024 * 1024;

    extern "C" {
        fn getxattr(
            path: *const std::ffi::c_char,
            name: *const std::ffi::c_char,
            value: *mut c_void,
            size: usize,
            position: u32,
            options: i32,
        ) -> isize;
        fn fsetxattr(
            fd: i32,
            name: *const std::ffi::c_char,
            value: *const c_void,
            size: usize,
            position: u32,
            options: i32,
        ) -> i32;
    }

    /// No mark, or a volume that keeps no extended attributes: nothing to
    /// carry. A mark that is there and cannot be read or written fails the
    /// save rather than leave the next version unmarked.
    pub(super) fn carry_quarantine(original: &Path, temp: &fs::File) -> io::Result<()> {
        match quarantine_of(original)? {
            Some(mark) => set_quarantine(temp, &mark),
            None => Ok(()),
        }
    }

    /// The mark a file carries, if any; read from the file itself, not
    /// through a link.
    pub(super) fn quarantine_of(original: &Path) -> io::Result<Option<Vec<u8>>> {
        attribute_of(original, QUARANTINE)
    }

    pub(super) fn set_quarantine(temp: &fs::File, value: &[u8]) -> io::Result<()> {
        set_attribute(temp, QUARANTINE, value)
    }

    /// An extended attribute of a file by its NUL-terminated name, if it has
    /// one. Its length is asked first and it is read at that length — again,
    /// if it grew in between — so a mark longer than a guess is carried
    /// rather than the save failed on `ERANGE`.
    pub(super) fn attribute_of(original: &Path, name: &[u8]) -> io::Result<Option<Vec<u8>>> {
        let path = CString::new(original.as_os_str().as_bytes())?;
        let mut value: Vec<u8> = Vec::new();
        for _ in 0..4 {
            // SAFETY: NUL-terminated path and name, and a buffer of the size
            // given — none, with a size of nought, to ask the length; the
            // attribute is read from the document itself, not through a link.
            let read = unsafe {
                getxattr(
                    path.as_ptr(),
                    name.as_ptr().cast(),
                    if value.is_empty() {
                        std::ptr::null_mut()
                    } else {
                        value.as_mut_ptr().cast()
                    },
                    value.len(),
                    0,
                    XATTR_NOFOLLOW,
                )
            };
            if read < 0 {
                let err = io::Error::last_os_error();
                match err.raw_os_error() {
                    Some(ENOATTR | ENOTSUP | ENOENT) => return Ok(None),
                    // Longer than when its length was asked: ask again.
                    Some(ERANGE) => {
                        value.clear();
                        continue;
                    }
                    _ => return Err(err),
                }
            }
            let read = read as usize;
            if read > LONGEST {
                return Err(io::Error::other(format!(
                    "an extended attribute of {read} bytes, longer than macOS writes"
                )));
            }
            if value.is_empty() && read > 0 {
                value = vec![0; read];
                continue;
            }
            value.truncate(read);
            return Ok(Some(value));
        }
        Err(io::Error::other(
            "an extended attribute kept changing while it was read",
        ))
    }

    pub(super) fn set_attribute(temp: &fs::File, name: &[u8], value: &[u8]) -> io::Result<()> {
        // SAFETY: an open descriptor, the NUL-terminated name and the bytes.
        let done = unsafe {
            fsetxattr(
                temp.as_raw_fd(),
                name.as_ptr().cast(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        if done == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
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

/// The document's security on Windows, read from it and given to its next
/// version.
///
/// `ReplaceFileW` did this for a while, at the moment of the replacement, and
/// two things came with it: until then the new version carried the folder's
/// security, readable by any account the folder let in; and it carried every
/// stream the document had, a planted one of half a gigabyte included, through
/// every save. Now the document's DACL is set on the new file as soon as it
/// exists — empty, and open to nobody else — and a plain rename does the rest.
#[cfg(windows)]
pub(crate) mod windows {
    use std::ffi::c_void;
    use std::fs;
    use std::io;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::ptr::null_mut;

    const SE_FILE_OBJECT: i32 = 1;
    const DACL_SECURITY_INFORMATION: u32 = 0x4;
    const PROTECTED_DACL_SECURITY_INFORMATION: u32 = 0x8000_0000;
    const UNPROTECTED_DACL_SECURITY_INFORMATION: u32 = 0x2000_0000;
    const SE_DACL_PROTECTED: u16 = 0x1000;
    const FILE_PERSISTENT_ACLS: u32 = 0x8;
    const READ_CONTROL: u32 = 0x0002_0000;
    pub(super) const FILE_READ_ATTRIBUTES: u32 = 0x80;
    const FILE_SHARE_ALL: u32 = 0x1 | 0x2 | 0x4;
    pub(super) const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_READ_WRITE: u32 = 0x1 | 0x2;
    const FILE_LIST_DIRECTORY: u32 = 0x1;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    /// What a new version is opened with, and with the right to set its
    /// security where it is to be given one.
    pub(super) const GENERIC_WRITE: u32 = 0x4000_0000;
    pub(super) const GENERIC_WRITE_AND_WRITE_DAC: u32 = GENERIC_WRITE | 0x0004_0000;
    /// What it takes of the document's attributes at its creation: encryption,
    /// which can only be given then, and being hidden. Encrypted anew, it is for
    /// whoever saves it: anybody else the document had been shared with through
    /// EFS has to be given it again.
    pub(super) const KEPT_ATTRIBUTES: u32 = 0x4000 | 0x2;

    #[link(name = "advapi32")]
    extern "system" {
        fn GetSecurityInfo(
            handle: *mut c_void,
            object_type: i32,
            info: u32,
            owner: *mut *mut c_void,
            group: *mut *mut c_void,
            dacl: *mut *mut c_void,
            sacl: *mut *mut c_void,
            descriptor: *mut *mut c_void,
        ) -> u32;
        fn SetSecurityInfo(
            handle: *mut c_void,
            object_type: i32,
            info: u32,
            owner: *mut c_void,
            group: *mut c_void,
            dacl: *const c_void,
            sacl: *const c_void,
        ) -> u32;
        fn GetSecurityDescriptorControl(
            descriptor: *mut c_void,
            control: *mut u16,
            revision: *mut u32,
        ) -> i32;
        fn GetSecurityDescriptorLength(descriptor: *mut c_void) -> u32;
        fn GetSecurityDescriptorDacl(
            descriptor: *mut c_void,
            present: *mut i32,
            dacl: *mut *mut c_void,
            defaulted: *mut i32,
        ) -> i32;
    }

    /// A document's DACL as it was when it was opened: the security
    /// descriptor itself, self-relative, kept in memory — aligned to eight,
    /// as the structures in it want — and whether it was protected from
    /// inheriting.
    #[derive(Debug, Clone)]
    pub(crate) struct Dacl {
        descriptor: Vec<u64>,
        protected: bool,
    }

    /// The DACL of an open file, kept; `None` on a volume that keeps no ACLs.
    pub(crate) fn dacl_of(file: &fs::File) -> io::Result<Option<Dacl>> {
        if !keeps_acls(file)? {
            return Ok(None);
        }
        let mut dacl = null_mut();
        let mut descriptor = null_mut();
        // SAFETY: a handle of an open file; the out-pointers are valid, and the
        // descriptor the call allocates is freed below.
        let status = unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let kept = (|| {
            let mut control = 0u16;
            let mut revision = 0u32;
            // SAFETY: the descriptor GetSecurityInfo returned, still allocated.
            if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: as above; the length is of the self-relative descriptor.
            let length = unsafe { GetSecurityDescriptorLength(descriptor) } as usize;
            let mut kept = vec![0u64; length.div_ceil(8)];
            // SAFETY: `length` bytes from the descriptor into a buffer at least
            // that long; the two do not overlap.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    descriptor.cast::<u8>(),
                    kept.as_mut_ptr().cast::<u8>(),
                    length,
                );
            }
            Ok(Dacl {
                descriptor: kept,
                protected: control & SE_DACL_PROTECTED != 0,
            })
        })();
        // SAFETY: allocated by GetSecurityInfo, freed once.
        unsafe { LocalFree(descriptor) };
        kept.map(Some)
    }

    /// Gives `to` a DACL kept by `dacl_of`, protected or inheriting as it was.
    pub(crate) fn set_dacl(to: &fs::File, kept: &Dacl) -> io::Result<()> {
        let descriptor = kept.descriptor.as_ptr() as *mut c_void;
        let mut present = 0i32;
        let mut defaulted = 0i32;
        let mut dacl = null_mut();
        // SAFETY: a self-relative descriptor this process copied whole and
        // keeps alive for the call; the out-pointers are valid.
        if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        if present == 0 {
            return Ok(());
        }
        let protection = if kept.protected {
            PROTECTED_DACL_SECURITY_INFORMATION
        } else {
            UNPROTECTED_DACL_SECURITY_INFORMATION
        };
        // SAFETY: the DACL points into the kept descriptor, alive for the
        // call; the handle was opened with WRITE_DAC.
        let status = unsafe {
            SetSecurityInfo(
                to.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | protection,
                null_mut(),
                null_mut(),
                dacl,
                std::ptr::null(),
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        Ok(())
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
        fn GetFinalPathNameByHandleW(
            file: *mut c_void,
            path: *mut u16,
            length: u32,
            flags: u32,
        ) -> u32;
        fn GetVolumeInformationByHandleW(
            file: *mut c_void,
            volume_name: *mut u16,
            volume_name_size: u32,
            serial: *mut u32,
            longest_component: *mut u32,
            flags: *mut u32,
            file_system_name: *mut u16,
            file_system_name_size: u32,
        ) -> i32;
        fn GetFileInformationByHandle(file: *mut c_void, info: *mut FileInformation) -> i32;
        fn GetFileInformationByHandleEx(
            file: *mut c_void,
            class: i32,
            info: *mut c_void,
            size: u32,
        ) -> i32;
    }

    /// `FileIdInfo` of `FILE_INFO_BY_HANDLE_CLASS`.
    const FILE_ID_INFO: i32 = 18;
    /// `FileStreamInfo` of `FILE_INFO_BY_HANDLE_CLASS`.
    const FILE_STREAM_INFO: i32 = 7;

    /// The streams of an open file other than its content and its
    /// `Zone.Identifier`, by name (`:name:$DATA`). None on a volume that keeps
    /// no streams. More than fit in 64 KiB of names are reported as foreign:
    /// nobody's document has that many on purpose.
    pub(crate) fn foreign_streams(file: &fs::File) -> io::Result<Vec<String>> {
        const ALLOWED: [&str; 2] = ["::$DATA", ":Zone.Identifier:$DATA"];
        let mut buffer = vec![0u64; 8192];
        // SAFETY: a handle of an open file, and a buffer of the size given,
        // aligned to eight as the entries in it want.
        let answered = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FILE_STREAM_INFO,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
            )
        } != 0;
        if !answered {
            let err = io::Error::last_os_error();
            return match err.raw_os_error() {
                // No streams at all on this volume (FAT), or none to list.
                Some(1 | 38 | 50 | 87) => Ok(Vec::new()),
                // ERROR_MORE_DATA: more than fit.
                Some(234) => Ok(vec!["(more streams than fit)".to_owned()]),
                _ => Err(err),
            };
        }

        let bytes: &[u8] =
            // SAFETY: the buffer is `buffer.len() * 8` bytes and outlives the slice.
            unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast(), buffer.len() * 8) };
        let read_u32 =
            |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        let mut foreign = Vec::new();
        let mut at = 0usize;
        loop {
            /* FILE_STREAM_INFO: next offset, name length in bytes, two 64-bit
            sizes, then the name in UTF-16. */
            let next = read_u32(at);
            let length = read_u32(at + 4);
            let start = at + 24;
            if start + length > bytes.len() {
                foreign.push("(a stream that could not be read)".to_owned());
                break;
            }
            let name: Vec<u16> = bytes[start..start + length]
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            let name = String::from_utf16_lossy(&name);
            if !ALLOWED
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(&name))
            {
                foreign.push(name);
            }
            if next == 0 {
                break;
            }
            at += next;
            if at + 24 > bytes.len() {
                break;
            }
        }
        Ok(foreign)
    }

    /// `FILE_ID_INFO`: the volume's serial number and the file's 128-bit ID.
    #[repr(C)]
    #[derive(Default)]
    struct FileIdInfo {
        volume_serial: u64,
        id: [u8; 16],
    }

    /// `BY_HANDLE_FILE_INFORMATION`, each FILETIME as its two halves.
    #[repr(C)]
    #[derive(Default)]
    struct FileInformation {
        _attributes: u32,
        _created: [u32; 2],
        _accessed: [u32; 2],
        _written: [u32; 2],
        volume_serial: u32,
        _size_high: u32,
        _size_low: u32,
        _links: u32,
        index_high: u32,
        index_low: u32,
    }

    /// A file opened only to be looked at: a link is the link and not what it
    /// points at, and there is no right to what is in it.
    ///
    /// Measured, on NTFS and over SMB: a program opening the file for itself
    /// alone still can, and an oplock on it is not broken. Like any handle,
    /// though, while it is open the file cannot be replaced by
    /// `MoveFileEx(REPLACE_EXISTING)` nor a folder above it renamed — so it is
    /// held no longer than it is needed.
    pub(crate) fn open_unfollowed(path: &Path) -> io::Result<fs::File> {
        fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_ALL)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    }

    /// Which file an open file is, as far as its file system can say.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) enum Identity {
        /// The volume's serial number and the file's 128-bit ID, from
        /// `FileIdInfo`. ReFS needs all of it: the 64-bit index it gives is
        /// not unique, and for many files it is all ones (MS-FSCC 2.1.9).
        Long(u64, [u8; 16]),
        /// The volume's serial number and the 64-bit index, where `FileIdInfo`
        /// is not answered — measured: WSL's 9P (error 50), which gives the
        /// inode and a serial of nought, and FAT (error 87).
        Short(u32, u64),
        /// An ID of nought or of all ones, which MS-FSCC says to ignore: it
        /// tells nothing of which file this is.
        Unknown,
    }

    pub(crate) fn identity(file: &fs::File) -> io::Result<Identity> {
        let mut long = FileIdInfo::default();
        // SAFETY: a handle of an open file, and a structure of the layout and
        // size the class asks for.
        let answered = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FILE_ID_INFO,
                (&mut long as *mut FileIdInfo).cast(),
                std::mem::size_of::<FileIdInfo>() as u32,
            )
        } != 0;
        if answered {
            /* And a 64-bit "unknown" widened to 128 bits by a file system
            that does not follow the specification: all ones in the low half,
            nought in the high one. */
            let widened = long.id[..8] == [0xff; 8] && long.id[8..] == [0; 8];
            return Ok(if long.id == [0; 16] || long.id == [0xff; 16] || widened {
                Identity::Unknown
            } else {
                Identity::Long(long.volume_serial, long.id)
            });
        }

        let mut info = FileInformation::default();
        // SAFETY: a handle of an open file, and a structure of the layout the
        // call fills in.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let index = (u64::from(info.index_high) << 32) | u64::from(info.index_low);
        Ok(if index == 0 || index == u64::MAX {
            Identity::Unknown
        } else {
            Identity::Short(info.volume_serial, index)
        })
    }

    /// The document, opened only to read its security and when it was made —
    /// which needs no right to read what is in it. `None` when there is no
    /// document there as a plain file: a first save, or something that is not
    /// one.
    pub(super) fn open_for_its_security(path: &Path) -> io::Result<Option<fs::File>> {
        if !fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file()) {
            return Ok(None);
        }
        fs::OpenOptions::new()
            .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_ALL)
            .open(path)
            .map(Some)
    }

    /// Whether a document is there whose DACL its next version is to be given:
    /// a plain file, on a volume that keeps ACLs. Asked to decide whether the
    /// new file needs the right to have its security set; when it cannot be
    /// told, yes — and `carry_over` then fails the save if it cannot be done.
    pub(super) fn has_acl_to_carry(path: &Path) -> bool {
        match open_for_its_security(path) {
            Ok(Some(document)) => keeps_acls(&document).unwrap_or(true),
            Ok(None) => false,
            Err(_) => true,
        }
    }

    /// Gives `to` the DACL `from` has, protected or inherited as `from`'s is.
    ///
    /// Inherited, the entries `from` inherited are worked out again from the
    /// folder — the same folder — and its own entries are kept; protected, the
    /// list is taken as it is. A volume that keeps no ACLs (WSL's 9P, FAT) has
    /// none to give; asked on one that does and refused, the save fails rather
    /// than go on with the folder's security.
    pub(super) fn copy_dacl(from: &fs::File, to: &fs::File) -> io::Result<()> {
        if !keeps_acls(from)? {
            return Ok(());
        }
        let mut dacl = null_mut();
        let mut descriptor = null_mut();
        // SAFETY: a handle of an open file; the out-pointers are valid, and the
        // descriptor the call allocates is freed below.
        let status = unsafe {
            GetSecurityInfo(
                from.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }

        let set = (|| {
            let mut control = 0u16;
            let mut revision = 0u32;
            // SAFETY: the descriptor GetSecurityInfo returned, still allocated.
            if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let protection = if control & SE_DACL_PROTECTED != 0 {
                PROTECTED_DACL_SECURITY_INFORMATION
            } else {
                UNPROTECTED_DACL_SECURITY_INFORMATION
            };
            // SAFETY: `dacl` points into the descriptor, still allocated; the
            // handle was opened with WRITE_DAC.
            let status = unsafe {
                SetSecurityInfo(
                    to.as_raw_handle(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | protection,
                    null_mut(),
                    null_mut(),
                    dacl,
                    std::ptr::null(),
                )
            };
            if status != 0 {
                return Err(io::Error::from_raw_os_error(status as i32));
            }
            Ok(())
        })();

        // SAFETY: allocated by GetSecurityInfo, freed once.
        unsafe { LocalFree(descriptor) };
        set
    }

    /// The folder a document is saved into, held until the save is over.
    ///
    /// Held with the right to list it and without letting anybody delete it,
    /// which on Windows is what renaming takes — measured: while it is held
    /// the folder cannot be renamed, nor any folder above it, so nothing can
    /// be put in its place; files inside it can be made and renamed as usual.
    /// And then asked what it really is: a folder swapped for a junction
    /// between the resolve and this is not the one that was resolved, and the
    /// save is refused.
    pub(super) fn hold_folder(folder: &Path) -> Result<fs::File, super::VfsError> {
        let held = fs::OpenOptions::new()
            .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(folder)?;
        if final_path(&held)? == folder {
            Ok(held)
        } else {
            Err(super::VfsError::OutsideWorkspace(super::display(folder)))
        }
    }

    /// Where an open file or folder really is, in the form `canonicalize` gives.
    pub(crate) fn final_path(file: &fs::File) -> io::Result<std::path::PathBuf> {
        use std::os::windows::ffi::OsStringExt;

        let mut buffer = vec![0u16; 512];
        loop {
            // SAFETY: a handle of an open file, and a buffer of the length
            // given; the flags ask for the normalised name with a drive letter.
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    0,
                )
            } as usize;
            if length == 0 {
                return Err(io::Error::last_os_error());
            }
            if length < buffer.len() {
                buffer.truncate(length);
                return Ok(std::ffi::OsString::from_wide(&buffer).into());
            }
            // Too short: the length is what it needs, the nought included.
            buffer.resize(length, 0);
        }
    }

    /// Whether the volume a file is on keeps ACLs at all.
    fn keeps_acls(file: &fs::File) -> io::Result<bool> {
        let mut flags = 0u32;
        // SAFETY: a handle of an open file; no names are asked for, so the
        // buffers are null with a size of nought.
        let done = unsafe {
            GetVolumeInformationByHandleW(
                file.as_raw_handle(),
                null_mut(),
                0,
                null_mut(),
                null_mut(),
                &mut flags,
                null_mut(),
                0,
            )
        };
        if done == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(flags & FILE_PERSISTENT_ACLS != 0)
    }
}

/// A temporary file beside `path` that did not exist until now.
fn create_beside(path: &Path, source: &Source<'_>) -> std::io::Result<(fs::File, PathBuf)> {
    #[cfg(unix)]
    let document = matches!(source, Source::Document);
    /* Encrypted with EFS, or hidden: what the document is, its next version is
    from the start. Encryption cannot be given to a file later. Nothing of a
    file that is not the document. */
    #[cfg(windows)]
    let attributes = match source {
        Source::Document => fs::symlink_metadata(path)
            .ok()
            .filter(|meta| meta.is_file())
            .map(|meta| {
                std::os::windows::fs::MetadataExt::file_attributes(&meta) & windows::KEPT_ATTRIBUTES
            })
            .unwrap_or(0),
        Source::Given(protection) => protection.attributes,
    };

    /* The right to set its security is asked for only where there is a
    security to give it: a share that does not grant it would otherwise refuse
    every save, a first one included. */
    #[cfg(windows)]
    let access = if match source {
        Source::Document => windows::has_acl_to_carry(path),
        Source::Given(protection) => protection.has_dacl(),
    } {
        windows::GENERIC_WRITE_AND_WRITE_DAC
    } else {
        windows::GENERIC_WRITE
    };
    /* Where there is a document, readable by its owner alone until it is given
    the document's own mode in `carry_over`; a first save keeps the defaults. */
    #[cfg(unix)]
    let replacing = !document || fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file());

    let mut taken = None;
    for attempt in 0..16 {
        let temp = temp_beside(path, attempt);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        /* On Windows nobody else opens it while it is written, and it may have
        its security set before anything is in it — see `carry_over`. */
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options
                .share_mode(0)
                /* And the right to read its attributes, to ask which streams
                it has before it takes the document's place. */
                .access_mode(access | windows::FILE_READ_ATTRIBUTES)
                .attributes(attributes);
        }
        #[cfg(unix)]
        if replacing {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
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
    Ok(stat_from(path, &fs::metadata(path)?))
}

/// What is told of `path`, from a look already taken at it.
pub(crate) fn stat_from(path: &Path, meta: &fs::Metadata) -> Stat {
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    Stat {
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
    }
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

    /// Written by another program since it was read to be edited: the save
    /// is refused and nothing is written, until the person says to.
    #[test]
    fn a_document_changed_since_it_was_read_is_not_saved_over_without_a_yes() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("changed")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        assert_eq!(workspace.read_document(&file).unwrap(), b"mine");

        fs::write(&file, "theirs, and longer").unwrap();
        let refused = workspace.save(&file, b"mine, edited", false);
        assert!(matches!(refused, Err(VfsError::Changed(_))), "{refused:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "theirs, and longer");

        workspace.save(&file, b"mine, edited", true).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "mine, edited");
        /* A save of its own is not somebody else's change. */
        workspace.save(&file, b"mine, again", false).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "mine, again");
    }

    /// Replaced by another file under the same name and length: which file it
    /// is gives it away.
    #[test]
    fn a_document_replaced_since_it_was_read_is_refused_too() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("replaced")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        workspace.read_document(&file).unwrap();

        let other = root.join("theirs.md");
        fs::write(&other, "them").unwrap();
        fs::rename(&other, &file).unwrap();
        let refused = workspace.save(&file, b"mine", false);
        assert!(matches!(refused, Err(VfsError::Changed(_))), "{refused:?}");
    }

    /// The document's folder swapped for a link — a junction on Windows — to
    /// another folder in the root, with a file of the same name there: asked
    /// about, and with a yes still not written through the link. The folder the
    /// document was read from is not there any more.
    #[test]
    fn a_document_whose_folder_was_swapped_for_a_link_is_not_written_through_it() {
        let mut links = crate::testing::Links::default();
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("folder-swapped")).unwrap();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        let file = sub.join("notes.md");
        fs::write(&file, "mine").unwrap();
        workspace.read_document(&file).unwrap();

        let elsewhere = root.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        fs::write(elsewhere.join("notes.md"), "somebody else's").unwrap();
        fs::remove_file(&file).unwrap();
        fs::remove_dir(&sub).unwrap();
        links.folder(&sub, &elsewhere);

        let refused = workspace.save(&file, b"mine", false);
        assert!(matches!(refused, Err(VfsError::Changed(_))), "{refused:?}");
        let written = workspace.save(&file, b"mine", true);
        assert!(written.is_err(), "written through the link");
        assert_eq!(
            fs::read_to_string(elsewhere.join("notes.md")).unwrap(),
            "somebody else's"
        );
    }

    /// A file nobody read here, a new one included, is saved as it always was.
    #[test]
    fn a_file_not_read_here_is_saved_as_before() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("unread")).unwrap();
        fs::write(root.join("old.md"), "x").unwrap();
        workspace.save(root.join("old.md"), b"y", false).unwrap();
        workspace.save(root.join("new.md"), b"z", false).unwrap();
        assert_eq!(fs::read_to_string(root.join("new.md")).unwrap(), "z");
    }

    /// The person said overwrite, over a file somebody put in the document's
    /// place with a security of their own. The new version is a new file in
    /// the folder, with the folder's security — not the planted one, which
    /// could have opened the person's content to whoever planted it.
    #[cfg(windows)]
    #[test]
    fn overwriting_a_replaced_document_does_not_take_its_security() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("planted-acl")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        /* The document closed to its owner alone: what its next version must
        have again, rather than the folder's wider security. */
        let me = std::env::var("USERNAME").unwrap();
        icacls(&file, &["/inheritance:r", "/grant:r", &format!("{me}:(F)")]);
        workspace.read_document(&file).unwrap();

        fs::remove_file(&file).unwrap();
        fs::write(&file, "planted").unwrap();
        /* An entry for the Guests group (S-1-5-32-546, "BG" in SDDL), which
        nothing else in the folder has: if it is on the new version, the
        planted security was carried over. Read as SDDL, so neither the
        language of the system nor the runner's folders decide what is seen. */
        const GUESTS: &str = ";;;BG)";
        icacls(&file, &["/grant", "*S-1-5-32-546:(R)"]);
        assert!(sddl(&file).contains(GUESTS), "the test could not plant it");

        workspace.save(&file, b"mine", true).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "mine");
        let after = sddl(&file);
        assert!(
            !after.contains(GUESTS),
            "the planted security was carried over: {after}"
        );
        /* Closed as the document was: protected, and nothing inherited from
        the folder. */
        let dacl = &after[after.find("D:").unwrap()..];
        assert!(
            dacl.starts_with("D:P"),
            "not protected as the document was: {after}"
        );
        assert!(
            !dacl.contains("(A;ID;"),
            "the folder's entries came in: {after}"
        );
    }

    /// A file's DACL as SDDL, through `icacls /save`.
    #[cfg(windows)]
    fn sddl(path: &Path) -> String {
        let out = path.with_extension("acl");
        let _ = fs::remove_file(&out);
        icacls(path, &["/save", &display(&out)]);
        let bytes = fs::read(&out).unwrap();
        let _ = fs::remove_file(&out);
        /* UTF-16, as icacls writes it. */
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|p| u16::from_le_bytes([p[0], p[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    }

    /// A document closed to its owner alone, read to be edited — what both
    /// tests below start from.
    #[cfg(windows)]
    fn closed_document(tag: &str) -> (Workspace, PathBuf, String) {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch(tag)).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        let me = std::env::var("USERNAME").unwrap();
        icacls(&file, &["/inheritance:r", "/grant:r", &format!("{me}:(F)")]);
        workspace.read_document(&file).unwrap();
        (workspace, file, me)
    }

    /// Put in the document's place by somebody who also closed it to reading
    /// — what `carry_over` asks for is still let through, so that file's
    /// security would have been carried. It is asked about, and written over
    /// only with the document's own.
    #[cfg(windows)]
    #[test]
    fn a_replacement_that_cannot_be_looked_at_is_asked_about_and_not_inherited_from() {
        let (mut workspace, file, me) = closed_document("unreadable");
        fs::remove_file(&file).unwrap();
        fs::write(&file, "planted").unwrap();
        icacls(&file, &["/grant", "*S-1-5-32-546:(R)"]);
        icacls(&file, &["/deny", &format!("{me}:(RD)")]);

        let refused = workspace.save(&file, b"mine", false);
        assert!(matches!(refused, Err(VfsError::Changed(_))), "{refused:?}");

        workspace.save(&file, b"mine", true).unwrap();
        let after = sddl(&file);
        assert!(
            !after.contains(";;;BG)"),
            "the planted security was carried over: {after}"
        );
        assert!(
            after[after.find("D:").unwrap()..].starts_with("D:P"),
            "{after}"
        );
    }

    /// Put in the document's place under its name in other letters —
    /// `NOTES.md` for `notes.md`, the same name to NTFS, while the path the
    /// file system hands back is spelled as the replacement is. Asked about,
    /// and written over only with the document's own security.
    #[cfg(windows)]
    #[test]
    fn a_replacement_named_in_other_letters_is_asked_about() {
        let (mut workspace, file, _) = closed_document("other-letters");
        fs::remove_file(&file).unwrap();
        let upper = file.with_file_name("NOTES.md");
        fs::write(&upper, "planted").unwrap();
        icacls(&upper, &["/grant", "*S-1-5-32-546:(R)"]);
        assert!(
            sddl(&upper).contains(";;;BG)"),
            "the test could not plant it"
        );

        let refused = workspace.save(&file, b"mine", false);
        assert!(matches!(refused, Err(VfsError::Changed(_))), "{refused:?}");
        assert_eq!(fs::read_to_string(&upper).unwrap(), "planted");

        workspace.save(&file, b"mine", true).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "mine");
        let after = sddl(&file);
        assert!(
            !after.contains(";;;BG)"),
            "the planted security was carried over: {after}"
        );
        assert!(
            after[after.find("D:").unwrap()..].starts_with("D:P"),
            "{after}"
        );
    }

    /// Deleted while it was open: nothing to ask about, and it comes back
    /// closed as it was — not with the folder's security.
    #[cfg(windows)]
    #[test]
    fn a_document_deleted_since_it_was_read_comes_back_with_its_own_protection() {
        let (mut workspace, file, _) = closed_document("deleted");
        fs::remove_file(&file).unwrap();

        workspace.save(&file, b"mine", false).unwrap();
        let after = sddl(&file);
        let dacl = &after[after.find("D:").unwrap()..];
        assert!(
            dacl.starts_with("D:P"),
            "not protected as the document was: {after}"
        );
        assert!(
            !dacl.contains("(A;ID;"),
            "the folder's entries came in: {after}"
        );
    }

    /// Put in the document's place and then read again — as an editor reads
    /// its document after every save — the planted file is what is edited,
    /// but its security is not what the next version gets: the file it was
    /// remembered from is not this one.
    #[cfg(windows)]
    #[test]
    fn a_replacement_read_again_does_not_hand_on_its_security() {
        let (mut workspace, file, _) = closed_document("read-again");
        fs::remove_file(&file).unwrap();
        fs::write(&file, "planted").unwrap();
        icacls(&file, &["/grant", "*S-1-5-32-546:(R)"]);
        assert_eq!(workspace.read_document(&file).unwrap(), b"planted");

        workspace.save(&file, b"mine", false).unwrap();
        let after = sddl(&file);
        assert!(
            !after.contains(";;;BG)"),
            "the planted security was carried over: {after}"
        );
        assert!(
            after[after.find("D:").unwrap()..].starts_with("D:P"),
            "{after}"
        );
    }

    /// Its own security changed while it was open — by the person, in the
    /// file's properties — is the document's, and the next version keeps it,
    /// with when it was made and its being hidden.
    #[cfg(windows)]
    #[test]
    fn the_documents_own_security_changed_while_open_is_kept() {
        use std::os::windows::fs::{FileTimesExt, MetadataExt};

        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("own-change")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        let me = std::env::var("USERNAME").unwrap();
        icacls(&file, &["/inheritance:r", "/grant:r", &format!("{me}:(F)")]);
        let made =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_times(fs::FileTimes::new().set_created(made))
            .unwrap();
        let hidden = std::process::Command::new("attrib")
            .arg("+h")
            .arg(display(&file))
            .status()
            .unwrap();
        assert!(hidden.success());
        workspace.read_document(&file).unwrap();
        icacls(&file, &["/grant", "*S-1-5-32-546:(R)"]);

        workspace.save(&file, b"mine, edited", false).unwrap();
        assert!(sddl(&file).contains(";;;BG)"), "{}", sddl(&file));
        let meta = fs::metadata(&file).unwrap();
        assert_eq!(meta.created().unwrap(), made);
        assert_ne!(meta.file_attributes() & 0x2, 0, "no longer hidden");
        let _ = std::process::Command::new("attrib")
            .arg("-h")
            .arg(display(&file))
            .status();
    }

    /// While a save holds the document, nobody can put another file in its
    /// place nor write into it: what was checked is what is replaced.
    #[cfg(windows)]
    #[test]
    fn a_held_document_can_be_neither_replaced_nor_written() {
        let root = scratch("held");
        let file = root.join("notes.md");
        let other = root.join("planted.md");
        fs::write(&file, "mine").unwrap();
        fs::write(&other, "planted").unwrap();

        let held = open_held(&file).unwrap();
        assert!(fs::rename(&other, &file).is_err(), "replaced while held");
        assert!(
            fs::OpenOptions::new().write(true).open(&file).is_err(),
            "written while held"
        );
        assert!(fs::remove_file(&file).is_err(), "deleted while held");
        drop(held);

        fs::rename(&other, &file).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "planted");
    }

    /// The same two on Unix, with the mode.
    #[cfg(unix)]
    #[test]
    fn a_replacement_read_again_does_not_hand_on_its_mode_and_the_documents_own_does() {
        use std::os::unix::fs::PermissionsExt;

        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("read-again-mode")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        workspace.read_document(&file).unwrap();

        fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
        workspace.save(&file, b"mine, edited", false).unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640, "the document's own change was lost: {mode:o}");

        fs::remove_file(&file).unwrap();
        fs::write(&file, "planted").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o606)).unwrap();
        workspace.read_document(&file).unwrap();
        workspace.save(&file, b"mine", false).unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640, "the planted mode was carried over: {mode:o}");
    }

    /// The same on Unix: a replacement nobody may read, and a deleted
    /// document, both come back with the document's own mode.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_replacement_and_a_deleted_document_keep_the_documents_mode() {
        use std::os::unix::fs::PermissionsExt;

        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("unreadable-mode")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        workspace.read_document(&file).unwrap();

        fs::remove_file(&file).unwrap();
        fs::write(&file, "planted").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o206)).unwrap();
        let refused = workspace.save(&file, b"mine", false);
        assert!(matches!(refused, Err(VfsError::Changed(_))), "{refused:?}");
        workspace.save(&file, b"mine", true).unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");

        fs::remove_file(&file).unwrap();
        workspace.save(&file, b"mine", false).unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");
    }

    /// Put in the document's place as a link to another file in the folder:
    /// asked about, and the save then goes where the document was read from —
    /// the link replaced, with the document's mode — not into the file the
    /// link points at.
    #[cfg(unix)]
    #[test]
    fn a_document_replaced_by_a_link_is_asked_about_and_not_written_through() {
        use std::os::unix::fs::PermissionsExt;

        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("link-in-place")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        workspace.read_document(&file).unwrap();

        let other = root.join("other.md");
        fs::write(&other, "somebody else's").unwrap();
        fs::set_permissions(&other, fs::Permissions::from_mode(0o644)).unwrap();
        fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(&other, &file).unwrap();

        let refused = workspace.save(&file, b"mine", false);
        assert!(matches!(refused, Err(VfsError::Changed(_))), "{refused:?}");
        assert_eq!(fs::read_to_string(&other).unwrap(), "somebody else's");

        workspace.save(&file, b"mine", true).unwrap();
        assert_eq!(fs::read_to_string(&other).unwrap(), "somebody else's");
        let meta = fs::symlink_metadata(&file).unwrap();
        assert!(meta.is_file(), "the link was written through");
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read_to_string(&file).unwrap(), "mine");
    }

    /// The same on Unix, with the mode.
    #[cfg(unix)]
    #[test]
    fn overwriting_a_replaced_document_does_not_take_its_mode() {
        use std::os::unix::fs::PermissionsExt;

        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("planted-mode")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        workspace.read_document(&file).unwrap();

        fs::remove_file(&file).unwrap();
        fs::write(&file, "planted").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o606)).unwrap();

        workspace.save(&file, b"mine", true).unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        /* The document's own, not the planted one and not the default. */
        assert_eq!(mode, 0o600, "{mode:o}");
    }

    /// The program's own folder stays shut with its parent open — read,
    /// written and listed — and so does a root opened on it directly.
    #[test]
    fn a_protected_folder_is_shut_whatever_is_open_above_it() {
        let base = scratch("protected");
        let own = base.join("org.uleditor.app");
        fs::create_dir_all(&own).unwrap();
        fs::write(own.join("trusted-projects.json"), "{}").unwrap();
        fs::write(base.join("other.txt"), "x").unwrap();

        let mut workspace = Workspace::new();
        workspace.protect(&own);
        let root = workspace.add_root(&base).unwrap();
        let answers = root.join("org.uleditor.app").join("trusted-projects.json");

        assert!(workspace.read(&answers).is_err());
        assert!(workspace
            .write(&answers, b"{\"trusted\":[\"/evil\"]}")
            .is_err());
        assert!(workspace.read_dir(root.join("org.uleditor.app")).is_err());
        assert_eq!(
            fs::read_to_string(own.join("trusted-projects.json")).unwrap(),
            "{}"
        );
        assert!(workspace.read(root.join("other.txt")).is_ok());

        let _ = workspace.add_root(&own);
        assert!(workspace.read(&answers).is_err());
    }

    /// A stream that is not the content or the mark is found, and a file with
    /// only those has none.
    #[cfg(windows)]
    #[test]
    fn a_stream_somebody_added_is_found() {
        let dir = scratch("streams");
        let file = dir.join("doc.md");
        fs::write(&file, "x").unwrap();
        fs::write(zone_stream(&file), "[ZoneTransfer]\r\nZoneId=3\r\n").unwrap();
        let open = |path: &Path| fs::OpenOptions::new().read(true).open(path).unwrap();
        assert_eq!(
            windows::foreign_streams(&open(&file)).unwrap(),
            Vec::<String>::new()
        );

        fs::write(format!("{}:planted", display(&file)), "somebody else's").unwrap();
        assert_eq!(
            windows::foreign_streams(&open(&file)).unwrap(),
            vec![":planted:$DATA".to_owned()]
        );
    }

    /// One link to something that is gone, and the rest of the folder is still
    /// there to see — the link too, as a link.
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

        let names: Vec<(&str, &str)> = listed
            .iter()
            .map(|e| (e.stat.name.as_str(), e.stat.kind.as_str()))
            .collect();
        assert_eq!(names, [("broken", "link"), ("kept.txt", "file")]);
    }

    /// A link is listed as a link, and nothing about what it points at is told:
    /// not that it is a folder, not its size, not its time.
    #[test]
    fn the_tree_tells_nothing_of_what_a_link_points_at() {
        let mut links = crate::testing::Links::default();
        let base = scratch("link-target");
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "a size worth hiding").unwrap();
        let inside = base.join("ws");
        fs::create_dir_all(&inside).unwrap();
        links.folder(&inside.join("there"), &outside);
        #[cfg(unix)]
        links.file(&inside.join("file-there"), &outside.join("secret.txt"));

        let mut workspace = Workspace::new();
        let root = workspace.add_root(&inside).unwrap();
        let listed = workspace.read_dir(&root).unwrap();

        assert!(!listed.is_empty());
        for entry in &listed {
            assert_eq!(entry.stat.kind, "link", "{}", entry.stat.name);
            assert_eq!((entry.stat.size, entry.stat.modified), (0, None));
        }
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

    #[cfg(windows)]
    fn icacls(path: &Path, args: &[&str]) -> String {
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
    }

    /// A document that inherits from its folder and has an entry of its own
    /// keeps both after a save: the inherited ones worked out again from the
    /// folder, its own carried over. A rename kept only the folder's.
    #[cfg(windows)]
    #[test]
    fn a_save_keeps_an_entry_the_document_has_of_its_own() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("acl-own")).unwrap();
        let file = root.join("shared.md");
        fs::write(&file, "before").unwrap();
        // BUILTIN\Users by its SID, so the test does not depend on the language of Windows.
        icacls(&file, &["/grant", "*S-1-5-32-545:(R)"]);
        let before = icacls(&file, &[]);
        assert!(
            before.contains("(I)"),
            "the test file stopped inheriting: {before}"
        );

        workspace.write(&file, b"after").unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "after");
        assert_eq!(icacls(&file, &[]), before);
    }

    #[cfg(windows)]
    #[test]
    fn a_save_keeps_when_the_document_was_made() {
        use std::os::windows::fs::FileTimesExt;

        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("made")).unwrap();
        let file = root.join("old.md");
        fs::write(&file, "before").unwrap();
        let made =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_times(fs::FileTimes::new().set_created(made))
            .unwrap();

        workspace.write(&file, b"after").unwrap();

        assert_eq!(fs::metadata(&file).unwrap().created().unwrap(), made);
    }

    #[cfg(windows)]
    #[test]
    fn a_file_on_ntfs_is_known_by_its_whole_id() {
        /* NTFS answers FileIdInfo, so neither the 64-bit index nor what stands
        in for an unknown one decides here. Two handles of one file are the
        same file, the one looked at and the one opened; another is not. */
        let root = scratch("identity");
        let one = root.join("one.txt");
        let other = root.join("other.txt");
        fs::write(&one, "a").unwrap();
        fs::write(&other, "a").unwrap();

        let seen = windows::identity(&windows::open_unfollowed(&one).unwrap()).unwrap();
        assert!(matches!(seen, windows::Identity::Long(..)), "{seen:?}");
        assert_eq!(
            windows::identity(&fs::File::open(&one).unwrap()).unwrap(),
            seen
        );
        assert_ne!(
            windows::identity(&fs::File::open(&other).unwrap()).unwrap(),
            seen
        );
    }

    /// While a save holds the folder, nothing can take its place.
    #[cfg(windows)]
    #[test]
    fn a_folder_being_saved_into_cannot_be_moved_away() {
        let base = scratch("held");
        let folder = base.join("documents");
        fs::create_dir_all(&folder).unwrap();
        let folder = fs::canonicalize(&folder).unwrap();

        let held = windows::hold_folder(&folder).unwrap();
        assert!(
            fs::rename(&folder, base.join("moved")).is_err(),
            "the held folder was moved"
        );
        fs::write(folder.join("inside.txt"), "x").unwrap();
        assert!(fs::rename(folder.join("inside.txt"), folder.join("renamed.txt")).is_ok());
        drop(held);
        assert!(fs::rename(&folder, base.join("moved")).is_ok());
    }

    /// A folder that is not what was resolved — a junction to somewhere else in
    /// its place — is refused.
    #[cfg(windows)]
    #[test]
    fn a_folder_swapped_for_a_junction_is_refused() {
        let mut links = crate::testing::Links::default();
        let base = scratch("swapped");
        let elsewhere = base.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let resolved = fs::canonicalize(&base).unwrap().join("documents");
        links.folder(&resolved, &elsewhere);

        assert!(matches!(
            windows::hold_folder(&resolved),
            Err(VfsError::OutsideWorkspace(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_swapped_for_a_link_is_refused() {
        let mut links = crate::testing::Links::default();
        let base = fs::canonicalize(scratch("swapped")).unwrap();
        let elsewhere = base.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let documents = base.join("documents");
        links.folder(&documents, &elsewhere);

        assert!(still_the_folder(&elsewhere).is_ok());
        assert!(matches!(
            still_the_folder(&documents),
            Err(VfsError::OutsideWorkspace(_))
        ));
    }

    /// Read asks the opened thing what it is: a folder is not a file to read.
    #[test]
    fn a_folder_is_not_read_as_a_file() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("folder-read")).unwrap();
        fs::create_dir_all(root.join("inner")).unwrap();

        let read = workspace.read(root.join("inner"));
        /* On Unix a folder opens and is then refused by what it is; Windows
        does not open a folder as a file at all. */
        if cfg!(unix) {
            assert!(matches!(read, Err(VfsError::NotAFile(_))), "{read:?}");
        } else {
            assert!(read.is_err());
        }
        fs::write(root.join("note.txt"), "text").unwrap();
        assert_eq!(workspace.read(root.join("note.txt")).unwrap(), b"text");
    }

    /// An extended attribute longer than the 64 KiB once guessed is read
    /// whole, its length asked first, rather than fail the save on `ERANGE`.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_long_extended_attribute_is_read_whole_on_macos() {
        let dir = scratch("long-attribute");
        let file = dir.join("doc.md");
        fs::write(&file, "x").unwrap();
        let long: Vec<u8> = (0..100 * 1024).map(|i| (i % 251) as u8).collect();
        let name = b"org.uleditor.test\0";
        let open = fs::OpenOptions::new().write(true).open(&file).unwrap();
        if let Err(err) = macos::set_attribute(&open, name, &long) {
            // E2BIG: a volume that cannot hold one this long cannot hand it back.
            assert_eq!(err.raw_os_error(), Some(7), "{err}");
            eprintln!("skipped: this volume holds no attribute this long");
            return;
        }
        assert_eq!(macos::attribute_of(&file, name).unwrap(), Some(long));
        assert_eq!(
            macos::attribute_of(&file, b"org.uleditor.none\0").unwrap(),
            None
        );
    }

    /// A file from the internet stays one through a save on macOS, as on Windows.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_save_keeps_the_quarantine_mark_on_macos() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("quarantine")).unwrap();
        let file = root.join("downloaded.docx");
        fs::write(&file, "before").unwrap();
        let mark = "0081;5f5e1000;Safari;";
        let set = std::process::Command::new("xattr")
            .args(["-w", "com.apple.quarantine", mark])
            .arg(&file)
            .status()
            .unwrap();
        assert!(set.success(), "the test could not mark the file");

        workspace.write(&file, b"after").unwrap();

        let out = std::process::Command::new("xattr")
            .args(["-p", "com.apple.quarantine"])
            .arg(&file)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), mark);
    }
}
