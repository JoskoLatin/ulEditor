//! Search across the whole workspace.
//!
//! **Why scanning, not an index.** The plan called for `tantivy`. An index pays
//! off when the corpus is large and queries frequent, but it brings a problem
//! with no halfway solution: invalidation. A file edited outside the program, a
//! `git checkout` that touches a thousand files, a folder added and then
//! removed — every one of those has to update the index by agreement, or search
//! quietly lies. Scanning cannot go stale because it holds no state at all.
//!
//! **Measured, since the claim used to be asserted.** With
//! `examples/search-timing.rs`, release build, one search:
//!
//! | Workspace | files walked | read as text | one search |
//! |---|---|---|---|
//! | This repository | 1 895 | 816 | **171 ms** (truncated at 500 hits) |
//! | A `Documents` folder with a portable ComfyUI in it | 19 575 | 8 371 | **2.2 s** |
//!
//! The second row was **17.2 s** before two changes. The first was not clever
//! at all: 90 998 of those files were under `site-packages` and 18 721 under
//! `__pycache__`, and the noise list in `vfs.rs` knew about `node_modules` and
//! `target` but nothing about Python. The second was reading the files a block
//! at a time on several threads instead of one after another, which took what
//! remained from 4.7 s to 2.2 s.
//!
//! An index becomes justified only once *that* stops being true. It has not: a
//! project folder answers in a sixth of a second, and the pathological case is
//! two seconds without holding any state that could go stale.
//!
//! **Links are not followed** — a symbolic link, or on Windows a junction,
//! whether it points at a folder or at a file. Only the roots go through
//! `Workspace::resolve`; what is under them is walked, and the walk used to ask
//! `is_dir()` of each entry, which follows a link. A folder holding a junction
//! to somebody's home then had that home searched and listed, its lines shown
//! in the results, while `read` refused the same path. Two junctions back to
//! the folder itself made a walk that never ended. An entry's own type follows
//! nothing, and it is what `library.rs` has always used.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use ul_formats::{detect_by_name, FormatId};

use crate::vfs::{display, VfsError, Workspace};

/// Files larger than this are almost certainly not source code; scanning would
/// cost more than the result is worth.
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// How many bytes from the start we look at to decide whether content is binary.
const PROBE: usize = 8 * 1024;

/// How many threads read files at once.
///
/// Capped rather than "as many as the machine has": this is bound by the disk,
/// not by the processor — eight thousand files of a few kilobytes each is almost
/// all waiting. Past a handful of readers the queue forms in the drive instead
/// of in the program, and on a spinning disk it gets slower rather than faster.
const MAX_READERS: usize = 8;

/// How many files one reader takes at a time.
///
/// The block is the unit of both parallelism and stopping. Larger blocks spend
/// less on coordination; smaller ones stop sooner once the limit is reached.
/// Thirty-two files each is a few milliseconds of work per thread and a
/// granularity nobody can perceive.
const PER_READER: usize = 32;

/// Length of the excerpt around a hit in the results view.
const PREVIEW_BEFORE: usize = 40;
const PREVIEW_AFTER: usize = 90;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub query: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    /// The most hits we return in total.
    #[serde(default = "default_limit")]
    pub limit: usize,
    /// The most hits per file — without this one generated file eats the
    /// entire quota.
    #[serde(default = "default_per_file")]
    pub per_file: usize,
}

fn default_limit() -> usize {
    500
}

