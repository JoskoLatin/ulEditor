//! The projects a language server may be started in.
//!
//! A language server is not a viewer. rust-analyzer builds the project it is
//! pointed at — its `build.rs`, its procedural macros, under whatever
//! `.cargo/config.toml` and `rust-toolchain.toml` the folder brings — and the
//! TypeScript and Python servers load the project's own plugins and settings.
//! All of it runs as whoever has ulEditor open. A folder that came in a
//! download or a cloned repository is somebody else's code, so opening one of
//! its files must not be enough to run it.
//!
//! So the first time a server would start in a project, the person is asked,
//! in a dialog the operating system draws — which the page can neither answer
//! nor word — and the answer is kept here, on the Rust side, in a file the page
//! has no command to write. "Trust" and "never" are kept for good; "not now"
//! until the program closes, so a session restored with six files of one
//! project asks once rather than six times.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// What to do about a project.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    Trusted,
    Declined,
    Ask,
}

/// What is kept on disk.
#[derive(Default, Serialize, Deserialize)]
struct Kept {
    #[serde(default)]
    trusted: Vec<PathBuf>,
    #[serde(default)]
    refused: Vec<PathBuf>,
}

#[derive(Default)]
pub(crate) struct ProjectTrust {
    /// Where the answers are kept; `None` keeps them for this session only
    /// (a folder that could not be made).
    file: Option<PathBuf>,
    kept: Kept,
    declined: HashSet<PathBuf>,
}

impl ProjectTrust {
    /// The answers given before, from `file`. A file that is missing or cannot
    /// be read trusts nothing: the person is asked again, which is the safe
    /// way to be wrong.
    pub(crate) fn load(file: PathBuf) -> Self {
        let kept = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Kept>(&bytes).ok())
            .unwrap_or_default();
        Self {
            file: Some(file),
            kept,
            declined: HashSet::new(),
        }
    }

    /// A project inside a folder that was answered for is answered for with
    /// it — trusting a repository is trusting what is in it — and where
    /// answers nest, the one about the folder nearest the project decides.
    pub(crate) fn verdict(&self, project: &Path) -> Verdict {
        if self.declined.contains(project) {
            return Verdict::Declined;
        }
        let nearest = |list: &[PathBuf]| {
            list.iter()
                .filter(|folder| project.starts_with(folder))
                .map(|folder| folder.components().count())
                .max()
        };
        match (nearest(&self.kept.trusted), nearest(&self.kept.refused)) {
            (Some(trusted), Some(refused)) if trusted > refused => Verdict::Trusted,
            (Some(_), None) => Verdict::Trusted,
            (_, Some(_)) => Verdict::Declined,
            (None, None) => Verdict::Ask,
        }
    }

    /// Remembers a yes, for good. Kept for the session even when it cannot be
    /// written: asking again over a full disk would be the program's fault
    /// presented as the person's.
    pub(crate) fn trust(&mut self, project: &Path) -> std::io::Result<()> {
        self.declined.remove(project);
        self.kept.refused.retain(|folder| folder != project);
        if !self.kept.trusted.iter().any(|folder| folder == project) {
            self.kept.trusted.push(project.to_path_buf());
        }
        self.save()
    }

    /// Remembers a "never", for good.
    pub(crate) fn refuse(&mut self, project: &Path) -> std::io::Result<()> {
        self.kept.trusted.retain(|folder| folder != project);
        if !self.kept.refused.iter().any(|folder| folder == project) {
            self.kept.refused.push(project.to_path_buf());
        }
        self.save()
    }

    /// Remembers a "not now" until the program closes.
    pub(crate) fn decline(&mut self, project: &Path) {
        self.declined.insert(project.to_path_buf());
    }

    fn save(&self) -> std::io::Result<()> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        let bytes = serde_json::to_vec_pretty(&self.kept).map_err(std::io::Error::other)?;
        /* Written beside and renamed over, so a crash in the middle leaves the
        old answers rather than half of new ones — which would trust nothing
        and ask about everything again. */
        let fresh = file.with_extension("json.new");
        std::fs::write(&fresh, bytes)?;
        std::fs::rename(&fresh, file)
    }
}

/// The question, in the language the interface is in. Here rather than in the
/// page's catalogue so that the page chooses only which of these two it is in,
/// never what the dialog says.
///
/// Three buttons, and the first is the safe one: a dialog that comes up while
/// somebody is typing takes the next Enter as the first button, and Windows
/// gives no other way to choose the default. Escape and closing the window are
/// never a yes either — on Linux they come back as the third button, so that
/// one is a no as well.
pub(crate) struct Question {
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) not_now: String,
    pub(crate) trust: String,
    pub(crate) never: String,
}

