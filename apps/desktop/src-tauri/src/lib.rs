//! Tauri commands — the bridge between the shell and `ul-core`.
//!
//! The frontend never gets raw disk access. Every path passes through
//! `Workspace::resolve`, which refuses it if it leaves the folder the user
//! explicitly opened.

use std::sync::Mutex;

mod crash;

use tauri::ipc::Response;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

use ul_convert::{Backend, ConvertError};
use ul_core::{
    Detection, DirEntry, LibraryScan, SearchOutcome, SearchQuery, Stat, VfsError, Workspace,
};
use ul_image::{ImageError, Info as ImageInfo, Ops as ImageOps, Written};
use ul_lsp::{Event as LspEvent, LspError, Servers};

struct AppState {
    workspace: Mutex<Workspace>,
}

/// The language servers, and the way their news reaches the window.
///
/// One registry for the whole application: a server exists per language per
/// project, not per document, and three copies of rust-analyzer indexing one
/// workspace is three times the memory for one answer.
struct LspState {
    servers: Mutex<Servers>,
    /// Handed to every server as it starts; the receiving end is read by a
    /// thread that turns each message into an event for the window.
    sink: std::sync::mpsc::Sender<LspEvent>,
}

/// Files the program was asked to open when it started.
///
/// Held rather than opened here: the window exists before the interface inside
/// it does, and something opened before the shell is listening is opened into
/// nothing. The frontend collects these once it is ready.
#[derive(Default)]
struct LaunchPaths(Mutex<Vec<String>>);

/// The lock is never held across an `.await` — dialogs are asynchronous, so the
/// first open dialog would otherwise block every other command.
fn with_workspace<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&mut Workspace) -> Result<T, VfsError>,
) -> Result<T, VfsError> {
    let mut guard = state
        .workspace
        .lock()
        .expect("the workspace lock is poisoned");
    f(&mut guard)
}

/* ── dialogs ─────────────────────────────────────────────────────────── */

/// Folder picker.
///
/// **Desktop only.** Android has no directory picker that returns a path — the
/// Storage Access Framework hands back a `content://` URI, over which
/// `ul-core`'s file sandbox makes no sense. The mobile build therefore works
/// with individual documents rather than a workspace; the guard is a `cfg`, not
/// a runtime error, so an impossible call shows up at compile time.
#[cfg(desktop)]
#[tauri::command]
async fn pick_directory(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Stat>, VfsError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |picked| {
        let _ = tx.send(picked);
    });

    let Some(path) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    let Ok(path) = path.into_path() else {
        return Ok(None);
    };

    with_workspace(&state, |workspace| {
        let root = workspace.add_root(&path)?;
        workspace.stat(&root).map(Some)
    })
}

/// The mobile counterpart: it speaks up honestly instead of staying silent.
#[cfg(mobile)]
#[tauri::command]
async fn pick_directory(
    _app: tauri::AppHandle,
    _state: State<'_, AppState>,
) -> Result<Option<Stat>, VfsError> {
    Err(VfsError::Unsupported(
        "Choosing a folder is not available on mobile devices.".into(),
    ))
}

#[tauri::command]
async fn pick_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<Stat>, VfsError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |picked| {
        let _ = tx.send(picked);
    });

    let Some(paths) = rx.await.ok().flatten() else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for path in paths {
        let Ok(path) = path.into_path() else { continue };
        // A individually chosen file becomes its own root — the user pointed at
        // it explicitly, but that does not open the whole folder around it.
        let stat = with_workspace(&state, |workspace| {
            if let Some(parent) = path.parent() {
                workspace.add_root(parent)?;
            }
            workspace.stat(&path)
        })?;
        out.push(stat);
    }
    Ok(out)
}

/// Where a converted or exported file should go.
///
/// The chosen folder is **granted** before the path is handed back. Choosing a
/// file in a dialog the operating system drew is the strongest permission there
/// is — stronger than anything this program could ask for itself — and without
/// recording it the write that follows was refused by our own sandbox, with a
/// message saying the file escaped a workspace the user had just pointed at.
/// Granted rather than opened: naming a folder to save into is not asking to
/// browse it, so it stays out of the tree.
#[tauri::command]
async fn pick_save_target(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    suggested_name: String,
) -> Result<Option<String>, VfsError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&suggested_name)
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });

    let Some(path) = rx.await.ok().flatten().and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };

    if let Some(parent) = path.parent() {
        with_workspace(&state, |workspace| workspace.grant_folder(parent))?;
    }

    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Opens a web link in the system browser.