fn default_per_file() -> usize {
    20
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub uri: String,
    pub name: String,
    /// 1-based line number.
    pub line: u32,
    /// 1-based column in characters, not bytes.
    pub column: u32,
    /// Excerpt of the line around the hit.
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub hits: Vec<SearchHit>,
    /// How many files were read at all — for the "searched N files" message.
    pub scanned: usize,
    /// Whether search stopped because of a limit rather than because it finished.
    pub truncated: bool,
    /// Files search could not read as text, but which another editor knows how
    /// to open (PDF, Word, Excel, e-book). The shell offers to search them with
    /// its own parsers — that is the difference from a plain grep.
    pub documents: Vec<DocumentCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCandidate {
    pub uri: String,
    pub name: String,
    /// `pdf`, `docx`, `xlsx`, `epub` …
    pub format: String,
}

/// A NUL byte almost always means binary content; the same heuristic as in detection.
fn looks_textual(bytes: &[u8]) -> bool {
    let window = &bytes[..bytes.len().min(PROBE)];
    !window.contains(&0)
}

/// Whether the hit sits on a word boundary on both sides.
fn word_bounded(haystack: &str, start: usize, end: usize) -> bool {
    let before = haystack[..start].chars().next_back();
    let after = haystack[end..].chars().next();
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    !before.is_some_and(is_word) && !after.is_some_and(is_word)
}

/// Excerpt around the hit, cut on character boundaries.
fn preview_of(line: &str, start: usize, end: usize) -> String {
    let from = line[..start]
        .char_indices()
        .rev()
        .take(PREVIEW_BEFORE)
        .last()
        .map(|(i, _)| i)
        .unwrap_or(start);
    let to = line[end..]
        .char_indices()
        .take(PREVIEW_AFTER)
        .last()
        .map(|(i, c)| end + i + c.len_utf8())
        .unwrap_or(end);

    let mut preview = String::new();
    if from > 0 {
        preview.push('…');
    }
    preview.push_str(line[from..to].trim_end());
    if to < line.len() {
        preview.push('…');
    }
    preview
}

struct Needle {
    text: String,
    case_sensitive: bool,
    whole_word: bool,
}

impl Needle {
    /// Hit positions within the line, as (byte start, byte end).
    fn find_in(&self, line: &str, out: &mut Vec<(usize, usize)>, limit: usize) {
        let haystack = if self.case_sensitive {
            line.to_owned()
        } else {
            line.to_lowercase()
        };

        // Lowercasing can change the length (e.g. "İ"), so we search the
        // lowered copy only when the lengths match; otherwise we fall back to an
        // exact comparison, because shifted indices would give a wrong excerpt.
        if haystack.len() != line.len() && !self.case_sensitive {
            return self.find_exact(line, out, limit);
        }

        let mut from = 0;
        while out.len() < limit {
            let Some(offset) = haystack[from..].find(&self.text) else {
                break;
            };
            let start = from + offset;
            let end = start + self.text.len();
            if !self.whole_word || word_bounded(line, start, end) {
                out.push((start, end));
            }
            from = end.max(start + 1);
        }
    }

    fn find_exact(&self, line: &str, out: &mut Vec<(usize, usize)>, limit: usize) {
        let mut from = 0;
        while out.len() < limit {
            let Some(offset) = line[from..].find(&self.text) else {
                break;
            };
            let start = from + offset;
            let end = start + self.text.len();
            if !self.whole_word || word_bounded(line, start, end) {
                out.push((start, end));
            }
            from = end.max(start + 1);
        }
    }
}

impl Workspace {
    /// Searches every workspace root.
    pub fn search(&self, query: &SearchQuery) -> Result<SearchOutcome, VfsError> {
        let mut outcome = SearchOutcome {
            hits: Vec::new(),
            scanned: 0,
            truncated: false,
            documents: Vec::new(),
        };

        if query.query.is_empty() {
            return Ok(outcome);
        }
        if self.roots().is_empty() {
            return Err(VfsError::NoWorkspace);
        }

        let needle = Needle {
            text: if query.case_sensitive {
                query.query.clone()
            } else {
                query.query.to_lowercase()
            },
            case_sensitive: query.case_sensitive,
            whole_word: query.whole_word,
        };

        let readers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
            .min(MAX_READERS);
        let block = readers * PER_READER;

        let shut = self.protected();
        for root in self.roots() {
            /* A root opened on a shut folder is passed over, not an error: the
            rest of the workspace is still there to search. */
            if is_shut(root, shut) {
                continue;
            }
            // The root was already checked when added, but `resolve` is the only
            // place allowed to confirm a path is inside the sandbox.
            let start = self.resolve(root)?;

            /*
             * Walked in blocks, and each block read on several threads at once.
             * Two properties had to survive that, and they are the reason the
             * block exists at all rather than a thread per file:
             *
             * - **the order.** Results are reported in the order the tree is
             *   walked, and that order is what makes two runs of one search
             *   agree. The walk still produces paths depth-first in sorted
             *   order, a block is a slice of that sequence, and the findings are
             *   merged in the order the paths were in. Which thread finished
             *   first changes nothing.
             * - **stopping early.** A search for a common word used to stop as
             *   soon as it had its five hundred hits, and walking the whole tree
             *   before reading anything would have thrown that away. So the walk
             *   pauses at every block boundary for the reading to catch up, and
             *   either side can end it.
             */
            each_block(&start, block, shut, |paths| {
                let findings = scan_block(paths, &needle, query, readers, &start);

                for finding in findings {
                    if finding.scanned {
                        outcome.scanned += 1;
                    }
                    if let Some(document) = finding.document {
                        if outcome.documents.len() < query.limit {
                            outcome.documents.push(document);
                        }
                    }
                    for hit in finding.hits {
                        if outcome.hits.len() >= query.limit {
                            outcome.truncated = true;
                            return false;
                        }
                        outcome.hits.push(hit);
                    }
                }
                true
            });

            if outcome.truncated {
                break;
            }
        }

        Ok(outcome)
    }

    /// A list of every file in the workspace — for quick open by name.
    pub fn list_files(&self, limit: usize) -> Result<Vec<Stat>, VfsError> {
        let mut out = Vec::new();
        let shut = self.protected();
        for root in self.roots() {
            if is_shut(root, shut) {
                continue;
            }
            let start = self.resolve(root)?;
            collect(&start, limit, &mut out, &start, shut);
        }
        Ok(out)
    }
}

/* ── one file, and a block of them ───────────────────────────────────── */

/// What one file contributed.
///
/// A value rather than a mutation, and that is the change that made the reading
/// parallel: a function of a path and a needle can run on any thread, while one
/// that pushed into the outcome could only ever run on the thread that owned it.
#[derive(Debug, Default)]
struct Finding {
    /// Whether the file was read as text at all — the "searched N files" count.
    scanned: bool,
    hits: Vec<SearchHit>,
    /// A document whose text is inside a container, for the readers to search.
    document: Option<DocumentCandidate>,
}

/// Walks depth-first in sorted order, handing out blocks of files.
///
/// The order is the one a person sees in the tree, and the one two runs of the
/// same search have to agree on. `read_dir` promises no order at all, so every
/// directory is sorted; the stack holds files and directories together so that a
/// directory is descended exactly where it appears, which is what the recursive
/// version did.
///
/// `sink` returns `false` to stop — the search has what it asked for, and the
/// rest of the tree is nobody's business.
/// Whether a path is in a folder `Workspace::protect` shut. The walk checks
/// it itself because it reads names and files without asking `resolve` for
/// each one; the program's own folders would otherwise be searched whenever a
/// folder above them was open.
fn is_shut(path: &Path, shut: &[PathBuf]) -> bool {
    shut.iter().any(|dir| path.starts_with(dir))
}

fn each_block(
    start: &Path,
    block: usize,
    shut: &[PathBuf],
    mut sink: impl FnMut(&[PathBuf]) -> bool,
) {
    enum Item {
        File(PathBuf),
        Dir(PathBuf),
    }

    let mut stack = vec![Item::Dir(start.to_path_buf())];
    let mut pending: Vec<PathBuf> = Vec::with_capacity(block);

    while let Some(item) = stack.pop() {
        match item {
            Item::File(path) => {
                pending.push(path);
                if pending.len() >= block {
                    if !sink(&pending) {
                        return;
                    }
                    pending.clear();
                }
            }
            Item::Dir(dir) => {
                /* Pushed in reverse, because a stack hands back what went on
                last: that is what turns "sorted" into "walked in order". */
                for (path, is_dir) in entries_of(&dir).into_iter().rev() {
                    if is_shut(&path, shut) {
                        continue;
                    }
                    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned())
                    else {
                        continue;
                    };
                    if is_dir {
                        if !crate::vfs::is_noise(&name) {
                            stack.push(Item::Dir(path));
                        }
                    } else {
                        stack.push(Item::File(path));
                    }
                }
            }
        }
    }

    if !pending.is_empty() {
        sink(&pending);
    }
}

