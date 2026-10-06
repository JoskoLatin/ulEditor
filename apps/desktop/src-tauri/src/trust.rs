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
//! nor word — and a yes is kept here, on the Rust side, in a folder the sandbox
//! never lets the page read or write (`Workspace::protect`). Anything else is
//! a no until the program closes, so a session restored with six files of one
//! project asks once rather than six times — and asks again next time: a no
//! that lasted would come from an Escape or a closed window as often as from a
//! decision, and there would be nothing to take it back with.

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

    /// A yes is for the very project it was given for, and nothing below it:
    /// the question named one folder, and a repository cloned into it next
    /// month is not what was looked at.
    pub(crate) fn verdict(&self, project: &Path) -> Verdict {
        if self.declined.contains(project) {
            Verdict::Declined
        } else if self.kept.trusted.iter().any(|folder| folder == project) {
            Verdict::Trusted
        } else {
            Verdict::Ask
        }
    }

    /// Remembers a yes, for good. Kept for the session even when it cannot be
    /// written: asking again over a full disk would be the program's fault
    /// presented as the person's.
    pub(crate) fn trust(&mut self, project: &Path) -> std::io::Result<()> {
        self.declined.remove(project);
        if !self.kept.trusted.iter().any(|folder| folder == project) {
            self.kept.trusted.push(project.to_path_buf());
        }
        self.save()
    }

    /// Remembers a no until the program closes.
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
/// Three buttons, and only the middle one is a yes. The first is where Enter
/// lands — a dialog that comes up while somebody is typing takes their next
/// Enter, and Windows gives no other way to choose the default — and the third
/// is what Escape and closing the window come back as, on every platform
/// (tauri-plugin-dialog turns a cancel into the third button's label). Two
/// buttons would leave one of those two on the yes.
pub(crate) struct Question {
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) not_now: String,
    pub(crate) trust: String,
    pub(crate) cancel: String,
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
                 Poslužitelj izvršava skripte za izgradnju, makroe i postavke ovog projekta \
                 — za Rust i Cargo workspacea u kojem je — s tvojim ovlastima. Dopusti to \
                 samo za projekt kojem vjeruješ: svoj ili od nekoga kome vjeruješ.\n\n\
                 „Vjerujem” se pamti za ovu mapu."
            ),
            not_now: "Ne sada".into(),
            trust: "Vjerujem, pokreni".into(),
            cancel: "Odustani".into(),
        }
    } else {
        Question {
            title: "Run this project's code?".into(),
            body: format!(
                "To check {language} code, ulEditor starts a language server in\n\n\
                 {project}\n\n\
                 The server runs this project's own build scripts, macros and settings \
                 — for Rust, those of the Cargo workspace it is in too — as you. Allow \
                 it only for a project you trust: your own, or one from somebody you \
                 trust.\n\n\
                 A \"Trust\" is remembered for this folder."
            ),
            not_now: "Not now".into(),
            trust: "Trust and start".into(),
            cancel: "Cancel".into(),
        }
    }
}

/// The question asked once before the library looks through the person's
/// folders on desktop (ADR 0005), in the same three buttons as `question`,
/// the middle one the yes. Script in the page can start a scan; it cannot
/// answer this. Desktop only.
#[cfg_attr(mobile, allow(dead_code))]
pub(crate) fn library_question(
    interface: Option<&str>,
    folders: &[std::path::PathBuf],
) -> Question {
    let folders: Vec<String> = folders.iter().map(|folder| readable(folder)).collect();
    let folders = folders.join("\n");
    if interface == Some("hr") {
        Question {
            title: "Pregledati dokumente na računalu?".into(),
            body: format!(
                "Knjižnica traži dokumente u mapama\n\n{folders}\n\n\
                 i prikazuje ih ovdje, da se otvore samo za čitanje. Otvoriti se \
                 mogu samo dokumenti koje pronađe.\n\n\
                 „Dopusti” se pamti, a opoziva ga „Zaboravi nedavno otvorene datoteke”."
            ),
            not_now: "Ne sada".into(),
            trust: "Dopusti".into(),
            cancel: "Odustani".into(),
        }
    } else {
        Question {
            title: "Look through your documents?".into(),
            body: format!(
                "The library looks for documents in\n\n{folders}\n\n\
                 and lists them here, to be opened read-only. Only the documents \
                 it finds can be opened.\n\n\
                 \"Allow\" is remembered; \"Forget recently opened files\" takes it back."
            ),
            not_now: "Not now".into(),
            trust: "Allow".into(),
            cancel: "Cancel".into(),
        }
    }
}

