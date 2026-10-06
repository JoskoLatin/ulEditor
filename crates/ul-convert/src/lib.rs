//! LibreOffice, run headless, for the three formats nobody else implements.
//!
//! `.cdr` is CorelDRAW's own, and the only thing that reads it is libcdr, inside
//! LibreOffice. `.eps` and `.ps` are PostScript — a programming language rather
//! than a drawing, so showing one means running an interpreter. An `.ai` saved
//! without PDF compatibility is PostScript too.
//!
//! **This is the one place a four-hundred-megabyte office suite is the right
//! instrument.** `.odt` and `.ods` were supposed to arrive this way and do not:
//! an OpenDocument file is a ZIP of XML, and requiring an installation before a
//! spreadsheet will open was a bigger imposition than writing the reader. These
//! three are different. They hold drawing models nobody has reimplemented, and
//! there is no honest way to show one without the code that understands it.
//!
//! So LibreOffice is **optional and asked for by name**: if it is not installed,
//! the program says which formats that costs and where to get it, and every
//! other format is unaffected. Nothing is bundled and nothing is downloaded.
//!
//! Three things about driving it from a command line are not obvious, and each
//! one of them is a conversion that silently does nothing:
//!
//! 1. **A running LibreOffice takes the job and drops it.** The CLI talks to
//!    whichever instance already owns the user profile, and that instance is
//!    busy showing somebody a document — so the conversion exits 0 having
//!    produced no file. A profile of its own per run is the fix, and it is why
//!    `-env:UserInstallation` is not optional here.
//! 2. **On Windows `soffice.exe` returns immediately.** It is a launcher: the
//!    process that does the work is another one, and waiting on the one you
//!    started tells you nothing. `soffice.com` is the console wrapper that
//!    waits, so it is preferred when present.
//! 3. **The exit code is not the answer.** It is 0 for a file it could not
//!    read, for a filter it does not have, and for the case in (1). The answer
//!    is whether the output file appeared, so that is what is waited for.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConvertError {
    #[error("LibreOffice is not installed, or not where this program can find it")]
    NotInstalled,
    #[error("the file to convert is not there: {0}")]
    NoSource(String),
    #[error("LibreOffice could not be started: {0}")]
    Start(String),
    #[error("LibreOffice produced no file within {0} seconds")]
    Timeout(u64),
    #[error("LibreOffice produced no file, and said: {0}")]
    Refused(String),
    #[error("file system error: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for ConvertError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// What the frontend is told about the backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backend {
    /// The binary that will be run, for the settings screen and for a bug report.
    pub path: String,
    /// What it can be asked for. Not a promise about any one file.
    pub formats: Vec<String>,
}

/// The formats this is for. Everything else in the program has its own reader.
pub const FORMATS: [&str; 4] = ["cdr", "eps", "ps", "ai"];

/// Where LibreOffice puts itself, per platform.
///
/// The PATH is asked first, because somebody who installed it somewhere unusual
/// has usually put it on the PATH — and because that is the answer a
/// distribution package gives. The rest are the defaults of the three
/// installers, which is where it is on a machine nobody has configured.
pub fn candidates() -> Vec<PathBuf> {
    /* On a platform with no office suite to find — Android, iOS — every block
    below is compiled out and nothing ever pushes. `-D warnings` in CI turns
    that into a build failure, which is how this was found: the Android job
    went red on a crate the phone build has no use for. */
    #[allow(unused_mut)]
    let mut found = Vec::new();

    #[cfg(target_os = "windows")]
    {
        /* `.com` before `.exe`: see the note at the top of this file — the `.exe`
        is a launcher that returns before the work is done. */
        for root in [
            r"C:\Program Files\LibreOffice",
            r"C:\Program Files (x86)\LibreOffice",
        ] {
            found.push(PathBuf::from(format!(r"{root}\program\soffice.com")));
            found.push(PathBuf::from(format!(r"{root}\program\soffice.exe")));
        }
    }

    #[cfg(target_os = "macos")]
    {
        found.push(PathBuf::from(
            "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        ));
    }

    /* Android and iOS are unix and neither has an office suite to find; saying
    so here is cheaper than a list of paths that cannot exist. */
    #[cfg(all(
        unix,
        not(any(target_os = "macos", target_os = "android", target_os = "ios"))
    ))]
    {
        for path in [
            "/usr/bin/soffice",
            "/usr/local/bin/soffice",
            "/usr/lib/libreoffice/program/soffice",
            "/opt/libreoffice/program/soffice",
            // A snap or a flatpak: the wrapper, not the binary inside the sandbox.
            "/snap/bin/libreoffice",
            "/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice",
        ] {
            found.push(PathBuf::from(path));
        }
    }

    found
}

