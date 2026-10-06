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

/// The most claimed offers remembered, apart from what gestures gave: a
/// page that claims everything a list offered fills these, and pushes out
/// none of the person's own consents.
pub const MOST_CLAIMED: usize = 64;

/// What is kept on disk.
#[derive(Default, Serialize, Deserialize)]
struct Kept {
    #[serde(default)]
    consents: Vec<Consent>,
    #[serde(default)]
    claimed: Vec<Consent>,
    #[serde(default)]
    library: bool,
}

/// The consents of this installation: what gestures gave and what was
/// claimed of an offer, kept across restarts, and what was offered in this
/// session.
#[derive(Debug, Default, Clone)]
pub struct Consents {
    /// Where the remembered ones are kept; `None` keeps them for this session
    /// only (a folder that could not be made, or a test).
    file: Option<PathBuf>,
    /// What gestures gave, newest first.
    remembered: Vec<Consent>,
    /// What the page claimed of an offer, newest first — a list of its own.
    claimed: Vec<Consent>,
    offered: std::collections::HashMap<PathBuf, Consent>,
    /// Whether the person let the library look through their folders: a
    /// yes to that, and nothing more — what it lets the page read is still
    /// only what a scan offers, never the folders whole.
    library: bool,
}

/// A path as it is shown, without the `\?\` the resolved form carries on
/// Windows: what two spellings of one place are compared by when the place
/// itself is gone and cannot be resolved again — a stick pulled out.
fn plain(path: &Path) -> PathBuf {
    PathBuf::from(crate::vfs::display(path))
}

