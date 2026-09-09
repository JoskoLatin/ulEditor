//! A Language Server Protocol client — the half of an editor that knows what
//! the code *means* rather than what it looks like.
//!
//! **What this does and does not do.** It starts a language server, tells it
//! which files are open and what is in them, and passes on what the server says
//! about them. That is diagnostics: the underline under a mistake, with the
//! compiler's own words. It also **asks**: what is this thing, where was it
//! defined, what could this word become. Those were the same plumbing asked
//! different questions, and the plumbing was the work — but asking needs one
//! thing publishing does not, which is a way to know which answer belongs to
//! which question. See `Asked`.
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

pub use protocol::{
    file_url, parse_completions, parse_hover, parse_locations, path_of_url, published_diagnostics,
    Completion, CompletionKind, Diagnostic, Hover, Location, Published, Severity, Span,
};
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
    /// A question the server answered with an error rather than a result.
    ///
    /// Not a failure of this client: `textDocument/definition` over a keyword
    /// is a perfectly ordinary thing to ask and a perfectly ordinary thing to
    /// refuse. The caller shows nothing, which is what nothing looks like.
    #[error("{0} refused the question: {1}")]
    Refused(String, String),
    /// The document moved while the server was answering.
    ///
    /// **The protocol's own "ask again"** — error `-32801`, `ContentModified` —
    /// and the only refusal that is not an answer. A server drops the question
    /// rather than replying about text nobody has any more, which is correct of
    /// it: a hover about the previous keystroke would point at the wrong word.
    ///
    /// It is common rather than exceptional. Every one of these questions is
    /// asked *while somebody is typing*, and a `didChange` that overtakes a
    /// request in flight is the ordinary case, not a rare one — which is why it
    /// has a name here instead of being one more thing that failed.
    #[error("{0} was still reading a newer version of the file")]
    Stale(String),
    /// A question that got no answer at all within the time allowed.
    ///
    /// A server that is indexing answers nothing for a while, and a tooltip
    /// that arrives after the pointer has moved is worse than no tooltip. So
    /// the wait has an end, and the end is reported rather than hidden.
    #[error("{0} did not answer {1} in time")]
    Silent(String, String),
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
/// Hands one answer to whoever asked the question.
///
/// The reading thread sees every message and knows nothing about who wanted
/// what; this is the whole of what it does with an answer. An id nobody is
/// waiting for is dropped without comment, and that is the ordinary case rather
/// than an error: a completion overtaken by the next keystroke is abandoned on
/// purpose, and the answer to it arrives anyway.
fn deliver(pending: &Pending, id: u64, value: &serde_json::Value) {
    let Ok(mut waiting) = pending.lock() else {
        return;
    };
    let Some(sender) = waiting.remove(&id) else {
        return;
    };

    /*
     * `result: null` is an answer and not an absence — "no definition here",
     * "nothing to say about this". Only an `error` member is a refusal, and it
     * is passed on with the server's own words in it for the same reason
     * stderr is kept: a client that reports "it did not work" has thrown away
     * the only sentence that said why.
     */
    let answer = match value.get("error") {
        Some(error) => Answer::Refused {
            code: error.get("code").and_then(|c| c.as_i64()).unwrap_or(0),
            message: error
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("no reason given")
                .to_string(),
        },
        None => Answer::Result(
            value
                .get("result")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        ),
    };
    let _ = sender.send(answer);
}

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

/// The file that marks the root of a project, per language.
///
/// A language server is started for a project rather than for a file, and which
/// directory that is matters more than it sounds: point rust-analyzer at
/// `C:\dev` and it will index every crate under it, which is a gigabyte of
/// memory and ten minutes to answer a question about one file.
fn project_marker(language: &str) -> &'static [&'static str] {
    match language {
        "rust" => &["Cargo.toml"],
        "typescript" | "javascript" => &["tsconfig.json", "jsconfig.json", "package.json"],
        "python" => &["pyproject.toml", "setup.py", "requirements.txt"],
        _ => &[],
    }
}

