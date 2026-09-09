//! The client against a real language server.
//!
//! `#[ignore]` rather than a self-skip, for the same reason the LibreOffice test
//! is: a test that passes on a machine without the server is a test that lies,
//! and this repository has already been bitten once by a check whose only
//! failure mode was a pass. CI installs no language servers, so this is run by
//! hand where one exists:
//!
//!     cargo test -p ul-lsp -- --ignored --nocapture
//!
//! **One test rather than two**, and that is not tidiness. There were two, and
//! cargo runs tests in parallel: the second took a hundred and twenty seconds
//! to do what it does in three when it runs alone, because two rust-analyzers
//! on one machine contend for a cache neither will share. One scenario with one
//! server is also what an editor actually does.
//!
//! What it proves is the part no unit test can: that the handshake is accepted,
//! that a real server's framing is read the way this client reads it, that the
//! server's own questions are answered — leave one unanswered and it stops
//! publishing anything at all — and that what comes back lands on the line the
//! mistake is on, and stops coming back once the mistake is gone.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use ul_lsp::{Event, Server, Severity};

fn project() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ul-lsp-live-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("src")).unwrap();

    /* A crate of its own, outside this workspace: rust-analyzer runs
    `cargo metadata`, and a directory inside another workspace that is not one
    of its members is a project cargo refuses to describe. */
    std::fs::write(
        dir.join("Cargo.toml"),
        "[package]\nname = \"proba\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\n",
    )
    .unwrap();
    dir
}

#[test]
#[ignore = "needs rust-analyzer installed; run with: cargo test -p ul-lsp -- --ignored"]
fn a_mistake_is_reported_where_it_is_and_cleared_when_it_goes() {
    let root = project();
    let file = root.join("src").join("main.rs");

    let broken = "fn main() {\n    let broken = ;\n}\n";
    std::fs::write(&file, broken).unwrap();

    let (sink, events) = mpsc::channel();
    /*
     * `checkOnSave` off, and this is the finding that took longest.
     *
     * With it on, the interesting half of this test — a corrected file being
     * reported as corrected — passed or timed out depending on the run.
     * rust-analyzer's `cargo check` blocks on `~/.cargo/.package-cache`, and a
     * test that runs under `cargo test` is holding that lock: the flycheck run
     * waits for the test, and the test waits for the flycheck run. Nothing in
     * the client was wrong, and no amount of staring at the client would have
     * shown it.
     *
     * Off, the server's own analysis answers instead — which is what the client
     * is being tested against. `didSave` is still sent below, because a client
     * that stopped sending it would break the compiler's diagnostics for real
     * people, and that is checked by the message the notification carries
     * rather than by what a locked cargo does with it.
     */
    let mut server = Server::start_with(
        "rust",
        &root,
        sink,
        Duration::from_secs(60),
        serde_json::json!({ "checkOnSave": false }),
    )
    .expect("rust-analyzer has to start and answer the handshake");
    server
        .open(&file, "rust", broken)
        .expect("telling it about the file cannot fail locally");

    /* The same file, whatever the server calls it: a path this test wrote as
    `C:\…` comes back as `file:///c:/…`, and the difference is a drive letter
    rather than a different document. */
    let same = |uri: &str| {
        ul_lsp::path_of_url(uri).is_some_and(|path| {
            let normalise = |text: String| text.to_lowercase().replace('\\', "/");
            normalise(path.to_string_lossy().into_owned())
                == normalise(file.to_string_lossy().into_owned())
        })
    };

    /* Two minutes for the first answer: rust-analyzer loads the sysroot and
    runs `cargo check` before it says anything, and on a cold cache that is
    most of a minute. */
    let wait_for = |want_errors: bool| -> Option<Vec<ul_lsp::Diagnostic>> {
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            match events.recv_timeout(Duration::from_secs(5)) {
                Ok(Event::Diagnostics { published, .. }) if same(&published.uri) => {
                    let has_error = published
                        .diagnostics
                        .iter()
                        .any(|d| d.severity == Severity::Error);
                    println!(
                        "publication: {} diagnostic(s), errors: {has_error}",
                        published.diagnostics.len()
                    );
                    if has_error == want_errors {
                        return Some(published.diagnostics);
                    }
                }
                Ok(Event::Stopped { language, detail }) => {
                    panic!("{language} stopped: {detail}");
                }
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return None,
            }
        }
        None
    };

    let reported = wait_for(true).expect("no diagnostic arrived within two minutes");
    let error = reported
        .iter()
        .find(|d| d.severity == Severity::Error)
        .expect("the publication had to carry one");
    println!("rust-analyzer said: {}", error.message);

    // The mistake is on the second line, and one-based is what the editor uses.
    assert_eq!(error.line, 2, "{error:?}");
    assert!(error.column >= 1, "columns are one-based too: {error:?}");
    assert!(!error.message.is_empty());

    /* And now the other half, which is the one easy to get wrong: a publication
    *replaces* what was said before, and an empty list is how a server says
    "fixed". A client that merged instead would leave every corrected error on
    the screen for as long as the file stayed open. */
    let fixed = "fn main() {\n    let fixed = 1;\n    println!(\"{fixed}\");\n}\n";
    std::fs::write(&file, fixed).unwrap();
    server.change(&file, 2, fixed).unwrap();
    /* Saved, because that is the notification that makes `cargo check` run
    again — and this is how the test found that `didSave` had been declared
    away in the client's own capabilities. */
    server.save(&file).unwrap();

    let cleared = wait_for(false)
        .expect("the correction was never reported — an underline would have stayed forever");
    assert!(
        !cleared.iter().any(|d| d.severity == Severity::Error),
        "{cleared:?}"
    );

    server.stop();
}