/// Keeps one consent for `consent.path` in `list`, first, the wider access
/// winning over a narrower one already there, and no more than `most`.
fn keep_first(list: &mut Vec<Consent>, consent: Consent, most: usize) {
    let wider = list
        .iter()
        .find(|kept| kept.path == consent.path && kept.kind == consent.kind)
        .is_some_and(|kept| kept.access == Access::ReadWrite);
    list.retain(|kept| kept.path != consent.path);
    let mut consent = consent;
    if wider {
        consent.access = Access::ReadWrite;
    }
    list.insert(0, consent);
    list.truncate(most);
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
        let kept = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Kept>(&bytes).ok())
            .unwrap_or_default();
        let mut consents = Self {
            file: Some(file),
            remembered: kept.consents,
            claimed: kept.claimed,
            offered: std::collections::HashMap::new(),
            library: kept.library,
        };
        consents.remembered.truncate(MOST_REMEMBERED);
        consents.claimed.truncate(MOST_CLAIMED);
        consents
    }

    /// What the page claimed of an offer, newest first.
    pub fn claimed(&self) -> &[Consent] {
        &self.claimed
    }

    /// What gestures gave, newest first.
    pub fn remembered(&self) -> &[Consent] {
        &self.remembered
    }

    /// Remembers a consent a gesture gave: first in the list, in place of an
    /// earlier one for the same path — keeping the wider of the two — and
    /// written at once.
    pub fn remember(&mut self, consent: Consent) -> io::Result<()> {
        keep_first(&mut self.remembered, consent, MOST_REMEMBERED);
        self.save()
    }

    /// Offers what a list Rust made holds, for this session: the page may
    /// claim it, and nothing beside it.
    pub fn offer(&mut self, consent: Consent) {
        self.offered.insert(consent.path.clone(), consent);
    }

    /// What the page may have of `path`, which the caller has resolved to its
    /// canonical form: what a gesture's consent covers, what was offered for
    /// it, or what it claimed of an offer before. A gesture's consent goes
    /// furthest and is taken first; a claimed offer is kept in a list of its
    /// own, so that a session restored later finds it without it pushing out
    /// anything the person gave. A list that cannot be written keeps what was
    /// claimed for this session. `None`: nobody consented to it, and the page
    /// asked anyway.
    pub fn claim(&mut self, path: &Path) -> Option<Consent> {
        /* Of the gestures' consents that cover it, the one that goes furthest,
        and of those the nearest: a folder let in to be read above a file
        given to be written must not narrow the file. */
        let widest = self
            .remembered
            .iter()
            .enumerate()
            .filter(|(_, kept)| kept.covers(path))
            .max_by_key(|(_, kept)| {
                (
                    kept.access == Access::ReadWrite,
                    kept.path.components().count(),
                )
            })
            .map(|(at, _)| at);
        if let Some(at) = widest {
            let kept = self.remembered.remove(at);
            self.remembered.insert(0, kept.clone());
            let _ = self.save();
            return Some(kept);
        }
        if let Some(offered) = self.offered.get(path).cloned() {
            keep_first(&mut self.claimed, offered.clone(), MOST_CLAIMED);
            let _ = self.save();
            return Some(offered);
        }
        let at = self.claimed.iter().position(|kept| kept.covers(path))?;
        let kept = self.claimed.remove(at);
        self.claimed.insert(0, kept.clone());
        let _ = self.save();
        Some(kept)
    }

    /// Forgets the consent for `path` — a folder taken out of Recent — with
    /// everything under it, given or claimed, and what was offered of it this
    /// session: an offer left standing would let the page claim straight back
    /// what was just forgotten. Compared as shown as well as resolved, so a
    /// folder on a stick that is gone is still forgotten.
    pub fn forget(&mut self, path: &Path) -> io::Result<()> {
        /* An empty path is under nothing and over everything: it forgets
        nothing, rather than all. */
        if path.as_os_str().is_empty() {
            return Ok(());
        }
        let gone = Consent::folder(plain(path), Access::Read);
        let forgotten = |kept: &Consent| gone.covers(&plain(&kept.path));
        let before = self.remembered.len() + self.claimed.len();
        self.offered.retain(|_, offer| !forgotten(offer));
        self.remembered.retain(|kept| !forgotten(kept));
        self.claimed.retain(|kept| !forgotten(kept));
        if self.remembered.len() + self.claimed.len() == before {
            return Ok(());
        }
        self.save()
    }

    /// Forgets every consent, given or claimed, every offer and the library's
    /// yes — what "Forget recently opened files" means to the person.
    pub fn forget_all(&mut self) -> io::Result<()> {
        self.remembered.clear();
        self.claimed.clear();
        self.offered.clear();
        self.library = false;
        self.save()
    }

    /// Whether the person let the library look through their folders.
    pub fn library_allowed(&self) -> bool {
        self.library
    }

    /// Remembers that the person let the library look — and only that: the
    /// folders it looks in are not granted, and the page may still claim only
    /// the documents a scan offers.
    pub fn allow_library(&mut self) -> io::Result<()> {
        self.library = true;
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
            claimed: self.claimed.clone(),
            library: self.library,
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

        let offered = consents.claim(Path::new("/library/ugovor.pdf"));
        assert_eq!(offered.map(|c| c.access), Some(Access::Read));
        /* Claimed, the offer is kept: a restored session finds it. */
        assert!(consents
            .claimed()
            .iter()
            .any(|c| c.path == Path::new("/library/ugovor.pdf")));

        let under = consents.claim(Path::new("/projects/ul/src/main.rs"));
        assert_eq!(under.map(|c| c.kind), Some(Kind::Folder));

        assert_eq!(consents.claim(Path::new("/library/other.pdf")), None);
        assert_eq!(consents.claim(Path::new("/projects/ulx/a.rs")), None);
        assert_eq!(consents.claim(Path::new("/Windows")), None);
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
        assert_eq!(consents.claim(Path::new("/projects/ul")), None);
        assert!(Consents::load(file).remembered().is_empty());
    }

    /// Forgotten, a file that was offered this session is not claimed straight
    /// back through its offer — nor a file offered inside a forgotten folder.
    #[test]
    fn a_forgotten_offer_is_not_claimed_back() {
        let mut consents = Consents::in_memory();
        consents.offer(Consent::file("/library/ugovor.pdf", Access::Read));
        consents.offer(Consent::file("/library/sub/plan.pdf", Access::Read));
        consents.claim(Path::new("/library/ugovor.pdf"));

        consents.forget(Path::new("/library/ugovor.pdf")).unwrap();
        assert_eq!(consents.claim(Path::new("/library/ugovor.pdf")), None);

        consents.forget(Path::new("/library/sub")).unwrap();
        assert_eq!(consents.claim(Path::new("/library/sub/plan.pdf")), None);
    }

    /// A page that claims everything a list offered fills a list of its own,
    /// and pushes out none of the person's consents.
    #[test]
    fn claimed_offers_push_out_no_gesture() {
        let mut consents = Consents::in_memory();
        for n in 0..MOST_REMEMBERED {
            consents
                .remember(Consent::file(format!("/given/f{n}"), Access::ReadWrite))
                .unwrap();
        }
        for n in 0..MOST_CLAIMED + 10 {
            let path = format!("/library/d{n}.pdf");
            consents.offer(Consent::file(&path, Access::Read));
            consents.claim(Path::new(&path));
        }
        assert_eq!(consents.remembered().len(), MOST_REMEMBERED);
        assert!(consents
            .remembered()
            .iter()
            .all(|c| c.path.starts_with("/given")));
        assert_eq!(consents.claimed().len(), MOST_CLAIMED);
    }

    /// A file a dialog gave to be written, offered later only to be read, is
    /// claimed as far as the dialog gave — and remembering it again to be
    /// read does not narrow it.
    #[test]
    fn the_wider_consent_wins() {
        let mut consents = Consents::in_memory();
        consents
            .remember(Consent::file("/a/notes.md", Access::ReadWrite))
            .unwrap();
        consents.offer(Consent::file("/a/notes.md", Access::Read));
        assert_eq!(
            consents.claim(Path::new("/a/notes.md")).map(|c| c.access),
            Some(Access::ReadWrite)
        );
        assert!(consents.claimed().is_empty());

        consents
            .remember(Consent::file("/a/notes.md", Access::Read))
            .unwrap();
        assert_eq!(consents.remembered()[0].access, Access::ReadWrite);
    }

    /// A folder forgotten takes what is under it with it, given or claimed,
    /// and is forgotten by its shown name when its resolved one is gone — a
    /// stick pulled out.
    #[test]
    fn a_forgotten_folder_takes_what_is_under_it() {
        let mut consents = Consents::in_memory();
        /* The resolved form as Windows gives it, and the shown one the page
        has once the stick is gone. Written as Windows paths: the shown form
        is what `display` makes of them there. */
        let (stick, notes, pdf, shown) = if cfg!(windows) {
            (
                r"\\?\E:\stick",
                r"\\?\E:\stick\notes.md",
                r"\\?\E:\stick\a.pdf",
                r"E:\stick",
            )
        } else {
            (
                "/media/stick",
                "/media/stick/notes.md",
                "/media/stick/a.pdf",
                "/media/stick",
            )
        };
        consents
            .remember(Consent::folder(stick, Access::ReadWrite))
            .unwrap();
        consents
            .remember(Consent::file(notes, Access::ReadWrite))
            .unwrap();
        consents.offer(Consent::file(pdf, Access::Read));
        consents.claim(Path::new(pdf));
        consents.forget(Path::new(shown)).unwrap();
        assert!(
            consents.remembered().is_empty(),
            "{:?}",
            consents.remembered()
        );
        assert!(consents.claimed().is_empty(), "{:?}", consents.claimed());
    }

    /// Forgetting everything leaves nothing to claim, after a restart too.
    #[test]
    fn everything_forgotten_is_forgotten() {
        let dir = scratch("forget-all");
        let file = dir.join("consents.json");
        let mut consents = Consents::load(file.clone());
        consents
            .remember(Consent::folder("/projects/ul", Access::ReadWrite))
            .unwrap();
        consents.offer(Consent::file("/library/x.pdf", Access::Read));
        consents.claim(Path::new("/library/x.pdf"));
        consents.allow_library().unwrap();
        assert!(Consents::load(file.clone()).library_allowed());
        consents.forget_all().unwrap();
        assert!(!consents.library_allowed());
        assert_eq!(consents.claim(Path::new("/projects/ul")), None);
        assert_eq!(consents.claim(Path::new("/library/x.pdf")), None);
        let again = Consents::load(file);
        assert!(again.remembered().is_empty() && again.claimed().is_empty());
        assert!(!again.library_allowed());
    }

    /// A list that cannot be written still lets the page claim what it may.
    #[test]
    fn a_claim_stands_when_the_list_cannot_be_written() {
        let dir = scratch("unwritable");
        let mut consents = Consents::load(dir.join("gone").join("consents.json"));
        consents.offer(Consent::file("/library/x.pdf", Access::Read));
        assert!(consents.claim(Path::new("/library/x.pdf")).is_some());
    }

    /// The library let look lets nothing be claimed by itself: only what a
    /// scan offers.
    #[test]
    fn the_library_let_look_grants_no_folder() {
        let mut consents = Consents::in_memory();
        consents.allow_library().unwrap();
        assert!(consents.library_allowed());
        assert_eq!(consents.claim(Path::new("/home/a/Downloads/id_rsa")), None);
        consents.offer(Consent::file("/home/a/Documents/ugovor.pdf", Access::Read));
        assert!(consents
            .claim(Path::new("/home/a/Documents/ugovor.pdf"))
            .is_some());
        assert_eq!(
            consents.claim(Path::new("/home/a/Documents/other.txt")),
            None
        );
    }

    /// A folder let in to be read above a file given to be written does not
    /// narrow the file; an empty path forgets nothing.
    #[test]
    fn the_widest_and_nearest_consent_is_claimed() {
        let file = Consent::file("/home/a/Documents/ugovor.docx", Access::ReadWrite);
        let folder = Consent::folder("/home/a/Documents", Access::Read);
        for order in [
            [file.clone(), folder.clone()],
            [folder.clone(), file.clone()],
        ] {
            let mut consents = Consents::in_memory();
            for consent in order {
                consents.remember(consent).unwrap();
            }
            let claimed = consents.claim(Path::new("/home/a/Documents/ugovor.docx"));
            assert_eq!(
                claimed.map(|c| (c.kind, c.access)),
                Some((Kind::File, Access::ReadWrite))
            );
            consents.forget(Path::new("")).unwrap();
            assert_eq!(consents.remembered().len(), 2);
        }
    }
}
