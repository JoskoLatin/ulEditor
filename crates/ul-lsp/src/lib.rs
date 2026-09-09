//! A Language Server Protocol client — the half of an editor that knows what
//! the code *means* rather than what it looks like.
//!
//! **What this does and does not do.** It starts a language server, tells it
//! which files are open and what is in them, and passes on what the server says
//! about them. That is diagnostics: the underline under a mistake, with the
//! compiler's own words. Hover, go-to-definition and completion are the same
//! plumbing asked different questions, and they are not here yet — the plumbing
//! was the work, and one answer arriving correctly is worth more than four
//! arriving nearly.
//!
//! **Nothing is bundled.** A language server is somebody else's program, often
//! a large one, and installing it is a decision about the machine rather than
//! about this editor: rust-analyzer through rustup, `typescript-language-server`
//! through npm, pyright through pip. Where one is not installed, the editor
//! colours the code as it always did and says nothing further. Where one is, it
//! is started for the workspace that was opened, not for the file — every
//! server worth using needs the project to make sense of the file.
//!
//! **Why the process handling is written out rather than taken from a crate.**
//! The protocol is a header, a blank line and some JSON; the difficulty is not
//! the parsing but the lifecycle, and a crate that owns an async runtime would
//! have to be reconciled with Tauri's. What is here is a thread per server
//! reading its output, and a mutex around the writing.

mod protocol;

/// Whether to print the conversation, for when a server does something
/// inexplicable.
///
/// `UL_LSP_TRACE=1` and every message in both directions goes to standard
/// error, truncated. It exists because the first day of this client was spent
/// on a change the server discarded in silence, and reading the traffic was the
/// only way to see that it had — a protocol client without a way to watch it is
/// a protocol client debugged by guesswork.
fn tracing() -> bool {
    std::env::var_os("UL_LSP_TRACE").is_some()
}

fn trace(direction: &str, text: &str) {
    if !tracing() {
        return;
    }
    let shown: String = text.chars().take(400).collect();
    eprintln!("[lsp {direction}] {shown}");
}

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use protocol::{file_url, path_of_url, published_diagnostics, Diagnostic, Published, Severity};
use protocol::{frame, take_message, Taken};

#[derive(Debug, Error)]
pub enum LspError {
    #[error("no language server is installed for {0}")]
    NoServer(String),
    #[error("{0} could not be started: {1}")]
    Start(String, String),
    #[error("{0} did not answer within {1} seconds")]
    Handshake(String, u64),
    #[error("the connection to {0} broke: {1}")]
    Broken(String, String),
    #[error("input/output error: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for LspError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// A server, and how to start it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
}

/// What a language is served by, if anything.
///
/// The names are the ones each project publishes, and the arguments are the
/// ones that put it on standard input and output rather than a socket. Only
/// languages whose servers are worth the machine they run on are here: a
/// server for JSON exists and tells you that a comma is missing, which
/// CodeMirror already does for free.
pub fn known_launch(language: &str) -> Option<Launch> {
    let launch = |program: &str, args: &[&str]| Launch {
        program: program.to_string(),
        args: args.iter().map(|a| (*a).to_string()).collect(),
    };

    match language {
        "rust" => Some(launch("rust-analyzer", &[])),
        "typescript" | "javascript" => Some(launch("typescript-language-server", &["--stdio"])),
        "python" => Some(launch("pyright-langserver", &["--stdio"])),
        _ => None,
    }
}

/// Where a server binary might be, beyond the PATH.
///
/// rustup puts rust-analyzer in `~/.cargo/bin`, which is on the PATH of a shell
/// that has been through the rustup profile and is *not* on the PATH of an
/// application started from a desktop icon on macOS. That difference is why
/// this list exists: the same machine has the server or does not depending on
/// how the program was started, which is not a difference anybody should have
/// to think about.
fn extra_directories() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        out.push(home.join(".cargo").join("bin"));
        out.push(home.join(".local").join("bin"));
        out.push(home.join("AppData").join("Roaming").join("npm"));
    }
    out
}

