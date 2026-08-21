//! ulEditor core — virtual file system and search.
//!
//! Everything the UI does with the disk passes through here. Two consequences
//! that pay off: the same logic compiles for desktop and mobile, and file
//! access lives in one place — which makes it auditable.

#![deny(clippy::all)]

pub mod library;
pub mod search;
pub mod vfs;

pub use library::{default_roots, LibraryEntry, LibraryScan};
pub use search::{DocumentCandidate, SearchHit, SearchOutcome, SearchQuery};
pub use ul_formats::{detect, detect_by_name, Detection, FormatId, PROBE_LEN};
pub use vfs::{DirEntry, Stat, VfsError, Workspace};