/// What the person said, out of the button that came back.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Answer {
    Trust,
    NotNow,
}

impl Question {
    /// Only the trust button is a yes. Whatever else comes back — the first
    /// button, Escape, a closed window, nothing at all — is not.
    pub(crate) fn answer(&self, pressed: Option<&str>) -> Answer {
        match pressed {
            Some(label) if label == self.trust => Answer::Trust,
            _ => Answer::NotNow,
        }
    }
}

/// A path as a person writes it: without the `\\?\` Windows puts in front of
/// a canonical one — and with nothing in it that could pass for part of the
/// question. The folder name is the one part of the dialog a repository
/// chooses: a line break in it could start a paragraph of its own ("This is
/// a verified project…"), a line or paragraph separator does the same without
/// being a control character, a right-to-left override turns the text after
/// it around, and some characters are not seen at all.
///
/// So what is shown as it is, is what is known to be harmless — letters and
/// digits of any script, the space, and the punctuation paths are made of —
/// and everything else is written out as a code. A list of what to leave out
/// would be one Unicode version from missing something.
fn readable(path: &Path) -> String {
    let text = path.to_string_lossy();
    let text = match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned(),
    };
    let mut shown = String::new();
    let mut previous = '\0';
    for c in text.chars() {
        /* A space after a space is a gap somebody made, wide enough to push
        what follows onto a line of its own. */
        if shown_as_it_is(c) && !(c == ' ' && previous == ' ') {
            shown.push(c);
        } else {
            shown.push_str(&format!("\\u{{{:04X}}}", c as u32));
        }
        previous = c;
    }

    /* A name long enough to fill the dialog would push the question out of
    it; the two ends are what tell one folder from another. */
    const ENDS: usize = 120;
    let count = shown.chars().count();
    if count > 2 * ENDS + 1 {
        let head: String = shown.chars().take(ENDS).collect();
        let tail: String = shown.chars().skip(count - ENDS).collect();
        shown = format!("{head}…{tail}");
    }
    shown
}

