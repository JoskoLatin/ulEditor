//! Virtual file system sandboxed to the workspace roots.
//!
//! The user opens a folder; everything after that must stay inside it. Without
//! that check, any bug in the UI — or a third-party plugin — turns into reading
//! an arbitrary file off the disk.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::consent::{Access, Consent};
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
    /// Let in to be read and not written — a document from the library, a
    /// definition a language server pointed at (ADR 0005).
    #[error("{0} is open read-only")]
    ReadOnly(String),
    /// A save or a read naming a reading this program never made, or one of
    /// another document (ADR 0006). A fault of the page, never a question:
    /// nobody is asked to write over anything.
    #[error("{0} was not read here")]
    NotRead(String),
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
    /// Folders and files let in without being opened, each to be read or
    /// also written (ADR 0005).
    granted: Vec<Consent>,
    /// Folders nothing is let into, whatever was opened above them.
    protected: Vec<PathBuf>,
    /// Files of the program's own that may be read though they lie in a
    /// protected folder — the crash reports it wrote. Only `show_own_file`
    /// adds to it, which Rust alone calls; no grant, offer or claim does.
    own: Vec<PathBuf>,
    /// Each reading of a document, as it was when it was read to be edited
    /// or last saved, by the token it was given (ADR 0006).
    seen: std::collections::HashMap<Reading, Opened>,
    /// The token the next reading gets.
    next_reading: Reading,
}

/// One tab's reading of one document, named by a token Rust makes (ADR
/// 0006): a save names the reading it continues, and is compared with that
/// and with nothing else — not with another tab's reading of the same file,
/// not with what another write left there. A counter, never reused while the
/// program runs, and kept below 2^53 so that it crosses to the page as a
/// number. It names a reading; it grants nothing.
pub type Reading = u64;

/// How many readings are kept at once. A read past them is refused; none is
/// ever let go to make room, so a save never fails for want of its reading.
pub const MOST_READINGS: usize = 1024;

