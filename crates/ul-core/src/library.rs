//! Document library — a survey of the device instead of a directory tree.
//!
//! **Why it exists at all.** An explorer with a folder tree is a desktop
//! metaphor and does not work on a phone: nobody there knows where a file
//! physically sits, only that they have some PDF somewhere. So the mobile view
//! does not ask the user to open a folder; it surveys the usual places itself
//! and offers what it found, newest first.
//!
//! **Scanning, not an index** — for the same reason as search in
//! [`crate::search`]: an index would demand invalidation, and the library is
//! looked at rarely and briefly anyway.
//!
//! **Android has a catch here.** Under scoped storage, `read_dir` over shared
//! storage returns **directories only** and quietly omits the files — without a
//! single error. The app then looks as if the device holds no documents, even
//! though it holds hundreds. That is why the scan also counts the folders it
//! visited: an empty result with visited folders means "you have no documents",
//! while an empty result with folders but not one file means "you have no
//! permission". That distinction surfaces in [`LibraryScan::looks_blocked`] and
//! the UI depends on it.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use ul_formats::{detect_by_name, FormatId};

use crate::vfs::{display, is_noise, is_scratch, VfsError, Workspace};

/// How deep we go. Shared storage tends to hold deep cache trees unrelated to
/// documents, and every level costs.
const MAX_DEPTH: usize = 6;

/// Upper bound on the number of entries; beyond that nobody reads the list anyway.
const DEFAULT_LIMIT: usize = 2000;

/// How many images are kept at most.
///
/// Without a separate budget, photos swallow the library whole: on the device we
/// measured, 1956 of 2000 entries were images and 41 were PDFs, and the limit
/// hit mid-scan — documents in folders visited later never even reached the
/// list. Images are here for OCR over a photographed document, not to be a
/// gallery, so they get their own, smaller quota.
const MAX_IMAGES: usize = 400;

/// Folders that carry application data, not the user's documents.
///
/// `Android/data` and `Android/obb` are other programs' caches; scanning them
/// takes a long time and finds nothing the user would recognise as their own.
const SKIP_DIRS: &[&str] = &[
    "Android",
    "MIUI",
    "LOST.DIR",
    ".thumbnails",
    ".trashed",
    "cache",
    "Cache",
    "node_modules",
    "downloaded_rom",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub uri: String,
    pub name: String,
    /// `pdf`, `epub`, `docx`, `image` …
    pub format: String,
    pub size: u64,
    /// Unix ms; `None` when the platform does not provide it.
    pub modified: Option<u64>,
    /// The folder it was found in, relative to the root — for grouping in the view.
    pub folder: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScan {
    pub entries: Vec<LibraryEntry>,
    /// How many folders were read successfully.
    pub scanned_dirs: usize,
    /// How many files were seen at all, before filtering by format.
    pub seen_files: usize,
    /// Whether the scan stopped at a limit instead of reaching the end.
    pub truncated: bool,
}

impl LibraryScan {
    /// Tells "no documents" apart from "the system is hiding them".
    ///
    /// If we walked through several folders and saw **not one file**, that is
    /// not an empty phone but denied access: genuinely empty storage has no
    /// subfolders either. On this basis the UI offers to turn the permission on
    /// instead of claiming "there is nothing here".
    pub fn looks_blocked(&self) -> bool {
        self.seen_files == 0 && self.scanned_dirs > 1
    }
}

/// Formats the library displays.
///
/// Documents and images, no code and no archives: on a phone you open what you
/// read, and a `.ts` or `.zip` in the list would be noise. On desktop the
/// explorer serves that purpose.
fn is_library_format(format: FormatId) -> bool {
    matches!(
        format,
        FormatId::Pdf
            | FormatId::Epub
            | FormatId::Docx
            | FormatId::Xlsx
            | FormatId::Pptx
            | FormatId::Odf
            | FormatId::Markdown
            | FormatId::Image
    )
}

/// Where documents are looked for, per platform.
///
/// Paths that do not exist are returned too — the caller skips anything it
/// cannot open anyway, and the list then reads as a statement of intent.
pub fn default_roots() -> Vec<PathBuf> {
    #[cfg(target_os = "android")]
    {
        // `/sdcard` is a symlink to `/storage/emulated/0`; we use the latter
        // form because `canonicalize` returns it that way regardless.
        let base = Path::new("/storage/emulated/0");
        [
            "Download",
            "Documents",
            "DCIM",
            "Pictures",
            "Books",
            "Audiobooks",
        ]
        .iter()
        .map(|dir| base.join(dir))
        .collect()
    }

    #[cfg(not(target_os = "android"))]
    {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from);
        let Some(home) = home else {
            return Vec::new();
        };
        ["Documents", "Downloads", "Desktop", "Pictures"]
            .iter()
            .map(|dir| home.join(dir))
            .collect()
    }
}

