//! Consent to a folder or a file: born and kept on the Rust side, never given
//! by the page (ADR 0005).
//!
//! It comes from one of two places. A gesture the operating system drew — a
//! dialog, a drop onto the window, a path on the command line, a second
//! instance — **grants** at once, and is remembered here. A list Rust made
//! itself — the library, a language server's answer, a conversion's output —
//! only **offers**, and the page may claim what was offered. The page can
//! claim and it can narrow; it can never add.
//!
//! What is remembered is kept in a file only Rust writes, in a folder the
//! sandbox never lets the page into (`Workspace::protect`), newest first and
//! no more than [`MOST_REMEMBERED`], written as soon as it changes: a list
//! written at exit is lost to every crash.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// How far a consent goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    Read,
    ReadWrite,
}

/// What a consent names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// A folder and everything in it.
    Folder,
    /// One file, and nothing beside it.
    File,
}

/// One consent: a folder or a file, by its canonical path, and how far it
/// goes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Consent {
    pub path: PathBuf,
    pub kind: Kind,
    pub access: Access,
}

impl Consent {
    pub fn folder(path: impl Into<PathBuf>, access: Access) -> Self {
        Self {
            path: path.into(),
            kind: Kind::Folder,
            access,
        }
    }

    pub fn file(path: impl Into<PathBuf>, access: Access) -> Self {
        Self {
            path: path.into(),
            kind: Kind::File,
            access,
        }
    }

    /// Whether `path` is what this names: the file itself, or the folder or
    /// anything under it — by whole components, so `C:\ab` is not under
    /// `C:\a`.
    pub fn covers(&self, path: &Path) -> bool {
        match self.kind {
            Kind::File => self.path == path,
            Kind::Folder => path.starts_with(&self.path),
        }
    }
}

/// The most consents remembered. The oldest go first.
pub const MOST_REMEMBERED: usize = 128;

/// What is kept on disk.
#[derive(Default, Serialize, Deserialize)]
struct Kept {
    #[serde(default)]
    consents: Vec<Consent>,
}

/// The consents of this installation: the remembered ones, kept across
/// restarts, and what was offered in this session.
#[derive(Debug, Default, Clone)]
pub struct Consents {
    /// Where the remembered ones are kept; `None` keeps them for this session
    /// only (a folder that could not be made, or a test).
    file: Option<PathBuf>,
    remembered: Vec<Consent>,
    offered: Vec<Consent>,
}

impl Consents {
    /// Consents kept for this session only.
    pub fn in_memory() -> Self {
        Self::default()
    }