/// The server for a language, if this machine has one.
pub fn find_server(language: &str) -> Option<Launch> {
    let mut launch = known_launch(language)?;

    if which(&launch.program).is_some() {
        return Some(launch);
    }

    /* Tried with the extensions Windows requires, since `soffice` and
    `rust-analyzer` are `soffice.com` and `rust-analyzer.exe` there and a
    bare name finds neither when the PATH is not consulted. */
    for directory in extra_directories() {
        for name in candidate_names(&launch.program) {
            let path = directory.join(&name);
            if path.is_file() {
                launch.program = path.to_string_lossy().into_owned();
                return Some(launch);
            }
        }
    }

    None
}

fn candidate_names(program: &str) -> Vec<String> {
    if cfg!(target_os = "windows") {
        vec![
            format!("{program}.exe"),
            format!("{program}.cmd"),
            format!("{program}.bat"),
            program.to_string(),
        ]
    } else {
        vec![program.to_string()]
    }
}

/// Whether a program is on the PATH — `which`, without a dependency.
fn which(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        for name in candidate_names(program) {
            let candidate = directory.join(&name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// One message down the pipe, from whichever thread has something to say.
fn write_message(stdin: &Arc<Mutex<ChildStdin>>, payload: &str) -> Result<(), LspError> {
    trace("out", payload);
    let mut stdin = stdin
        .lock()
        .map_err(|_| LspError::Broken("the server".into(), "the write lock is poisoned".into()))?;
    stdin.write_all(&frame(payload))?;
    stdin.flush()?;
    Ok(())
}

/// Answers a request this client does not implement.
///
/// **Everything with an id gets an answer**, and that is the rule rather than a
/// courtesy: a server that asked and heard nothing waits, and a waiting server
/// publishes nothing. `null` is the right answer where the result type is void
/// — `workspace/diagnostic/refresh` is one, and it is the one rust-analyzer
/// sends within a second of starting. For anything else, "method not found" is
/// both true and what the protocol has a number for.
fn answer_request(stdin: &Arc<Mutex<ChildStdin>>, id: &serde_json::Value, method: &str) {
    const VOID: [&str; 4] = [
        "workspace/diagnostic/refresh",
        "workspace/semanticTokens/refresh",
        "workspace/inlayHint/refresh",
        "workspace/codeLens/refresh",
    ];

    let response = if VOID.contains(&method) || method == "client/registerCapability" {
        serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": serde_json::Value::Null })
    } else if method == "workspace/configuration" {
        /* One `null` per item asked about: no configuration of our own, which
        is a real answer rather than a refusal — the server then uses its own
        defaults instead of waiting. */
        serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": [serde_json::Value::Null] })
    } else {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("ulEditor does not implement {method}") }
        })
    };

    let _ = write_message(stdin, &response.to_string());
}

/// Where a document ends, as a position the protocol understands.
///
/// **Lines are counted from zero and characters in UTF-16 code units**, which
/// is the protocol's one genuinely awkward decision: `č` is one code unit and
/// one character, `😀` is two code units and one character, and a client that
/// counted characters would be right about Croatian and wrong about an emoji.
/// Counted properly here, because this position is the end of a replacement
/// range — get it short and the tail of the file survives the edit twice.
fn end_of(text: &str) -> (u32, u32) {
    let mut line = 0u32;
    let mut last = "";
    for (index, content) in text.split('\n').enumerate() {
        line = index as u32;
        last = content;
    }
    let column = last.encode_utf16().count() as u32;
    (line, column)
}

/// What the editor hears from a server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Event {
    /// Everything the server has to say about one file, replacing what it said
    /// before — including nothing at all, which is how it says "fixed".
    Diagnostics {
        language: String,
        published: Published,
    },
    /// The server stopped. Not necessarily an error: it is also what happens on
    /// the way out.
    Stopped { language: String, detail: String },
}