///
/// Only `https://` — the command is callable from the webview, and a scheme
/// like `file:` or `ms-settings:` would make it a lever it must not be. The
/// shell asks for it when a document names a font the machine does not have,
/// to send the person to a search for it.
#[cfg(desktop)]
#[tauri::command]
fn open_external(url: String) -> Result<(), VfsError> {
    if !url.starts_with("https://") {
        return Err(VfsError::Unsupported(
            "Only web links open outside the application.".into(),
        ));
    }

    #[cfg(target_os = "windows")]
    // `rundll32 url.dll` rather than `cmd /C start`: `start` reads `&` in a
    // query string as a command separator.
    let spawned = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&url).spawn();

    spawned.map(|_| ()).map_err(VfsError::from)
}

/// On a phone the browser is reached through an Intent, which needs the plugin
/// we have not taken yet. Said out loud rather than silently swallowed.
#[cfg(mobile)]
#[tauri::command]
fn open_external(_url: String) -> Result<(), VfsError> {
    Err(VfsError::Unsupported(
        "Opening the browser is not wired up on mobile devices yet.".into(),
    ))
}

/* ── file system ─────────────────────────────────────────────────────── */

/// Takes in paths the user pointed at — dropped onto the window, or remembered
/// from an earlier session and clicked in the recent list.
///
/// Both are explicit user gestures, so the parent folder of each file is
/// added as a root — otherwise the sandbox would refuse it immediately. A folder
/// becomes a root in its own right. A path that no longer exists adds nothing:
/// it is reported by its stat failing, not by quietly widening the sandbox
/// with its parent.
#[tauri::command]
fn adopt_paths(state: State<'_, AppState>, paths: Vec<String>) -> Result<Vec<Stat>, VfsError> {
    let mut out = Vec::new();
    for raw in paths {
        let path = std::path::PathBuf::from(&raw);
        let stat = with_workspace(&state, |workspace| {
            if path.is_dir() {
                workspace.add_root(&path)?;
            } else if let Some(parent) = path.parent().filter(|_| path.is_file()) {
                workspace.add_root(parent)?;
            }
            workspace.stat(&path)
        });
        // One failed path must not bring down the whole drop.
        match stat {
            Ok(stat) => out.push(stat),
            Err(err) => eprintln!("[uleditor] adopted path refused: {raw} — {err}"),
        }
    }
    Ok(out)
}

#[tauri::command]
fn roots(state: State<'_, AppState>) -> Result<Vec<Stat>, VfsError> {
    with_workspace(&state, |workspace| {
        workspace
            .roots()
            .to_vec()
            .iter()
            .map(|root| workspace.stat(root))
            .collect()
    })
}

#[tauri::command]
fn read_directory(state: State<'_, AppState>, path: String) -> Result<Vec<DirEntry>, VfsError> {
    with_workspace(&state, |workspace| workspace.read_dir(&path))
}

#[tauri::command]
fn stat(state: State<'_, AppState>, path: String) -> Result<Stat, VfsError> {
    with_workspace(&state, |workspace| workspace.stat(&path))
}

#[tauri::command]
fn detect_format(state: State<'_, AppState>, path: String) -> Result<Detection, VfsError> {
    with_workspace(&state, |workspace| workspace.detect_at(&path))
}

/// Returns raw bytes through `Response` rather than as a `Vec<u8>`. JSON
/// serialisation of a number array takes seconds on a ten-megabyte PDF.
/// Search across the whole workspace.
///
/// It lives in Rust, not JS: scanning thousands of files over IPC would mean
/// shipping their contents into the browser. The query goes in, only the hits
/// come back.
#[tauri::command]
async fn search_workspace(
    state: State<'_, AppState>,
    query: SearchQuery,
) -> Result<SearchOutcome, VfsError> {
    with_workspace(&state, |workspace| workspace.search(&query))
}

/// The file list for quick open by name (`Ctrl+P`).
#[tauri::command]
async fn list_files(state: State<'_, AppState>, limit: usize) -> Result<Vec<Stat>, VfsError> {
    with_workspace(&state, |workspace| workspace.list_files(limit))
}