/// The first candidate that is there.
///
/// `exists` is a parameter so that the answer can be checked on a machine that
/// has LibreOffice and on one that does not, which is the whole difficulty with
/// testing anything that looks for an installation.
pub fn find_in(candidates: &[PathBuf], exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.iter().find(|path| exists(path)).cloned()
}

/// Whatever is on the PATH, if anything.
fn on_path() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|path| on_path_in(&path))
        .unwrap_or_default()
}

/// The places a PATH names, absolute ones only.
///
/// A relative entry — `.`, or an empty one, which means the same — is whatever
/// folder the program happens to be running in, and a `soffice` found there is
/// not the LibreOffice this machine has installed. It was tried, and started by
/// that relative path.
fn on_path_in(path: &std::ffi::OsStr) -> Vec<PathBuf> {
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["soffice.com", "soffice.exe"]
    } else {
        &["soffice", "libreoffice"]
    };

    let mut found = Vec::new();
    for directory in std::env::split_paths(path) {
        if !directory.is_absolute() {
            continue;
        }
        for name in names {
            found.push(directory.join(name));
        }
    }
    found
}

/// LibreOffice, if this machine has it.
pub fn backend() -> Option<Backend> {
    let mut all = on_path();
    all.extend(candidates());

    find_in(&all, |path| path.is_file()).map(|path| Backend {
        path: path.to_string_lossy().into_owned(),
        formats: FORMATS.iter().map(|f| (*f).to_string()).collect(),
    })
}

/// LibreOffice started so that nothing it starts in turn is looked for in a
/// relative place: a PATH of absolute entries only, and on Windows no looking
/// in the current folder (`NoDefaultCurrentDirectoryInExePath`). The same as a
/// language server is started with — see `harden` in ul-lsp.
fn harden(command: &mut Command) {
    harden_with(command, std::env::var_os("PATH"));
}

/// The same, with the PATH it starts from given.
fn harden_with(command: &mut Command, path: Option<std::ffi::OsString>) {
    if let Some(path) = path {
        let absolute = std::env::split_paths(&path).filter(|entry| entry.is_absolute());
        // One that cannot be put back together leaves no PATH, not the old one.
        command.env("PATH", std::env::join_paths(absolute).unwrap_or_default());
    }
    #[cfg(windows)]
    command.env("NoDefaultCurrentDirectoryInExePath", "1");
}

/// The command LibreOffice is started with, apart from the start so the
/// environment it is given can be checked.
fn soffice_command(backend: &Backend, source: &Path, outdir: &Path, profile: &Path) -> Command {
    let mut command = Command::new(&backend.path);
    harden(&mut command);
    command.args(arguments(source, outdir, profile));
    command
}

/// What the output of a conversion is called.
///
/// LibreOffice names it after the input with the extension replaced, in the
/// directory it was given — there is no way to ask for a name, so the name has
/// to be predicted in order to be waited for.
pub fn output_name(source: &Path) -> String {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "converted".to_string());
    format!("{stem}.pdf")
}

/// The arguments, built where they can be read and checked.
///
/// `profile` is a directory of its own for this run. Without it the command
/// reaches whichever instance already holds the user's profile, and a
/// LibreOffice that is showing somebody a document accepts the job and does
/// nothing with it — exit code 0, no file, no message.
pub fn arguments(source: &Path, outdir: &Path, profile: &Path) -> Vec<String> {
    vec![
        format!("-env:UserInstallation={}", file_url(profile)),
        "--headless".to_string(),
        "--norestore".to_string(),
        "--invisible".to_string(),
        "--nolockcheck".to_string(),
        "--nodefault".to_string(),
        "--nofirststartwizard".to_string(),
        "--convert-to".to_string(),
        "pdf".to_string(),
        "--outdir".to_string(),
        outdir.to_string_lossy().into_owned(),
        source.to_string_lossy().into_owned(),
    ]
}

/// A path as LibreOffice wants it in `-env:` — a URL, with the separators the
/// URL form uses even on Windows.
pub fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if text.starts_with('/') {
        format!("file://{text}")
    } else {
        format!("file:///{text}")
    }
}

