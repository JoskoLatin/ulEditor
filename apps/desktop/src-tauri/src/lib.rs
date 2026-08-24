//! Tauri commands — the bridge between the shell and `ul-core`.
//!
//! The frontend never gets raw disk access. Every path passes through
//! `Workspace::resolve`, which refuses it if it leaves the folder the user
//! explicitly opened.

use std::sync::Mutex;

use tauri::ipc::Response;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

use ul_core::{
    Detection, DirEntry, LibraryScan, SearchOutcome, SearchQuery, Stat, VfsError, Workspace,
};

struct AppState {
    workspace: Mutex<Workspace>,
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
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

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
            search_workspace,
            list_files,
            scan_library,
            open_devtools,
            devtools_available,
            take_launch_paths,
        ])
        .build(tauri::generate_context!())
        .expect("starting ulEditor failed")
        .run(|_app, _event| {
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