pub(crate) fn question(interface: Option<&str>, language: &str, project: &Path) -> Question {
    let language = match language {
        "rust" => "Rust",
        "typescript" => "TypeScript",
        "javascript" => "JavaScript",
        "python" => "Python",
        other => other,
    };
    let project = readable(project);
    if interface == Some("hr") {
        Question {
            title: "Pokrenuti kod ovog projekta?".into(),
            body: format!(
                "Za provjeru koda ({language}) ulEditor pokreće jezični poslužitelj u mapi\n\n\
                 {project}\n\n\
                 Poslužitelj izvršava skripte za izgradnju, makroe i postavke ovog projekta, \
                 s tvojim ovlastima. Dopusti to samo za projekt kojem vjeruješ — svoj ili od \
                 nekoga kome vjeruješ.\n\n\
                 „Vjerujem” i „Nikad” pamte se za ovu mapu."
            ),
            not_now: "Ne sada".into(),
            trust: "Vjerujem, pokreni".into(),
            never: "Nikad za ovu mapu".into(),
        }
    } else {
        Question {
            title: "Run this project's code?".into(),
            body: format!(
                "To check {language} code, ulEditor starts a language server in\n\n\
                 {project}\n\n\
                 The server runs this project's own build scripts, macros and settings, \
                 as you. Allow it only for a project you trust — your own, or one from \
                 somebody you trust.\n\n\
                 \"Trust\" and \"Never\" are remembered for this folder."
            ),
            not_now: "Not now".into(),
            trust: "Trust and start".into(),
            never: "Never for this folder".into(),
        }
    }
}

/// What the person said, out of the button that came back.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Answer {
    Trust,
    Never,
    NotNow,
}

impl Question {
    /// Only the trust button is a yes. Whatever else comes back — the first
    /// button, Escape, a closed window, nothing at all — is not.
    pub(crate) fn answer(&self, pressed: Option<&str>) -> Answer {
        match pressed {
            Some(label) if label == self.trust => Answer::Trust,
            Some(label) if label == self.never => Answer::Never,
            _ => Answer::NotNow,
        }
    }
}

/// A path as a person writes it: without the `\\?\` Windows puts in front of
/// a canonical one.
fn readable(path: &Path) -> String {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ul-trust-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_project_nobody_has_answered_for_is_asked_about() {
        let trust = ProjectTrust::load(scratch("empty").join("trusted.json"));
        assert_eq!(trust.verdict(Path::new("/home/a/repo")), Verdict::Ask);
    }

    #[test]
    fn a_yes_is_remembered_across_a_restart_and_covers_what_is_inside() {
        let file = scratch("yes").join("trusted.json");
        let mut trust = ProjectTrust::load(file.clone());
        trust.trust(Path::new("/home/a/repo")).unwrap();

        let again = ProjectTrust::load(file);
        assert_eq!(again.verdict(Path::new("/home/a/repo")), Verdict::Trusted);
        assert_eq!(
            again.verdict(Path::new("/home/a/repo/crates/x")),
            Verdict::Trusted
        );
        /* A sibling whose name begins the same is not inside it. */
        assert_eq!(again.verdict(Path::new("/home/a/repo-evil")), Verdict::Ask);
        assert_eq!(again.verdict(Path::new("/home/a")), Verdict::Ask);
    }

    #[test]
    fn a_not_now_lasts_the_session_and_a_never_lasts() {
        let file = scratch("no").join("trusted.json");
        let mut trust = ProjectTrust::load(file.clone());
        trust.decline(Path::new("/home/a/download"));
        trust.refuse(Path::new("/home/a/other")).unwrap();
        assert_eq!(
            trust.verdict(Path::new("/home/a/download")),
            Verdict::Declined
        );

        let again = ProjectTrust::load(file);
        assert_eq!(again.verdict(Path::new("/home/a/download")), Verdict::Ask);
        assert_eq!(
            again.verdict(Path::new("/home/a/other/sub")),
            Verdict::Declined
        );
    }

    #[test]
    fn the_nearest_answer_decides() {
        let mut trust = ProjectTrust::load(scratch("nested").join("trusted.json"));
        trust.refuse(Path::new("/home/a")).unwrap();
        trust.trust(Path::new("/home/a/mine")).unwrap();
        assert_eq!(
            trust.verdict(Path::new("/home/a/mine/crate")),
            Verdict::Trusted
        );
        assert_eq!(
            trust.verdict(Path::new("/home/a/theirs")),
            Verdict::Declined
        );
    }

    #[test]
    fn answers_that_cannot_be_read_trust_nothing() {
        let file = scratch("broken").join("trusted.json");
        std::fs::write(&file, b"{ not json").unwrap();
        let trust = ProjectTrust::load(file);
        assert_eq!(trust.verdict(Path::new("/")), Verdict::Ask);
    }

    #[test]
    fn only_the_trust_button_is_a_yes() {
        let asked = question(Some("en"), "rust", Path::new("/home/a/repo"));
        assert_eq!(asked.answer(Some("Trust and start")), Answer::Trust);
        assert_eq!(asked.answer(Some("Never for this folder")), Answer::Never);
        for other in [Some("Not now"), Some("OK"), Some(""), None] {
            assert_eq!(asked.answer(other), Answer::NotNow, "{other:?}");
        }
    }

    #[test]
    fn the_question_names_the_folder_as_a_person_writes_it() {
        let asked = question(Some("hr"), "rust", Path::new(r"\\?\C:\dev\repo"));
        assert!(asked.body.contains("C:\\dev\\repo\n"), "{}", asked.body);
        assert!(!asked.body.contains(r"\\?\"));
        assert_eq!(asked.trust, "Vjerujem, pokreni");
        let asked = question(Some("fr"), "python", Path::new("/home/a/repo"));
        assert!(asked.body.starts_with("To check Python code"));
    }
}