/// The directory a server should be started in for this file.
///
/// Walks up from the file to the workspace root, and the choice between the
/// candidates it finds is per language rather than uniform:
///
/// - **Rust takes the topmost.** A cargo workspace is the normal shape of a
///   Rust project, and its members are not separate projects: starting a server
///   in `crates/ul-core` would give an analyzer that cannot see the crate next
///   door, and every cross-crate reference would be an error that is not one.
/// - **TypeScript takes the nearest.** A monorepo is a set of packages with
///   their own `tsconfig.json`, and each is genuinely its own compilation.
///
/// Nothing found means the workspace root, which is what a person opened and
/// the only honest answer when there is no project to speak of.
pub fn project_root_for(language: &str, file: &Path, workspace_root: &Path) -> PathBuf {
    let markers = project_marker(language);
    if markers.is_empty() {
        return workspace_root.to_path_buf();
    }

    let mut found: Vec<PathBuf> = Vec::new();
    let mut at = file.parent();

    while let Some(directory) = at {
        if markers
            .iter()
            .any(|marker| directory.join(marker).is_file())
        {
            found.push(directory.to_path_buf());
        }
        if directory == workspace_root {
            break;
        }
        at = directory.parent();
    }

    let topmost = language == "rust";
    let chosen = if topmost { found.last() } else { found.first() };
    chosen
        .cloned()
        .unwrap_or_else(|| workspace_root.to_path_buf())
}

/// Questions that have been asked and not yet answered.
///
/// **This is the one thing a client that only listens does not need.** A
/// notification is finished when it has been written; a request is finished
/// when a message with the same id comes back, and between those two moments
/// the answer belongs to a thread that is not the one waiting for it. So the
/// asking thread leaves a channel here under its id, and the reading thread —
/// which sees every message and knows nothing about who wanted what — posts the
/// answer into whichever channel matches.
///
/// The ids never repeat, so nothing here is ever ambiguous; what it can be is
/// abandoned, which is what `Asked`'s `Drop` is for.
type Pending = Arc<Mutex<HashMap<u64, std::sync::mpsc::Sender<Answer>>>>;

/// What came back for one question.
///
/// Not a `Result`, because neither arm is an error at this level — a server
/// declining a question is as ordinary as answering one, and `null` is a real
/// result meaning "nothing here". The refusal carries its code as well as its
/// sentence, and the code is not decoration: one of them — `-32801` — means
/// "ask me again", and a client that kept only the message would have thrown
/// away the difference between a question worth repeating and one that is
/// simply not answerable.
enum Answer {
    /// What the server said, which may legitimately be `null`.
    Result(serde_json::Value),
    /// The server saying no, in its own words and with its own number.
    Refused { code: i64, message: String },
}

/// `ContentModified` — the document changed under the question.
const CONTENT_MODIFIED: i64 = -32801;

/// A question that has been sent, waiting for its answer.
///
/// It is a value rather than a blocking call for one reason, and it is not
/// tidiness: **the registry of servers is behind a mutex**, and a call that
/// held that mutex while it waited would stop every other document being
/// synchronised for as long as one tooltip took to arrive. So the lock is held
/// long enough to write the question and no longer, and this is what is carried
/// out of it.
pub struct Asked {
    id: u64,
    program: String,
    method: String,
    answer: std::sync::mpsc::Receiver<Answer>,
    pending: Pending,
}

impl Asked {
    /// Waits for the answer, or gives up.
    ///
    /// Giving up is a real outcome and not an error to be retried: a server
    /// that is still indexing has nothing to say about a symbol yet, and it
    /// will say so by not saying anything. The caller shows nothing.
    pub fn wait(self, timeout: Duration) -> Result<serde_json::Value, LspError> {
        match self.answer.recv_timeout(timeout) {
            Ok(Answer::Result(value)) => Ok(value),
            Ok(Answer::Refused { code, .. }) if code == CONTENT_MODIFIED => {
                Err(LspError::Stale(self.program.clone()))
            }
            Ok(Answer::Refused { message, .. }) => {
                Err(LspError::Refused(self.program.clone(), message))
            }
            /* Timed out, or the reading thread has gone — which means the
            server has, and the next notification will report that properly. */
            Err(_) => Err(LspError::Silent(self.program.clone(), self.method.clone())),
        }
    }
}

