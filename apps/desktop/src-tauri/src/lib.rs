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

#[tauri::command]
async fn pick_save_target(
    app: tauri::AppHandle,
    suggested_name: String,
) -> Result<Option<String>, VfsError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&suggested_name)
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });

    Ok(rx
        .await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/* ── file system ─────────────────────────────────────────────────────── */

/// Takes in paths dropped onto the window.
///
/// A drop is an explicit user gesture, so the parent folder of each file is
/// added as a root — otherwise the sandbox would refuse it immediately. A folder
/// dropped directly becomes a root in its own right.
#[tauri::command]
fn adopt_paths(state: State<'_, AppState>, paths: Vec<String>) -> Result<Vec<Stat>, VfsError> {
    let mut out = Vec::new();
    for raw in paths {
        let path = std::path::PathBuf::from(&raw);
        let stat = with_workspace(&state, |workspace| {
            if path.is_dir() {
                workspace.add_root(&path)?;
            } else if let Some(parent) = path.parent() {
                workspace.add_root(parent)?;
            }
            workspace.stat(&path)
        });
        // One failed path must not bring down the whole drop.
        match stat {
            Ok(stat) => out.push(stat),
            Err(err) => eprintln!("[uleditor] dropped path refused: {raw} — {err}"),
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
            if workspace.add_library_root(root).is_ok() {
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(AppState {
                workspace: Mutex::new(Workspace::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
        ])
        .run(tauri::generate_context!())
        .expect("starting ulEditor failed");
}
