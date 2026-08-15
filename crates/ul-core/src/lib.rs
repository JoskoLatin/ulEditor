//! Jezgra ulEditora — virtualni datotečni sustav.
//!
//! Sve što UI radi s diskom prolazi ovuda. Dvije posljedice koje se isplate:
//! ista se logika kompajlira za desktop i mobile, a pristup datotekama je na
//! jednom mjestu — dakle i provjerljiv.

#![deny(clippy::all)]

pub mod vfs;

pub use ul_formats::{detect, detect_by_name, Detection, FormatId, PROBE_LEN};
pub use vfs::{DirEntry, Stat, VfsError, Workspace};