/// Converts one file to PDF and returns where the PDF is.
///
/// The output directory is the caller's business: this writes one file into it
/// and nothing else. Nothing is ever written beside the original — a program
/// that leaves a PDF next to somebody's drawing without being asked is a
/// program that litters.
///
/// `profile` is the LibreOffice user profile this run uses, and the caller
/// keeps it somewhere nobody else can write: the profile is where macro
/// security and every other setting of that LibreOffice live, so a profile
/// somebody planted is a LibreOffice that runs their macros in the document.
/// It is apart from `outdir` for that reason — the PDF is handed to the
/// interface to open, the profile never is.
pub fn to_pdf(
    backend: &Backend,
    source: &Path,
    outdir: &Path,
    profile: &Path,
    timeout: Duration,
) -> Result<PathBuf, ConvertError> {
    if !source.is_file() {
        return Err(ConvertError::NoSource(
            source.to_string_lossy().into_owned(),
        ));
    }
    std::fs::create_dir_all(outdir)?;

    let expected = outdir.join(output_name(source));
    // A stale file from a previous run would be mistaken for this run's answer.
    let _ = std::fs::remove_file(&expected);

    let child = soffice_command(backend, source, outdir, profile)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| ConvertError::Start(err.to_string()))?;
    watch(child, &expected, timeout)
}

/// How much of what LibreOffice says is kept for the message: a reason is in
/// the first lines, and the rest is not worth the memory.
const KEPT: usize = 64 * 1024;

/// A pipe read to its end on a thread of its own from the moment the process
/// starts, keeping the first `KEPT` bytes.
///
/// Read at the end instead, a pipe fills while nobody is reading it — 4 KiB on
/// Windows, 64 on Linux — and a LibreOffice with that much to say about a
/// document blocks on its next write, produces nothing, and is killed at the
/// timeout two minutes later with its reason still in the pipe. What has been
/// read is shared rather than joined: on Windows the launcher hands the pipe to
/// the real process, which may hold it open long after the launcher has gone.
fn drain(pipe: Option<impl Read + Send + 'static>) -> Arc<Mutex<Vec<u8>>> {
    let kept = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut pipe) = pipe {
        let into = Arc::clone(&kept);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(read) = pipe.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                let mut kept = into.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                let room = KEPT.saturating_sub(kept.len());
                kept.extend_from_slice(&buffer[..read.min(room)]);
            }
        });
    }
    kept
}

fn said(kept: &Arc<Mutex<Vec<u8>>>) -> String {
    let kept = kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    String::from_utf8_lossy(&kept).trim().to_string()
}