/// A survey of the device in search of documents.
///
/// The locations looked at come from `ul_core::default_roots()` and depend on
/// the platform. A scanned folder becomes a **library root**, not an ordinary
/// root: a document from the list must be openable, but those folders have no
/// business in the explorer tree — otherwise a single glance at the library on
/// desktop would drop Documents, Downloads and Desktop among the user's opened
/// folders.
#[tauri::command]
async fn scan_library(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<LibraryScan, VfsError> {
    let roots = ul_core::default_roots();

    with_workspace(&state, |workspace| {
        let mut usable = Vec::new();
        for root in &roots {
            // Missing folders are expected — the list is the same for every device.
            if workspace.grant_folder(root).is_ok() {
                usable.push(root.clone());
            }
        }
        workspace.scan_library(&usable, limit)
    })
}

#[tauri::command]
fn read_file(state: State<'_, AppState>, path: String) -> Result<Response, VfsError> {
    let bytes = with_workspace(&state, |workspace| workspace.read(&path))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
fn write_file(state: State<'_, AppState>, path: String, contents: Vec<u8>) -> Result<(), VfsError> {
    with_workspace(&state, |workspace| workspace.write(&path, &contents))
}

/* ── images ──────────────────────────────────────────────────────────── */

/// Two failures with nothing in common: a path the workspace refuses, and a
/// picture that cannot be read. Both are one message to the person, and
/// flattening them into a `String` at the boundary would throw away which of the
/// two it was — so they are joined rather than merged.
#[derive(Debug, thiserror::Error)]
enum ImageCommandError {
    #[error(transparent)]
    Vfs(#[from] VfsError),
    #[error(transparent)]
    Image(#[from] ImageError),
}

impl serde::Serialize for ImageCommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// What the image is — the size a person sees, the format, and whether this is
/// one of the formats that can be written back at all.
#[tauri::command]
fn image_info(state: State<'_, AppState>, path: String) -> Result<ImageInfo, ImageCommandError> {
    let bytes = with_workspace(&state, |workspace| workspace.read(&path))?;
    Ok(ul_image::info(&bytes)?)
}

/// Applies a plan and writes the result.
///
/// The bytes are read, transformed and written **without leaving Rust**: a
/// photograph out of a phone is a hundred and sixty megabytes decoded, and the
/// webview has no business holding it. What comes back is what the file now
/// holds — the new size, the format, and whether the encoding itself lost
/// anything, which the editor says before it says "saved".
#[tauri::command]
fn image_write(
    state: State<'_, AppState>,
    source: String,
    target: String,
    ops: ImageOps,
) -> Result<Written, ImageCommandError> {
    let bytes = with_workspace(&state, |workspace| workspace.read(&source))?;
    let (out, written) = ul_image::apply(&bytes, &ops)?;
    with_workspace(&state, |workspace| workspace.write(&target, &out))?;
    Ok(written)
}

/* ── conversions ─────────────────────────────────────────────────────── */

/// The same shape as the image errors: a path the workspace refuses and a
/// conversion that failed are one message to the person and two different
/// things to whoever is reading a bug report.
#[derive(Debug, thiserror::Error)]
enum ConvertCommandError {
    #[error(transparent)]
    Vfs(#[from] VfsError),
    #[error(transparent)]
    Convert(#[from] ConvertError),
}

impl serde::Serialize for ConvertCommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Whether this machine has LibreOffice, and where.
///
/// Asked rather than assumed, every time the question matters: somebody can
/// install it while the program is open, and a program that decided at startup
/// would tell them to install what they have just installed.
#[tauri::command]
fn convert_backend() -> Option<Backend> {
    ul_convert::backend()
}

/// Converts one drawing to PDF and says where the PDF is.
///
/// The output goes into a directory of this program's own under the system
/// temporary folder — never beside the original. A program that leaves a PDF
/// next to somebody's drawing without being asked is a program that litters,
/// and the folder a `.cdr` lives in is usually somebody's work.
#[tauri::command]
async fn convert_to_pdf(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, ConvertCommandError> {
    let source = with_workspace(&state, |workspace| workspace.resolve(&path))?;
    let backend = ul_convert::backend().ok_or(ConvertError::NotInstalled)?;

    /* One directory per document, named after the document rather than at
    random: a second conversion of the same file reuses it, and a person
    looking at the temporary folder can tell what is in there. */
    let outdir = std::env::temp_dir()
        .join("uleditor-converted")
        .join(digest_of(&path));

    /* Two minutes. LibreOffice takes a few seconds for a drawing and can take
    twenty on a cold start, since the first run of a fresh profile builds it;
    a minute would time out on exactly the machine where it was slowest. */
    let output = ul_convert::to_pdf(
        &backend,
        &source,
        &outdir,
        std::time::Duration::from_secs(120),
    )?;
    Ok(output.to_string_lossy().into_owned())
}

/// A short, stable, filesystem-safe name for a path.
///
/// Not a hash for security — for a directory name. The point is that the same
/// document lands in the same place twice and two documents do not collide.
fn digest_of(path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/* ── language servers ────────────────────────────────────────────────── */

#[derive(Debug, thiserror::Error)]
enum LspCommandError {
    #[error(transparent)]
    Vfs(#[from] VfsError),
    #[error(transparent)]
    Lsp(#[from] LspError),
}

impl serde::Serialize for LspCommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// The workspace root a path belongs to.
///
/// A person can have several folders open, and a language server belongs to one
/// of them — the one the file is actually in. Falling back to the first root
/// would start a server for a project the file has nothing to do with.
fn root_of(workspace: &Workspace, file: &std::path::Path) -> Option<std::path::PathBuf> {
    workspace
        .roots()
        .iter()
        .filter_map(|root| workspace.resolve(root).ok())
        .filter(|root| file.starts_with(root))
        /* The longest match, for nested roots: a folder opened inside another
        folder is the more specific answer about where a file lives. */
        .max_by_key(|root| root.components().count())
}

/// Which languages this machine can serve. Asked, never assumed.
///
/// A person can install rust-analyzer while the program is open — usually
/// *because* the program said the code was not being checked — so this is a
/// question rather than a fact settled at startup.
#[tauri::command]
fn lsp_languages() -> Vec<String> {
    ["rust", "typescript", "javascript", "python"]
        .iter()
        .filter(|language| ul_lsp::find_server(language).is_some())
        .map(|language| (*language).to_string())
        .collect()
}

/// A document is open: start a server if one is installed, and tell it.
///
/// Returns whether anything is listening. `false` is not a failure — it is the
/// ordinary answer on a machine without that server installed, and the editor
/// uses it to stop expecting underlines rather than to report a problem.
#[tauri::command]
async fn lsp_open(
    state: State<'_, AppState>,
    lsp: State<'_, LspState>,
    path: String,
    language: String,
    text: String,
) -> Result<bool, LspCommandError> {
    if ul_lsp::find_server(&language).is_none() {
        return Ok(false);
    }

    let (file, root) = with_workspace(&state, |workspace| {
        let file = workspace.resolve(&path)?;
        let root = root_of(workspace, &file).unwrap_or_else(|| {
            file.parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or_else(|| file.clone())
        });
        Ok((file, root))
    })?;

    /* The project rather than the folder that was opened: `C:\dev` may hold
    fifty crates, and rust-analyzer pointed at it would index all of them. */
    let project = ul_lsp::project_root_for(&language, &file, &root);

    let mut servers = lsp.servers.lock().expect("the server registry is poisoned");
    let server = servers.ensure(
        &language,
        &project,
        &lsp.sink,
        /* A minute for the handshake. rust-analyzer answers `initialize` at
        once and does its indexing afterwards, so this is generous rather
        than a limit anybody will meet. */
        std::time::Duration::from_secs(60),
    )?;
    server.open(&file, &language, &text)?;
    Ok(true)
}

#[tauri::command]
async fn lsp_change(
    state: State<'_, AppState>,
    lsp: State<'_, LspState>,
    path: String,
    language: String,
    version: i64,
    text: String,
) -> Result<(), LspCommandError> {
    let file = with_workspace(&state, |workspace| workspace.resolve(&path))?;
    let mut servers = lsp.servers.lock().expect("the server registry is poisoned");
    for server in servers.serving(&language) {
        server.change(&file, version, &text)?;
    }
    Ok(())
}

/// A save is what makes the compiler's own diagnostics arrive.
///
/// rust-analyzer runs `cargo check` on this notification and publishes what it
/// says — the type errors and borrow errors its own parser does not report. An
/// editor that never mentioned a save would show syntax errors and nothing
/// else, which is indistinguishable from a compiler with nothing to say.
#[tauri::command]
async fn lsp_save(
    state: State<'_, AppState>,
    lsp: State<'_, LspState>,
    path: String,
    language: String,
) -> Result<(), LspCommandError> {
    let file = with_workspace(&state, |workspace| workspace.resolve(&path))?;
    let mut servers = lsp.servers.lock().expect("the server registry is poisoned");
    for server in servers.serving(&language) {
        server.save(&file)?;
    }
    Ok(())
}

#[tauri::command]
async fn lsp_close(
    state: State<'_, AppState>,
    lsp: State<'_, LspState>,
    path: String,
    language: String,
) -> Result<(), LspCommandError> {
    let file = with_workspace(&state, |workspace| workspace.resolve(&path))?;
    let mut servers = lsp.servers.lock().expect("the server registry is poisoned");
    for server in servers.serving(&language) {
        server.close(&file)?;
    }
    Ok(())
}

/* ── asking a server a question ──────────────────────────────────────── */

/// Where a name was defined, as the editor wants it: a path, not a URL.
///
/// The server answers `file:///c:/dev/x.rs`; the shell opens `C:\dev\x.rs`.
/// The conversion belongs on this side for the same reason it does for
/// diagnostics — three slashes and a percent-encoded space are the platform's
/// business, and the platform is here.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Jump {
    path: String,
    line: u32,
    column: u32,
    end_line: u32,
    end_column: u32,
}

/// How long a question is worth waiting for.
///
/// **Not "how late is too late to show" — the editor decides that, and it
/// already does.** CodeMirror drops a hover whose pointer has moved on and a
/// completion whose context is stale, so a slow answer is discarded rather than
/// arriving as a surprise. What this bounds is the other thing: a thread held
/// for a question nobody is still asking.
///
/// Ten seconds because a language server is not always idle when it is asked.
/// rust-analyzer runs `cargo check` on every save and answers slowly or not at
/// all while it does, which is exactly when somebody is looking at the code
/// they just saved. Three seconds — the first value here — was short enough
/// that the desktop check failed all three questions in a row while `F12`,
/// asked half a minute later through the same command, went through.
const PATIENCE: std::time::Duration = std::time::Duration::from_secs(10);

/// What a question is about: which file, in which language, and where in it.
///
/// Four arguments that always travel together and are never meaningful apart —
/// a line without the file it is a line of is not an address.
struct At<'a> {
    path: &'a str,
    language: &'a str,
    line: u32,
    column: u32,
}

/// Sends one question to the server that has the file open, and waits off the lock.
///
/// **Two halves, and the seam is the point.** The registry is behind a mutex
/// that every other document's `didChange` also needs; a command that held it
/// while a server thought would stop the underlines updating anywhere else for
/// as long as one tooltip took. So the lock is taken to write the question and
/// dropped, and the waiting happens on a thread that is allowed to block.
///
/// `Ok(None)` means no server has this document — which happens legitimately,
/// between a tab appearing and a handshake finishing, and is not a failure to
/// report to anybody.
///
/// **Asked twice, at most.** Every one of these questions is asked while
/// somebody is typing, and a `didChange` that overtakes a request in flight
/// makes the server drop it with `ContentModified` — correctly, since the
/// answer would have been about the previous keystroke. That is the protocol
/// saying "ask again", and it happens often enough that a client which did not
/// would have a hover that stops working for as long as anybody is typing. The
/// second attempt is against the document as it now is, so a third would be
/// answering a question nobody is still asking.
async fn asked(
    state: &State<'_, AppState>,
    lsp: &State<'_, LspState>,
    at: At<'_>,
    question: fn(
        &mut ul_lsp::Server,
        &std::path::Path,
        u32,
        u32,
    ) -> Result<ul_lsp::Asked, LspError>,
) -> Result<Option<serde_json::Value>, LspCommandError> {
    let file = with_workspace(state, |workspace| workspace.resolve(at.path))?;

    for attempt in 0..2 {
        let waiting = {
            let mut servers = lsp.servers.lock().expect("the server registry is poisoned");
            let Some(server) = servers.serving_file(at.language, &file) else {
                return Ok(None);
            };
            question(server, &file, at.line, at.column)?
        };

        /*
         * On a thread that may block, rather than on the async runtime's. Tauri
         * runs commands on a small pool of worker threads, and a `recv_timeout`
         * there is a worker held for the whole timeout — three of those and the
         * pool is gone, along with every other command the window wanted.
         */
        match tauri::async_runtime::spawn_blocking(move || waiting.wait(PATIENCE)).await {
            Ok(Ok(value)) => return Ok(Some(value)),
            Ok(Err(LspError::Stale(_))) if attempt == 0 => continue,
            /* A server that refused the question, said nothing in time, or is
            still behind after a second attempt. None of those is worth
            interrupting anybody over: there is no tooltip, no jump and no
            list, which is exactly what "it does not know" looks like. */
            Ok(Err(_)) | Err(_) => return Ok(None),
        }
    }

    Ok(None)
}

/// What is this thing? — one block of Markdown, or nothing.
#[tauri::command]
async fn lsp_hover(
    state: State<'_, AppState>,
    lsp: State<'_, LspState>,
    path: String,
    language: String,
    line: u32,
    column: u32,
) -> Result<Option<ul_lsp::Hover>, LspCommandError> {
    let answer = asked(
        &state,
        &lsp,
        At {
            path: &path,
            language: &language,
            line,
            column,
        },
        ul_lsp::Server::hover_at,
    )
    .await?;
    Ok(answer.as_ref().and_then(ul_lsp::parse_hover))
}

/// Where was it defined? — nowhere, one place, or several.
#[tauri::command]
async fn lsp_definition(
    state: State<'_, AppState>,
    lsp: State<'_, LspState>,
    path: String,
    language: String,
    line: u32,
    column: u32,
) -> Result<Vec<Jump>, LspCommandError> {
    let answer = asked(
        &state,
        &lsp,
        At {
            path: &path,
            language: &language,
            line,
            column,
        },
        ul_lsp::Server::definition_at,
    )
    .await?;
    let Some(answer) = answer else {
        return Ok(Vec::new());
    };

    Ok(ul_lsp::parse_locations(&answer)
        .into_iter()
        /* A location this side cannot turn into a path is dropped rather than
        passed on: rust-analyzer answers about the standard library with a
        real file, but a server can also answer with `untitled:` or a URL of
        its own invention, and a tab that cannot be opened is worse than a
        jump that did not happen. */
        .filter_map(|found| {
            let path = ul_lsp::path_of_url(&found.uri)?;
            Some(Jump {
                path: path.to_string_lossy().into_owned(),
                line: found.span.line,
                column: found.span.column,
                end_line: found.span.end_line,
                end_column: found.span.end_column,
            })
        })
        .collect())
}

/// What could this word become? — the list, and whether it is the whole list.
#[tauri::command]
async fn lsp_completion(
    state: State<'_, AppState>,
    lsp: State<'_, LspState>,
    path: String,
    language: String,
    line: u32,
    column: u32,
) -> Result<Vec<ul_lsp::Completion>, LspCommandError> {
    let answer = asked(
        &state,
        &lsp,
        At {
            path: &path,
            language: &language,
            line,
            column,
        },
        ul_lsp::Server::completion_at,
    )
    .await?;
    let Some(answer) = answer else {
        return Ok(Vec::new());
    };

    /* `isIncomplete` is dropped here, and deliberately: this client asks again
    on every keystroke regardless, so there is nothing the flag would change.
    It is parsed and named in `ul-lsp` for the day that stops being true. */
    let (items, _incomplete) = ul_lsp::parse_completions(&answer);
    Ok(items)
}

/* ── files the program was started with ──────────────────────────────── */

/// The paths out of a command line.
///
/// The first argument is the program itself and anything starting with `-` is a
/// switch — neither is a document. Everything else is taken as a path without
/// being checked for existence: a file that has been deleted between the
/// double-click and the start of the program is a case the opening path already
/// reports properly, and duplicating that judgement here would mean two places
/// deciding what a readable file is.
fn paths_from(args: impl Iterator<Item = String>) -> Vec<String> {
    args.skip(1)
        .filter(|arg| !arg.starts_with('-') && !arg.is_empty())
        .collect()
}

/// Hands over the files the program was started with, and forgets them.
///
/// Draining rather than reading: the frontend reloads on a language change, and
/// a list that survived would reopen the same documents every time somebody
/// switched between English and Croatian.
#[tauri::command]
fn take_launch_paths(state: State<'_, LaunchPaths>) -> Vec<String> {
    let mut guard = state.0.lock().expect("the launch path lock is poisoned");
    std::mem::take(&mut *guard)
}

/* ── what is written down when it breaks ─────────────────────────────── */

/// The size a report from the window is allowed to be.
///
/// A stack trace is a few kilobytes. Sixty-four of them is a runaway, and a
/// runaway is the case this exists to survive rather than to preserve.
const LONGEST_REPORT: usize = 64 * 1024;

/// Writes what the window says went wrong, beside what the core writes.
///
/// It answers with the path so the caller could show it, and with a plain string
/// error rather than a rich one: there is nothing useful to do about a crash
/// report that could not be written, and something that has to be *done* about
/// it is the beginning of a loop.
#[tauri::command]
fn record_crash(text: String) -> Result<String, String> {
    let text = if text.len() > LONGEST_REPORT {
        format!(
            "{}\n…the rest was cut; it was longer than this file is allowed to be.\n",
            &text[..LONGEST_REPORT]
        )
    } else {
        text
    };
    crash::write(&text)
        .map(|path| path.display().to_string())
        .map_err(|err| err.to_string())
}

/// The reports nobody has been shown yet, and after this call, none.
///
/// Drained the same way the launch paths are, and for the same reason: the
/// window reloads when the language changes, and a list that survived would
/// announce the same crash every time somebody switched between English and
/// Croatian.
#[tauri::command]
fn take_crash_reports() -> Vec<String> {
    crash::unseen()
        .into_iter()
        .map(|path| path.display().to_string())
        .collect()
}

/* ── developer tools ─────────────────────────────────────────────────── */

/// Opens the webview's inspector.
///
/// It opens in a **window of its own**, and that is not a choice we are making:
/// WebView2 owns its devtools and offers no way to dock them beside the page.
/// Docking is a feature of the Chrome browser, not of an embedded webview.
///
/// Debug builds only. In release the call does nothing, deliberately: shipping
/// the inspector would put "Inspect" in the right-click menu of a document
/// editor for every user, which is a strange thing to hand somebody who opened
/// a PDF. Building with `--features devtools` turns it on for a release binary
/// when that is actually wanted.
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    #[cfg(any(debug_assertions, feature = "devtools"))]
    window.open_devtools();
    #[cfg(not(any(debug_assertions, feature = "devtools")))]
    let _ = window;
}

/// Whether the command above will do anything, so the interface can leave the
/// entry out of the palette rather than offer one that silently does nothing.
#[tauri::command]
fn devtools_available() -> bool {
    cfg!(any(debug_assertions, feature = "devtools"))
}

/* ── startup ─────────────────────────────────────────────────────────── */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /*
     * First, before the plugins, before the context, before the builder's own
     * `expect` below. Everything above this line in the program's life would
     * otherwise fail into a silence with nowhere to write — and "it will not
     * start at all" is the report that most needs a file behind it.
     */
    crash::install();

    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    /*
     * The updater, and the restart that follows it.
     *
     * Desktop only, in both directions: a phone updates through its store, and
     * Tauri's updater will not build for Android at all. The endpoint and the
     * public key live in `tauri.conf.json` — the key is what makes this safe to
     * have, since an update is only installed if it was signed by the private
     * half, which never leaves GitHub Secrets. Without that, "download and run
     * an executable from the internet" is exactly what it sounds like.
     */
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    /*
     * A second double-click has to reach the window that is already open. Without
     * this, every file opened from Explorer starts another copy of the program,
     * each with its own tabs and its own idea of what is unsaved — and the second
     * one would fight the first over the same file.
     */
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        /* Imported here rather than at the top of the file: on Android neither
        this block nor the macOS one below is compiled, and an import nothing
        uses is an error under `-D warnings`. */
        use tauri::Emitter;
        let paths = paths_from(argv.into_iter());
        if !paths.is_empty() {
            let _ = app.emit("uleditor://open-paths", paths);
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
    }));

    builder
        .setup(|app| {
            app.manage(AppState {
                workspace: Mutex::new(Workspace::new()),
            });
            app.manage(LaunchPaths(Mutex::new(paths_from(std::env::args()))));

            /* Old reports go now rather than inside the hook. A directory sweep
            on a process that is already dying is the one piece of this that
            can safely wait until the program is healthy again. */
            crash::trim();

            /*
             * The language servers, and one thread that carries what they say
             * into the window.
             *
             * A channel rather than the servers holding a handle to the app:
             * `ul-lsp` knows nothing about Tauri, which is what lets it be
             * tested against a real rust-analyzer from `cargo test` with no
             * window anywhere. This is the only place the two meet.
             */
            let (sink, news) = std::sync::mpsc::channel::<LspEvent>();
            app.manage(LspState {
                servers: Mutex::new(Servers::new()),
                sink,
            });

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                use tauri::Emitter;
                while let Ok(event) = news.recv() {
                    /* Turned into a path here rather than in the page. A server
                    answers with `file:///c:/dev/x.rs` for a file the editor
                    calls `C:\dev\x.rs`, and the difference — three slashes, a
                    lowercased drive letter, percent-encoded spaces — is the
                    platform's, so it is dealt with on the side that has one. */
                    let payload = match event {
                        LspEvent::Diagnostics {
                            language,
                            published,
                        } => {
                            let path = ul_lsp::path_of_url(&published.uri)
                                .map(|p| p.to_string_lossy().into_owned())
                                .unwrap_or_else(|| published.uri.clone());
                            serde_json::json!({
                                "kind": "diagnostics",
                                "language": language,
                                "uri": path,
                                "version": published.version,
                                "diagnostics": published.diagnostics,
                            })
                        }
                        LspEvent::Stopped { language, detail } => serde_json::json!({
                            "kind": "stopped",
                            "language": language,
                            "detail": detail,
                        }),
                    };

                    /* An emit that fails means the window has gone, and there is
                    nothing to do about it here — the process is ending, and
                    the servers are stopped by the exit handler below. */
                    let _ = handle.emit("uleditor://language", payload);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_external,
            pick_directory,
            pick_files,
            pick_save_target,
            adopt_paths,
            roots,
            read_directory,
            stat,
            detect_format,
            read_file,
            write_file,
            image_info,
            image_write,
            convert_backend,
            convert_to_pdf,
            lsp_languages,
            lsp_open,
            lsp_change,
            lsp_save,
            lsp_close,
            lsp_hover,
            lsp_definition,
            lsp_completion,
            search_workspace,
            list_files,
            scan_library,
            open_devtools,
            devtools_available,
            take_launch_paths,
            record_crash,
            take_crash_reports,
        ])
        .build(tauri::generate_context!())
        .expect("starting ulEditor failed")
        .run(|_app, _event| {
            /*
             * The language servers are stopped by hand on the way out.
             *
             * They are somebody else's processes, and rust-analyzer with a
             * large project is a core and a gigabyte: left running after the
             * window closed, it is a process in a task manager with no window
             * to explain it. Tauri's state is not dropped on every route out,
             * so the shutdown cannot be left to `Drop`.
             */
            if matches!(_event, tauri::RunEvent::Exit) {
                if let Some(lsp) = _app.try_state::<LspState>() {
                    if let Ok(mut servers) = lsp.servers.lock() {
                        servers.stop_all();
                    }
                }
            }

            /*
             * macOS does not put the file on the command line. It sends the
             * running application an event, which only exists on this path —
             * `.run()` on the builder never sees it, which is why the program is
             * built and then run rather than the shorter form.
             */
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                use tauri::Emitter;
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect();
                if !paths.is_empty() {
                    let _ = _app.emit("uleditor://open-paths", paths);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::paths_from;

    #[test]
    fn the_program_itself_is_not_a_document() {
        let args = [
            "C:/Program Files/ulEditor/ulEditor.exe",
            "C:/w/contract.pdf",
        ];
        assert_eq!(
            paths_from(args.iter().map(|s| s.to_string())),
            vec!["C:/w/contract.pdf".to_string()]
        );
    }

    #[test]
    fn switches_are_not_documents() {
        let args = ["ulEditor.exe", "--flag", "C:/w/a.md", "-x", "C:/w/b.md"];
        assert_eq!(
            paths_from(args.iter().map(|s| s.to_string())),
            vec!["C:/w/a.md".to_string(), "C:/w/b.md".to_string()]
        );
    }

    #[test]
    fn starting_with_nothing_opens_nothing() {
        let args = ["ulEditor.exe"];
        assert!(paths_from(args.iter().map(|s| s.to_string())).is_empty());
    }
}