impl Workspace {
    /// Surveys the default locations and returns documents, newest first.
    ///
    /// The roots are **not** run through `resolve`: the library deliberately
    /// looks outside the adopted workspace, because otherwise it would be empty
    /// on a phone until the user opened a folder by hand — which is exactly what
    /// we are avoiding. That is also why reading is the only operation allowed
    /// here.
    pub fn scan_library(
        &self,
        roots: &[PathBuf],
        limit: Option<usize>,
    ) -> Result<LibraryScan, VfsError> {
        let limit = limit.unwrap_or(DEFAULT_LIMIT);
        let mut walked = Walked {
            documents: Vec::new(),
            images: Vec::new(),
            scanned_dirs: 0,
            seen_files: 0,
            truncated: false,
        };

        for root in roots {
            if walked.documents.len() >= limit {
                walked.truncated = true;
                break;
            }
            walk(root, root, 0, limit, &mut walked);
        }

        /*
         * Images are collected without a quota and trimmed here by time, not by
         * visit order: a folder is not walked chronologically, so trimming on
         * the fly would keep a random 400 photos instead of the newest ones.
         * The per-entry struct is tiny, so holding them all transiently is cheap.
         */
        walked.images.sort_by(newest_first);
        if walked.images.len() > MAX_IMAGES {
            walked.images.truncate(MAX_IMAGES);
            walked.truncated = true;
        }

        let mut entries = walked.documents;
        entries.extend(walked.images);
        entries.sort_by(newest_first);
        if entries.len() > limit {
            entries.truncate(limit);
            walked.truncated = true;
        }

        Ok(LibraryScan {
            entries,
            scanned_dirs: walked.scanned_dirs,
            seen_files: walked.seen_files,
            truncated: walked.truncated,
        })
    }
}

/// Documents and images are collected separately so photos do not eat the quota.
struct Walked {
    documents: Vec<LibraryEntry>,
    images: Vec<LibraryEntry>,
    scanned_dirs: usize,
    seen_files: usize,
    truncated: bool,
}

/// Newest first; entries without a timestamp go last, as they cannot be ordered.
fn newest_first(a: &LibraryEntry, b: &LibraryEntry) -> std::cmp::Ordering {
    match (b.modified, a.modified) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.name.cmp(&b.name),
    }
}

fn walk(root: &Path, dir: &Path, depth: usize, limit: usize, walked: &mut Walked) {
    if depth > MAX_DEPTH || walked.documents.len() >= limit {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    walked.scanned_dirs += 1;

    for entry in entries.flatten() {
        if walked.documents.len() >= limit {
            walked.truncated = true;
            return;
        }

        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };

        // `file_type` is cheaper than `metadata`: it does not touch the inode per entry.
        let Ok(kind) = entry.file_type() else {
            continue;
        };

        if kind.is_dir() {
            if is_noise(&name) || SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            walk(root, &path, depth + 1, limit, walked);
            continue;
        }

        if !kind.is_file() {
            continue;
        }

        walked.seen_files += 1;

        // An Office owner file carries the extension of the document beside it
        // and none of its content — see `is_scratch`.
        if is_scratch(&name) {
            continue;
        }

        let format = detect_by_name(&name).format;
        if !is_library_format(format) {
            continue;
        }

        let meta = entry.metadata().ok();
        let item = LibraryEntry {
            uri: display(&path),
            name,
            format: format.as_str().to_owned(),
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            modified: meta.as_ref().and_then(modified_ms),
            folder: folder_label(root, &path),
        };

        if format == FormatId::Image {
            walked.images.push(item);
        } else {
            walked.documents.push(item);
        }
    }
}

/// The folder a file sits in, relative to the scan root.
///
/// The root itself supplies the name (`Download`), and deeper levels append the
/// path (`Download/Foxit`) — enough for the list to show where something came
/// from, without displaying a full absolute path that means nothing on a phone.
fn folder_label(root: &Path, path: &Path) -> String {
    let root_name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_owned();

    let Some(parent) = path.parent() else {
        return root_name;
    };

    match parent.strip_prefix(root) {
        Ok(rest) if rest.as_os_str().is_empty() => root_name,
        Ok(rest) => format!("{root_name}/{}", rest.to_string_lossy().replace('\\', "/")),
        Err(_) => root_name,
    }
}

fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ul-library-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_documents_and_images_and_skips_code() {
        let dir = temp_dir("mix");
        fs::write(dir.join("ugovor.pdf"), b"%PDF-1.4").unwrap();
        fs::write(dir.join("photo.png"), b"\x89PNG").unwrap();
        fs::write(dir.join("biljeske.md"), b"# naslov").unwrap();
        fs::write(dir.join("main.rs"), b"fn main() {}").unwrap();
        fs::write(dir.join("arhiva.zip"), b"PK").unwrap();

        let workspace = Workspace::new();
        let scan = workspace
            .scan_library(std::slice::from_ref(&dir), None)
            .unwrap();

        let mut formats: Vec<_> = scan.entries.iter().map(|e| e.format.as_str()).collect();
        formats.sort_unstable();
        assert_eq!(formats, ["image", "markdown", "pdf"]);
        assert_eq!(scan.seen_files, 5);
    }

    #[test]
    fn skips_application_data_folders() {
        let dir = temp_dir("skip");
        fs::create_dir_all(dir.join("Android/data")).unwrap();
        fs::write(dir.join("Android/data/tudje.pdf"), b"%PDF").unwrap();
        fs::write(dir.join("moje.pdf"), b"%PDF").unwrap();

        let workspace = Workspace::new();
        let scan = workspace
            .scan_library(std::slice::from_ref(&dir), None)
            .unwrap();

        assert_eq!(scan.entries.len(), 1);
        assert_eq!(scan.entries[0].name, "moje.pdf");
    }

    #[test]
    fn the_most_recent_comes_first() {
        let dir = temp_dir("order");
        fs::write(dir.join("old.pdf"), b"%PDF").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dir.join("new.pdf"), b"%PDF").unwrap();

        let workspace = Workspace::new();
        let scan = workspace
            .scan_library(std::slice::from_ref(&dir), None)
            .unwrap();

        assert_eq!(scan.entries[0].name, "new.pdf");
    }

    #[test]
    fn the_folder_is_reported_relative_to_the_root() {
        let dir = temp_dir("folder");
        fs::create_dir_all(dir.join("racuni")).unwrap();
        fs::write(dir.join("racuni/r1.pdf"), b"%PDF").unwrap();

        let workspace = Workspace::new();
        let scan = workspace
            .scan_library(std::slice::from_ref(&dir), None)
            .unwrap();

        let root_name = dir.file_name().unwrap().to_str().unwrap();
        assert_eq!(scan.entries[0].folder, format!("{root_name}/racuni"));
    }

    /// Scoped storage looks exactly like this: folders are visible, files are not.
    #[test]
    fn folders_alone_with_no_files_mean_access_denied() {
        let dir = temp_dir("blocked");
        fs::create_dir_all(dir.join("Download")).unwrap();
        fs::create_dir_all(dir.join("Documents")).unwrap();

        let workspace = Workspace::new();
        let scan = workspace
            .scan_library(std::slice::from_ref(&dir), None)
            .unwrap();

        assert!(scan.entries.is_empty());
        assert!(scan.looks_blocked());
    }

    /// Without a separate quota, photos push documents out of the list.
    #[test]
    fn images_cannot_crowd_documents_out() {
        let dir = temp_dir("photos");
        for i in 0..(MAX_IMAGES + 50) {
            fs::write(dir.join(format!("IMG_{i:04}.jpg")), b"\xff\xd8").unwrap();
        }
        fs::write(dir.join("ugovor.pdf"), b"%PDF").unwrap();

        let workspace = Workspace::new();
        let scan = workspace
            .scan_library(std::slice::from_ref(&dir), None)
            .unwrap();

        let images = scan.entries.iter().filter(|e| e.format == "image").count();
        assert_eq!(images, MAX_IMAGES, "images must be capped by the quota");
        assert!(
            scan.entries.iter().any(|e| e.name == "ugovor.pdf"),
            "the document has to stay in the list no matter how many photos there are"
        );
        assert!(scan.truncated);
    }

    /// The library may read its own folders, but must not push them into the explorer.
    #[test]
    fn a_granted_folder_does_not_enter_the_tree() {
        let dir = temp_dir("roots");
        fs::write(dir.join("ugovor.pdf"), b"%PDF").unwrap();

        let mut workspace = Workspace::new();
        workspace.grant_folder(&dir).unwrap();

        assert!(
            workspace.roots().is_empty(),
            "the explorer must not receive a folder the library opened"
        );
        assert!(
            workspace.read(dir.join("ugovor.pdf")).is_ok(),
            "a document from the library must be openable"
        );
    }

    #[test]
    fn an_empty_folder_is_not_denied_access() {
        let dir = temp_dir("empty");

        let workspace = Workspace::new();
        let scan = workspace.scan_library(&[dir], None).unwrap();

        assert!(!scan.looks_blocked());
    }
}