impl Drop for Asked {
    /// Takes the question out of the register, answered or not.
    ///
    /// Without this, every question a server never answered would leave a
    /// channel behind, and a session of a few hours would be holding thousands
    /// of them — one per keystroke that asked for a completion and was
    /// overtaken by the next.
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.id);
        }
    }
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
    /// Questions asked and not yet answered, shared with the reading thread.
    pending: Pending,
    /// What to call this server in an error message.
    program: String,
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
                   handle what comes back — a server told the client
                   understands something sends it, and what nobody reads is
                   bandwidth spent on a silence. Four things are read: what a
                   server says unasked, and the three questions below. */
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
                        /* Markdown first, plain text as the fallback, and the
                           order is the preference: a server that can only do
                           one of them picks from this list. Both are handled —
                           see `hover_text`, which flattens four shapes into
                           one — so both can honestly be claimed. */
                        "hover": {
                            "dynamicRegistration": false,
                            "contentFormat": ["markdown", "plaintext"],
                        },
                        /*
                         * `linkSupport` changes the shape of the answer, and it
                         * is worth asking for: a `LocationLink` carries
                         * `targetSelectionRange` — the name of the function —
                         * beside `targetRange`, which is the whole body of it.
                         * Jumping to the first puts the cursor on the
                         * declaration; jumping to the second selects forty
                         * lines and scrolls the top of them off the screen.
                         */
                        "definition": { "dynamicRegistration": false, "linkSupport": true },
                        "completion": {
                            "dynamicRegistration": false,
                            "completionItem": {
                                /*
                                 * **False, and it is not a shortcut.** A
                                 * snippet is `${1:name}` with tab stops, and
                                 * claiming it means being able to expand one —
                                 * a client that declared support and then
                                 * inserted the text literally would put
                                 * `println!("$1")` into somebody's file. Told
                                 * no, rust-analyzer offers `push` where it
                                 * would have offered `push(${1:value})`, which
                                 * is a completion that compiles.
                                 */
                                "snippetSupport": false,
                                "documentationFormat": ["markdown", "plaintext"],
                                "insertReplaceSupport": true,
                            },
                            /* A `CompletionList` rather than a bare array, so a
                               server can say the list is partial. Both shapes
                               are read either way. */
                            "contextSupport": true,
                        },
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
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let waiting = Arc::clone(&pending);
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
                            method is an answer to one of *ours*, and it goes
                            to whoever is waiting for that id. */
                            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                                if let (Some(id), Some(method)) = (
                                    value.get("id"),
                                    value.get("method").and_then(|m| m.as_str()),
                                ) {
                                    answer_request(&answering, id, method);
                                    continue;
                                }

                                if let Some(id) =
                                    value.get("id").and_then(serde_json::Value::as_u64)
                                {
                                    deliver(&waiting, id, &value);
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
            pending,
            program: launch.program.clone(),
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

    /// Whether this server was told about this file.
    ///
    /// A notification can be broadcast to every server of a language and the
    /// wrong ones will ignore it. A *question* cannot: it has to go to the
    /// server that has the document open, or the answer is about a file it has
    /// never read.
    pub fn knows(&self, path: &Path) -> bool {
        self.open.contains_key(path)
    }

    /// Sends a question and hands back the means of waiting for it.
    ///
    /// Two halves rather than one call, and the seam is deliberate: the caller
    /// holds a lock over every running server, and holding it through the wait
    /// would stop every other document being synchronised while one tooltip
    /// was being drawn. See `Asked`.
    pub fn ask(&mut self, method: &str, params: serde_json::Value) -> Result<Asked, LspError> {
        let id = self.next_id;
        self.next_id += 1;

        let (sender, answer) = std::sync::mpsc::channel();
        /*
         * Registered *before* the question is written. The other order is a
         * race that would fire perhaps one time in a thousand — a server on the
         * same machine can answer inside a microsecond, and an answer that
         * arrives before anybody is registered for it is dropped as an id
         * nobody wanted. A tooltip that fails once a week is a bug nobody can
         * reproduce.
         */
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, sender);
        }

        let message = serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        });
        if let Err(err) = write_message(&self.stdin, &message.to_string()) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(err);
        }

        Ok(Asked {
            id,
            program: self.program.clone(),
            method: method.to_string(),
            answer,
            pending: Arc::clone(&self.pending),
        })
    }

    /// A position in a document, as the protocol wants it.
    ///
    /// **One-based coming in, zero-based going out**, which is the same
    /// conversion a diagnostic makes on the way back and the same reason for
    /// doing it in one place: an answer about the wrong line looks like a
    /// broken editor rather than like arithmetic.
    fn at(path: &Path, line: u32, column: u32) -> serde_json::Value {
        serde_json::json!({
            "textDocument": { "uri": file_url(path) },
            "position": {
                "line": line.saturating_sub(1),
                "character": column.saturating_sub(1),
            },
        })
    }

    /// What is this thing? Read the answer with `parse_hover`.
    pub fn hover_at(&mut self, path: &Path, line: u32, column: u32) -> Result<Asked, LspError> {
        self.ask("textDocument/hover", Self::at(path, line, column))
    }

    /// Where was it defined? Read the answer with `parse_locations`.
    pub fn definition_at(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
    ) -> Result<Asked, LspError> {
        self.ask("textDocument/definition", Self::at(path, line, column))
    }

    /// What could this word become? Read the answer with `parse_completions`.
    ///
    /// The `context` says why the list was asked for, and the distinction is
    /// one servers act on: `1` is a person pressing the key for it, `2` is a
    /// character that triggers one by itself — a `.` in Rust, a `<` in HTML.
    /// Asked as `1`, because in this editor it is always the person: the list
    /// opens on typing, and a list that opened itself on every dot would be
    /// a list in the way.
    pub fn completion_at(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
    ) -> Result<Asked, LspError> {
        let mut params = Self::at(path, line, column);
        params["context"] = serde_json::json!({ "triggerKind": 1 });
        self.ask("textDocument/completion", params)
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

    /// Every running server for a language, whatever project it belongs to.
    ///
    /// A change to a file has to reach the server that was told about it, and
    /// the caller knows the language and the path but not which project root a
    /// server was started in. There is at most a handful of them, so the
    /// question is answered by looking rather than by another index.
    pub fn serving(&mut self, language: &str) -> Vec<&mut Server> {
        self.running
            .iter_mut()
            .filter(|((_, lang), _)| lang == language)
            .map(|(_, server)| server)
            .collect()
    }

    /// The server that was told about this file, if one was.
    ///
    /// `serving` is the right question for a notification, which every server
    /// of the language may as well hear. A question needs this one: the answer
    /// has to come from the server that has the document open, and asking any
    /// other is asking about a file it has never read. `None` where the file
    /// was never opened — which happens legitimately, between the tab
    /// appearing and the handshake finishing.
    pub fn serving_file(&mut self, language: &str, path: &Path) -> Option<&mut Server> {
        self.running
            .iter_mut()
            .filter(|((_, lang), _)| lang == language)
            .map(|(_, server)| server)
            .find(|server| server.knows(path))
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

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ul-lsp-root-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
    }

    #[test]
    fn rust_starts_at_the_workspace_and_not_at_the_crate() {
        /* The shape of this very repository: a cargo workspace with the crates
        under it. A server started in `crates/ul-core` sees one crate and
        calls every reference to the one beside it an error. */
        let root = scratch("cargo");
        touch(&root.join("Cargo.toml"));
        touch(&root.join("crates").join("ul-core").join("Cargo.toml"));
        let file = root
            .join("crates")
            .join("ul-core")
            .join("src")
            .join("vfs.rs");
        touch(&file);

        assert_eq!(project_root_for("rust", &file, &root), root);
    }

    #[test]
    fn typescript_starts_at_the_package_it_belongs_to() {
        /* And the other way, for the same reason reversed: the packages of a
        monorepo are separate compilations, and one server over all of them
        would answer about the wrong `tsconfig`. */
        let root = scratch("mono");
        touch(&root.join("package.json"));
        let package = root.join("packages").join("shell-ui");
        touch(&package.join("tsconfig.json"));
        let file = package.join("src").join("main.ts");
        touch(&file);

        assert_eq!(project_root_for("typescript", &file, &root), package);
    }

    #[test]
    fn a_file_with_no_project_belongs_to_the_folder_that_was_opened() {
        let root = scratch("bare");
        let file = root.join("scratch.rs");
        touch(&file);
        assert_eq!(project_root_for("rust", &file, &root), root);
    }

    #[test]
    fn the_search_never_climbs_above_what_was_opened() {
        /* The workspace root is a boundary, not a hint: a `Cargo.toml` in the
        person's home directory is not the project they opened, and reading
        it would put a server outside the sandbox everything else here
        respects. */
        let outer = scratch("outer");
        touch(&outer.join("Cargo.toml"));
        let inner = outer.join("inner");
        let file = inner.join("src").join("main.rs");
        touch(&file);

        assert_eq!(project_root_for("rust", &file, &inner), inner);
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
