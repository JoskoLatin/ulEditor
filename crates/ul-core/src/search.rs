//! Search across the whole workspace.
//!
//! **Why scanning, not an index.** The plan called for `tantivy`. An index pays
//! off when the corpus is large and queries frequent, but it brings a problem
//! with no halfway solution: invalidation. A file edited outside the program, a
//! `git checkout` that touches a thousand files, a folder added and then
//! removed — every one of those has to update the index by agreement, or search
//! quietly lies. Scanning cannot go stale because it holds no state at all.
//!
//! For a workspace of a few thousand files the answer arrives in tenths of a
//! second. An index becomes justified only once that stops being true, and by
//! then it will have a clearly defined job instead of being the first
//! assumption.
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

/// Formats this module cannot read itself, but the shell can.
fn is_document(format: FormatId) -> bool {
    matches!(
        format,
        FormatId::Pdf | FormatId::Epub | FormatId::Docx | FormatId::Xlsx | FormatId::Odf
    )
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

        for root in self.roots() {
            // The root was already checked when added, but `resolve` is the only
            // place allowed to confirm a path is inside the sandbox.
            let start = self.resolve(root)?;
            self.walk(&start, &needle, query, &mut outcome);
            if outcome.truncated {
                break;
            }
        }

        Ok(outcome)
    }

    fn walk(&self, dir: &Path, needle: &Needle, query: &SearchQuery, outcome: &mut SearchOutcome) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };

        // Sorted so results are stable between runs; `read_dir` guarantees no order.
        let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        paths.sort();

        for path in paths {
            if outcome.truncated {
                return;
            }

            let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };

            if path.is_dir() {
                if crate::vfs::is_noise(&name) {
                    continue;
                }
                self.walk(&path, needle, query, outcome);
                continue;
            }

            self.scan_file(&path, &name, needle, query, outcome);
        }
    }

    fn scan_file(
        &self,
        path: &Path,
        name: &str,
        needle: &Needle,
        query: &SearchQuery,
        outcome: &mut SearchOutcome,
    ) {
        let Ok(meta) = fs::metadata(path) else {
            return;
        };
        if meta.len() > MAX_FILE_BYTES {
            return;
        }

        let format = detect_by_name(name).format;
        if is_document(format) {
            if outcome.documents.len() < query.limit {
                outcome.documents.push(DocumentCandidate {
                    uri: display(path),
                    name: name.to_owned(),
                    format: format.as_str().to_owned(),
                });
            }
            return;
        }

        let Ok(bytes) = fs::read(path) else {
            return;
        };
        if !looks_textual(&bytes) {
            return;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            return;
        };

        outcome.scanned += 1;

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
                if outcome.hits.len() >= query.limit {
                    outcome.truncated = true;
                    return;
                }
                outcome.hits.push(SearchHit {
                    uri: uri.clone(),
                    name: name.to_owned(),
                    line: index as u32 + 1,
                    column: line[..start].chars().count() as u32 + 1,
                    preview: preview_of(line, start, end),
                });
                in_file += 1;
            }
        }
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