/// One running language server.
pub struct Server {
    language: String,
    root: PathBuf,
    child: Child,
    /// Shared, because **a server asks questions too**.
    ///
    /// This was the second thing that cost an afternoon. rust-analyzer sends
    /// `workspace/diagnostic/refresh` — a *request*, with an id, expecting an
    /// answer — and a client that only ever listened left it unanswered. The
    /// server then stopped publishing anything at all: no error, no complaint,
    /// diagnostics simply never arrived again after the first change. So the
    /// thread that reads has to be able to write, and the mutex is what lets
    /// two threads share one pipe.
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: u64,
    /// Documents this server has been told about, and where each one ended when
    /// it was last told. The end is what the next change replaces up to.
    open: HashMap<PathBuf, (u32, u32)>,
}

impl Server {
    /// Starts a server for a language and a workspace, and completes the
    /// handshake before returning.
    ///
    /// The handshake is synchronous on purpose. The protocol forbids sending
    /// anything before the answer to `initialize` arrives, and a client that
    /// fired `didOpen` immediately would have it ignored — silently, since a
    /// server that is not ready has nothing to say about a file it has not
    /// accepted. So the response is waited for here, and only then is the
    /// output handed to the thread that reads it from now on.
    pub fn start(
        language: &str,
        root: &Path,
        sink: Sender<Event>,
        timeout: Duration,
    ) -> Result<Self, LspError> {
        Self::start_with(language, root, sink, timeout, serde_json::Value::Null)
    }