/// What is in a folder, sorted, each with whether it is a folder — **links
/// left out**.
///
/// The type is the entry's own, which a link does not pass on: a junction or a
/// symbolic link is reported as a link rather than as what it points at, and is
/// skipped whatever it points at. That costs a link that stays inside the
/// folder, which is the price of never having to work out where one goes.
fn entries_of(dir: &Path) -> Vec<(PathBuf, bool)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(PathBuf, bool)> = entries
        .flatten()
        .filter_map(|entry| {
            let kind = entry.file_type().ok()?;
            /* Folders and files, and nothing else: a FIFO on Linux or macOS
            is neither, and reading one waits for somebody to write into it —
            for ever, in a folder that came with one. */
            if kind.is_dir() {
                Some((entry.path(), true))
            } else if kind.is_file() {
                Some((entry.path(), false))
            } else {
                None
            }
        })
        .collect();
    found.sort();
    found
}

/// Reads one block of files, on as many threads as it is worth.
///
/// The findings come back in the order the paths were in, whichever thread
/// produced them: the slices are joined in order rather than as they finish.
fn scan_block(
    paths: &[PathBuf],
    needle: &Needle,
    query: &SearchQuery,
    readers: usize,
    root: &Path,
) -> Vec<Finding> {
    if readers <= 1 || paths.len() < 2 {
        return paths
            .iter()
            .map(|path| scan_one(path, needle, query, root))
            .collect();
    }

    let per = paths.len().div_ceil(readers);
    let mut findings = Vec::with_capacity(paths.len());

    std::thread::scope(|scope| {
        let handles: Vec<_> = paths
            .chunks(per)
            .map(|slice| {
                scope.spawn(move || {
                    slice
                        .iter()
                        .map(|path| scan_one(path, needle, query, root))
                        .collect::<Vec<_>>()
                })
            })
            .collect();

        for handle in handles {
            /* A panic in here is a bug in the text scanning rather than a
            condition to absorb: swallowing it would drop a slice of the
            workspace out of the results with nothing said anywhere, which is
            the failure this project likes least. */
            findings.extend(handle.join().expect("a file scan panicked"));
        }
    });

    findings
}

/// One file: read it, and find what is in it.
fn scan_one(path: &Path, needle: &Needle, query: &SearchQuery, root: &Path) -> Finding {
    let mut finding = Finding::default();

    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return finding;
    };
    /* The walk has left links out already. Asked again of the file itself,
    which does not follow a link either, for a file swapped for one since; a
    folder above it swapped for one is answered by where the opened file
    really is — see `read_regular`. */
    let Some(seen) = look_at(path) else {
        return finding;
    };
    if !seen.meta.is_file() || seen.meta.len() > MAX_FILE_BYTES {
        return finding;
    }

    let format = detect_by_name(&name).format;
    if FormatId::text_is_inside_a_container(format) {
        /* Offered only if it is inside the root, as a file read is: a folder
        swapped for a link on the way gave away the names of what was
        outside. */
        if opened_inside(path, &seen, root).is_none() {
            return finding;
        }
        /* Not read here at all: the text of a `.docx` is inside a ZIP, and the
        reader that understands it lives in the frontend. What goes back is
        the offer — the shell asks whether to search them too, which is the
        difference between this and a grep. The cap is applied by the caller,
        which is the only place that knows how many there already are. */
        finding.document = Some(DocumentCandidate {
            uri: display(path),
            name: name.clone(),
            format: format.as_str().to_owned(),
        });
        return finding;
    }

    let Some(bytes) = read_regular(path, &seen, root) else {
        return finding;
    };
    // Read: the file held for the look is let go before its text is searched.
    #[cfg(windows)]
    drop(seen);
    if !looks_textual(&bytes) {
        return finding;
    }
    let Ok(text) = String::from_utf8(bytes) else {
        return finding;
    };

    finding.scanned = true;

    let uri = display(path);
    let mut in_file = 0usize;
    let mut positions = Vec::new();

    for (index, line) in text.lines().enumerate() {
        if in_file >= query.per_file {
            break;
        }

        positions.clear();
        needle.find_in(line, &mut positions, query.per_file - in_file);

        for &(start, end) in &positions {
            finding.hits.push(SearchHit {
                uri: uri.clone(),
                name: name.clone(),
                line: index as u32 + 1,
                column: line[..start].chars().count() as u32 + 1,
                preview: preview_of(line, start, end),
            });
            in_file += 1;
        }
    }

    finding
}

