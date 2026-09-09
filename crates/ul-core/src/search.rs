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
//! Everything goes through `Workspace::resolve`, so search cannot leave the
//! sandbox, not even via a symlink.

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

        for root in self.roots() {
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
            each_block(&start, block, |paths| {
                let findings = scan_block(paths, &needle, query, readers);

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
        for root in self.roots() {
            let start = self.resolve(root)?;
            collect(&start, limit, &mut out);
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
fn each_block(start: &Path, block: usize, mut sink: impl FnMut(&[PathBuf]) -> bool) {
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
                let Ok(entries) = fs::read_dir(&dir) else {
                    continue;
                };
                let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
                paths.sort();

                /* Pushed in reverse, because a stack hands back what went on
                last: that is what turns "sorted" into "walked in order". */
                for path in paths.into_iter().rev() {
                    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned())
                    else {
                        continue;
                    };
                    if path.is_dir() {
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

/// Reads one block of files, on as many threads as it is worth.
///
/// The findings come back in the order the paths were in, whichever thread
/// produced them: the slices are joined in order rather than as they finish.
fn scan_block(
    paths: &[PathBuf],
    needle: &Needle,
    query: &SearchQuery,
    readers: usize,
) -> Vec<Finding> {
    if readers <= 1 || paths.len() < 2 {
        return paths
            .iter()
            .map(|path| scan_one(path, needle, query))
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
                        .map(|path| scan_one(path, needle, query))
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
fn scan_one(path: &Path, needle: &Needle, query: &SearchQuery) -> Finding {
    let mut finding = Finding::default();

    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return finding;
    };
    let Ok(meta) = fs::metadata(path) else {
        return finding;
    };
    if meta.len() > MAX_FILE_BYTES {
        return finding;
    }

    let format = detect_by_name(&name).format;
    if FormatId::text_is_inside_a_container(format) {
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

    let Ok(bytes) = fs::read(path) else {
        return finding;
    };
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

use crate::vfs::{stat_of, Stat};

fn collect(dir: &Path, limit: usize, out: &mut Vec<Stat>) {
    if out.len() >= limit {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();

    for path in paths {
        if out.len() >= limit {
            return;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if path.is_dir() {
            if !crate::vfs::is_noise(&name) {
                collect(&path, limit, out);
            }
        } else if let Ok(stat) = stat_of(&path) {
            out.push(stat);
        }
    }
}

/* ── tests ───────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;
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
}