/// Waits for LibreOffice's answer, which is a file rather than an exit code.
fn watch(mut child: Child, expected: &Path, timeout: Duration) -> Result<PathBuf, ConvertError> {
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    /*
     * The file is what is waited for, not the process. On Windows the process
     * that was started is a launcher and has usually exited before the work
     * begins; everywhere, the exit code is 0 for a file it could not read. So:
     * poll for the output, and treat the process ending without one as the
     * refusal it is — with whatever it wrote on the way out, since that is the
     * only place a reason is ever given.
     */
    let deadline = Instant::now() + timeout;
    loop {
        if expected.is_file()
            && std::fs::metadata(expected)
                .map(|m| m.len() > 0)
                .unwrap_or(false)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(expected.to_path_buf());
        }

        match child.try_wait() {
            Ok(Some(_)) => {
                /* One more look before giving up: the file may have appeared in
                the same moment the process ended. */
                std::thread::sleep(Duration::from_millis(250));
                if expected.is_file() {
                    return Ok(expected.to_path_buf());
                }
                let said = match said(&stderr) {
                    text if text.is_empty() => said(&stdout),
                    text => text,
                };
                return Err(ConvertError::Refused(if said.is_empty() {
                    "nothing".to_string()
                } else {
                    said.chars().take(300).collect()
                }));
            }
            Ok(None) => {}
            Err(err) => return Err(ConvertError::Start(err.to_string())),
        }

        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ConvertError::Timeout(timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not a check of its own: the noisy child the next test starts — this
    /// same test binary, asked for this one test, with the variable set.
    #[test]
    fn noisy_child() {
        if std::env::var_os("UL_CONVERT_NOISY_CHILD").is_some() {
            use std::io::Write;
            let line = [b'x'; 1024];
            let mut err = std::io::stderr().lock();
            for _ in 0..1024 {
                let _ = err.write_all(&line);
            }
            std::process::exit(3);
        }
    }

    #[test]
    fn a_libreoffice_with_a_lot_to_say_is_heard_rather_than_left_to_time_out() {
        /* A megabyte on stderr and no file: the refusal it is, at once, with
        the start of what it said. With its pipes read only at the end it
        filled them, blocked on the next write, and was killed at the timeout
        with its reason still inside. */
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::noisy_child", "--nocapture"])
            .env("UL_CONVERT_NOISY_CHILD", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let nowhere = std::env::temp_dir().join("ul-convert-never-written.pdf");
        let started = Instant::now();
        match watch(child, &nowhere, Duration::from_secs(20)) {
            Err(ConvertError::Refused(said)) => {
                assert!(said.starts_with("xxxx"), "{}", &said[..said.len().min(80)]);
                assert!(
                    started.elapsed() < Duration::from_secs(10),
                    "{:?}",
                    started.elapsed()
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn libreoffice_is_started_with_nothing_relative_to_look_in() {
        /* The command the conversion really uses, not `harden` on its own. */
        let backend = Backend {
            path: "soffice".to_string(),
            formats: Vec::new(),
        };
        let here = Path::new("x");
        let command = soffice_command(&backend, here, here, here);
        let envs: Vec<_> = command.get_envs().collect();
        let path = envs
            .iter()
            .find(|(key, _)| *key == "PATH")
            .and_then(|(_, value)| *value);
        if let Some(path) = path {
            assert!(std::env::split_paths(path).all(|entry| entry.is_absolute()));
        }
        if cfg!(windows) {
            assert!(envs.iter().any(|(key, value)| {
                *key == "NoDefaultCurrentDirectoryInExePath" && *value == Some("1".as_ref())
            }));
        }
    }

    #[test]
    fn whatever_path_it_starts_from_only_absolute_entries_are_passed_on() {
        let messy = std::env::join_paths([
            std::path::PathBuf::from("."),
            std::path::PathBuf::from("relative"),
            std::env::temp_dir(),
        ])
        .unwrap();
        let mut probe = Command::new("probe");
        harden_with(&mut probe, Some(messy));
        let path = probe
            .get_envs()
            .find(|(key, _)| *key == "PATH")
            .and_then(|(_, value)| value)
            .unwrap();
        let entries: Vec<_> = std::env::split_paths(path).collect();
        assert_eq!(entries, vec![std::env::temp_dir()]);
    }

    #[test]
    fn only_an_absolute_path_entry_is_looked_in() {
        let absolute = if cfg!(windows) {
            r"C:\Program Files\LibreOffice\program"
        } else {
            "/usr/bin"
        };
        let path = std::env::join_paths([".", "", "relative/bin", absolute]).unwrap();
        let looked = on_path_in(&path);
        assert!(!looked.is_empty());
        assert!(
            looked.iter().all(|candidate| candidate.is_absolute()),
            "{looked:?}"
        );
    }

    #[test]
    fn the_first_candidate_that_exists_wins() {
        let candidates = vec![
            PathBuf::from("/nowhere/soffice"),
            PathBuf::from("/somewhere/soffice"),
            PathBuf::from("/elsewhere/soffice"),
        ];
        let found = find_in(&candidates, |path| path.starts_with("/somewhere"));
        assert_eq!(found, Some(PathBuf::from("/somewhere/soffice")));
    }

    #[test]
    fn nothing_installed_is_nothing_found() {
        assert_eq!(find_in(&candidates(), |_| false), None);
    }

    #[test]
    fn windows_prefers_the_console_wrapper() {
        /* The `.exe` is a launcher that returns before the work is done, so the
        `.com` beside it has to be tried first — the whole reason this order
        is written down rather than left to a directory listing. */
        if cfg!(target_os = "windows") {
            let all = candidates();
            let com = all.iter().position(|p| p.ends_with("soffice.com"));
            let exe = all.iter().position(|p| p.ends_with("soffice.exe"));
            assert!(com.is_some() && exe.is_some());
            assert!(com < exe, "{all:?}");
        }
    }

    #[test]
    fn the_output_is_named_after_the_input() {
        assert_eq!(output_name(Path::new("/tmp/plakat.cdr")), "plakat.pdf");
        assert_eq!(output_name(Path::new("/tmp/crtež 2.eps")), "crtež 2.pdf");
        assert_eq!(
            output_name(Path::new("/tmp/noextension")),
            "noextension.pdf"
        );
    }

    #[test]
    fn a_profile_of_its_own_is_asked_for() {
        let args = arguments(
            Path::new("/in/plakat.cdr"),
            Path::new("/out"),
            Path::new("/out/profile"),
        );
        /* Without this the command reaches a LibreOffice that is already open,
        which accepts the job, produces nothing and exits 0. It is the first
        argument because it is the one that must not be forgotten. */
        assert!(
            args[0].starts_with("-env:UserInstallation=file://"),
            "{args:?}"
        );
        assert!(args.contains(&"--headless".to_string()));
        assert!(args.contains(&"--convert-to".to_string()));
        assert!(args.contains(&"pdf".to_string()));
    }

    #[test]
    fn the_source_is_the_last_word() {
        let args = arguments(Path::new("/in/a.cdr"), Path::new("/out"), Path::new("/p"));
        assert_eq!(args.last().unwrap(), "/in/a.cdr");
        let outdir = args.iter().position(|a| a == "--outdir").unwrap();
        assert_eq!(args[outdir + 1], "/out");
    }

    #[test]
    fn a_windows_path_becomes_a_url_with_three_slashes() {
        assert_eq!(
            file_url(Path::new(r"C:\Users\x\AppData\Local\Temp\p")),
            "file:///C:/Users/x/AppData/Local/Temp/p"
        );
        assert_eq!(file_url(Path::new("/tmp/p")), "file:///tmp/p");
    }

    #[test]
    fn a_file_that_is_not_there_is_refused_before_libreoffice_is_started() {
        let backend = Backend {
            path: "/definitely/not/soffice".to_string(),
            formats: vec![],
        };
        let error = to_pdf(
            &backend,
            Path::new("/definitely/not/a/drawing.cdr"),
            Path::new("/tmp/ul-convert-test"),
            Path::new("/tmp/ul-convert-test-profile"),
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(matches!(error, ConvertError::NoSource(_)), "{error}");
    }

    /**
     * The whole pipeline against the real thing.
     *
     * `#[ignore]` rather than a self-skip: a test that passes on a machine
     * without LibreOffice is a test that lies, and this repository has already
     * been bitten once by a check whose only failure mode was a pass. CI has no
     * office suite, so this is run by hand — `cargo test -p ul-convert --
     * --ignored` — on a machine that has one.
     *
     * The fixture is EPS written out here rather than a file in the repository:
     * PostScript is text, so there is nothing binary to commit, and LibreOffice
     * takes it through libcdr's sibling path — the same `draw_pdf_Export` filter
     * a `.cdr` goes through.
     */
    #[test]
    #[ignore = "needs LibreOffice installed; run with: cargo test -p ul-convert -- --ignored"]
    fn a_real_libreoffice_turns_postscript_into_a_pdf() {
        let Some(backend) = backend() else {
            panic!(
                "LibreOffice was not found — this test is only meaningful where it is installed"
            );
        };

        let dir = std::env::temp_dir().join("ul-convert-live");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let source = dir.join("proba.eps");
        std::fs::write(
            &source,
            b"%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 200 100
              /Helvetica findfont 18 scalefont setfont
              20 50 moveto (Pozdrav iz EPS-a) show
              0 0 1 setrgbcolor 20 20 160 15 rectfill
showpage
%%EOF
"
            .as_ref(),
        )
        .unwrap();

        let out = dir.join("out");
        let profile = dir.join("profile");
        let pdf = to_pdf(&backend, &source, &out, &profile, Duration::from_secs(180)).unwrap();

        assert_eq!(pdf.file_name().unwrap(), "proba.pdf");
        let bytes = std::fs::read(&pdf).unwrap();
        assert!(
            bytes.starts_with(b"%PDF"),
            "not a PDF: {:?}",
            &bytes[..8.min(bytes.len())]
        );
        // A page of nothing is about a kilobyte; a drawing is not.
        assert!(
            bytes.len() > 3000,
            "{} bytes — suspiciously empty",
            bytes.len()
        );

        /* And the profile really was its own, which is the argument that stops
        this failing whenever somebody has LibreOffice open. */
        assert!(profile.exists());
        assert!(!out.join("profile").exists());
    }

    #[test]
    fn the_formats_are_the_ones_with_no_reader_of_their_own() {
        // Everything else in this program is read without an office suite, and
        // adding one here would mean a document that opens differently depending
        // on what somebody has installed.
        assert_eq!(FORMATS.len(), 4);
        for format in ["cdr", "eps", "ps", "ai"] {
            assert!(FORMATS.contains(&format), "{format}");
        }
        for format in ["odt", "ods", "docx", "xlsx", "pdf", "rtf", "doc"] {
            assert!(
                !FORMATS.contains(&format),
                "{format} has a reader of its own"
            );
        }
    }
}