/// A document as it was read to be edited: under which name, where it was,
/// which file it was, and how it was protected.
#[derive(Debug, Clone)]
struct Opened {
    /// The name it was read under, as the page gave it: a reading continues
    /// only under the name it was made under.
    name: PathBuf,
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
    fn of(name: PathBuf, at: PathBuf, print: Fingerprint, protection: Protection) -> Self {
        Self {
            name,
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

/// The name a reading is made under: the path as the page gave it, with
/// nothing on disk asked — not as the file system resolves it, which a
/// replacement under other letters or a link in its place would change.
/// Letters are not folded: in a folder told to tell them apart (WSL's, or
/// `fsutil file setCaseSensitiveInfo`), `notes.md` and `NOTES.md` are two
/// documents.
fn reading_name(path: &Path) -> PathBuf {
    normalize(path)
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
            mark: mark_of_open(path, file),
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
            quarantine: macos::quarantine_of_file(file)?,
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

    /// Takes from `other` whatever of it is stricter than this, where
    /// stricter can be told: a file read again that is not the one this was
    /// read from does not give its security, but neither does a document
    /// put in its place more closed come out of a save less so. A mark of
    /// the internet on either is kept, encryption and being hidden on either
    /// are kept, and on Unix only what both modes allow is allowed. Two
    /// DACLs have no such meet: there, this one — the document's as it was
    /// opened — is what the next version gets.
    fn keep_the_stricter_of(&mut self, other: &Self) {
        let _ = other;
        #[cfg(windows)]
        {
            if self.mark.is_none() {
                self.mark.clone_from(&other.mark);
            }
            self.attributes |= other.attributes;
        }
        #[cfg(unix)]
        if let (Some(mine), Some(theirs)) = (self.mode, other.mode) {
            self.mode = Some(mine & theirs);
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
    /// On another machine — a share, or WSL's 9P — whose IDs and times are
    /// that machine's to give.
    #[cfg(windows)]
    remote: bool,
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
            #[cfg(windows)]
            remote: windows::is_remote(file),
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
    ///
    /// On Windows only a whole ID of a volume on this machine tells. A 64-bit
    /// index is given again to the next file made where the file system frees
    /// it — measured on WSL's 9P, with ext4 behind it — and a file on another
    /// machine has whatever ID and times that machine gives it: over 9P the
    /// "birth" is a time anybody can set, and a Samba server answers with
    /// inodes and with a birth its files' owners can write. Such a file is
    /// written over with the protection remembered from when the document was
    /// opened — which also means a change of its security made while it was
    /// open is not kept there.
    fn same_file(&self, other: &Self) -> bool {
        let born_together = matches!((self.created, other.created), (Some(a), Some(b)) if a == b);
        #[cfg(windows)]
        {
            born_together
                && !self.remote
                && !other.remote
                && matches!((&self.id, &other.id), (Some(a @ windows::Identity::Long(..)), Some(b)) if a == b)
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
    /// Whether `path` lies in a folder nothing is let into (`protect`) —
    /// asked before a gesture is granted or remembered, so that a consent to
    /// one is never kept, though it would let nothing in.
    pub fn is_protected(&self, path: impl AsRef<Path>) -> bool {
        let real = canonical_prefix(&normalize(path.as_ref()));
        self.protected.iter().any(|dir| real.starts_with(dir))
    }

    pub fn protect(&mut self, dir: impl AsRef<Path>) {
        let dir = canonical_prefix(&normalize(dir.as_ref()));
        if !self.protected.contains(&dir) {
            self.protected.push(dir);
        }
    }

    /// A file of the program's own, in a folder `protect` shut, that the page
    /// may read and nothing more: a crash report, which opens in a tab. Rust
    /// calls this for files it wrote itself; the page has no way to.
    pub fn show_own_file(&mut self, path: impl AsRef<Path>) -> Result<PathBuf, VfsError> {
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
        if !self.own.contains(&canonical) {
            self.own.push(canonical.clone());
        }
        Ok(canonical)
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
    pub fn grant_folder(
        &mut self,
        path: impl AsRef<Path>,
        access: Access,
    ) -> Result<PathBuf, VfsError> {
        let canonical = fs::canonicalize(path.as_ref())?;
        if !canonical.is_dir() {
            return Err(VfsError::NotADirectory(display(&canonical)));
        }
        self.grant(Consent::folder(canonical.clone(), access));
        Ok(canonical)
    }

    /// Lets in what a consent names. The same path granted twice keeps the
    /// wider of the two: a read-only offer of a file already opened to be
    /// written does not take the writing away.
    fn grant(&mut self, consent: Consent) {
        match self
            .granted
            .iter_mut()
            .find(|kept| kept.path == consent.path && kept.kind == consent.kind)
        {
            Some(kept) => {
                if consent.access == Access::ReadWrite {
                    kept.access = Access::ReadWrite;
                }
            }
            None => self.granted.push(consent),
        }
    }

    /// A file chosen in a save dialog, which need not exist yet: that file,
    /// to be written, and nothing beside it — choosing where to save is not
    /// opening the folder. Its folder has to exist, and the name not be a
    /// link: a link put there would have the save written wherever it points.
    pub fn grant_future_file(&mut self, path: impl AsRef<Path>) -> Result<PathBuf, VfsError> {
        let normalized = normalize(path.as_ref());
        let (Some(folder), Some(name)) = (normalized.parent(), normalized.file_name()) else {
            return Err(VfsError::NotAFile(display(&normalized)));
        };
        let folder = fs::canonicalize(folder)?;
        if !folder.is_dir() {
            return Err(VfsError::NotADirectory(display(&folder)));
        }
        let target = folder.join(name);
        if let Ok(meta) = fs::symlink_metadata(&target) {
            if !meta.is_file() {
                return Err(VfsError::NotAFile(display(&target)));
            }
        }
        self.grant(Consent::file(target.clone(), Access::ReadWrite));
        Ok(target)
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
    pub fn grant_file(
        &mut self,
        path: impl AsRef<Path>,
        access: Access,
    ) -> Result<PathBuf, VfsError> {
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
        self.grant(Consent::file(canonical.clone(), access));
        Ok(canonical)
    }

    /// Takes a folder out of the roots.
    ///
    /// Taking it off the tree used to leave it in the sandbox until the program
    /// was closed — still searched, still listed by Ctrl+P, still open to read
    /// and write. Matched by the folder itself and by how it was shown, since a
    /// folder that is gone cannot be resolved any more.
    ///
    /// What of it stays open is `keep`: the files the page still has open in
    /// it, each let in on its own, to be written, if it really is a file
    /// under that root — resolved before the root goes. Anything else in
    /// `keep` is passed over: the page can narrow, never widen (ADR 0005).
    pub fn forget_root(&mut self, path: impl AsRef<Path>, keep: &[PathBuf]) {
        let path = path.as_ref();
        let canonical = fs::canonicalize(path).ok();
        let shown = display(path);
        let going: Vec<PathBuf> = self
            .roots
            .iter()
            .filter(|root| canonical.as_ref() == Some(root) || display(root) == shown)
            .cloned()
            .collect();
        for root in &going {
            for file in keep {
                let Ok(real) = fs::canonicalize(file) else {
                    continue;
                };
                if real.starts_with(root)
                    && real.is_file()
                    && !self.protected.iter().any(|dir| real.starts_with(dir))
                {
                    self.grant(Consent::file(real, Access::ReadWrite));
                }
            }
        }
        self.roots.retain(|root| !going.contains(root));
    }

    /// Resolves a path to be read and checks that it stays inside what was
    /// let in.
    ///
    /// `..` is removed lexically first, because a file that does not exist yet
    /// (save-as) cannot be resolved by the file system at all — and then as
    /// much of the path as does exist is resolved for real, so a symlink out of
    /// the workspace is caught. See `canonical_prefix`.
    pub fn resolve(&self, path: impl AsRef<Path>) -> Result<PathBuf, VfsError> {
        self.resolve_for(path.as_ref(), Access::Read)
    }

    /// Resolves a path to be written: as `resolve`, and only where what let it
    /// in lets it be written — a root, or a grant to read and write. One let
    /// in only to be read is `ReadOnly`.
    pub fn resolve_for_write(&self, path: impl AsRef<Path>) -> Result<PathBuf, VfsError> {
        self.resolve_for(path.as_ref(), Access::ReadWrite)
    }

    fn resolve_for(&self, path: &Path, access: Access) -> Result<PathBuf, VfsError> {
        if self.roots.is_empty() && self.granted.is_empty() {
            return Err(VfsError::NoWorkspace);
        }

        let normalized = normalize(path);

        // A symlink can lead outside; the real path is what gets checked.
        let effective = canonical_prefix(&normalized);

        if self.allows(&effective, access) {
            Ok(effective)
        } else if access == Access::ReadWrite && self.allows(&effective, Access::Read) {
            Err(VfsError::ReadOnly(display(&normalized)))
        } else {
            Err(VfsError::OutsideWorkspace(display(&normalized)))
        }
    }

    /// Whether a path already resolved may be had for `access`: outside every
    /// protected folder, and inside a root or under a grant that goes that
    /// far.
    fn allows(&self, effective: &Path, access: Access) -> bool {
        if self.protected.iter().any(|dir| effective.starts_with(dir)) {
            /* Shut, whatever is open above it and whatever was granted or
            claimed in it — but for a file of the program's own it means to
            show, a crash report it wrote there, which is read and never
            written. A grant cannot stand in for that: a read-only offer is
            what a language server's answer becomes, and a server can be made
            to name any file (found by the review of 39e0855). */
            return access == Access::Read && self.own.iter().any(|own| own == effective);
        }
        self.roots.iter().any(|root| effective.starts_with(root))
            || self.granted.iter().any(|grant| {
                grant.covers(effective)
                    && (access == Access::Read || grant.access == Access::ReadWrite)
            })
    }

    /// What is told of a file, `readonly` included where it was let in only
    /// to be read — which is how the interface knows to say so.
    pub fn stat(&self, path: impl AsRef<Path>) -> Result<Stat, VfsError> {
        let resolved = self.resolve(path)?;
        let mut stat = stat_of(&resolved)?;
        stat.readonly |= !self.allows(&resolved, Access::ReadWrite);
        Ok(stat)
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
            let mut stat = if is_link {
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
            // Let in only to be read, it says so.
            stat.readonly |= !self.allows(&entry.path(), Access::ReadWrite);
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
    ///
    /// Without a `reading` it is a new one, and its token comes back with the
    /// bytes. With one, it is that reading read again — under the name it was
    /// made under, or not at all (`VfsError::NotRead`).
    pub fn read_document(
        &mut self,
        path: impl AsRef<Path>,
        reading: Option<Reading>,
    ) -> Result<(Reading, Vec<u8>), VfsError> {
        use std::io::Read;

        let name = reading_name(path.as_ref());
        let before = match reading {
            Some(token) => Some(self.reading_of(token, &name)?),
            None => {
                self.room_for_a_reading(&name)?;
                None
            }
        };
        let resolved = self.resolve(path)?;
        let mut file = open_regular(&resolved)?;
        let print = Fingerprint::of(&file)?;
        let protection = Protection::of(&resolved, &file)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        /* Read again — after a save, or to take in somebody else's change —
        it is what is in it now that is agreed to, not the security of
        whatever file is there: one that is not provably the file the
        protection was read from does not replace it, and only what of it is
        stricter is kept (`keep_the_stricter_of`). An editor reads its document again after
        every save, and a file put in its place in that moment would
        otherwise hand its security to every save after. */
        let opened = match before {
            Some(mut before) if !before.is_owner(&print) => {
                before.protection.keep_the_stricter_of(&protection);
                Opened {
                    at: resolved,
                    print: Some(print),
                    ..before
                }
            }
            _ => Opened::of(name, resolved, print, protection),
        };
        let token = reading.unwrap_or_else(|| self.take_a_token());
        self.seen.insert(token, opened);
        Ok((token, bytes))
    }

    /// The reading a token names, if it is one this program made and of the
    /// document named.
    fn reading_of(&self, token: Reading, name: &Path) -> Result<Opened, VfsError> {
        match self.seen.get(&token) {
            Some(opened) if opened.name == name => Ok(opened.clone()),
            _ => Err(VfsError::NotRead(display(name))),
        }
    }

    /// Whether another reading may be kept: refused past `MOST_READINGS`,
    /// and none let go to make room.
    fn room_for_a_reading(&self, name: &Path) -> Result<(), VfsError> {
        if self.seen.len() >= MOST_READINGS || self.next_reading >= 1 << 53 {
            return Err(VfsError::Unsupported(format!(
                "{} cannot be opened for editing: too many documents are open",
                display(name)
            )));
        }
        Ok(())
    }

    fn take_a_token(&mut self) -> Reading {
        self.next_reading += 1;
        self.next_reading
    }

    /// Forgets readings — a tab's, when it closes. A token forgotten is one
    /// nobody made: a save naming it is refused.
    pub fn forget_readings(&mut self, readings: &[Reading]) {
        for token in readings {
            self.seen.remove(token);
        }
    }

    /// Forgets every reading — when the page loads, since it keeps its tokens
    /// in memory only and has none left.
    pub fn forget_all_readings(&mut self) {
        self.seen.clear();
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
    ///
    /// The document is the one `reading` names (ADR 0006), and no other: a
    /// save with a reading is compared with that reading, under the name it
    /// was made under or not at all (`VfsError::NotRead`), and the reading
    /// then describes what this save wrote. A save without one is of a file
    /// nobody read here — save-as, an export — and finds and moves nobody's
    /// reading, whatever the path: an export written over a document open in
    /// a tab leaves that tab's reading as it was, and the tab's next save is
    /// asked about it. With `begin`, what was written becomes a reading, and
    /// its token is returned.
    pub fn save(
        &mut self,
        path: impl AsRef<Path>,
        data: &[u8],
        overwrite: bool,
        reading: Option<Reading>,
        begin: bool,
    ) -> Result<Option<Reading>, VfsError> {
        let name = reading_name(path.as_ref());
        let opened = match reading {
            Some(token) => Some(self.reading_of(token, &name)?),
            None => {
                if begin {
                    self.room_for_a_reading(&name)?;
                }
                None
            }
        };
        let resolved = self.resolve_for_write(path)?;
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
        let token = match reading {
            Some(token) => token,
            None if begin => self.take_a_token(),
            None => return Ok(None),
        };
        let record = Opened {
            name,
            at: target,
            print: now.clone(),
            protection: written.protection,
            owner: now,
        };
        self.seen.insert(token, record);
        Ok(Some(token))
    }

    /// Where a document read from `at` is written when its name no longer
    /// leads there: `at` itself, so long as its folder is still that folder
    /// and still let in.
    fn where_it_was(&self, at: &Path) -> Result<PathBuf, VfsError> {
        let (Some(folder), Some(name)) = (at.parent(), at.file_name()) else {
            return Err(VfsError::NotAFile(display(at)));
        };
        /* The folder still that folder — not swapped for a link since — and
        the document one this program may write. */
        if fs::canonicalize(folder).ok().as_deref() != Some(folder) {
            return Err(VfsError::OutsideWorkspace(display(at)));
        }
        let target = folder.join(name);
        if !self.allows(&target, Access::ReadWrite) {
            return Err(if self.allows(&target, Access::Read) {
                VfsError::ReadOnly(display(at))
            } else {
                VfsError::OutsideWorkspace(display(at))
            });
        }
        Ok(target)
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
        let resolved = self.resolve_for_write(path)?;
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
        fn fgetxattr(
            fd: i32,
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

    /// The mark an open file carries, if any — asked of the file itself, so
    /// it is the mark of the file the rest of its protection was read from,
    /// not of whatever the name leads to a moment later.
    pub(super) fn quarantine_of_file(file: &fs::File) -> io::Result<Option<Vec<u8>>> {
        attribute_of_file(file, QUARANTINE)
    }

    pub(super) fn set_quarantine(temp: &fs::File, value: &[u8]) -> io::Result<()> {
        set_attribute(temp, QUARANTINE, value)
    }

    /// An extended attribute of a file by its NUL-terminated name, if it has
    /// one; read from the file itself, not through a link.
    pub(super) fn attribute_of(original: &Path, name: &[u8]) -> io::Result<Option<Vec<u8>>> {
        let path = CString::new(original.as_os_str().as_bytes())?;
        read_attribute(|value, size| {
            // SAFETY: NUL-terminated path and name, and a buffer of the size
            // given — none, with a size of nought, to ask the length.
            unsafe {
                getxattr(
                    path.as_ptr(),
                    name.as_ptr().cast(),
                    value,
                    size,
                    0,
                    XATTR_NOFOLLOW,
                )
            }
        })
    }

    /// An extended attribute of an open file by its NUL-terminated name.
    pub(super) fn attribute_of_file(file: &fs::File, name: &[u8]) -> io::Result<Option<Vec<u8>>> {
        let fd = file.as_raw_fd();
        read_attribute(|value, size| {
            // SAFETY: an open descriptor, the NUL-terminated name, and a
            // buffer of the size given — none, with a size of nought, to ask
            // the length.
            unsafe { fgetxattr(fd, name.as_ptr().cast(), value, size, 0, 0) }
        })
    }

    /// Reads an extended attribute through `get`, handed a buffer and its
    /// size. Its length is asked first and it is read at that length — again,
    /// if it grew in between — so a mark longer than a guess is carried
    /// rather than the save failed on `ERANGE`.
    fn read_attribute(
        mut get: impl FnMut(*mut c_void, usize) -> isize,
    ) -> io::Result<Option<Vec<u8>>> {
        let mut value: Vec<u8> = Vec::new();
        for _ in 0..4 {
            let read = get(
                if value.is_empty() {
                    std::ptr::null_mut()
                } else {
                    value.as_mut_ptr().cast()
                },
                value.len(),
            );
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

/// The plain mark of the internet zone: what a mark that cannot be taken as
/// it is becomes.
#[cfg(windows)]
const INTERNET: &[u8] = b"[ZoneTransfer]\r\nZoneId=3\r\n";

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
    match open_mark(original) {
        Ok(Some(stream)) => Some(read_mark(stream)),
        Ok(None) => None,
        Err(()) => Some(INTERNET.to_vec()),
    }
}

/// The mark of an open document. A stream is opened by its name, and the
/// name could lead to another file by then — one put in the document's
/// place, marked as it liked (`ZoneId=0`, trusted). So the stream is kept
/// only if it is the open file's own, by ID; otherwise the open file is asked
/// whether it has one, and one that does gets the plain internet mark.
#[cfg(windows)]
fn mark_of_open(path: &Path, file: &fs::File) -> Option<Vec<u8>> {
    let of_the_file = || windows::has_mark(file).then(|| INTERNET.to_vec());
    match open_mark(path) {
        Ok(Some(stream)) => match (windows::identity(&stream), windows::identity(file)) {
            (Ok(a), Ok(b))
                if a != windows::Identity::Unknown && b != windows::Identity::Unknown =>
            {
                if a == b {
                    Some(read_mark(stream))
                } else {
                    of_the_file()
                }
            }
            /* A volume that cannot tell whose stream it is: there is a mark
            under the name, and the plain internet one is kept rather than
            none. */
            _ => Some(INTERNET.to_vec()),
        },
        Ok(None) => of_the_file(),
        Err(()) => Some(INTERNET.to_vec()),
    }
}

/// A file's `Zone.Identifier` stream, opened by name: none where there is
/// none — no stream, or a volume with no streams at all — and an error where
/// it is there and cannot be opened.
#[cfg(windows)]
fn open_mark(path: &Path) -> Result<Option<fs::File>, ()> {
    match fs::File::open(zone_stream(path)) {
        Ok(stream) => Ok(Some(stream)),
        // Not found, path not found, or a name this volume has no streams for.
        Err(err) if matches!(err.raw_os_error(), Some(2 | 3 | 123)) => Ok(None),
        Err(_) => Err(()),
    }
}

/// What a mark says, or the plain internet mark where it is too long or
/// cannot be read.
#[cfg(windows)]
fn read_mark(stream: fs::File) -> Vec<u8> {
    use std::io::Read;

    let mut mark = Vec::new();
    match stream.take(LONGEST_MARK + 1).read_to_end(&mut mark) {
        Ok(_) if mark.len() as u64 <= LONGEST_MARK => mark,
        _ => INTERNET.to_vec(),
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
    pub(super) const WRITE_DAC: u32 = 0x0004_0000;
    pub(super) const GENERIC_WRITE_AND_WRITE_DAC: u32 = GENERIC_WRITE | WRITE_DAC;

    /// `SECURITY_ATTRIBUTES`, as `CreateFileW` takes it.
    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: *mut c_void,
        inherit: i32,
    }

    /// A security descriptor, self-relative, with a DACL and nothing else:
    /// protected, and one entry letting the file's owner do anything (OWNER
    /// RIGHTS, S-1-3-4). Laid out by hand as MS-DTYP 2.4.6 has it, aligned
    /// as the structures in it want.
    #[repr(C, align(8))]
    struct OwnerOnly([u8; 48]);

    const OWNER_ONLY: OwnerOnly = OwnerOnly([
        /* SECURITY_DESCRIPTOR_RELATIVE: revision 1; control SE_DACL_PRESENT
        | SE_DACL_PROTECTED | SE_SELF_RELATIVE (0x9004); no owner, group or
        SACL; the DACL 20 bytes in. */
        1, 0, 0x04, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 0, 0,
        /* ACL: revision 2, 28 bytes long, one entry. */
        2, 0, 28, 0, 1, 0, 0, 0,
        /* ACCESS_ALLOWED_ACE: no flags, 20 bytes long, FILE_ALL_ACCESS
        (0x001F01FF) ... */
        0, 0, 20, 0, 0xFF, 0x01, 0x1F, 0x00,
        /* ... for S-1-3-4: revision 1, one sub-authority, authority 3
        (big-endian, six bytes), sub-authority 4. */
        1, 1, 0, 0, 0, 0, 0, 3, 4, 0, 0, 0,
    ]);

    /// Makes a new file at `path` that nobody but its owner may open until
    /// it is given a security of its own — how a new version is made where a
    /// DACL is to be set on it.
    ///
    /// Opened for itself alone (`share_mode(0)`), it was still not closed:
    /// sharing governs what is in a file, not its security, and from its
    /// making until the document's DACL was set it had the folder's — so an
    /// account the folder lets change new files' security could open it for
    /// `WRITE_DAC` in that moment, measured by the independent review, and
    /// open the next version to itself after the save. Made closed, there is
    /// no such moment.
    pub(super) fn create_closed(path: &Path, access: u32, attributes: u32) -> io::Result<fs::File> {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::io::FromRawHandle;

        const CREATE_NEW: u32 = 1;
        const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut descriptor = OWNER_ONLY;
        let security = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: descriptor.0.as_mut_ptr().cast(),
            inherit: 0,
        };
        /* Not through a link: CREATE_NEW alone follows a symbolic link left
        under the name and makes whatever it points at, wherever that is —
        the standard library adds this flag to every `create_new` for that
        reason, and a call of its own has to as well (found by the review of
        the commit that brought this function in). With it, a link under the
        name is a name taken, and the next one is tried. */
        let flags = FILE_FLAG_OPEN_REPARSE_POINT
            | if attributes == 0 {
                FILE_ATTRIBUTE_NORMAL
            } else {
                attributes
            };
        // SAFETY: a NUL-terminated name, a valid self-relative descriptor that
        // lives through the call, and no template.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                access,
                0,
                &security,
                CREATE_NEW,
                flags,
                null_mut(),
            )
        };
        if handle as isize == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a handle just made and owned by nothing else.
        Ok(unsafe { fs::File::from_raw_handle(handle) })
    }
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
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *const SecurityAttributes,
            disposition: u32,
            flags: u32,
            template: *mut c_void,
        ) -> *mut c_void;
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
    /// `FileRemoteProtocolInfo` of `FILE_INFO_BY_HANDLE_CLASS`.
    const FILE_REMOTE_PROTOCOL_INFO: i32 = 13;

    /// Whether an open file is on another machine. Asked of the file: the
    /// class is answered only for a file reached through a network
    /// redirector — measured: an SMB share and WSL's 9P answer, NTFS here
    /// refuses with error 87 — whatever path or drive letter led to it.
    pub(crate) fn is_remote(file: &fs::File) -> bool {
        /* FILE_REMOTE_PROTOCOL_INFO is 116 bytes; only whether it is given
        matters. */
        let mut info = [0u64; 32];
        // SAFETY: a handle of an open file, and a buffer of the size given,
        // larger than the structure.
        unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FILE_REMOTE_PROTOCOL_INFO,
                info.as_mut_ptr().cast(),
                std::mem::size_of_val(&info) as u32,
            ) != 0
        }
    }

    /// `Zone.Identifier`'s stream, as an open file names it.
    const MARK_STREAM: &str = ":Zone.Identifier:$DATA";

    /// The streams of an open file other than its content and its
    /// `Zone.Identifier`, by name (`:name:$DATA`). None on a volume that keeps
    /// no streams. More than fit in 64 KiB of names are reported as foreign:
    /// nobody's document has that many on purpose.
    pub(crate) fn foreign_streams(file: &fs::File) -> io::Result<Vec<String>> {
        const ALLOWED: [&str; 2] = ["::$DATA", MARK_STREAM];
        Ok(match stream_names(file)? {
            None => vec!["(more streams than fit)".to_owned()],
            Some(names) => names
                .into_iter()
                .filter(|name| {
                    !ALLOWED
                        .iter()
                        .any(|allowed| allowed.eq_ignore_ascii_case(name))
                })
                .collect(),
        })
    }

    /// Whether an open file has a `Zone.Identifier` stream — asked of the
    /// file, not of its name. One with more streams than can be listed is
    /// taken to have it.
    pub(crate) fn has_mark(file: &fs::File) -> bool {
        match stream_names(file) {
            Ok(Some(names)) => names
                .iter()
                .any(|name| name.eq_ignore_ascii_case(MARK_STREAM)),
            Ok(None) => true,
            Err(_) => false,
        }
    }

    /// The names of an open file's streams (`::$DATA` its content); none on a
    /// volume that keeps no streams, `None` where they do not fit in 64 KiB.
    fn stream_names(file: &fs::File) -> io::Result<Option<Vec<String>>> {
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
                Some(1 | 38 | 50 | 87) => Ok(Some(Vec::new())),
                // ERROR_MORE_DATA: more than fit.
                Some(234) => Ok(None),
                _ => Err(err),
            };
        }

        let bytes: &[u8] =
            // SAFETY: the buffer is `buffer.len() * 8` bytes and outlives the slice.
            unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast(), buffer.len() * 8) };
        let read_u32 =
            |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        let mut names = Vec::new();
        let mut at = 0usize;
        loop {
            /* FILE_STREAM_INFO: next offset, name length in bytes, two 64-bit
            sizes, then the name in UTF-16. */
            let next = read_u32(at);
            let length = read_u32(at + 4);
            let start = at + 24;
            if start + length > bytes.len() {
                names.push("(a stream that could not be read)".to_owned());
                break;
            }
            let name: Vec<u16> = bytes[start..start + length]
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            names.push(String::from_utf16_lossy(&name));
            if next == 0 {
                break;
            }
            at += next;
            if at + 24 > bytes.len() {
                break;
            }
        }
        Ok(Some(names))
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
        /* Where its security is to be set, made closed to all but its owner
        until it is: see `windows::create_closed`. */
        #[cfg(windows)]
        let opened = if access & windows::WRITE_DAC != 0 {
            windows::create_closed(&temp, access | windows::FILE_READ_ATTRIBUTES, attributes)
        } else {
            options.open(&temp)
        };
        #[cfg(not(windows))]
        let opened = options.open(&temp);
        match opened {
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

/// A path in the form the sandbox keeps it — as much of it resolved as
/// exists, the rest as written — for a caller that has to match one it kept
/// when the thing itself may be gone.
pub fn canonical_path(path: impl AsRef<Path>) -> PathBuf {
    canonical_prefix(&normalize(path.as_ref()))
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

    /// A tab, as the shell keeps one (ADR 0006): one reading for each path
    /// as it names it, sent with every read and save of that path; a write
    /// of a path it never read goes without one and begins a reading. Most
    /// of the checks below are of one tab, and read as they did before
    /// readings existed; the ones about readings themselves use the
    /// workspace's own calls.
    struct Tab {
        workspace: Workspace,
        readings: std::collections::HashMap<String, Reading>,
    }

    impl Tab {
        fn new() -> Self {
            Self {
                workspace: Workspace::new(),
                readings: Default::default(),
            }
        }

        fn read_document(&mut self, path: impl AsRef<Path>) -> Result<Vec<u8>, VfsError> {
            let key = display(path.as_ref());
            let reading = self.readings.get(&key).copied();
            let (token, bytes) = self.workspace.read_document(path, reading)?;
            self.readings.insert(key, token);
            Ok(bytes)
        }

        fn save(
            &mut self,
            path: impl AsRef<Path>,
            data: &[u8],
            overwrite: bool,
        ) -> Result<(), VfsError> {
            let key = display(path.as_ref());
            let reading = self.readings.get(&key).copied();
            if let Some(token) =
                self.workspace
                    .save(path, data, overwrite, reading, reading.is_none())?
            {
                self.readings.insert(key, token);
            }
            Ok(())
        }
    }

    impl std::ops::Deref for Tab {
        type Target = Workspace;
        fn deref(&self) -> &Workspace {
            &self.workspace
        }
    }

    impl std::ops::DerefMut for Tab {
        fn deref_mut(&mut self) -> &mut Workspace {
            &mut self.workspace
        }
    }

    /// Two tabs of one document: each save is compared with its own
    /// reading, so the second, which read what the first then replaced, is
    /// asked about it rather than writing over it in silence.
    #[test]
    fn a_save_is_compared_with_its_own_reading() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("two-readings")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        let (first, _) = workspace.read_document(&file, None).unwrap();
        let (second, _) = workspace.read_document(&file, None).unwrap();
        assert_ne!(first, second);

        workspace
            .save(&file, b"from the first tab", false, Some(first), false)
            .unwrap();
        let refused = workspace.save(&file, b"from the second tab", false, Some(second), false);
        assert!(matches!(refused, Err(VfsError::Changed(_))), "{refused:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "from the first tab");
    }

    /// A write that names no reading — an export, the scratch panel, a
    /// converted workbook — over a document open in a tab moves nobody's
    /// reading: the tab's next save is asked about what it wrote.
    #[test]
    fn a_write_nobody_read_moves_no_reading() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("export-over")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        let (tab, _) = workspace.read_document(&file, None).unwrap();

        workspace
            .save(&file, b"an export, and longer", false, None, true)
            .unwrap();
        let refused = workspace.save(&file, b"mine, edited", false, Some(tab), false);
        assert!(matches!(refused, Err(VfsError::Changed(_))), "{refused:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "an export, and longer");
    }

    /// A reading continues only under the name it was made under: sent with
    /// another, even one that is the same file, it is refused — overwrite or
    /// not, and nothing is written.
    #[test]
    fn a_save_under_another_name_than_its_reading_is_refused() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("other-name")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        let (tab, _) = workspace.read_document(&file, None).unwrap();

        for overwrite in [false, true] {
            let refused = workspace.save(root.join("NOTES.md"), b"x", overwrite, Some(tab), false);
            assert!(matches!(refused, Err(VfsError::NotRead(_))), "{refused:?}");
        }
        let refused = workspace.read_document(root.join("NOTES.md"), Some(tab));
        assert!(matches!(refused, Err(VfsError::NotRead(_))), "{refused:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "mine");
    }

    /// A token nobody made is refused, for a save and for a read, and nothing
    /// is written — a fault of the page, never taken for a file nobody read.
    #[test]
    fn an_unknown_reading_is_refused_and_nothing_is_written() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("unknown-reading")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();

        let refused = workspace.save(&file, b"x", true, Some(999), false);
        assert!(matches!(refused, Err(VfsError::NotRead(_))), "{refused:?}");
        let refused = workspace.read_document(&file, Some(999));
        assert!(matches!(refused, Err(VfsError::NotRead(_))), "{refused:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "mine");
    }

    /// A file written by name — save-as, a converted workbook — becomes a
    /// reading when asked to, and its next save is compared with it.
    #[test]
    fn a_write_that_begins_a_reading_is_compared_on_the_next_save() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("begins")).unwrap();
        let file = root.join("copy.md");
        let token = workspace
            .save(&file, b"mine", false, None, true)
            .unwrap()
            .expect("a reading begun");
        assert_eq!(
            workspace.save(&file, b"x", false, None, false).unwrap(),
            None
        );

        fs::write(&file, "theirs, and longer").unwrap();
        let refused = workspace.save(&file, b"mine, again", false, Some(token), false);
        assert!(matches!(refused, Err(VfsError::Changed(_))), "{refused:?}");
    }

    /// A reading forgotten — its tab closed, or every one when the page
    /// loads — is one nobody made.
    #[test]
    fn a_forgotten_reading_is_unknown() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("forgotten")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        let (one, _) = workspace.read_document(&file, None).unwrap();
        let (two, _) = workspace.read_document(&file, None).unwrap();

        workspace.forget_readings(&[one]);
        let refused = workspace.save(&file, b"x", false, Some(one), false);
        assert!(matches!(refused, Err(VfsError::NotRead(_))), "{refused:?}");
        workspace
            .save(&file, b"y", false, Some(two), false)
            .unwrap();

        workspace.forget_all_readings();
        let refused = workspace.save(&file, b"z", false, Some(two), false);
        assert!(matches!(refused, Err(VfsError::NotRead(_))), "{refused:?}");
        assert!(workspace.seen.is_empty());
    }

    /// Past the most readings kept, another is refused — a read, and a write
    /// that would begin one — and none is let go to make room: the first
    /// still saves.
    #[test]
    fn readings_past_the_most_are_refused_and_none_is_let_go() {
        let mut workspace = Workspace::new();
        let root = workspace.add_root(scratch("most-readings")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        let (first, _) = workspace.read_document(&file, None).unwrap();
        for _ in 1..MOST_READINGS {
            workspace.read_document(&file, None).unwrap();
        }
        assert!(workspace.read_document(&file, None).is_err());
        assert!(workspace
            .save(root.join("new.md"), b"x", false, None, true)
            .is_err());
        assert!(
            !root.join("new.md").exists(),
            "written before it was refused"
        );
        workspace
            .save(&file, b"saved", false, Some(first), false)
            .unwrap();
    }

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
        let mut workspace = Tab::new();
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
        let mut workspace = Tab::new();
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
        let mut workspace = Tab::new();
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
        let mut workspace = Tab::new();
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
        let mut workspace = Tab::new();
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
        let mut workspace = Tab::new();
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

        let mut workspace = Tab::new();
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

    /// The same on Windows, where a new version is made by a call of this
    /// program's own: a link left under its name, to a file not there yet
    /// outside the folder, is neither followed nor made. Needs an account that
    /// can make a link to a file — the CI runner; elsewhere it says it was
    /// skipped.
    #[cfg(windows)]
    #[test]
    fn a_save_does_not_follow_a_link_left_where_its_temporary_file_goes_on_windows() {
        let base = scratch("link-windows");
        let outside = base.join("made-outside.txt");
        let inside = base.join("ws");
        fs::create_dir_all(&inside).unwrap();

        let mut workspace = Tab::new();
        let root = workspace.add_root(&inside).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "before").unwrap();
        let me = std::env::var("USERNAME").unwrap();
        /* A DACL of its own, so the new version is made by `create_closed`. */
        icacls(&file, &["/inheritance:r", "/grant:r", &format!("{me}:(F)")]);
        let mut links = crate::testing::Links::default();
        if !links.file(&temp_beside(&file, 0), &outside) {
            crate::testing::skip("this account cannot make a link to a file");
            return;
        }

        workspace.read_document(&file).unwrap();
        workspace.save(&file, b"after", false).unwrap();
        workspace.write(&file, b"again").unwrap();

        assert!(!outside.exists(), "the link was followed");
        assert_eq!(fs::read_to_string(&file).unwrap(), "again");
    }

    #[cfg(windows)]
    #[test]
    fn a_save_keeps_the_mark_of_a_file_from_the_internet() {
        let mut workspace = Tab::new();
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

    /// The same for a document read to be edited, whose mark is taken from
    /// the open file it was read from — through a save, and the next one,
    /// which takes it from what the first one wrote.
    #[cfg(windows)]
    #[test]
    fn a_document_read_and_saved_twice_keeps_its_mark() {
        let mut workspace = Tab::new();
        let root = workspace.add_root(scratch("zone-read")).unwrap();
        let file = root.join("downloaded.docx");
        fs::write(&file, "before").unwrap();
        fs::write(zone_stream(&file), "[ZoneTransfer]\r\nZoneId=3\r\n").unwrap();
        workspace.read_document(&file).unwrap();

        workspace.save(&file, b"after", false).unwrap();
        workspace.save(&file, b"again", false).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "again");
        assert_eq!(
            fs::read_to_string(zone_stream(&file)).ok().as_deref(),
            Some("[ZoneTransfer]\r\nZoneId=3\r\n"),
            "the save took the mark away"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_save_keeps_who_may_read_the_document() {
        use std::os::unix::fs::PermissionsExt;

        let mut workspace = Tab::new();
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
        let mut workspace = Tab::new();
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
        let mut workspace = Tab::new();
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
        let mut workspace = Tab::new();
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
        let mut workspace = Tab::new();
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
        let mut workspace = Tab::new();
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
        let mut workspace = Tab::new();
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
        let mut workspace = Tab::new();
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
    fn closed_document(tag: &str) -> (Tab, PathBuf, String) {
        let mut workspace = Tab::new();
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

    /// In a folder told to tell letters apart, `notes.md` and `NOTES.md` are
    /// two documents, both open: each is saved as itself, with no question
    /// and nothing written over the other.
    #[cfg(windows)]
    #[test]
    fn two_documents_named_apart_only_by_their_letters_are_two() {
        let mut workspace = Tab::new();
        let root = workspace.add_root(scratch("letters-apart")).unwrap();
        let folder = root.join("sensitive");
        fs::create_dir(&folder).unwrap();
        let told = std::process::Command::new("fsutil")
            .args(["file", "setCaseSensitiveInfo"])
            .arg(display(&folder))
            .arg("enable")
            .output()
            .is_ok_and(|out| out.status.success());
        if !told {
            crate::testing::skip("this folder cannot be told to tell letters apart");
            return;
        }
        let lower = folder.join("notes.md");
        let upper = folder.join("NOTES.md");
        fs::write(&lower, "mine").unwrap();
        fs::write(&upper, "the other").unwrap();
        workspace.read_document(&lower).unwrap();
        workspace.read_document(&upper).unwrap();

        workspace.save(&lower, b"mine, edited", false).unwrap();
        assert_eq!(fs::read_to_string(&upper).unwrap(), "the other");
        assert_eq!(fs::read_to_string(&lower).unwrap(), "mine, edited");
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

    /// A replacement read again that is hidden leaves the next version
    /// hidden, though its security is not taken: what is stricter of it is.
    #[cfg(windows)]
    #[test]
    fn a_hidden_replacement_read_again_leaves_the_next_version_hidden() {
        use std::os::windows::fs::MetadataExt;

        let (mut workspace, file, _) = closed_document("hidden-again");
        fs::remove_file(&file).unwrap();
        fs::write(&file, "planted").unwrap();
        let attrib = |flag: &str| {
            std::process::Command::new("attrib")
                .arg(flag)
                .arg(display(&file))
                .status()
                .unwrap()
                .success()
        };
        assert!(attrib("+h"));
        workspace.read_document(&file).unwrap();

        workspace.save(&file, b"mine", false).unwrap();
        let hidden = fs::metadata(&file).unwrap().file_attributes() & 0x2 != 0;
        let _ = attrib("-h");
        assert!(hidden, "no longer hidden");
    }

    /// Saved once under another spelling — a write nobody read under that
    /// name, which moves no reading — and then its folder swapped for a
    /// junction to a folder holding a file of its name: the reading under
    /// the first spelling is asked about, and nothing is written through the
    /// junction.
    #[cfg(windows)]
    #[test]
    fn a_spelling_saved_under_once_keeps_its_record() {
        let mut links = crate::testing::Links::default();
        let mut workspace = Tab::new();
        let root = workspace.add_root(scratch("spelling-junction")).unwrap();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        let file = sub.join("notes.md");
        fs::write(&file, "private").unwrap();
        workspace.read_document(&file).unwrap();
        workspace
            .save(sub.join("NOTES.md"), b"private, first save", false)
            .unwrap();

        let elsewhere = root.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        fs::write(elsewhere.join("notes.md"), "somebody else's").unwrap();
        fs::remove_dir_all(&sub).unwrap();
        links.folder(&sub, &elsewhere);

        let refused = workspace.save(&file, b"private, second save", false);
        assert!(matches!(refused, Err(VfsError::Changed(_))), "{refused:?}");
        assert_eq!(
            fs::read_to_string(elsewhere.join("notes.md")).unwrap(),
            "somebody else's"
        );
    }

    /// A document taken away between its opening and the reading of its mark,
    /// with an unmarked file put in its place: the open file is asked whether
    /// it has a mark, and the plain internet one is remembered rather than
    /// none.
    #[cfg(windows)]
    #[test]
    fn the_mark_of_the_file_opened_is_kept_when_its_name_has_none() {
        let root = scratch("mark-of-open");
        let file = root.join("downloaded.docx");
        fs::write(&file, "from the internet").unwrap();
        fs::write(zone_stream(&file), "[ZoneTransfer]\r\nZoneId=3\r\n").unwrap();
        let open = open_regular(&file).unwrap();
        fs::rename(&file, root.join("away.docx")).unwrap();
        fs::write(&file, "unmarked").unwrap();

        let protection = Protection::of(&file, &open).unwrap();
        assert_eq!(
            protection.mark.as_deref(),
            Some(INTERNET),
            "the mark was lost"
        );
    }

    /// And with a file put in its place that carries a mark of its own —
    /// trusted, `ZoneId=0` — that mark is not taken for the document's: the
    /// stream the name leads to is not the open file's.
    #[cfg(windows)]
    #[test]
    fn a_mark_of_a_file_put_in_the_documents_place_is_not_taken() {
        let root = scratch("mark-planted");
        let file = root.join("downloaded.docx");
        fs::write(&file, "from the internet").unwrap();
        fs::write(zone_stream(&file), "[ZoneTransfer]\r\nZoneId=3\r\n").unwrap();
        let open = open_regular(&file).unwrap();
        fs::rename(&file, root.join("away.docx")).unwrap();
        fs::write(&file, "planted").unwrap();
        fs::write(zone_stream(&file), "[ZoneTransfer]\r\nZoneId=0\r\n").unwrap();

        let protection = Protection::of(&file, &open).unwrap();
        assert_eq!(protection.mark.as_deref(), Some(INTERNET));

        /* The document's own stream, through its own name, is still read as
        it is. */
        let own = root.join("away.docx");
        let open = open_regular(&own).unwrap();
        let protection = Protection::of(&own, &open).unwrap();
        assert_eq!(
            protection.mark.as_deref(),
            Some(&b"[ZoneTransfer]\r\nZoneId=3\r\n"[..])
        );
    }

    /// Its own security changed while it was open — by the person, in the
    /// file's properties — is the document's, and the next version keeps it,
    /// with when it was made and its being hidden.
    #[cfg(windows)]
    #[test]
    fn the_documents_own_security_changed_while_open_is_kept() {
        use std::os::windows::fs::{FileTimesExt, MetadataExt};

        let mut workspace = Tab::new();
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

    /// Only a whole ID of a volume on this machine tells the same file: a
    /// 64-bit index, and anything on another machine, never does — however
    /// alike the two looks are.
    #[cfg(windows)]
    #[test]
    fn only_a_whole_local_id_tells_the_same_file() {
        let born = Some(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1));
        let print = |id: windows::Identity, remote: bool| Fingerprint {
            id: Some(id),
            remote,
            created: born,
            modified: born,
            len: 1,
        };
        let long = windows::Identity::Long(7, [1; 16]);
        let short = windows::Identity::Short(7, 42);

        assert!(print(long.clone(), false).same_file(&print(long.clone(), false)));
        assert!(!print(long.clone(), true).same_file(&print(long, true)));
        assert!(!print(short.clone(), false).same_file(&print(short, false)));
    }

    /// A new version that is to be given the document's security is made
    /// closed to all but its owner: from the moment it exists, nobody the
    /// folder lets in may open it to change its security.
    #[cfg(windows)]
    #[test]
    fn a_new_version_is_made_closed_until_it_has_the_documents_security() {
        let root = scratch("made-closed");
        let file = root.join("notes.md");
        fs::write(&file, "mine").unwrap();
        let protection = Protection::of(&file, &fs::File::open(&file).unwrap()).unwrap();
        assert!(protection.has_dacl(), "the test needs a volume with ACLs");

        let (made, temp) = create_beside(&file, &Source::Given(&protection)).unwrap();
        let after = sddl(&temp);
        drop(made);
        let _ = fs::remove_file(&temp);
        let dacl = &after[after.find("D:").unwrap()..];
        assert!(dacl.starts_with("D:P(A;;FA;;;OW)"), "{after}");
    }

    /// While a save holds the document, nobody can put another file in its
    /// place nor write into it: what was checked is what is replaced.
    #[cfg(windows)]
    #[test]
    fn a_held_document_can_be_neither_replaced_nor_written() {
        let root = scratch("held-document");
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

        let mut workspace = Tab::new();
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
        /* Only what both allow: not the planted file's reading and writing
        by anybody, and not the group's reading it did not allow. */
        assert_eq!(mode, 0o600, "the planted mode was carried over: {mode:o}");
    }

    /// Put in the document's place more closed than the document was, and
    /// read again: the next version is not opened wider than either.
    #[cfg(unix)]
    #[test]
    fn a_more_closed_replacement_read_again_stays_closed() {
        use std::os::unix::fs::PermissionsExt;

        let mut workspace = Tab::new();
        let root = workspace.add_root(scratch("closed-again")).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "shared").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        workspace.read_document(&file).unwrap();

        fs::remove_file(&file).unwrap();
        fs::write(&file, "private").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        workspace.read_document(&file).unwrap();
        workspace.save(&file, b"private, edited", false).unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "opened wider than it was: {mode:o}");
    }

    /// The same on Unix: a replacement nobody may read, and a deleted
    /// document, both come back with the document's own mode.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_replacement_and_a_deleted_document_keep_the_documents_mode() {
        use std::os::unix::fs::PermissionsExt;

        let mut workspace = Tab::new();
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

        let mut workspace = Tab::new();
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

        let mut workspace = Tab::new();
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

        let mut workspace = Tab::new();
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

        let mut workspace = Tab::new();
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

        let mut workspace = Tab::new();
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
        let mut workspace = Tab::new();
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

    /// A file let in only to be read is read, said to be read-only, and
    /// written by neither a write nor a save — read to be edited first or not.
    #[test]
    fn a_file_let_in_to_be_read_is_not_written() {
        let base = scratch("read-only");
        let file = base.join("ugovor.md");
        fs::write(&file, "theirs").unwrap();
        let mut workspace = Tab::new();
        workspace.grant_file(&file, Access::Read).unwrap();

        assert_eq!(workspace.read_document(&file).unwrap(), b"theirs");
        assert!(workspace.stat(&file).unwrap().readonly);
        let written = workspace.write(&file, b"mine");
        assert!(matches!(written, Err(VfsError::ReadOnly(_))), "{written:?}");
        let saved = workspace.save(&file, b"mine", true);
        assert!(matches!(saved, Err(VfsError::ReadOnly(_))), "{saved:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "theirs");

        /* Let in again to be written — by a dialog — it is. */
        workspace.grant_file(&file, Access::ReadWrite).unwrap();
        assert!(!workspace.stat(&file).unwrap().readonly);
        workspace.save(&file, b"mine", false).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "mine");
        /* And a read-only offer of it after does not take that away. */
        workspace.grant_file(&file, Access::Read).unwrap();
        workspace.save(&file, b"mine, again", false).unwrap();
    }

    /// The one thing read in a protected folder: a file of the program's own
    /// it means to show — a crash report. Nothing there is written, nothing
    /// beside it read, and no grant lets anything in: neither one to read,
    /// which is what a language server's answer becomes, nor one to write.
    #[test]
    fn a_protected_folder_shows_only_its_own_file_and_grants_let_nothing_in() {
        let base = scratch("protected-report");
        let own = base.join("crash");
        fs::create_dir_all(&own).unwrap();
        fs::write(own.join("report.txt"), "boom").unwrap();
        fs::write(own.join("consents.json"), "{}").unwrap();
        let mut workspace = Tab::new();
        workspace.protect(&own);
        workspace.add_root(&base).unwrap();

        let report = workspace.show_own_file(own.join("report.txt")).unwrap();
        assert_eq!(workspace.read(&report).unwrap(), b"boom");
        assert!(workspace.write(&report, b"planted").is_err());
        assert!(workspace.read_dir(&own).is_err());

        let kept = own.join("consents.json");
        workspace.grant_file(&kept, Access::Read).unwrap();
        assert!(
            workspace.read(&kept).is_err(),
            "a read grant opened a protected file"
        );
        workspace.grant_file(&kept, Access::ReadWrite).unwrap();
        assert!(workspace.read(&kept).is_err());
        assert!(workspace.write(&kept, b"planted").is_err());
    }

    /// A folder let in only to be read lists its files as read-only and
    /// writes none of them, a new one included.
    #[test]
    fn a_folder_let_in_to_be_read_lists_read_only_and_writes_nothing() {
        let base = scratch("read-only-folder");
        fs::write(base.join("a.md"), "a").unwrap();
        let mut workspace = Tab::new();
        workspace.grant_folder(&base, Access::Read).unwrap();

        let listed = workspace.read_dir(&base).unwrap();
        assert!(listed.iter().all(|entry| entry.stat.readonly), "{listed:?}");
        assert!(matches!(
            workspace.write(base.join("new.md"), b"x"),
            Err(VfsError::ReadOnly(_))
        ));
        assert!(!base.join("new.md").exists());
    }

    /// A file chosen in a save dialog is let in to be written, though it does
    /// not exist yet — and nothing beside it.
    #[test]
    fn a_file_chosen_to_save_into_is_let_in_alone() {
        let base = scratch("future");
        let mut workspace = Tab::new();
        let target = workspace.grant_future_file(base.join("izvoz.pdf")).unwrap();

        workspace.write(&target, b"%PDF").unwrap();
        assert_eq!(fs::read(base.join("izvoz.pdf")).unwrap(), b"%PDF");
        assert!(workspace.write(base.join("beside.pdf"), b"x").is_err());
        assert!(workspace.read_dir(&base).is_err());
    }

    /// A root taken away keeps the files still open in it, each on its own,
    /// and nothing else of it — nor anything named that was never in it.
    #[test]
    fn a_folder_forgotten_keeps_only_the_files_still_open_in_it() {
        let base = scratch("forget-keep");
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("open.md"), "o").unwrap();
        fs::write(root.join("closed.md"), "c").unwrap();
        fs::write(base.join("outside.md"), "x").unwrap();
        let mut workspace = Tab::new();
        let root = workspace.add_root(&root).unwrap();

        workspace.forget_root(&root, &[root.join("open.md"), base.join("outside.md")]);
        assert!(workspace.roots().is_empty());
        workspace.write(root.join("open.md"), b"still").unwrap();
        assert!(workspace.read(root.join("closed.md")).is_err());
        assert!(workspace.read(base.join("outside.md")).is_err());
        assert!(workspace.read_dir(&root).is_err());
    }

    /// Only the file a language server pointed at is let in, not its folder.
    #[test]
    fn a_granted_file_lets_in_that_file_and_nothing_beside_it() {
        let base = scratch("grant-file");
        fs::write(base.join("definition.rs"), "fn here() {}").unwrap();
        fs::write(base.join("beside.rs"), "fn not_asked_for() {}").unwrap();

        let mut workspace = Tab::new();
        let granted = workspace
            .grant_file(base.join("definition.rs"), Access::ReadWrite)
            .unwrap();

        assert!(workspace.read(&granted).is_ok());
        assert!(matches!(
            workspace.read(granted.with_file_name("beside.rs")),
            Err(VfsError::OutsideWorkspace(_))
        ));
        assert!(workspace.roots().is_empty(), "the folder became a root");
        assert!(matches!(
            workspace.grant_file(&base, Access::ReadWrite),
            Err(VfsError::NotAFile(_))
        ));
    }

    #[test]
    fn a_forgotten_folder_is_out_of_the_sandbox() {
        let base = scratch("forget");
        fs::write(base.join("note.txt"), "here").unwrap();

        let mut workspace = Tab::new();
        let root = workspace.add_root(&base).unwrap();
        assert!(workspace.read(root.join("note.txt")).is_ok());

        workspace.forget_root(display(&root), &[]);

        assert!(workspace.roots().is_empty());
        assert!(workspace.read(root.join("note.txt")).is_err());
    }

    /// What an interrupted save left beside the document goes with the next
    /// save — and nothing that only looks like it.
    #[test]
    fn a_save_takes_away_what_an_interrupted_one_left() {
        let mut workspace = Tab::new();
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

        let mut workspace = Tab::new();
        assert!(matches!(
            workspace.grant_file(base.join("pointer.rs"), Access::ReadWrite),
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
        let mut workspace = Tab::new();
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

        let mut workspace = Tab::new();
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
        let mut workspace = Tab::new();
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
        assert_eq!(
            macos::attribute_of(&file, name).unwrap(),
            Some(long.clone())
        );
        assert_eq!(
            macos::attribute_of_file(&fs::File::open(&file).unwrap(), name).unwrap(),
            Some(long)
        );
        assert_eq!(
            macos::attribute_of(&file, b"org.uleditor.none\0").unwrap(),
            None
        );
    }

    /// A file from the internet stays one through a save on macOS, as on Windows.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_save_keeps_the_quarantine_mark_on_macos() {
        let mut workspace = Tab::new();
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
        /* And for a document read to be edited, whose mark is taken from the
        open file it was read from, through two saves. */
        workspace.read_document(&file).unwrap();
        workspace.save(&file, b"again", false).unwrap();
        workspace.save(&file, b"and again", false).unwrap();

        let out = std::process::Command::new("xattr")
            .args(["-p", "com.apple.quarantine"])
            .arg(&file)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), mark);
    }
}
