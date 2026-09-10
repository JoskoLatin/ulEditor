//! What is written down when ulEditor dies, and why it is written this way.
//!
//! This program is built with `panic = "abort"`. A panic is therefore not an
//! error that propagates — it is the last thing that happens. There is no
//! unwinding, no `Drop`, no chance for the window to say anything, and the
//! binary is linked for the Windows GUI subsystem, so the message Rust prints to
//! stderr goes to a console that does not exist. **Without a hook, ulEditor
//! vanishes and leaves nothing anywhere.** That is the state this file ends.
//!
//! Three constraints shape every line of it, and all three were measured rather
//! than assumed.
//!
//! **The hook must take no lock.** `std::sync::Mutex` is not reentrant and the
//! hook runs on the thread that panicked — which, in this program, may be a
//! thread holding the very lock a richer report would want: `with_workspace`
//! holds the workspace across a search whose worker threads are joined with an
//! `expect`. A hook that locked it would not abort; it would *hang*, and a
//! frozen window that only the task manager can end is strictly worse than the
//! crash it replaced. So the hook reads one `OnceLock` that was filled before
//! any of this could go wrong, and nothing else.
//!
//! **The hook cannot ask Tauri anything.** `app.path().app_log_dir()` needs an
//! `AppHandle`, and the first one exists inside `setup()` — by which point the
//! plugins have initialised, the context has been generated and the builder has
//! run its own `expect`. Those are exactly the failures that make a program
//! refuse to start at all, which is the most common report any desktop
//! application gets. So the directory is computed here, from `LOCALAPPDATA` and
//! the identifier, which is byte for byte what Tauri's own formula builds — and
//! the hook is installed first, before anything else in `run()`.
//!
//! **There is no backtrace.** The release profile sets `strip = true` and ships
//! no PDB, and every captured frame comes back `<unknown>` — including
//! ulEditor's own. What survives is the payload and `location()`: a file, a line
//! and the message, which is what a fix is actually made from.
//!
//! Two crashes still leave nothing here, and both were measured: a **stack
//! overflow** prints `thread 'main' has overflowed its stack` and never calls
//! the hook, and an **allocation failure** aborts the same way. So an empty
//! folder after a crash is a real state rather than a claim that nothing went
//! wrong, and it is worth saying that out loud somewhere a person will read it.
//!
//! And nothing here reaches the network. A report is a file, in a program whose
//! job is opening files.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Must match `identifier` in `tauri.conf.json`; `tools/verify-crash.mjs` says so.
const IDENTIFIER: &str = "org.uleditor.app";

/// How many reports are kept. Trimmed at startup, never inside the hook.
const KEEP: usize = 20;

/// Resolved before the hook is installed, so the hook only ever reads it.
static FOLDER: OnceLock<PathBuf> = OnceLock::new();

/// Where Tauri would put a log directory, worked out without Tauri.
fn resolve_folder() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
    }?;
    Some(base.join(IDENTIFIER).join("logs"))
}

/// The folder reports live in, whether or not it exists yet.
pub fn folder() -> Option<&'static Path> {
    FOLDER.get().map(PathBuf::as_path)
}

fn millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Writes one report and answers with where it went.
///
/// The name carries the process id as well as the time. Two threads panicking
/// in the same millisecond is not a thought experiment — a scan that trips over
/// the same malformed character in several files does it — and `create_new`
/// turns the collision into a second file rather than a first one truncated to
/// nothing.
pub fn write(text: &str) -> std::io::Result<PathBuf> {
    let folder = folder().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "no crash folder was resolved")
    })?;
    write_into(folder, text)
}

fn write_into(folder: &Path, text: &str) -> std::io::Result<PathBuf> {
    fs::create_dir_all(folder)?;

    let stamp = millis();
    let pid = std::process::id();
    for attempt in 0..8u32 {
        let name = if attempt == 0 {
            format!("crash-{stamp}-{pid}.txt")
        } else {
            format!("crash-{stamp}-{pid}-{attempt}.txt")
        };
        let path = folder.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(text.as_bytes())?;
                return Ok(path);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "eight reports in the same millisecond",
    ))
}

/// Installs the panic hook. Call this first, before anything that can fail.
pub fn install() {
    let _ = FOLDER.set(match resolve_folder() {
        Some(path) => path,
        None => return,
    });

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        /* Everything in here reads; nothing locks, nothing calls into Tauri, and
        nothing touches a directory listing. The trim happens at startup, where
        the process is healthy enough to afford it. */
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "a panic with no message".to_owned());

        let where_ = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "an unknown place".to_owned());

        let thread = std::thread::current();
        let text = format!(
            "ulEditor — the program stopped\n\
             when:     {} (unix ms)\n\
             where:    {where_}\n\
             thread:   {}\n\
             version:  {}\n\
             \n\
             panic: {payload}\n\
             \n\
             There is no backtrace here on purpose: the release build is stripped\n\
             and ships no symbols, so every frame would read <unknown>. The file\n\
             and line above are what a fix is made from.\n",
            millis(),
            thread.name().unwrap_or("unnamed"),
            env!("CARGO_PKG_VERSION"),
        );

        let _ = write(&text);
        previous(info);
    }));
}