    /// The same, with settings for the server.
    ///
    /// `initializationOptions` is where a server takes its own configuration,
    /// and every server takes a different shape of it — rust-analyzer's is the
    /// whole of what an editor's settings screen would offer. Nothing is passed
    /// by default: a person's project is theirs, and a client that quietly
    /// overrode a setting would be a client to be fought.
    ///
    /// The tests use it to turn `checkOnSave` off, for a reason worth writing
    /// down: `cargo check` blocks on `~/.cargo/.package-cache`, and a test that
    /// runs *under* cargo holds that lock — so the flycheck run waits for the
    /// test that is waiting for it. Turning it off leaves the server's own
    /// analysis, which is what the client is being tested against anyway.
    pub fn start_with(
        language: &str,
        root: &Path,
        sink: Sender<Event>,
        timeout: Duration,
        options: serde_json::Value,
    ) -> Result<Self, LspError> {
        let launch =
            find_server(language).ok_or_else(|| LspError::NoServer(language.to_string()))?;

        let mut child = Command::new(&launch.program)
            .args(&launch.args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            /*
             * Piped and drained, never discarded.
             *
             * Discarding it was the first version, on the argument that a
             * server logging faster than anybody reads fills the pipe and
             * blocks. True — and the answer is to read it, not to throw it
             * away. The first machine this ran on had `rust-analyzer` on the
             * PATH as a rustup shim with the component not installed: it
             * printed "Unknown binary 'rust-analyzer.exe' in official
             * toolchain" and exited, and the client could only report that the
             * output closed. The reason was on the stream that had been sent
             * to nowhere.
             */
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| LspError::Start(launch.program.clone(), err.to_string()))?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| LspError::Start(launch.program.clone(), "no standard input".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| LspError::Start(launch.program.clone(), "no standard output".into()))?;

        /* Drained on a thread so the pipe never fills, and the last of it kept
        so that a failure can quote the server rather than describing the
        shape of the silence. */
        let complaints: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            let kept = Arc::clone(&complaints);
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut chunk = [0u8; 4096];
                while let Ok(read) = reader.read(&mut chunk) {
                    if read == 0 {
                        return;
                    }
                    let text = String::from_utf8_lossy(&chunk[..read]);
                    trace("err", text.trim());
                    let Ok(mut kept) = kept.lock() else { return };
                    kept.push_str(&text);
                    /* Only the tail is of any use, and a server that has been
                    running for an hour must not be holding an hour of log. */
                    if kept.len() > 4096 {
                        let cut = kept.len() - 2048;
                        *kept = kept[cut..].to_string();
                    }
                }
            });
        }

        /// What the server said on its way out, for an error message.
        fn said(complaints: &Arc<Mutex<String>>) -> String {
            let text = complaints
                .lock()
                .map(|kept| kept.clone())
                .unwrap_or_default();
            let trimmed = text.trim();
            if trimmed.is_empty() {
                "and said nothing".to_string()
            } else {
                format!(
                    "and said: {}",
                    trimmed.lines().take(3).collect::<Vec<_>>().join(" / ")
                )
            }
        }

        let initialize = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": std::process::id(),
                "clientInfo": { "name": "ulEditor" },
                "rootUri": file_url(root),
                "initializationOptions": options,
                "workspaceFolders": [{
                    "uri": file_url(root),
                    "name": root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                }],
                /* Asked for narrowly, because a capability is a promise to
                   handle what comes back. Diagnostics are what this client
                   understands today, and a server told otherwise would send
                   things nobody reads. */
                "capabilities": {
                    "textDocument": {
                        /*
                         * `didSave` is not optional, and declaring it false was
                         * the third thing that cost an afternoon.
                         *
                         * For Rust, most of what a person wants to see comes
                         * from `cargo check` rather than from the server's own
                         * parser — a type error, a borrow error, a missing
                         * trait — and rust-analyzer runs `cargo check` **when
                         * the client says the file was saved**. A client that
                         * never mentions a save gets one set of diagnostics
                         * when the file is opened and never another, which
                         * looks exactly like a server that has died.
                         */
                        "synchronization": { "didSave": true, "dynamicRegistration": false },
                        "publishDiagnostics": { "relatedInformation": false },
                    },
                    "workspace": { "workspaceFolders": true },
                },
            }
        });

        stdin.write_all(&frame(&initialize.to_string()))?;
        stdin.flush()?;

        let mut reader = BufReader::new(stdout);
        let mut buffer: Vec<u8> = Vec::new();
        let deadline = Instant::now() + timeout;
        let mut ready = false;

        while !ready {
            if Instant::now() > deadline {
                let _ = child.kill();
                return Err(LspError::Handshake(
                    launch.program.clone(),
                    timeout.as_secs(),
                ));
            }

            let mut chunk = [0u8; 8192];
            let read = reader.read(&mut chunk)?;
            if read == 0 {
                let _ = child.kill();
                /* The most likely cause is not a protocol failure at all: a
                binary that is on the PATH and cannot run. `rust-analyzer`
                in `~/.cargo/bin` is a rustup shim, and without the component
                installed it prints a line and exits — which is exactly what
                this branch now reports, in the server's own words. */
                return Err(LspError::Broken(
                    launch.program.clone(),
                    format!(
                        "it closed its output during the handshake, {}",
                        said(&complaints)
                    ),
                ));
            }
            buffer.extend_from_slice(&chunk[..read]);

            loop {
                match take_message(&mut buffer) {
                    Taken::Message(text) => {
                        trace("in", &text);
                        /* The answer to `initialize` is the only thing being
                        waited for. Anything else at this point is the
                        server talking about itself, and diagnostics cannot
                        arrive yet because no file has been opened. */
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                            if value.get("id").and_then(|v| v.as_u64()) == Some(1)
                                && value.get("result").is_some()
                            {
                                ready = true;
                                break;
                            }
                        }
                    }
                    Taken::Incomplete => break,
                    Taken::Broken(reason) => {
                        let _ = child.kill();
                        return Err(LspError::Broken(launch.program.clone(), reason));
                    }
                }
            }
        }

        let stdin = Arc::new(Mutex::new(stdin));
        let initialized = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "initialized",
            "params": {}
        });
        write_message(&stdin, &initialized.to_string())?;

        /* From here the output belongs to a thread. It ends when the server
        does, and it says so — a server that dies is a fact the editor has
        to hear, or the underlines simply stop appearing and nobody knows
        why. */
        let language_owned = language.to_string();
        let program = launch.program.clone();
        let answering = Arc::clone(&stdin);
        std::thread::spawn(move || {
            let mut buffer = buffer;
            let mut reader = reader;
            let mut chunk = [0u8; 16384];

            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => {
                        let _ = sink.send(Event::Stopped {
                            language: language_owned.clone(),
                            detail: format!("{program} closed its output, {}", said(&complaints)),
                        });
                        return;
                    }
                    Ok(read) => buffer.extend_from_slice(&chunk[..read]),
                    Err(err) => {
                        let _ = sink.send(Event::Stopped {
                            language: language_owned.clone(),
                            detail: err.to_string(),
                        });
                        return;
                    }
                }

                loop {
                    match take_message(&mut buffer) {
                        Taken::Message(text) => {
                            trace("in", &text);

                            /* A message with both an id and a method is a
                            question, and every question gets an answer —
                            see `answer_request`. A message with an id and no
                            method is an answer to one of ours, and nothing
                            here has asked anything worth waiting for yet. */
                            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                                if let (Some(id), Some(method)) = (
                                    value.get("id"),
                                    value.get("method").and_then(|m| m.as_str()),
                                ) {
                                    answer_request(&answering, id, method);
                                    continue;
                                }
                            }

                            if let Some(published) = published_diagnostics(&text) {
                                if sink
                                    .send(Event::Diagnostics {
                                        language: language_owned.clone(),
                                        published,
                                    })
                                    .is_err()
                                {
                                    return; // nobody is listening any more
                                }
                            }
                        }
                        Taken::Incomplete => break,
                        Taken::Broken(reason) => {
                            let _ = sink.send(Event::Stopped {
                                language: language_owned.clone(),
                                detail: reason,
                            });
                            return;
                        }
                    }
                }
            }
        });

        Ok(Server {
            language: language.to_string(),
            root: root.to_path_buf(),
            child,
            stdin,
            next_id: 2,
            open: HashMap::new(),
        })
    }

    pub fn language(&self) -> &str {
        &self.language
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn notify(&mut self, method: &str, params: serde_json::Value) -> Result<(), LspError> {
        let message = serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params });
        write_message(&self.stdin, &message.to_string())
    }

    fn request(&mut self, method: &str, params: serde_json::Value) -> Result<u64, LspError> {
        let id = self.next_id;
        self.next_id += 1;
        let message = serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        });
        write_message(&self.stdin, &message.to_string())?;
        Ok(id)
    }

    /// Tells the server a file is open, and what is in it.
    pub fn open(&mut self, path: &Path, language_id: &str, text: &str) -> Result<(), LspError> {
        self.notify(
            "textDocument/didOpen",
            serde_json::json!({
                "textDocument": {
                    "uri": file_url(path),
                    "languageId": language_id,
                    "version": 1,
                    "text": text,
                }
            }),
        )?;
        self.open.insert(path.to_path_buf(), end_of(text));
        Ok(())
    }

    /// Tells the server what the file says now.
    ///
    /// **The whole text every time, but sent as a range covering the whole
    /// document.** Those are not the same thing, and the difference cost an
    /// afternoon: a change with no `range` means "replace everything", and a
    /// server may only be sent one if it declared `TextDocumentSyncKind.Full`.
    /// rust-analyzer declares `Incremental`, so it *discarded every change* —
    /// no error to the client, no diagnostic ever again for that file, and an
    /// editor that looked like it worked until the first correction. A range
    /// from the start of the document to where it last ended is valid under
    /// incremental sync and means exactly the same thing.
    ///
    /// Real incremental synchronisation — a range per keystroke — is the other
    /// way, and it requires the client and the server to agree, edit by edit,
    /// about a document neither of them owns. One disagreement puts every
    /// diagnostic on the wrong line until the file is closed. A few kilobytes
    /// down a pipe is cheaper than that class of bug.
    pub fn change(&mut self, path: &Path, version: i64, text: &str) -> Result<(), LspError> {
        let (line, column) = self
            .open
            .get(path)
            .copied()
            /* Nothing was opened, so nothing can be replaced up to: the server
            will refuse the change either way, and pretending the document
            was empty is the closest thing to the truth. */
            .unwrap_or((0, 0));

        self.notify(
            "textDocument/didChange",
            serde_json::json!({
                "textDocument": { "uri": file_url(path), "version": version },
                "contentChanges": [{
                    "range": {
                        "start": { "line": 0, "character": 0 },
                        "end": { "line": line, "character": column },
                    },
                    "text": text,
                }],
            }),
        )?;

        self.open.insert(path.to_path_buf(), end_of(text));
        Ok(())
    }

    /// Tells the server the file was saved.
    ///
    /// This is what makes the compiler's own diagnostics arrive. rust-analyzer
    /// runs `cargo check` on a save and publishes what it says — a type
    /// mismatch, a borrow that outlives its owner, a trait that is not
    /// implemented — none of which its own parser reports. Without this the
    /// editor would show syntax errors and nothing else, and there would be no
    /// way to tell that from a compiler with nothing to complain about.
    ///
    /// The text is not sent: rust-analyzer's `save` options ask for the
    /// notification only, and it reads the file from disk itself. A server that
    /// wanted the text would say so in its capabilities, and sending it
    /// unasked is a megabyte down the pipe for nobody.
    pub fn save(&mut self, path: &Path) -> Result<(), LspError> {
        self.notify(
            "textDocument/didSave",
            serde_json::json!({ "textDocument": { "uri": file_url(path) } }),
        )
    }

    pub fn close(&mut self, path: &Path) -> Result<(), LspError> {
        self.open.remove(path);
        self.notify(
            "textDocument/didClose",
            serde_json::json!({ "textDocument": { "uri": file_url(path) } }),
        )
    }

    /// Asks the server to stop, and makes sure it did.
    ///
    /// The protocol's way out is a `shutdown` request and then an `exit`
    /// notification, and a well-behaved server leaves on its own. Then it is
    /// killed anyway: rust-analyzer with a large project can be busy enough not
    /// to notice for a while, and a language server left running after the
    /// editor closed is a process eating a core in somebody's task manager.
    pub fn stop(mut self) {
        let _ = self.request("shutdown", serde_json::Value::Null);
        let _ = self.notify("exit", serde_json::Value::Null);

        let deadline = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The servers running for one window.
///
/// One per language per workspace root, started when a file of that language is
/// first opened and stopped when the window closes. Not one per file: a server
/// exists to understand a project, and three copies of rust-analyzer indexing
/// the same workspace is three times the memory for the same answer.
#[derive(Default)]
pub struct Servers {
    running: HashMap<(PathBuf, String), Server>,
}

impl Servers {
    pub fn new() -> Self {
        Self::default()
    }

    /// The server for this language and root, started if it is not running.
    pub fn ensure(
        &mut self,
        language: &str,
        root: &Path,
        sink: &Sender<Event>,
        timeout: Duration,
    ) -> Result<&mut Server, LspError> {
        let key = (root.to_path_buf(), language.to_string());
        if !self.running.contains_key(&key) {
            let server = Server::start(language, root, sink.clone(), timeout)?;
            self.running.insert(key.clone(), server);
        }
        Ok(self.running.get_mut(&key).expect("just inserted"))
    }

    /// Whether anything is running for this language and root.
    pub fn is_running(&self, language: &str, root: &Path) -> bool {
        self.running
            .contains_key(&(root.to_path_buf(), language.to_string()))
    }

    pub fn languages(&self) -> Vec<String> {
        let mut out: Vec<String> = self.running.keys().map(|(_, lang)| lang.clone()).collect();
        out.sort();
        out.dedup();
        out
    }

    /// Stops everything. Called when the window goes.
    pub fn stop_all(&mut self) {
        for (_, server) in self.running.drain() {
            server.stop();
        }
    }
}

impl Drop for Servers {
    fn drop(&mut self) {
        self.stop_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_languages_with_a_server_are_the_ones_worth_one() {
        assert_eq!(
            known_launch("rust"),
            Some(Launch {
                program: "rust-analyzer".into(),
                args: vec![],
            })
        );
        assert_eq!(
            known_launch("typescript").map(|l| l.args),
            Some(vec!["--stdio".to_string()])
        );
        assert_eq!(known_launch("javascript"), known_launch("typescript"));

        /* No server for these, and that is a decision rather than an omission:
        CodeMirror already reports a missing comma in JSON, and a Markdown
        server would spend a process telling somebody their heading skipped a
        level. */
        for language in ["json", "markdown", "yaml", "toml", "batch", "css"] {
            assert!(known_launch(language).is_none(), "{language}");
        }
    }

    #[test]
    fn a_windows_binary_is_looked_for_by_every_name_windows_uses() {
        let names = candidate_names("rust-analyzer");
        if cfg!(target_os = "windows") {
            assert!(names.contains(&"rust-analyzer.exe".to_string()));
            /* npm installs a `.cmd` shim, which is the only thing on the PATH
            for `typescript-language-server` on Windows — a client that
            looked for the bare name would report it as not installed. */
            assert!(names.contains(&"rust-analyzer.cmd".to_string()));
        } else {
            assert_eq!(names, vec!["rust-analyzer".to_string()]);
        }
    }

    #[test]
    fn the_end_of_a_document_is_where_the_protocol_says_it_is() {
        // Zero-based lines, and the column is where the last line stops.
        assert_eq!(end_of(""), (0, 0));
        assert_eq!(end_of("abc"), (0, 3));
        assert_eq!(end_of("abc\n"), (1, 0), "a trailing newline opens a line");
        assert_eq!(end_of("abc\ndef"), (1, 3));
        assert_eq!(end_of("a\nb\nc\n"), (3, 0));
    }

    #[test]
    fn the_column_is_counted_in_utf16_because_the_protocol_is() {
        /* `č` is one UTF-16 unit and two bytes; an emoji is two units and four
        bytes. Counting bytes would put the end of the line past the end of
        the line, and counting characters would put it short — and the end of
        a line is where a whole-document replacement stops. */
        assert_eq!(end_of("čćžšđ"), (0, 5));
        assert_eq!(end_of("a😀"), (0, 3));
        assert_eq!("čćžšđ".len(), 10, "ten bytes, five units");
    }

    #[test]
    fn nothing_is_running_before_anything_is_started() {
        let servers = Servers::new();
        assert!(!servers.is_running("rust", Path::new("/tmp/x")));
        assert!(servers.languages().is_empty());
    }

    #[test]
    fn a_language_nobody_serves_is_reported_as_such() {
        let (sink, _receiver) = std::sync::mpsc::channel();
        let mut servers = Servers::new();
        /* `unwrap_err` would want `Server` to be printable, and a running
        process is not a thing to print — so the result is matched instead. */
        let outcome = servers.ensure("markdown", Path::new("."), &sink, Duration::from_secs(1));
        let error = match outcome {
            Ok(_) => panic!("nothing serves Markdown, so nothing should have started"),
            Err(error) => error,
        };
        assert!(matches!(error, LspError::NoServer(_)), "{error}");
    }
}