/// Reads a file the walk saw as a regular file, if it is still that file and
/// still inside the root.
///
/// Between the look and the read the file can be swapped for a link out of the
/// folder, a folder above it for a junction, or the file can grow past the
/// limit. So it is opened once; the open file is asked whether it is the one
/// that was looked at and where it really is — a folder swapped on the way
/// puts it outside the root — and no more than the limit is read whatever its
/// size has become.
fn read_regular(path: &Path, seen: &Look, root: &Path) -> Option<Vec<u8>> {
    use std::io::Read;

    let file = opened_inside(path, seen, root)?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= MAX_FILE_BYTES).then_some(bytes)
}

/// The file at `path`, opened, if it is the regular file the walk saw and is
/// inside the root. Opened as `Workspace::read` opens one — on Unix without
/// waiting, so a file swapped for a FIFO since the walk is refused rather than
/// waited on for ever.
fn opened_inside(path: &Path, seen: &Look, root: &Path) -> Option<fs::File> {
    let file = crate::vfs::open_regular(path).ok()?;
    if !same_file(seen, &file) {
        return None;
    }
    where_opened(&file, path)
        .is_some_and(|at| at.starts_with(root))
        .then_some(file)
}

/// Linux's and Android's answer to where an open file is, through `fds` —
/// `/proc/self/fd`, or another folder in a test.
///
/// A system with no such folder at all — a sandbox or a chroot without
/// `/proc` — is asked the path instead, as systems are that have no way to
/// ask the file: every file used to be skipped there, and the search said it
/// had found nothing. What is opened is still checked to be the file the walk
/// saw (`same_file`) before this is asked. A folder that is there and does
/// not answer for a file leaves that file out.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn where_opened_through(fds: &Path, fd: i32, path: &Path) -> Option<PathBuf> {
    if !fds.is_dir() {
        return fs::canonicalize(path).ok();
    }
    let at = fs::read_link(fds.join(fd.to_string())).ok()?;
    // A file taken away since it was opened is not one to report.
    (!at.to_string_lossy().ends_with(" (deleted)")).then_some(at)
}

/// Where an opened file really is, asked of the open file rather than of the
/// path: Windows by `GetFinalPathNameByHandleW`, Linux and Android through
/// `/proc/self/fd`, macOS by `fcntl(F_GETPATH)`. Elsewhere the path is asked,
/// which leaves the moment between the open and the question.
fn where_opened(file: &fs::File, path: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let _ = path;
        crate::vfs::windows::final_path(file).ok()
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::io::AsRawFd;
        where_opened_through(Path::new("/proc/self/fd"), file.as_raw_fd(), path)
    }
    #[cfg(target_vendor = "apple")]
    {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::io::AsRawFd;
        /// `F_GETPATH` and `PATH_MAX`, from the libc crate's tables (0.2.189).
        const F_GETPATH: i32 = 50;
        const PATH_MAX: usize = 1024;
        extern "C" {
            fn fcntl(fd: i32, cmd: i32, ...) -> i32;
        }
        let _ = path;
        let mut buffer = vec![0u8; PATH_MAX];
        // SAFETY: an open descriptor, and a buffer of PATH_MAX bytes as
        // F_GETPATH requires.
        if unsafe { fcntl(file.as_raw_fd(), F_GETPATH, buffer.as_mut_ptr()) } == -1 {
            return None;
        }
        let end = buffer.iter().position(|&b| b == 0)?;
        Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buffer[..end])))
    }
    #[cfg(not(any(
        windows,
        target_os = "linux",
        target_os = "android",
        target_vendor = "apple"
    )))]
    {
        let _ = file;
        fs::canonicalize(path).ok()
    }
}

/// A look at a file, which follows no link: what it is, and enough to tell
/// later whether a file opened is the one looked at.
///
/// On Unix the metadata carries that, as the device and the inode. On Windows
/// the standard library does not hand out the file's ID, so the file looked at
/// is held — with no right to what is in it — and asked for its ID when it is
/// compared; it is let go as soon as the file is read, since while it is held
/// the file cannot be replaced (`vfs::windows::open_unfollowed`). When it was
/// made used to stand in for the ID there, and WSL's 9P does not answer that
/// the same way twice: a file just written from Windows gave one time to a
/// look and another to the open file, and was left out of the search with
/// nothing said.
struct Look {
    meta: fs::Metadata,
    #[cfg(windows)]
    held: fs::File,
}

fn look_at(path: &Path) -> Option<Look> {
    #[cfg(windows)]
    {
        let held = crate::vfs::windows::open_unfollowed(path).ok()?;
        let meta = held.metadata().ok()?;
        Some(Look { meta, held })
    }
    #[cfg(not(windows))]
    {
        fs::symlink_metadata(path).ok().map(|meta| Look { meta })
    }
}

