//! Tauri komande — most između shella i `ul-core`.
//!
//! Frontend nikad ne dobiva sirov pristup disku. Svaka putanja prolazi kroz
//! `Workspace::resolve`, koji je odbija ako izlazi izvan mape koju je korisnik
//! izričito otvorio.

use std::sync::Mutex;

use tauri::ipc::Response;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

use ul_core::{Detection, DirEntry, Stat, VfsError, Workspace};

struct AppState {
    workspace: Mutex<Workspace>,
}

/// Zaključavanje se nikad ne drži preko `.await` — dijalozi su asinkroni,
/// pa bi inače prvi otvoreni dijalog zablokirao sve ostale komande.
fn with_workspace<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&mut Workspace) -> Result<T, VfsError>,
) -> Result<T, VfsError> {
    let mut guard = state.workspace.lock().expect("radni prostor je otrovan");
    f(&mut guard)
}

/* ── dijalozi ────────────────────────────────────────────────────────── */

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
        // Pojedinačno odabrana datoteka postaje vlastiti korijen — korisnik ju
        // je izričito pokazao, ali to ne otvara i cijelu mapu oko nje.
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

/* ── datotečni sustav ────────────────────────────────────────────────── */

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

/// Vraća sirove bajtove kroz `Response` umjesto kao `Vec<u8>`. JSON
/// serijalizacija polja brojeva na desetmegabajtnom PDF-u traje sekundama.
#[tauri::command]
fn read_file(state: State<'_, AppState>, path: String) -> Result<Response, VfsError> {
    let bytes = with_workspace(&state, |workspace| workspace.read(&path))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
fn write_file(state: State<'_, AppState>, path: String, contents: Vec<u8>) -> Result<(), VfsError> {
    with_workspace(&state, |workspace| workspace.write(&path, &contents))
}

/* ── pokretanje ──────────────────────────────────────────────────────── */

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
            roots,
            read_directory,
            stat,
            detect_format,
            read_file,
            write_file,
        ])
        .run(tauri::generate_context!())
        .expect("pokretanje ulEditora nije uspjelo");
}