/// Not `%`: GTK takes the dialog's text as a printf format (rfd passes it to
/// `gtk_message_dialog_format_secondary_text` as the format itself), so a
/// folder called `%s%n` would read and write memory before a button was
/// drawn. Not `&` either, which some toolkits read as a mnemonic.
fn shown_as_it_is(c: char) -> bool {
    /* Letters that are drawn as nothing: the Hangul fillers. */
    const BLANK_LETTERS: [char; 4] = ['\u{115F}', '\u{1160}', '\u{3164}', '\u{FFA0}'];
    (c.is_alphanumeric() && !BLANK_LETTERS.contains(&c)) || " -_.,()[]{}'!@#$+=~;:/\\^`".contains(c)
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
    fn a_yes_is_remembered_across_a_restart_for_that_project_alone() {
        let file = scratch("yes").join("trusted.json");
        let mut trust = ProjectTrust::load(file.clone());
        trust.trust(Path::new("/home/a/repo")).unwrap();

        let again = ProjectTrust::load(file);
        assert_eq!(again.verdict(Path::new("/home/a/repo")), Verdict::Trusted);
        /* Something cloned into it later was not what was looked at. */
        assert_eq!(
            again.verdict(Path::new("/home/a/repo/vendor/x")),
            Verdict::Ask
        );
        assert_eq!(again.verdict(Path::new("/home/a/repo-evil")), Verdict::Ask);
        assert_eq!(again.verdict(Path::new("/home/a")), Verdict::Ask);
    }

    #[test]
    fn a_no_lasts_the_session_and_no_longer() {
        let file = scratch("no").join("trusted.json");
        let mut trust = ProjectTrust::load(file.clone());
        trust.decline(Path::new("/home/a/download"));
        assert_eq!(
            trust.verdict(Path::new("/home/a/download")),
            Verdict::Declined
        );

        let again = ProjectTrust::load(file);
        assert_eq!(again.verdict(Path::new("/home/a/download")), Verdict::Ask);
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
        for other in [Some("Not now"), Some("Cancel"), Some("OK"), Some(""), None] {
            assert_eq!(asked.answer(other), Answer::NotNow, "{other:?}");
        }
    }

    /// The library's question names its folders as a person writes them, and
    /// only its own allow button is a yes, in either language.
    #[test]
    fn only_the_allow_button_lets_the_library_look() {
        let folders = [std::path::PathBuf::from("/home/a/Documents\nThis is safe.")];
        let asked = library_question(Some("en"), &folders);
        assert!(!asked.body.contains("\nThis is safe."), "{}", asked.body);
        assert_eq!(asked.answer(Some("Allow")), Answer::Trust);
        for other in [
            Some("Not now"),
            Some("Cancel"),
            Some("Trust and start"),
            None,
        ] {
            assert_eq!(asked.answer(other), Answer::NotNow, "{other:?}");
        }
        let asked = library_question(Some("hr"), &folders);
        assert_eq!(asked.answer(Some("Dopusti")), Answer::Trust);
        assert_eq!(asked.answer(Some("Ne sada")), Answer::NotNow);
    }

    #[test]
    fn a_folder_name_cannot_write_part_of_the_question() {
        let tricky = "/tmp/repo\n\nThis project is verified.\u{202E}txt.exe\u{200B}";
        let asked = question(Some("en"), "rust", Path::new(tricky));
        assert!(!asked.body.contains("\n\nThis project"), "{}", asked.body);
        assert!(!asked.body.contains('\u{202E}'));
        assert!(!asked.body.contains('\u{200B}'));
        assert!(asked
            .body
            .contains("\\u{000A}\\u{000A}This project is verified.\\u{202E}"));

        /* Not control characters, and still a line, a hidden hyphen and an
        invisible tag. */
        for sly in ['\u{2028}', '\u{2029}', '\u{00AD}', '\u{E0041}', '\u{180E}'] {
            let asked = question(Some("en"), "rust", Path::new(&format!("/tmp/a{sly}b")));
            assert!(!asked.body.contains(sly), "{:04X}", sly as u32);
        }
        /* Blank letters, a run of spaces, and a name long enough to fill the
        dialog. */
        let asked = question(Some("en"), "rust", Path::new("/tmp/a\u{3164}b   c"));
        assert!(
            asked
                .body
                .contains("/tmp/a\\u{3164}b \\u{0020}\\u{0020}c\n"),
            "{}",
            asked.body
        );
        let long = format!("/tmp/{}", "x".repeat(5000));
        let asked = question(Some("en"), "rust", Path::new(&long));
        assert!(asked.body.chars().count() < 1000, "{}", asked.body.len());
        assert!(asked.body.contains('…'));

        /* A printf format for GTK, and a mnemonic for some toolkits. */
        let asked = question(Some("en"), "rust", Path::new("/tmp/100%/a%s%s%n&b"));
        assert!(!asked.body.contains('%'), "{}", asked.body);
        assert!(!asked.body.contains('&'), "{}", asked.body);
        assert!(asked.body.contains("/tmp/100\\u{0025}/a\\u{0025}s"));

        /* While a name in any script is shown as it is. */
        let asked = question(
            Some("hr"),
            "rust",
            Path::new("/home/čovik/Projekti/ключ-数据"),
        );
        assert!(asked.body.contains("/home/čovik/Projekti/ключ-数据\n"));
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