/// The reports the person has not been told about yet, oldest first.
///
/// "Not told about" is the modification time of a marker file this touches on
/// the way out. A file rather than a setting, because the reports are files: one
/// folder holds the whole state, and deleting it is a complete reset.
pub fn unseen() -> Vec<PathBuf> {
    match folder() {
        Some(folder) => unseen_in(folder),
        None => Vec::new(),
    }
}

fn unseen_in(folder: &Path) -> Vec<PathBuf> {
    let marker = folder.join("last-seen");
    let since = fs::metadata(&marker).and_then(|m| m.modified()).ok();

    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };

    let mut found: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("crash-") && name.ends_with(".txt"))
        })
        .filter_map(|entry| {
            let when = entry.metadata().and_then(|m| m.modified()).ok()?;
            match since {
                Some(seen) if when <= seen => None,
                _ => Some((when, entry.path())),
            }
        })
        .collect();

    found.sort_by_key(|(when, _)| *when);

    if !found.is_empty() {
        // Touched only when there was something to say, so a quiet start changes nothing.
        let _ = fs::write(&marker, b"");
    }

    found.into_iter().map(|(_, path)| path).collect()
}

/// Keeps the newest `KEEP` reports and removes the rest.
///
/// At startup, deliberately. Inside the hook it would mean a directory sweep on
/// a process that is already dying — measured at 193 ms with two thousand files,
/// which is a long time to spend inside a crash — and it is the one thing here
/// that can safely wait until the program is healthy again.
pub fn trim() {
    if let Some(folder) = folder() {
        trim_in(folder, KEEP);
    }
}

fn trim_in(folder: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };

    let mut found: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("crash-") && name.ends_with(".txt"))
        })
        .filter_map(|entry| {
            let when = entry.metadata().and_then(|m| m.modified()).ok()?;
            Some((when, entry.path()))
        })
        .collect();

    if found.len() <= keep {
        return;
    }
    found.sort_by_key(|(when, _)| *when);
    for (_, path) in found.iter().take(found.len() - keep) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own per test — the resolved one is a global, and these
    /// would otherwise write into the machine's real report folder.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ul-crash-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a scratch folder");
        dir
    }

    #[test]
    fn a_second_report_in_the_same_millisecond_does_not_erase_the_first() {
        let dir = scratch("collision");

        /* The case is real rather than theoretical: a scan whose worker threads
        trip over the same malformed byte panics on several of them at once, and
        a name made only of the clock would have one report truncating another. */
        let first = write_into(&dir, "the first thread").expect("the first report");
        let second = write_into(&dir, "the second thread").expect("the second report");

        assert_ne!(first, second, "two reports must not share a name");
        assert_eq!(fs::read_to_string(&first).unwrap(), "the first thread");
        assert_eq!(fs::read_to_string(&second).unwrap(), "the second thread");
    }

    #[test]
    fn the_folder_is_made_if_it_is_not_there() {
        // The first crash on a machine that has never crashed: nothing exists yet.
        let dir = scratch("mkdir").join("logs");
        assert!(!dir.exists());

        let path = write_into(&dir, "hello").expect("a report in a folder that had to be made");
        assert!(path.exists());
    }

    #[test]
    fn the_oldest_reports_go_and_the_newest_stay() {
        let dir = scratch("trim");
        let mut written = Vec::new();
        for i in 0..6 {
            written.push(write_into(&dir, &format!("report {i}")).expect("a report"));
            // Distinct modification times, which is what the order is taken from.
            std::thread::sleep(std::time::Duration::from_millis(12));
        }

        trim_in(&dir, 2);

        let left: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("crash-"))
            .collect();
        assert_eq!(left.len(), 2, "two kept");
        assert!(written[5].exists(), "the newest is one of them");
        assert!(!written[0].exists(), "the oldest is gone");
    }

    #[test]
    fn a_report_is_announced_once_and_then_not_again() {
        let dir = scratch("unseen");
        write_into(&dir, "something broke").expect("a report");

        let first = unseen_in(&dir);
        assert_eq!(first.len(), 1, "the report is new");

        /* The whole point of the marker: the window reloads when the language
        changes, and without it the same crash would be announced every time. */
        let again = unseen_in(&dir);
        assert!(again.is_empty(), "and it is not new twice");

        std::thread::sleep(std::time::Duration::from_millis(12));
        write_into(&dir, "and again").expect("a second report");
        assert_eq!(unseen_in(&dir).len(), 1, "but a later one is");
    }

    #[test]
    fn a_folder_that_is_not_there_answers_with_nothing_rather_than_failing() {
        let dir = std::env::temp_dir().join("ul-crash-never-made-at-all");
        let _ = fs::remove_dir_all(&dir);
        assert!(unseen_in(&dir).is_empty());
        trim_in(&dir, 1); // must not panic
    }
}