    /// The consents remembered in `file`. One that is missing or cannot be
    /// read remembers nothing — every folder is opened again by hand, which is
    /// the safe way to be wrong.
    pub fn load(file: PathBuf) -> Self {
        let remembered = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Kept>(&bytes).ok())
            .map(|kept| kept.consents)
            .unwrap_or_default();
        let mut consents = Self {
            file: Some(file),
            remembered,
            offered: Vec::new(),
        };
        consents.remembered.truncate(MOST_REMEMBERED);
        consents
    }

    /// The remembered consents, newest first.
    pub fn remembered(&self) -> &[Consent] {
        &self.remembered
    }

    /// Remembers a consent a gesture gave: first in the list, in place of an
    /// earlier one for the same path, and written at once.
    pub fn remember(&mut self, consent: Consent) -> io::Result<()> {
        self.remembered.retain(|kept| kept.path != consent.path);
        self.remembered.insert(0, consent);
        self.remembered.truncate(MOST_REMEMBERED);
        self.save()
    }

    /// Offers what a list Rust made holds, for this session: the page may
    /// claim it, and nothing beside it.
    pub fn offer(&mut self, consent: Consent) {
        self.offered.retain(|kept| kept.path != consent.path);
        self.offered.push(consent);
    }

    /// What the page may have of `path`, which the caller has resolved to its
    /// canonical form: what was offered for it, or a remembered consent that
    /// covers it. A claimed offer is remembered — a session restored later
    /// finds it — and a remembered consent moves to the front. `None`: nobody
    /// consented to it, and the page asked anyway.
    pub fn claim(&mut self, path: &Path) -> io::Result<Option<Consent>> {
        if let Some(offered) = self.offered.iter().find(|offer| offer.path == path) {
            let offered = offered.clone();
            self.remember(offered.clone())?;
            return Ok(Some(offered));
        }
        let Some(at) = self.remembered.iter().position(|kept| kept.covers(path)) else {
            return Ok(None);
        };
        let kept = self.remembered.remove(at);
        self.remembered.insert(0, kept.clone());
        self.save()?;
        Ok(Some(kept))
    }

    /// Forgets the consent for `path` — a folder taken out of Recent.
    pub fn forget(&mut self, path: &Path) -> io::Result<()> {
        let before = self.remembered.len();
        self.remembered.retain(|kept| kept.path != path);
        if self.remembered.len() == before {
            return Ok(());
        }
        self.save()
    }

    /// Written beside and renamed over, so a crash in the middle leaves the
    /// old list rather than half of a new one.
    fn save(&self) -> io::Result<()> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        let kept = Kept {
            consents: self.remembered.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&kept).map_err(io::Error::other)?;
        let fresh = file.with_extension("json.new");
        std::fs::write(&fresh, bytes)?;
        std::fs::rename(&fresh, file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ul-consent-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_consent_a_gesture_gave_outlives_a_restart() {
        let dir = scratch("restart");
        let file = dir.join("consents.json");
        let mut consents = Consents::load(file.clone());
        consents
            .remember(Consent::folder(dir.join("project"), Access::ReadWrite))
            .unwrap();
        consents
            .remember(Consent::file(dir.join("notes.md"), Access::ReadWrite))
            .unwrap();

        let again = Consents::load(file);
        let paths: Vec<_> = again.remembered().iter().map(|c| c.path.clone()).collect();
        assert_eq!(paths, vec![dir.join("notes.md"), dir.join("project")]);
    }

    #[test]
    fn what_cannot_be_read_remembers_nothing() {
        let dir = scratch("unreadable");
        let file = dir.join("consents.json");
        std::fs::write(&file, "{ not json").unwrap();
        assert!(Consents::load(file).remembered().is_empty());
        assert!(Consents::load(dir.join("missing.json"))
            .remembered()
            .is_empty());
    }

    #[test]
    fn the_list_keeps_the_newest_and_no_more() {
        let mut consents = Consents::in_memory();
        for n in 0..MOST_REMEMBERED + 5 {
            consents
                .remember(Consent::file(format!("/f{n}"), Access::Read))
                .unwrap();
        }
        assert_eq!(consents.remembered().len(), MOST_REMEMBERED);
        assert_eq!(
            consents.remembered()[0].path,
            PathBuf::from(format!("/f{}", MOST_REMEMBERED + 4))
        );

        /* The same path again is one entry, moved to the front. */
        consents
            .remember(Consent::file("/f10", Access::ReadWrite))
            .unwrap();
        assert_eq!(consents.remembered()[0].path, PathBuf::from("/f10"));
        assert_eq!(
            consents
                .remembered()
                .iter()
                .filter(|c| c.path == Path::new("/f10"))
                .count(),
            1
        );
    }

    #[test]
    fn the_page_claims_what_was_offered_or_remembered_and_nothing_else() {
        let mut consents = Consents::in_memory();
        consents.offer(Consent::file("/library/ugovor.pdf", Access::Read));
        consents
            .remember(Consent::folder("/projects/ul", Access::ReadWrite))
            .unwrap();

        let offered = consents.claim(Path::new("/library/ugovor.pdf")).unwrap();
        assert_eq!(offered.map(|c| c.access), Some(Access::Read));
        /* Claimed, the offer is remembered: a restored session finds it. */
        assert!(consents
            .remembered()
            .iter()
            .any(|c| c.path == Path::new("/library/ugovor.pdf")));

        let under = consents
            .claim(Path::new("/projects/ul/src/main.rs"))
            .unwrap();
        assert_eq!(under.map(|c| c.kind), Some(Kind::Folder));

        assert_eq!(
            consents.claim(Path::new("/library/other.pdf")).unwrap(),
            None
        );
        assert_eq!(
            consents.claim(Path::new("/projects/ulx/a.rs")).unwrap(),
            None
        );
        assert_eq!(consents.claim(Path::new("/Windows")).unwrap(), None);
    }

    #[test]
    fn a_file_consent_names_that_file_alone() {
        let consent = Consent::file("/a/notes.md", Access::ReadWrite);
        assert!(consent.covers(Path::new("/a/notes.md")));
        assert!(!consent.covers(Path::new("/a/notes.md/x")));
        assert!(!consent.covers(Path::new("/a/other.md")));
        assert!(!consent.covers(Path::new("/a")));
    }

    #[test]
    fn a_forgotten_folder_is_not_claimed_again() {
        let dir = scratch("forget");
        let file = dir.join("consents.json");
        let mut consents = Consents::load(file.clone());
        consents
            .remember(Consent::folder("/projects/ul", Access::ReadWrite))
            .unwrap();
        consents.forget(Path::new("/projects/ul")).unwrap();
        assert_eq!(consents.claim(Path::new("/projects/ul")).unwrap(), None);
        assert!(Consents::load(file).remembered().is_empty());
    }
}