/// Whether the file opened is the one looked at.
///
/// Where the open file really is is asked as well (`where_opened`), and that
/// alone answers a link or a folder swapped in on the way. This answers what
/// it does not: a file swapped for a hard link to one outside the root, which
/// is opened under its name inside.
fn same_file(seen: &Look, opened: &fs::File) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        opened
            .metadata()
            .is_ok_and(|opened| (seen.meta.dev(), seen.meta.ino()) == (opened.dev(), opened.ino()))
    }
    #[cfg(windows)]
    {
        use crate::vfs::windows::identity;
        ids_agree(identity(&seen.held), identity(opened), || {
            made_alike(&seen.meta, opened)
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        made_alike(&seen.meta, opened)
    }
}

/// Whether two files' IDs say they are one file.
///
/// Like with like: an ID of one kind is never the same as one of another, and
/// an unknown one is never the same as a known one. Where neither has an ID
/// worth the name, `alike` is asked — when each was made and its size, as
/// before there were IDs: weaker, but not nothing. A file that could not be
/// asked is not the same file.
#[cfg(windows)]
fn ids_agree(
    seen: std::io::Result<crate::vfs::windows::Identity>,
    opened: std::io::Result<crate::vfs::windows::Identity>,
    alike: impl FnOnce() -> bool,
) -> bool {
    use crate::vfs::windows::Identity;
    match (seen, opened) {
        (Ok(Identity::Unknown), Ok(Identity::Unknown)) => alike(),
        (Ok(seen), Ok(opened)) => seen == opened,
        _ => false,
    }
}

/// Whether two looks saw a file made at the same moment and of the same size —
/// what stands in for which file it is where nothing better is told.
#[cfg(not(unix))]
fn made_alike(seen: &fs::Metadata, opened: &fs::File) -> bool {
    opened.metadata().is_ok_and(|opened| {
        seen.created().ok() == opened.created().ok() && seen.len() == opened.len()
    })
}

use crate::vfs::{stat_from, Stat};

/// What Ctrl+P is told of a file the walk found, asked of the file itself: a
/// file swapped for a link since the walk is not listed with the size and
/// time of what the link points at.
fn listed(path: &Path) -> Option<Stat> {
    fs::symlink_metadata(path)
        .ok()
        .filter(|meta| meta.is_file())
        .map(|meta| stat_from(path, &meta))
}

fn collect(dir: &Path, limit: usize, out: &mut Vec<Stat>, root: &Path, shut: &[PathBuf]) {
    if out.len() >= limit {
        return;
    }
    /* A folder swapped for a link since its parent was read is not listed:
    its names and sizes are somebody else's. Asked of the path, which narrows
    the moment rather than closing it — closing it takes reading a folder
    through a handle of it, which the standard library does not offer. */
    if !fs::canonicalize(dir).is_ok_and(|real| real.starts_with(root)) {
        return;
    }
    for (path, is_dir) in entries_of(dir) {
        if out.len() >= limit {
            return;
        }
        if is_shut(&path, shut) {
            continue;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if is_dir {
            if !crate::vfs::is_noise(&name) {
                collect(&path, limit, out, root, shut);
            }
        } else if let Some(stat) = listed(&path) {
            out.push(stat);
        }
    }
}

/* ── tests ───────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Links;
    use std::env;

    fn temp_root(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("ul-search-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    /// Enough files, deep enough, that the reading is genuinely spread across
    /// threads — a block is thirty-two files per reader, so a couple of hundred
    /// crosses several blocks on any machine.
    fn many_files(root: &Path, count: usize) -> Vec<String> {
        let mut written = Vec::new();
        for i in 0..count {
            let rel = format!("d{:02}/f{:03}.txt", i % 7, i);
            write(
                root,
                &rel,
                "needle here
",
            );
            written.push(rel);
        }
        written.sort();
        written
    }

    #[test]
    fn reading_in_parallel_does_not_reorder_the_results() {
        /* The order is the one the tree is walked in, and it has to be the same
        whichever thread finished first — it is what makes two runs of one
        search agree, and what keeps a result list still while somebody reads
        it.

        For this fixture, depth-first in sorted order is the same as sorted
        by path, so "in order" can be asked of the answer directly rather
        than by rebuilding the expected list with the platform's separator. */
        let root = temp_root("order");
        let expected = many_files(&root, 200);

        let mut ws = Workspace::new();
        ws.add_root(&root).unwrap();

        let out = ws.search(&query("needle")).unwrap();
        assert_eq!(out.hits.len(), expected.len());

        let uris: Vec<&str> = out.hits.iter().map(|hit| hit.uri.as_str()).collect();
        let mut sorted = uris.clone();
        sorted.sort_unstable();
        assert_eq!(uris, sorted, "walked out of order");
    }

    #[test]
    fn the_same_search_twice_gives_the_same_answer() {
        let root = temp_root("stable");
        many_files(&root, 200);

        let mut ws = Workspace::new();
        ws.add_root(&root).unwrap();

        let first = ws.search(&query("needle")).unwrap();
        let second = ws.search(&query("needle")).unwrap();

        let uris = |out: &SearchOutcome| out.hits.iter().map(|h| h.uri.clone()).collect::<Vec<_>>();
        assert_eq!(uris(&first), uris(&second));
        assert_eq!(first.scanned, second.scanned);
    }

    #[test]
    fn it_still_stops_as_soon_as_it_has_enough() {
        /* The whole reason the walk hands out blocks instead of a file list:
        walking two hundred files before reading any of them would have
        thrown away the early exit a common word depends on. The limit here
        is smaller than one block, so the walk must stop inside the first. */
        let root = temp_root("enough");
        many_files(&root, 200);

        let mut ws = Workspace::new();
        ws.add_root(&root).unwrap();

        let mut wanted = query("needle");
        wanted.limit = 10;

        let out = ws.search(&wanted).unwrap();
        assert!(out.truncated, "should have said it stopped early");
        assert_eq!(out.hits.len(), 10);
        /* And it did not read the whole tree to find them: one block is at
        most eight readers of thirty-two files. */
        assert!(
            out.scanned <= MAX_READERS * PER_READER,
            "read {} files",
            out.scanned
        );
    }

    #[test]
    fn a_deep_tree_is_walked_in_the_order_a_person_sees_it() {
        /* A directory is descended where it appears, not after every file in
        its parent — the stack in `each_block` exists to reproduce exactly
        the order the recursive walk had. */
        let root = temp_root("deep");
        write(
            &root, "a.txt", "needle
",
        );
        write(
            &root,
            "b/inner.txt",
            "needle
",
        );
        write(
            &root, "c.txt", "needle
",
        );

        let mut ws = Workspace::new();
        ws.add_root(&root).unwrap();

        let names: Vec<String> = ws
            .search(&query("needle"))
            .unwrap()
            .hits
            .iter()
            .map(|hit| hit.name.clone())
            .collect();
        assert_eq!(names, vec!["a.txt", "inner.txt", "c.txt"]);
    }

    fn query(text: &str) -> SearchQuery {
        SearchQuery {
            query: text.to_owned(),
            case_sensitive: false,
            whole_word: false,
            limit: 500,
            per_file: 20,
        }
    }

    #[test]
    fn finds_matches_with_line_and_column() {
        let root = temp_root("basic");
        write(&root, "a.ts", "const x = 1;\nconst needle = 2;\n");

        let mut ws = Workspace::new();
        ws.add_root(&root).unwrap();

        let out = ws.search(&query("needle")).unwrap();
        assert_eq!(out.hits.len(), 1);
        assert_eq!(out.hits[0].line, 2);
        assert_eq!(out.hits[0].column, 7);
        assert!(out.hits[0].preview.contains("needle"));
    }

    #[test]
    fn skips_noise_directories() {
        let root = temp_root("noise");
        write(&root, "src/a.ts", "needle\n");
        write(&root, "node_modules/pkg/b.ts", "needle\n");
        write(&root, "target/c.ts", "needle\n");
        /* The Python half of the list, and the reason it is there: a portable
        ComfyUI in somebody's Documents put ninety-one thousand files under
        `site-packages` and eighteen thousand under `__pycache__`, and a
        search over that folder took seventeen seconds. */
        write(&root, "site-packages/pkg/d.py", "needle\n");
        write(&root, "__pycache__/e.pyc", "needle\n");
        write(&root, "venv/lib/f.py", "needle\n");
        write(&root, ".mypy_cache/g.json", "needle\n");

        let mut ws = Workspace::new();
        ws.add_root(&root).unwrap();

        let out = ws.search(&query("needle")).unwrap();
        assert_eq!(out.hits.len(), 1, "src/a.ts only");
        assert!(out.hits[0].uri.contains("src"));
    }

    #[test]
    fn binary_files_are_left_alone() {
        let root = temp_root("binary");
        fs::write(root.join("blob.bin"), [0x00, 0x01, b'n', b'e', 0x00]).unwrap();

        let mut ws = Workspace::new();
        ws.add_root(&root).unwrap();

        assert_eq!(ws.search(&query("ne")).unwrap().hits.len(), 0);
    }

    #[test]
    fn documents_are_reported_not_scanned() {
        // This is the difference from grep: a PDF is not skipped but reported,
        // so the shell can search it with its own parser.
        let root = temp_root("docs");
        write(&root, "ugovor.pdf", "%PDF-1.4 needle");
        write(&root, "biljeske.md", "needle\n");

        let mut ws = Workspace::new();
        ws.add_root(&root).unwrap();

        let out = ws.search(&query("needle")).unwrap();
        assert_eq!(out.hits.len(), 1, "only Markdown was scanned");
        assert_eq!(out.documents.len(), 1);
        assert_eq!(out.documents[0].format, "pdf");
    }

    #[test]
    fn case_and_word_boundaries() {
        let root = temp_root("case");
        write(&root, "a.txt", "Needle needles NEEDLE\n");

        let mut ws = Workspace::new();
        ws.add_root(&root).unwrap();

        assert_eq!(ws.search(&query("needle")).unwrap().hits.len(), 3);

        let mut sensitive = query("needle");
        sensitive.case_sensitive = true;
        assert_eq!(
            ws.search(&sensitive).unwrap().hits.len(),
            1,
            "'needles' only"
        );

        let mut whole = query("needle");
        whole.whole_word = true;
        assert_eq!(ws.search(&whole).unwrap().hits.len(), 2, "'needles' otpada");
    }

    #[test]
    fn limits_are_respected() {
        let root = temp_root("limits");
        let body = "needle\n".repeat(50);
        write(&root, "a.txt", &body);
        write(&root, "b.txt", &body);

        let mut ws = Workspace::new();
        ws.add_root(&root).unwrap();

        let mut limited = query("needle");
        limited.per_file = 5;
        limited.limit = 8;

        let out = ws.search(&limited).unwrap();
        assert_eq!(out.hits.len(), 8);
        assert!(out.truncated, "the truncation has to be reported");
    }

    #[test]
    fn search_without_workspace_is_refused() {
        let ws = Workspace::new();
        assert!(matches!(ws.search(&query("x")), Err(VfsError::NoWorkspace)));
    }

    #[test]
    fn lists_files_for_quick_open() {
        let root = temp_root("list");
        write(&root, "src/a.ts", "");
        write(&root, "src/deep/b.ts", "");
        write(&root, "node_modules/c.ts", "");

        let mut ws = Workspace::new();
        ws.add_root(&root).unwrap();

        let files = ws.list_files(1000).unwrap();
        let names: Vec<_> = files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"a.ts") && names.contains(&"b.ts"));
        assert!(!names.contains(&"c.ts"), "noise is skipped here too");
    }

    #[test]
    fn a_link_out_of_the_folder_is_neither_searched_nor_listed() {
        let mut links = Links::default();
        let outside = temp_root("outside");
        write(&outside, "secret.txt", "password = MARKER-OUTSIDE\n");
        let root = temp_root("linked");
        write(
            &root,
            "inside.txt",
            "MARKER-OUTSIDE is named here and only here\n",
        );
        links.folder(&root.join("docs"), &outside);
        #[cfg(unix)]
        links.file(&root.join("secret-link.txt"), &outside.join("secret.txt"));

        let mut ws = Workspace::new();
        ws.add_root(&root).unwrap();

        let found = ws.search(&query("MARKER-OUTSIDE")).unwrap();
        let names: Vec<&str> = found.hits.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["inside.txt"], "found through a link");

        let listed = ws.list_files(1000).unwrap();
        let names: Vec<&str> = listed.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["inside.txt"], "listed through a link");
    }

    #[test]
    fn links_back_to_the_folder_do_not_make_a_walk_that_never_ends() {
        /* Followed, one link back to the root is the tree again under every
        folder, and two of them double it at every level: it was still
        walking after twenty-five seconds. */
        let mut links = Links::default();
        let root = temp_root("loop");
        write(&root, "only.txt", "nothing to find\n");
        links.folder(&root.join("a"), &root);
        links.folder(&root.join("b"), &root);

        let mut ws = Workspace::new();
        ws.add_root(&root).unwrap();

        let (done, outcome) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let scanned = ws.search(&query("absent")).map(|out| out.scanned);
            let listed = ws.list_files(10_000).map(|files| files.len());
            let _ = done.send((scanned, listed));
        });
        let (scanned, listed) = outcome
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the walk did not end");
        assert_eq!(scanned.unwrap(), 1);
        assert_eq!(listed.unwrap(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_in_the_folder_does_not_stop_the_search() {
        /* Read, a FIFO waits for somebody to write into it. It is neither a
        file nor a folder, and the walk leaves it out. */
        let root = temp_root("fifo");
        write(&root, "only.txt", "nothing to find\n");
        let made = std::process::Command::new("mkfifo")
            .arg(root.join("pipe.txt"))
            .status()
            .unwrap();
        assert!(made.success());

        let mut ws = Workspace::new();
        ws.add_root(&root).unwrap();

        let (done, outcome) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let scanned = ws.search(&query("absent")).map(|out| out.scanned);
            let listed = ws.list_files(100).map(|files| files.len());
            let _ = done.send((scanned, listed));
        });
        let (scanned, listed) = outcome
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the search waited on the FIFO");
        assert_eq!(scanned.unwrap(), 1);
        assert_eq!(listed.unwrap(), 1);
    }

    #[test]
    fn a_file_reached_through_a_folder_swapped_for_a_link_is_not_read() {
        /* The state the race leaves: the walk saw `sub` as a folder, and by
        the time a file in it is read, `sub` is a link out of the root. */
        let mut links = Links::default();
        let outside = temp_root("swapped-outside");
        write(&outside, "secret.txt", "lozinka=tajna\n");
        let root = fs::canonicalize(temp_root("swapped-root")).unwrap();
        write(&root, "here.txt", "lozinka=ovdje\n");
        links.folder(&root.join("sub"), &outside);

        let through = root.join("sub").join("secret.txt");
        let seen = look_at(&through).unwrap();
        assert!(
            read_regular(&through, &seen, &root).is_none(),
            "read from outside the root"
        );

        let inside = root.join("here.txt");
        let seen = look_at(&inside).unwrap();
        assert_eq!(
            read_regular(&inside, &seen, &root).as_deref(),
            Some(&b"lozinka=ovdje\n"[..])
        );
    }

    /// The decision itself, on the pairs no volume here can produce: a ReFS
    /// whose IDs are unknown, and two file systems answering differently.
    #[cfg(windows)]
    #[test]
    fn ids_decide_like_with_like_and_ask_the_times_only_when_neither_knows() {
        use crate::vfs::windows::Identity::{Long, Short, Unknown};
        let io = || Err(std::io::Error::other("could not be asked"));
        let never = || -> bool { panic!("asked the times with an ID to go by") };

        assert!(ids_agree(Ok(Unknown), Ok(Unknown), || true));
        assert!(!ids_agree(Ok(Unknown), Ok(Unknown), || false));
        assert!(!ids_agree(Ok(Unknown), Ok(Long(1, [7; 16])), never));
        assert!(!ids_agree(Ok(Long(1, [7; 16])), Ok(Unknown), never));
        assert!(!ids_agree(Ok(Long(1, [7; 16])), Ok(Short(1, 7)), never));
        assert!(ids_agree(Ok(Long(1, [7; 16])), Ok(Long(1, [7; 16])), never));
        assert!(!ids_agree(
            Ok(Long(1, [7; 16])),
            Ok(Long(1, [8; 16])),
            never
        ));
        assert!(!ids_agree(
            Ok(Long(1, [7; 16])),
            Ok(Long(2, [7; 16])),
            never
        ));
        assert!(ids_agree(Ok(Short(0, 41926)), Ok(Short(0, 41926)), never));
        assert!(!ids_agree(io(), Ok(Unknown), never));
        assert!(!ids_agree(Ok(Unknown), io(), never));
    }

    #[test]
    fn a_shut_folder_is_neither_searched_nor_listed() {
        /* The program's own folder under a folder that is open: its file is
        not searched, its names are not listed, and a root opened on it is
        passed over without failing the rest. */
        let base = fs::canonicalize(temp_root("shut")).unwrap();
        write(&base, "open.txt", "the needle is here\n");
        write(
            &base,
            "org.uleditor.app/trusted-projects.json",
            "the needle is here too\n",
        );

        let mut ws = Workspace::new();
        ws.protect(base.join("org.uleditor.app"));
        ws.add_root(&base).unwrap();
        let _ = ws.add_root(base.join("org.uleditor.app"));

        let found = ws.search(&query("needle")).unwrap();
        let files: Vec<&str> = found.hits.iter().map(|hit| hit.name.as_str()).collect();
        assert_eq!(files, ["open.txt"]);

        let listed = ws.list_files(100).unwrap();
        let names: Vec<&str> = listed.iter().map(|stat| stat.name.as_str()).collect();
        assert_eq!(names, ["open.txt"]);
    }

    #[test]
    fn a_file_swapped_for_a_hard_link_since_the_look_is_not_read() {
        /* The walk looked at `here.txt`; before it is read, it is a hard link
        to a file outside the root. Opened, it is still under its name inside,
        so only which file it is gives it away. Same length, so that the size
        does not. */
        let outside = temp_root("relinked-outside");
        write(&outside, "secret.txt", "lozinka=tajna\n");
        let root = fs::canonicalize(temp_root("relinked-root")).unwrap();
        write(&root, "here.txt", "lozinka=ovdje\n");

        let here = root.join("here.txt");
        let seen = look_at(&here).unwrap();
        fs::remove_file(&here).unwrap();
        fs::hard_link(outside.join("secret.txt"), &here).unwrap();
        assert!(
            read_regular(&here, &seen, &root).is_none(),
            "read the file swapped in"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_file_swapped_for_a_fifo_since_the_look_is_not_waited_on() {
        /* The walk leaves FIFOs out; this is one put in a file's place after
        the walk looked. Opened as an ordinary file is, it would wait for a
        writer for ever. */
        let root = fs::canonicalize(temp_root("fifo-swap")).unwrap();
        write(&root, "pipe.txt", "nothing to find\n");
        let pipe = root.join("pipe.txt");
        let seen = look_at(&pipe).unwrap();
        fs::remove_file(&pipe).unwrap();
        let made = std::process::Command::new("mkfifo")
            .arg(&pipe)
            .status()
            .unwrap();
        assert!(made.success());

        let (done, outcome) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(read_regular(&pipe, &seen, &root).is_none());
        });
        let refused = outcome
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the read waited on the FIFO");
        assert!(refused);
    }

    /// Without `/proc`, a file is placed by its path rather than left out —
    /// and with it, by the open file, as before.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn without_proc_a_file_is_placed_by_its_path() {
        use std::os::unix::io::AsRawFd;

        let root = fs::canonicalize(temp_root("no-proc")).unwrap();
        write(&root, "here.txt", "x");
        let file = root.join("here.txt");
        let open = fs::File::open(&file).unwrap();

        let nowhere = root.join("no-proc-here");
        assert_eq!(
            where_opened_through(&nowhere, open.as_raw_fd(), &file),
            Some(file.clone())
        );
        assert_eq!(
            where_opened_through(Path::new("/proc/self/fd"), open.as_raw_fd(), &file),
            Some(file)
        );
    }

    #[test]
    fn ctrl_p_tells_nothing_of_what_a_file_swapped_for_a_link_points_at() {
        /* The walk leaves links out; this is one put in a file's place after
        it, and its target is not described under the name inside. */
        let mut links = Links::default();
        let outside = temp_root("listed-outside");
        write(&outside, "secret.txt", "a size worth hiding\n");
        let root = fs::canonicalize(temp_root("listed-root")).unwrap();
        write(&root, "here.txt", "x");
        if !links.file(&root.join("there.txt"), &outside.join("secret.txt")) {
            eprintln!("skipped: this account cannot make a link to a file");
            return;
        }

        assert!(listed(&root.join("there.txt")).is_none());
        assert_eq!(
            listed(&root.join("here.txt")).map(|stat| stat.size),
            Some(1)
        );
    }

    #[test]
    fn names_from_a_folder_swapped_for_a_link_are_not_given_away() {
        /* The state the race leaves, as above: `sub` was a folder when the
        walk saw it and is a link out of the root by the time it is used. A
        document there is not offered for the readers, and Ctrl+P does not list
        what is in it. */
        let mut links = Links::default();
        let outside = temp_root("names-outside");
        write(&outside, "secret-plan.docx", "not a real docx");
        write(&outside, "secret.txt", "x");
        let root = fs::canonicalize(temp_root("names-root")).unwrap();
        links.folder(&root.join("sub"), &outside);

        let document = root.join("sub").join("secret-plan.docx");
        let needle = Needle {
            text: "x".into(),
            case_sensitive: false,
            whole_word: false,
        };
        let finding = scan_one(&document, &needle, &query("x"), &root);
        assert!(finding.document.is_none(), "offered from outside the root");

        let mut listed = Vec::new();
        collect(&root.join("sub"), 100, &mut listed, &root, &[]);
        let names: Vec<&str> = listed.iter().map(|s| s.name.as_str()).collect();
        assert!(names.is_empty(), "listed from outside the root: {names:?}");
    }
}
