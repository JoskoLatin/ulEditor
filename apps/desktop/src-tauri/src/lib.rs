//! Tauri commands — the bridge between the shell and `ul-core`.
//!
//! The frontend never gets raw disk access. Every path passes through
//! `Workspace::resolve`, which refuses it if it leaves the folder the user
//! explicitly opened.

use std::sync::Mutex;

mod crash;
mod trust;

use tauri::ipc::Response;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

use ul_convert::{Backend, ConvertError};
use ul_core::{
    Access, Consent, Consents, Detection, DirEntry, Kind, LibraryScan, Reading, SearchOutcome,
    SearchQuery, Stat, VfsError, Workspace,
};
use ul_image::{ImageError, Info as ImageInfo, Ops as ImageOps, Written};
use ul_lsp::{Event as LspEvent, LspError, Servers};

struct AppState {
    workspace: Mutex<Workspace>,
    /// What the person consented to, remembered across restarts, and what
    /// was offered this session (ADR 0005). Locked after `workspace`, never
    /// before it.
    consents: Mutex<Consents>,
    /// A no to the library, for this session: asked again next time. Desktop
    /// only: on a phone "All files access" is the consent.
    #[cfg_attr(mobile, allow(dead_code))]
    library_declined: std::sync::atomic::AtomicBool,
    /// The nos to links this session, and when the program's own last opened.
    #[cfg_attr(mobile, allow(dead_code))]
    links: Mutex<trust::Links>,
    /// Cancels of "Open for editing…", paced as a link's no is: script in
    /// the page could otherwise ask again the moment one is cancelled, for
    /// ever, until Open is pressed to make it stop.
    #[cfg_attr(mobile, allow(dead_code))]
    editing: Mutex<trust::Links>,
    /// Cancels of "Save as" and "Open folder", which may not be drawn again
    /// for a moment (`trust::Quiet`).
    #[cfg_attr(mobile, allow(dead_code))]
    dialogs: Mutex<trust::Quiet>,
}

/// Held while the core asks the person anything in a dialog of its own —
/// whether a language server may start, the library may look, a link may
/// open — so that one question is on the screen at a time: two stacked, each
/// with its yes in the middle, and a person answering one could press the yes
/// of the other (found by the independent review of N6).
struct Questions(tokio::sync::Mutex<()>);

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
    /// The projects a server may start in — see `trust.rs`. The question is
    /// asked under `Questions`, so that a restored session opening several
    /// files of one project asks once.
    trust: Mutex<trust::ProjectTrust>,
    /// "Not now" answers, paced as a link's no is — whatever project the
    /// page asks about next: a page that can write a `Cargo.toml` into every
    /// folder it holds could otherwise make each one a new question.
    asking: Mutex<trust::Links>,
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

/// `with_workspace`, with the consents beside it — locked in that order.
fn with_consents<T>(
    state: &AppState,
    f: impl FnOnce(&mut Workspace, &mut Consents) -> Result<T, VfsError>,
) -> Result<T, VfsError> {
    let mut workspace = state
        .workspace
        .lock()
        .expect("the workspace lock is poisoned");
    let mut consents = state.consents.lock().expect("the consent lock is poisoned");
    f(&mut workspace, &mut consents)
}

/// What a gesture the operating system drew gives — a dialog, a drop onto
/// the window, a path the program was started or reached with (ADR 0005):
/// a folder opened, or a file alone without its folder, to be read and
/// written, and remembered. A path that is neither — gone, or a device —
/// gives nothing. A list that cannot be written keeps the consent for this
/// session: refusing the gesture over a full disk would be the program's
/// fault shown as the person's.
fn grant_gesture(
    workspace: &mut Workspace,
    consents: &mut Consents,
    path: &std::path::Path,
) -> Result<(), VfsError> {
    /* A folder of the program's own lets nothing in whatever is granted, so
    nothing is granted or remembered for it: a consent kept to it would only
    wait for the day the folder stopped being protected. */
    if workspace.is_protected(path) {
        return Ok(());
    }
    if path.is_dir() {
        let root = workspace.add_root(path)?;
        let _ = consents.remember(Consent::folder(root, Access::ReadWrite));
    } else if path.is_file() {
        let file = workspace.grant_file(path, Access::ReadWrite)?;
        let _ = consents.remember(Consent::file(file, Access::ReadWrite));
    }
    Ok(())
}

/// Every path a gesture brought, granted; one that cannot be is passed over
/// and the rest still are.
fn grant_gestures<P: AsRef<std::path::Path>>(state: &AppState, paths: &[P]) {
    let _ = with_consents(state, |workspace, consents| {
        for path in paths {
            if let Err(err) = grant_gesture(workspace, consents, path.as_ref()) {
                eprintln!(
                    "[uleditor] not granted: {} — {err}",
                    path.as_ref().display()
                );
            }
        }
        Ok(())
    });
}

/// Lets into the sandbox what a claimed consent names, as far as it goes.
fn admit(workspace: &mut Workspace, consent: &Consent) -> Result<(), VfsError> {
    match (consent.kind, consent.access) {
        (Kind::Folder, Access::ReadWrite) => workspace.add_root(&consent.path).map(|_| ()),
        (Kind::Folder, access) => workspace.grant_folder(&consent.path, access).map(|_| ()),
        (Kind::File, access) => workspace.grant_file(&consent.path, access).map(|_| ()),
    }
}

/// Offers files a list Rust made holds — the library, a language server's
/// answer, a conversion's output — for the page to claim, to be read.
fn offer_files<'a>(state: &AppState, paths: impl IntoIterator<Item = &'a str>, access: Access) {
    let mut consents = state.consents.lock().expect("the consent lock is poisoned");
    for path in paths {
        if let Ok(real) = std::fs::canonicalize(path) {
            if real.is_file() {
                consents.offer(Consent::file(real, access));
            }
        }
    }
}

/// A copy of the sandbox, for a walk of the whole tree.
///
/// A search holds what it walks for as long as it walks it, and under the lock
/// that was every command that needs the sandbox — saving among them — waiting
/// for a search through a large folder to finish. The copy is two lists of
/// folders, and the walk checks against it just as it would against the one
/// behind the lock.
fn walking_copy(state: &State<'_, AppState>) -> Workspace {
    state
        .workspace
        .lock()
        .expect("the workspace lock is poisoned")
        .clone()
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
    ui_language: Option<String>,
) -> Result<Option<Stat>, VfsError> {
    /* One of the core's dialogs at a time (`Questions`), and not again the
    moment one was cancelled: Enter in an empty folder dialog opens the
    folder it shows (`trust::Quiet`). */
    let questions = app.state::<Questions>();
    let Ok(_asking) = questions.0.try_lock() else {
        return Ok(None);
    };
    let dialogs = || state.dialogs.lock().expect("the dialog lock is poisoned");
    if !dialogs().may_ask(std::time::Instant::now()) {
        return Err(VfsError::Unsupported(trust::dialog_paused(
            ui_language.as_deref(),
        )));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |picked| {
        let _ = tx.send(picked);
    });

    let Some(path) = rx.await.ok().flatten() else {
        dialogs().declined(std::time::Instant::now());
        return Ok(None);
    };
    let Ok(path) = path.into_path() else {
        return Ok(None);
    };

    with_consents(&state, |workspace, consents| {
        grant_gesture(workspace, consents, &path)?;
        workspace.stat(&path).map(Some)
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
    let questions = app.state::<Questions>();
    let Ok(_asking) = questions.0.try_lock() else {
        return Ok(Vec::new());
    };
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
        /* The file chosen, and not the folder around it: pointing at a file
        is not asking for its folder in the search and Ctrl+P (ADR 0005). */
        let stat = with_consents(&state, |workspace, consents| {
            grant_gesture(workspace, consents, &path)?;
            workspace.stat(&path)
        })?;
        out.push(stat);
    }
    Ok(out)
}

/// "Open for editing…": how a document opened only to be read — from the
/// library on desktop, F12's answer, a converted PDF (ADR 0005) — becomes one
/// that can be saved, without its folder coming with it.
///
/// The page names the document; Rust draws the system's own file dialog in
/// the document's folder, and grants what the person picks there, to be read
/// and written — the gesture "Open files" is, and no more. **Nothing is
/// chosen in it beforehand**: with the name filled in, Enter alone was Open,
/// and script in the page sees every key — it could bring the dialog up in
/// the middle of a word and have the next Enter grant a file of its choosing
/// (the independent review of card 501). The person clicks the file. The
/// name has to be one the page may read already, so the dialog never opens
/// on a folder the page could not see into, nor on one of the program's own;
/// a document that can be written already is answered without asking. A
/// Cancel is paced as a link's no is — nothing asked for half a minute, and
/// after three not again this session — and one question is on the screen
/// at a time, shared with the core's others.
#[cfg(desktop)]
#[tauri::command]
async fn open_for_editing(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    ui_language: Option<String>,
) -> Result<Option<Stat>, VfsError> {
    let (document, protected) = with_workspace(&state, |workspace| {
        let document = workspace.stat(&path)?;
        let protected = workspace.is_protected(&document.uri);
        Ok((document, protected))
    })?;
    if !document.readonly {
        return Ok(Some(document));
    }
    if protected {
        return Err(VfsError::ReadOnly(document.uri));
    }
    let questions = app.state::<Questions>();
    let Ok(_asking) = questions.0.try_lock() else {
        return Ok(None);
    };
    let editing = || state.editing.lock().expect("the editing lock is poisoned");
    if !editing().may_ask(std::time::Instant::now()) {
        return Err(VfsError::Unsupported(trust::editing_paused(
            ui_language.as_deref(),
        )));
    }

    let shown = std::path::PathBuf::from(&document.uri);
    let mut dialog = app
        .dialog()
        .file()
        .set_title(trust::editing_title(ui_language.as_deref(), &document.name));
    if let Some(folder) = shown.parent() {
        dialog = dialog.set_directory(folder);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.pick_file(move |picked| {
        let _ = tx.send(picked);
    });
    let Some(picked) = rx.await.ok().flatten().and_then(|p| p.into_path().ok()) else {
        editing().declined(std::time::Instant::now());
        return Ok(None);
    };

    with_consents(&state, |workspace, consents| {
        grant_gesture(workspace, consents, &picked)?;
        workspace.stat(&picked).map(Some)
    })
}

/// A phone has no such step: the library there is read and written already.
#[cfg(mobile)]
#[tauri::command]
fn open_for_editing(_path: String) -> Result<Option<Stat>, VfsError> {
    Err(VfsError::Unsupported(
        "Opening for editing is not needed on mobile devices.".into(),
    ))
}

/// Where a converted or exported file should go.
///
/// The chosen file is **granted** before the path is handed back. Choosing a
/// file in a dialog the operating system drew is the strongest permission there
/// is — stronger than anything this program could ask for itself — and without
/// recording it the write that follows was refused by our own sandbox, with a
/// message saying the file escaped a workspace the user had just pointed at.
/// The file alone, to be written, though it does not exist yet: naming where
/// to save is neither opening the folder nor letting the rest of it in.
#[tauri::command]
async fn pick_save_target(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    suggested_name: String,
    ui_language: Option<String>,
) -> Result<Option<String>, VfsError> {
    let questions = app.state::<Questions>();
    let Ok(_asking) = questions.0.try_lock() else {
        return Ok(None);
    };
    let dialogs = || state.dialogs.lock().expect("the dialog lock is poisoned");
    if !dialogs().may_ask(std::time::Instant::now()) {
        return Err(VfsError::Unsupported(trust::dialog_paused(
            ui_language.as_deref(),
        )));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(offered_name(&suggested_name))
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });

    let Some(path) = rx.await.ok().flatten().and_then(|p| p.into_path().ok()) else {
        dialogs().declined(std::time::Instant::now());
        return Ok(None);
    };

    /* That file, to be written, though it does not exist yet — and not the
    folder it goes into (ADR 0005). */
    with_consents(&state, |workspace, consents| {
        /* Never a file in one of the program's own folders, as no gesture
        is (`grant_gesture`): it would let nothing in, and would be kept. */
        if workspace.is_protected(&path) {
            return Err(VfsError::ReadOnly(path.to_string_lossy().into_owned()));
        }
        let target = workspace.grant_future_file(&path)?;
        let _ = consents.remember(Consent::file(target, Access::ReadWrite));
        Ok(())
    })?;

    Ok(Some(path.to_string_lossy().into_owned()))
}

/// The name a "Save as" dialog offers: the last part of what the page
/// suggested and nothing else. A whole path in the name box outranks the
/// folder the dialog opened in (measured by the review of card 501): script
/// in the page could suggest the Startup folder, and one Enter would grant it
/// a file there. A name with anything a file name cannot hold is not offered.
///
/// And only what reads as what it is: letters and digits of any script, the
/// space, and the punctuation names are made of — no right-to-left override
/// to show `ugovor\u{202E}fdp.exe` as "ugovorexe.pdf", no invisible mark,
/// nothing Windows would quietly drop (a trailing dot or space) or take for a
/// device (`CON`, `NUL.txt`, also in full-width letters), no run of spaces,
/// no more than a few in all, and no letter drawn as nothing to push an
/// extension out of sight, no `%` for the dialog to expand into a path, and
/// not too long to be read whole. Anything else is offered as "untitled", and
/// the person names it.
fn offered_name(suggested: &str) -> String {
    const LONGEST: usize = 120;
    /* A space with a combining mark after it is not two spaces, and fifty of
    them pushed `.exe` along a dotted line (the review of 396a4f9); a real
    name has a handful. */
    const MOST_SPACES: usize = 8;
    /* `CLOCK$`, `COM0` and `LPT0` are not devices on Windows 11 any more, and
    are kept out all the same. */
    const DEVICES: [&str; 33] = [
        "CON",
        "PRN",
        "AUX",
        "NUL",
        "CONIN$",
        "CONOUT$",
        "CLOCK$",
        "COM0",
        "COM1",
        "COM2",
        "COM3",
        "COM4",
        "COM5",
        "COM6",
        "COM7",
        "COM8",
        "COM9",
        "COM\u{B9}",
        "COM\u{B2}",
        "COM\u{B3}",
        "LPT1",
        "LPT2",
        "LPT3",
        "LPT4",
        "LPT5",
        "LPT6",
        "LPT7",
        "LPT8",
        "LPT9",
        "LPT\u{B9}",
        "LPT\u{B2}",
        "LPT\u{B3}",
        "LPT0",
    ];
    let last = suggested.rsplit(['/', '\\']).next().unwrap_or_default();
    /* Compared as the ASCII full-width letters look like: `ＣＯＮ` is read as
    what it shows. */
    let stem: String = last
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .chars()
        .map(|c| match c {
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            _ => c,
        })
        .collect();
    let fits = !last.is_empty()
        && last.chars().count() <= LONGEST
        && !last.ends_with(['.', ' '])
        && !last.starts_with(' ')
        && last.chars().any(char::is_alphanumeric)
        && !last.contains("  ")
        && last.chars().filter(|c| *c == ' ').count() <= MOST_SPACES
        && last.chars().all(|c| {
            (c.is_alphanumeric() && !trust::BLANK_LETTERS.contains(&c))
                || " -_.,()[]{}'!@#$+=~;&".contains(c)
        })
        && !DEVICES
            .iter()
            .any(|device| stem.eq_ignore_ascii_case(device));
    if fits {
        last.to_string()
    } else {
        "untitled".to_string()
    }
}

/// Opens a web link in the system browser, and says whether it did.
///
/// Only `https://` (`trust::link`). And only after asking, unless the link is
/// one of the program's own: the command is callable from the page, an
/// address is a message to the site it names, and script in the page could
/// write into one whatever it had read — the browser would carry it out of
/// the program with no gesture at all (found by the independent review of
/// ADR 0005). The person clicking a link in a document, or asking for a search
/// for a font the screen does not have, answers the question; script cannot.
///
/// Not queued: a link asked for while any of the core's questions is open is
/// not opened, so a page cannot stack dialogs up behind each other. After a no
/// the page is kept from asking for a while, and after a few not again this
/// session (`trust::Links`).
#[cfg(desktop)]
#[tauri::command]
async fn open_external(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
    ui_language: Option<String>,
) -> Result<bool, VfsError> {
    let links = || state.links.lock().expect("the link lock is poisoned");
    let url = match trust::link(&url) {
        Some(trust::Link::Own(url)) => {
            if !links().may_open_own(std::time::Instant::now()) {
                return Ok(false);
            }
            url
        }
        Some(trust::Link::Other(url)) => {
            let questions = app.state::<Questions>();
            let Ok(_asking) = questions.0.try_lock() else {
                return Ok(false);
            };
            if !links().may_ask(std::time::Instant::now()) {
                return Err(VfsError::Unsupported(trust::links_paused(
                    ui_language.as_deref(),
                )));
            }
            let asked = trust::link_question(ui_language.as_deref(), &url);
            let answer = ask(&app, &asked, tauri_plugin_dialog::MessageDialogKind::Info).await;
            if answer != trust::Answer::Trust {
                links().declined(std::time::Instant::now());
                return Ok(false);
            }
            url
        }
        None => {
            return Err(VfsError::Unsupported(
                "This link does not open outside the application.".into(),
            ))
        }
    };

    /* The address as it was parsed and shown, not as the page wrote it. */
    let url = url.as_str();
    #[cfg(target_os = "windows")]
    // `rundll32 url.dll` rather than `cmd /C start`: `start` reads `&` in a
    // query string as a command separator. By its full path, not by a name
    // searched for beside the program first.
    let spawned = std::process::Command::new(
        std::path::PathBuf::from(
            std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into()),
        )
        .join("System32")
        .join("rundll32.exe"),
    )
    .args(["url.dll,FileProtocolHandler", url])
    .spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(url).spawn();

    spawned.map(|_| true).map_err(VfsError::from)
}

/// On a phone the browser is reached through an Intent, which needs the plugin
/// we have not taken yet. Said out loud rather than silently swallowed.
#[cfg(mobile)]
#[tauri::command]
fn open_external(_url: String) -> Result<bool, VfsError> {
    Err(VfsError::Unsupported(
        "Opening the browser is not wired up on mobile devices yet.".into(),
    ))
}

/* ── updates ─────────────────────────────────────────────────────────── */

/// The update `check_update` found, kept here until the person takes it.
#[cfg(desktop)]
#[derive(Default)]
struct Updates(Mutex<Option<tauri_plugin_updater::Update>>);

/// What the page is told about an update: which version, over which.
#[cfg(desktop)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Available {
    version: String,
    current_version: String,
}

/// Looks for a new version, at the endpoint `tauri.conf.json` names and in no
/// other way.
///
/// The page has no updater permission of its own. The plugin's `check` takes a
/// proxy, headers and a target from whoever calls it, and a proxy named by
/// script in the page — `http://name:<what it read>@<more of it>.example/` —
/// would carry the data out of the program in a DNS lookup and a
/// `Proxy-Authorization` header, from Rust, where the CSP does not reach (found
/// by the independent review of N6). These two commands take nothing from the
/// page but the channel progress is reported on.
#[cfg(desktop)]
#[tauri::command]
async fn check_update(
    app: tauri::AppHandle,
    updates: State<'_, Updates>,
) -> Result<Option<Available>, String> {
    use tauri_plugin_updater::UpdaterExt;

    let found = app
        .updater()
        .map_err(|err| err.to_string())?
        .check()
        .await
        .map_err(|err| err.to_string())?;
    let available = found.as_ref().map(|update| Available {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
    });
    *updates.0.lock().expect("the update lock is poisoned") = found;
    Ok(available)
}

/// How a download is going, in the shape the plugin's own events had.
#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", content = "data")]
enum Downloading {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

/// Downloads and installs the update `check_update` found. Nothing of it runs
/// unless it verifies against the public key compiled into the program.
#[cfg(desktop)]
#[tauri::command]
async fn install_update(
    app: tauri::AppHandle,
    updates: State<'_, Updates>,
    on_event: tauri::ipc::Channel<Downloading>,
) -> Result<(), String> {
    let update = updates
        .0
        .lock()
        .expect("the update lock is poisoned")
        .clone()
        .ok_or_else(|| "No update was found to install.".to_string())?;
    let mut started = false;
    update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_event.send(Downloading::Started { content_length });
                }
                let _ = on_event.send(Downloading::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(Downloading::Finished);
            },
        )
        .await
        .map_err(|err| err.to_string())?;
    /* The restart is the core's, and only here: a page that could restart
    the program could start every question paced "for the session" afresh
    (the review of 46418d0). On Windows the installer has closed the program
    already; elsewhere the new files are in place and only this is missing. */
    app.restart()
}

/// A phone updates through its store.
#[cfg(mobile)]
#[tauri::command]
fn check_update() -> Result<Option<()>, String> {
    Err("This build updates where it was installed from.".into())
}

#[cfg(mobile)]
#[tauri::command]
fn install_update() -> Result<(), String> {
    Err("This build updates where it was installed from.".into())
}

/* ── file system ─────────────────────────────────────────────────────── */

/// What the page asks to have — a document or folder it was told about, one
/// restored from the last session, one in the recent list.
///
/// The page **claims**; it never grants (ADR 0005). A path already let in is
/// confirmed. Otherwise it has to be one Rust offered this session — the
/// library, a language server's answer, a conversion — or one a remembered
/// consent covers, and it is let in as far as that consent goes. Anything
/// else is refused, however it is asked: code in the webview that names
/// `C:\Windows` gets nothing. One refused path does not bring down the rest.
#[tauri::command]
fn adopt_paths(state: State<'_, AppState>, paths: Vec<String>) -> Result<Vec<Stat>, VfsError> {
    let mut out = Vec::new();
    for raw in paths {
        let stat = with_consents(&state, |workspace, consents| {
            if let Ok(stat) = workspace.stat(&raw) {
                return Ok(stat);
            }
            let real = std::fs::canonicalize(&raw)?;
            match consents.claim(&real) {
                Some(consent) => {
                    admit(workspace, &consent)?;
                    workspace.stat(&real)
                }
                None => Err(VfsError::OutsideWorkspace(raw.clone())),
            }
        });
        match stat {
            Ok(stat) => out.push(stat),
            Err(err) => eprintln!("[uleditor] claimed path refused: {raw} — {err}"),
        }
    }
    Ok(out)
}

/// A folder taken off the tree leaves the sandbox as well, keeping the files
/// still open in it (`keep`, which can only narrow). `remember: false` — a
/// folder taken out of Recent — forgets the consent too; a folder that only
/// could not be read just now stays remembered, to be opened again.
#[tauri::command]
fn forget_root(
    state: State<'_, AppState>,
    path: String,
    keep: Option<Vec<String>>,
    remember: Option<bool>,
) -> Result<(), VfsError> {
    let keep: Vec<std::path::PathBuf> = keep
        .unwrap_or_default()
        .into_iter()
        .map(std::path::PathBuf::from)
        .collect();
    with_consents(&state, |workspace, consents| {
        workspace.forget_root(&path, &keep);
        if !remember.unwrap_or(false) {
            consents.forget(&ul_core::vfs::canonical_path(&path))?;
        }
        Ok(())
    })
}

/// Forgets every consent, given or claimed — "Forget recently opened files".
/// What is open now stays open; nothing is let in again after a restart
/// until it is handed over again.
#[tauri::command]
fn forget_consents(state: State<'_, AppState>) -> Result<(), VfsError> {
    with_consents(&state, |_, consents| Ok(consents.forget_all()?))
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
    walking_copy(&state).search(&query)
}

/// The file list for quick open by name (`Ctrl+P`).
#[tauri::command]
async fn list_files(state: State<'_, AppState>, limit: usize) -> Result<Vec<Stat>, VfsError> {
    walking_copy(&state).list_files(limit)
}

/// A survey of the device in search of documents.
///
/// The locations looked at come from `ul_core::default_roots()` and depend on
/// the platform. The folders are walked and granted nothing: each document
/// found is **offered**, and let in when the page claims it by opening it — to
/// be read on desktop (ADR 0005). A glance at the library used to grant
/// Documents, Downloads, Desktop and Pictures whole, to read and to write.
#[tauri::command]
async fn scan_library(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    limit: Option<usize>,
    ui_language: Option<String>,
) -> Result<LibraryScan, VfsError> {
    // Missing folders are expected — the list is the same for every device.
    let usable: Vec<_> = ul_core::default_roots()
        .into_iter()
        .filter(|root| root.is_dir())
        .collect();
    /* No more than the list was ever meant to hold, whatever the page asks. */
    let limit = Some(
        limit
            .unwrap_or(ul_core::library::DEFAULT_LIMIT)
            .min(ul_core::library::DEFAULT_LIMIT),
    );

    /* On desktop the person is asked first, once (see `library_allowed`). */
    #[cfg(desktop)]
    if !library_allowed(&app, &state, &usable, ui_language.as_deref()).await {
        return Err(VfsError::Unsupported(
            if ui_language.as_deref() == Some("hr") {
                "Knjižnici nije dopušteno pregledati tvoje mape.".into()
            } else {
                "The library was not allowed to look through your folders.".into()
            },
        ));
    }
    #[cfg(mobile)]
    let _ = (&app, &ui_language);

    /* Walked outside the lock, on a copy, like a search: a walk of Documents,
    Downloads, Desktop and Pictures held every command that needs the
    sandbox — saving among them — until it was done. */
    let workspace = with_workspace(&state, |workspace| Ok(workspace.clone()))?;
    let scan = workspace.scan_library(&usable, limit)?;

    /* The folders are granted nothing; each document found is offered, for
    the page to claim when it is opened (ADR 0005). To be read on desktop,
    where opening one to write is a gesture of its own; on a phone, where
    the system's "All files access" is the consent, to be written too. */
    let access = if cfg!(mobile) {
        Access::ReadWrite
    } else {
        Access::Read
    };
    offer_files(
        &state,
        scan.entries.iter().map(|entry| entry.uri.as_str()),
        access,
    );
    Ok(scan)
}

#[tauri::command]
fn read_file(state: State<'_, AppState>, path: String) -> Result<Response, VfsError> {
    let bytes = with_workspace(&state, |workspace| workspace.read(&path))?;
    Ok(Response::new(bytes))
}

/// A document read to be edited: remembered as it was, so that its save can
/// tell whether somebody else changed it meanwhile (`Workspace::save`).
#[tauri::command]
fn read_document(
    state: State<'_, AppState>,
    path: String,
    reading: Option<Reading>,
) -> Result<Response, VfsError> {
    let (token, bytes) =
        with_workspace(&state, |workspace| workspace.read_document(&path, reading))?;
    Ok(Response::new(framed(token, bytes)))
}

/// A reading's token in front of the document's bytes: the first eight, as a
/// little-endian number (ADR 0006). A response carries a body and nothing
/// else, and a second command for the token would make a reading named and
/// not yet read a state every path had to refuse. Written here only, and read
/// in `tauri-fs.ts` only.
fn framed(token: Reading, bytes: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + bytes.len());
    out.extend_from_slice(&token.to_le_bytes());
    out.extend(bytes);
    out
}

/// Every yes to "Run this project's code?" forgotten, and the language
/// servers stopped: each project trusted before is asked about again before
/// it starts (card 488). A "Not now" stays (`ProjectTrust::forget_all`).
/// The servers go first, so a list that cannot be written leaves none of
/// them running on a yes about to come back after a restart; and off the
/// thread the window draws on, since a server takes a moment to stop.
#[tauri::command]
async fn forget_trusted_projects(app: tauri::AppHandle) -> Result<(), VfsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let lsp = app.state::<LspState>();
        lsp.servers
            .lock()
            .expect("the server lock is poisoned")
            .stop_all();
        let forgotten = lsp
            .trust
            .lock()
            .expect("the trust lock is poisoned")
            .forget_all();
        forgotten.map_err(VfsError::from)
    })
    .await
    .map_err(|err| VfsError::Unsupported(err.to_string()))?
}

/// A tab's readings, forgotten as it closes (ADR 0006).
#[tauri::command]
fn forget_readings(state: State<'_, AppState>, readings: Vec<Reading>) -> Result<(), VfsError> {
    with_workspace(&state, |workspace| {
        workspace.forget_readings(&readings);
        Ok(())
    })
}

/// A save. Refused with `VfsError::Changed` when the file is not what it was
/// when it was read to be edited, until the page passes `overwrite` — which
/// it does only after the person said so, for that one save. Compared with
/// the reading it names, if any; with `begin`, a file nobody read becomes a
/// reading, and its token is what comes back (ADR 0006).
#[tauri::command]
fn write_file(
    state: State<'_, AppState>,
    path: String,
    contents: Vec<u8>,
    overwrite: Option<bool>,
    reading: Option<Reading>,
    begin: Option<bool>,
) -> Result<Option<Reading>, VfsError> {
    with_workspace(&state, |workspace| {
        workspace.save(
            &path,
            &contents,
            overwrite.unwrap_or(false),
            reading,
            begin.unwrap_or(false),
        )
    })
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
        match self {
            /* The workspace's own, code and all: flattened to its words, a
            save refused over a changed file reached the image editor as a
            failure, and the person was never asked whether to write over it. */
            Self::Vfs(err) => err.serialize(serializer),
            Self::Image(err) => serializer.serialize_str(&err.to_string()),
        }
    }
}

/// What a command about an image says, and the reading it was (ADR 0006).
#[derive(serde::Serialize)]
struct WithReading<T: serde::Serialize> {
    #[serde(flatten)]
    value: T,
    reading: Option<Reading>,
}

/// What the image is — the size a person sees, the format, and whether this is
/// one of the formats that can be written back at all.
///
/// `as_document`: the image editor's reading of its document, so remembered
/// like one, and its token returned (ADR 0006). Asked about any other way, a
/// plain read, which remembers nothing.
#[tauri::command]
fn image_info(
    state: State<'_, AppState>,
    path: String,
    reading: Option<Reading>,
    as_document: Option<bool>,
) -> Result<WithReading<ImageInfo>, ImageCommandError> {
    let (token, bytes) = if as_document.unwrap_or(false) {
        let (token, bytes) =
            with_workspace(&state, |workspace| workspace.read_document(&path, reading))?;
        (Some(token), bytes)
    } else {
        (
            None,
            with_workspace(&state, |workspace| workspace.read(&path))?,
        )
    };
    Ok(WithReading {
        value: ul_image::info(&bytes)?,
        reading: token,
    })
}

/// The picture as a PNG, for a format the webview cannot draw — a TIFF. Read
/// and decoded here, under ul-image's limits, and handed over as the bytes
/// of a PNG. A plain read: it remembers nothing, as the document was already
/// read to be edited when it was opened.
///
/// Decoded off the thread the window draws on: a large TIFF takes seconds,
/// and a command that is not `async` runs there.
#[tauri::command]
async fn image_preview(
    state: State<'_, AppState>,
    path: String,
) -> Result<Response, ImageCommandError> {
    let bytes = with_workspace(&state, |workspace| workspace.read(&path))?;
    let png = tauri::async_runtime::spawn_blocking(move || ul_image::preview(&bytes))
        .await
        .map_err(|err| ImageError::Decode(err.to_string()))??;
    Ok(Response::new(png))
}

/// Applies a plan and writes the result.
///
/// The bytes are read, transformed and written **without leaving Rust**: a
/// photograph out of a phone is a hundred and sixty megabytes decoded, and the
/// webview has no business holding it. What comes back is what the file now
/// holds — the new size, the format, and whether the encoding itself lost
/// anything, which the editor says before it says "saved".
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn image_write(
    state: State<'_, AppState>,
    source: String,
    target: String,
    ops: ImageOps,
    overwrite: Option<bool>,
    reading: Option<Reading>,
    begin: Option<bool>,
) -> Result<WithReading<Written>, ImageCommandError> {
    let bytes = with_workspace(&state, |workspace| workspace.read(&source))?;
    let (out, written) = ul_image::apply(&bytes, &ops)?;
    let reading = with_workspace(&state, |workspace| {
        workspace.save(
            &target,
            &out,
            overwrite.unwrap_or(false),
            reading,
            begin.unwrap_or(false),
        )
    })?;
    Ok(WithReading {
        value: written,
        reading,
    })
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
/// The output goes into this program's own cache folder — never beside the
/// original. A program that leaves a PDF next to somebody's drawing without
/// being asked is a program that litters, and the folder a `.cdr` lives in is
/// usually somebody's work.
///
/// The cache folder is the person's own. It used to be the system temporary
/// folder, which on Linux is `/tmp`, shared by every account on the machine,
/// under a name anybody could work out: another account could make that folder
/// first — as a link to wherever it liked — and choose where LibreOffice wrote,
/// what it deleted and which profile it started with.
#[tauri::command]
async fn convert_to_pdf(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<String, ConvertCommandError> {
    let source = with_workspace(&state, |workspace| workspace.resolve(&path))?;
    let backend = ul_convert::backend().ok_or(ConvertError::NotInstalled)?;

    /* One directory per document, named after the document rather than at
    random: a second conversion of the same file reuses it, and a person
    looking at the temporary folder can tell what is in there. */
    let converted = app
        .path()
        .app_cache_dir()
        .map_err(|err| ConvertError::Start(err.to_string()))?
        .join("converted");
    private_folder(&converted).map_err(ConvertError::from)?;
    let outdir = converted.join(digest_of(&path));

    /* The LibreOffice profile apart from the PDF, in the program's own data
    folder: the sandbox never lets the page in there (`Workspace::protect`),
    and a profile somebody could write is a LibreOffice that runs their
    macros. The cache, which the PDF is opened from, is not shut. */
    let profiles = app
        .path()
        .app_data_dir()
        .map_err(|err| ConvertError::Start(err.to_string()))?
        .join("libreoffice");
    private_folder(&profiles).map_err(ConvertError::from)?;
    let profile = profiles.join(digest_of(&path));

    /* Where the file to convert is staged, private like the profile: the page
    never reaches it, so it cannot swap the bytes between the check and the
    open (ul_convert::to_pdf), and each conversion copies into a directory of
    its own under it, so two asked for at once cannot either. Apart from both
    the profile and the cache the PDF is read from. */
    let staging = app
        .path()
        .app_data_dir()
        .map_err(|err| ConvertError::Start(err.to_string()))?
        .join("convert-input");
    private_folder(&staging).map_err(ConvertError::from)?;
    let workdir = staging.join(digest_of(&path));

    /* Two minutes. LibreOffice takes a few seconds for a drawing and can take
    twenty on a cold start, since the first run of a fresh profile builds it;
    a minute would time out on exactly the machine where it was slowest. */
    let output = ul_convert::to_pdf(
        &backend,
        &source,
        &outdir,
        &profile,
        &workdir,
        std::time::Duration::from_secs(120),
    )?;
    let output = output.to_string_lossy().into_owned();
    /* The PDF alone is offered, to be read: it is a copy in the program's own
    cache, and that folder has no business in the tree or a search. */
    offer_files(&state, [output.as_str()], Access::Read);
    Ok(output)
}

/// Asks a question in a dialog the system draws — which the page can neither
/// answer nor word — and waits for the answer. A dialog that went away without
/// one is a no.
async fn ask(
    app: &tauri::AppHandle,
    asked: &trust::Question,
    kind: tauri_plugin_dialog::MessageDialogKind,
) -> trust::Answer {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogResult};

    let (tx, rx) = tokio::sync::oneshot::channel();
    let dialog = app
        .dialog()
        .message(asked.body.clone())
        .title(asked.title.clone())
        .kind(kind)
        /* The safe answers where Enter and Escape land — see `trust::Question`. */
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            asked.not_now.clone(),
            asked.trust.clone(),
            asked.cancel.clone(),
        ));
    /* Owned by the window, so it cannot end up behind it while what asked
    waits for it. Desktop only: a phone has one window, and the plugin has no
    parent to set there. */
    #[cfg(desktop)]
    let dialog = match app.get_webview_window("main") {
        Some(window) => dialog.parent(&window),
        None => dialog,
    };
    dialog.show_with_result(move |pressed| {
        let _ = tx.send(pressed);
    });
    let pressed = match rx.await {
        Ok(MessageDialogResult::Custom(label)) => Some(label),
        _ => None,
    };
    asked.answer(pressed.as_deref())
}

/// Whether the library may look through `roots` on desktop: a consent to read
/// them, given once in a dialog the system draws and remembered (ADR 0005).
///
/// Script in the page can start a scan, and every document the scan found
/// was offered for it to claim and read — Documents, Downloads, Desktop and
/// Pictures, with no gesture at all (found by the independent review of
/// 39e0855). It cannot answer this. A no lasts the session; a yes is
/// remembered — that the library may look, not the folders granted — and
/// taken back with the rest by "Forget recently opened files".
#[cfg(desktop)]
async fn library_allowed(
    app: &tauri::AppHandle,
    state: &AppState,
    roots: &[std::path::PathBuf],
    interface: Option<&str>,
) -> bool {
    use std::sync::atomic::Ordering;
    use tauri_plugin_dialog::MessageDialogKind;

    let consented = || {
        state
            .consents
            .lock()
            .expect("the consent lock is poisoned")
            .library_allowed()
    };
    if consented() {
        return true;
    }
    if state.library_declined.load(Ordering::Relaxed) {
        return false;
    }
    let questions = app.state::<Questions>();
    let _asking = questions.0.lock().await;
    if consented() {
        return true;
    }
    if state.library_declined.load(Ordering::Relaxed) {
        return false;
    }

    let asked = trust::library_question(interface, roots);
    match ask(app, &asked, MessageDialogKind::Info).await {
        /* A yes lets the library look, and no more: the folders are not
        granted, and the page may claim only the documents a scan offers —
        not anything else lying in Downloads (found by the automated review
        of 54b2819). */
        trust::Answer::Trust => {
            let _ = state
                .consents
                .lock()
                .expect("the consent lock is poisoned")
                .allow_library();
            true
        }
        trust::Answer::NotNow => {
            state.library_declined.store(true, Ordering::Relaxed);
            false
        }
    }
}

/// A folder only its owner can enter, made if it is not there.
fn private_folder(path: &std::path::Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)?;
    /* `create` leaves a folder that is already there as it was, and one made
    before this was the rule is made private now. */
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
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

/// Whether a language server may start in `project`: asked of the person the
/// first time, in a dialog the system draws, and remembered (`trust.rs`).
/// `interface` picks the language the question is in, and nothing else.
/// What a held-back trust question begins with when it reaches the page,
/// which shows the rest: a code, as `CHANGED_OUTSIDE` is.
const QUESTION_HELD: &str = "ul:question-held:";

async fn may_start(
    app: &tauri::AppHandle,
    lsp: &LspState,
    language: &str,
    project: &std::path::Path,
    interface: Option<&str>,
) -> Result<bool, String> {
    use tauri_plugin_dialog::MessageDialogKind;

    let verdict = |lsp: &LspState| {
        lsp.trust
            .lock()
            .expect("the trust list is poisoned")
            .verdict(project)
    };
    /* Answered already: no waiting behind a question about another project. */
    match verdict(lsp) {
        trust::Verdict::Trusted => return Ok(true),
        trust::Verdict::Declined => return Ok(false),
        trust::Verdict::Ask => {}
    }
    /* One question at a time, and asked again once it is this one's turn: the
    one before may have been about this same project. */
    let questions = app.state::<Questions>();
    let _asking = questions.0.lock().await;
    match verdict(lsp) {
        trust::Verdict::Trusted => return Ok(true),
        trust::Verdict::Declined => return Ok(false),
        trust::Verdict::Ask => {}
    }

    /* After a "Not now", no question for a while, and after three none this
    session: not asked, the project's code does not run — and the person is
    told so, rather than left with an editor that marks nothing. */
    let asking = || lsp.asking.lock().expect("the asking lock is poisoned");
    if !asking().may_ask(std::time::Instant::now()) {
        return Err(format!(
            "{QUESTION_HELD}{}",
            trust::question_held(interface)
        ));
    }

    let asked = trust::question(interface, language, project);
    let answer = ask(app, &asked, MessageDialogKind::Warning).await;

    let mut trust = lsp.trust.lock().expect("the trust list is poisoned");
    match answer {
        /* Kept for the session even when it cannot be written down. */
        trust::Answer::Trust => {
            let _ = trust.trust(project);
            Ok(true)
        }
        trust::Answer::NotNow => {
            trust.decline(project);
            asking().declined(std::time::Instant::now());
            Ok(false)
        }
    }
}

/// A document is open: start a server if one is installed and the project is
/// trusted, and tell it.
///
/// Returns whether anything is listening. `false` is not a failure — it is the
/// ordinary answer on a machine without that server installed, or for a
/// project the person did not trust, and the editor uses it to stop expecting
/// underlines rather than to report a problem.
#[tauri::command]
async fn lsp_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    lsp: State<'_, LspState>,
    path: String,
    language: String,
    text: String,
    ui_language: Option<String>,
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

    /* Before the server, not inside it: starting is what runs the project's
    code, so the question comes first — every time a document opens,
    including the ones a restored session opens by itself. */
    if !may_start(&app, &lsp, &language, &project, ui_language.as_deref())
        .await
        .map_err(|held| LspCommandError::Vfs(VfsError::Unsupported(held)))?
    {
        return Ok(false);
    }

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

    let jumps = ul_lsp::parse_locations(&answer)
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
        .collect::<Vec<_>>();
    /* A file pointed at in a library is offered, to be read, and nothing
    beside it: a server's answer is not a person pointing at a folder
    (ADR 0005). Only there — see `library_source` — and judged where it
    really is: the path the server named with its links followed, which is
    what is offered. Judging the name and offering where it led let a link
    in a `node_modules` named `x.ts` offer the key it pointed at (found by
    the review of 63f3655). */
    {
        let mut consents = state.consents.lock().expect("the consent lock is poisoned");
        for jump in &jumps {
            let Ok(real) = std::fs::canonicalize(&jump.path) else {
                continue;
            };
            if real.is_file() && library_source(&language, &real) {
                consents.offer(Consent::file(real, Access::Read));
            }
        }
    }
    Ok(jumps)
}

/// Whether a file a language server pointed at may be offered to the page:
/// one of that language's own sources, where its libraries are kept — the
/// Rust toolchain and the crates downloaded (`.rustup`, `.cargo`, or where
/// `RUSTUP_HOME` and `CARGO_HOME` say), a `node_modules`, a Python
/// `site-packages` or the stubs a server ships.
///
/// Not any file it names: the page writes the documents the server reads, and
/// a document can make the server name any file at all — `#[path = "…/id_rsa"]
/// mod x;`, an import of `…/.env` — so its answer is not the person asking
/// for that file (found by the review of 39e0855). A definition inside the
/// folders already open needs no offer, and one elsewhere — a sibling project
/// — is not opened by F12; it is opened as any folder is.
fn library_source(language: &str, path: &std::path::Path) -> bool {
    let (extensions, places): (&[&str], &[&str]) = match language {
        "rust" => (&["rs"], &[".rustup", ".cargo"]),
        "typescript" | "javascript" => (
            &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
            &["node_modules"],
        ),
        "python" => (
            &["py", "pyi"],
            &["site-packages", "dist-packages", "typeshed-fallback"],
        ),
        _ => return false,
    };
    let source = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extensions.iter().any(|e| e.eq_ignore_ascii_case(extension)));
    let in_a_place = path.components().any(|part| {
        let part = part.as_os_str().to_string_lossy();
        places.iter().any(|place| place.eq_ignore_ascii_case(&part))
    });
    let in_a_home = language == "rust"
        && ["RUSTUP_HOME", "CARGO_HOME"]
            .iter()
            .filter_map(std::env::var_os)
            .filter_map(|home| std::fs::canonicalize(home).ok())
            .any(|home| path.starts_with(home));
    source && (in_a_place || in_a_home)
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
///
/// No more than `MOST_REPORTS` a run: the page can call this, and a runaway —
/// or script in the page — writing report after report would fill the disk,
/// which old reports are trimmed of only at the next start.
#[tauri::command]
fn record_crash(text: String) -> Result<String, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static WRITTEN: AtomicUsize = AtomicUsize::new(0);
    if WRITTEN.fetch_add(1, Ordering::Relaxed) >= MOST_REPORTS {
        return Err("enough reports were written this run".into());
    }
    crash::write(&within_limit(text))
        .map(|path| path.display().to_string())
        .map_err(|err| err.to_string())
}

/// The most reports the window may write in one run.
const MOST_REPORTS: usize = 16;

/// The report, cut to at most `LONGEST_REPORT` bytes when it is longer.
///
/// The cut moves back to the start of the letter it would land in: slicing a
/// `str` inside a letter panics, and with `panic = "abort"` in the release
/// profile a report about one crash would have been the next.
fn within_limit(text: String) -> String {
    if text.len() <= LONGEST_REPORT {
        return text;
    }
    let mut end = LONGEST_REPORT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n…the rest was cut; it was longer than this file is allowed to be.\n",
        &text[..end]
    )
}

/* ── closing the window ────────────────────────────────────────────────── */

/// How long a close request may wait for the page to say it has it. Past
/// that the page is taken to be frozen and the window closes as it would
/// have before there was a question to ask.
const UNANSWERED: std::time::Duration = std::time::Duration::from_secs(3);

/// Whether a close request is held for the page to ask about unsaved work.
///
/// The decision is here rather than in a `onCloseRequested` listener on the
/// page. Tauri holds every close while a page listens for one, and a reload —
/// a change of language, F5 — leaves the old page's listener registered with
/// nobody behind it: the close was held and never answered, and Alt+F4 did
/// nothing at all. So the page says it will ask (`guard_close`), every page
/// load takes that back until the new page says it again, and a request the
/// page does not acknowledge in `UNANSWERED` goes through.
#[derive(Default)]
struct CloseGuard(Mutex<Guarding>);

#[derive(Default)]
struct Guarding {
    on: bool,
    /// When a held request went to the page and has not been acknowledged.
    unanswered_since: Option<std::time::Instant>,
}

impl CloseGuard {
    fn set(&self, on: bool) {
        let mut guarding = self.0.lock().unwrap_or_else(|p| p.into_inner());
        guarding.on = on;
        guarding.unanswered_since = None;
    }

    fn acknowledge(&self) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .unanswered_since = None;
    }

    /// Whether to hold this close request and hand it to the page.
    fn hold(&self, now: std::time::Instant) -> bool {
        let mut guarding = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if !guarding.on {
            return false;
        }
        match guarding.unanswered_since {
            None => {
                guarding.unanswered_since = Some(now);
                true
            }
            Some(since) if now.duration_since(since) < UNANSWERED => true,
            Some(_) => {
                // The page never answered: let this one through.
                guarding.on = false;
                guarding.unanswered_since = None;
                false
            }
        }
    }
}

/// The page will ask before the window closes — or, with `on` false, that it
/// is done asking and the close it is about to make should go through.
#[tauri::command]
fn guard_close(guard: State<'_, CloseGuard>, on: bool) {
    guard.set(on);
}

/// The page has the close request and is dealing with it.
#[tauri::command]
fn close_acknowledged(guard: State<'_, CloseGuard>) {
    guard.acknowledge();
}

/// The reports nobody has been shown yet, and after this call, none.
///
/// Drained the same way the launch paths are, and for the same reason: the
/// window reloads when the language changes, and a list that survived would
/// announce the same crash every time somebody switched between English and
/// Croatian.
///
/// Each report is let in to be read, and nothing else of the reports' folder,
/// which stays shut (`Workspace::show_own_file`): Rust shows the page what it
/// wrote itself. Not as an offer — a language server's answer becomes one,
/// and must not open a protected folder.
#[tauri::command]
fn take_crash_reports(state: State<'_, AppState>) -> Vec<String> {
    let reports = crash::unseen();
    let _ = with_workspace(&state, |workspace| {
        for report in &reports {
            let _ = workspace.show_own_file(report);
        }
        Ok(())
    });
    reports
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

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        /* The window never leaves the application. A link in a Markdown
        preview was followed by the window itself: the whole interface gave way
        to the page, with no address bar to say where it was and unsaved work
        behind it. The shell sends such links to the browser instead
        (`routeExternalLinks`); this is what holds when something does not. */
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("stay-in-app")
                .on_navigation(|webview, url| {
                    stays_in_app(url, webview.app_handle().config().build.dev_url.as_ref())
                })
                .build(),
        );

    /*
     * The updater, and the restart that follows it.
     *
     * Desktop only, in both directions: a phone updates through its store, and
     * Tauri's updater will not build for Android at all. The endpoint and the
     * public key live in `tauri.conf.json` — the key is what makes this safe to
     * have, since an update is only installed if it was signed by the private
     * half, which is never in the repository — it is in GitHub Secrets and in
     * the one file it was made in (docs/RELEASE.md). Without that, "download
     * and run an executable from the internet" is exactly what it sounds like.
     * The page reaches it only through `check_update` and `install_update`.
     */
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Updates::default());

    /*
     * A second double-click has to reach the window that is already open. Without
     * this, every file opened from Explorer starts another copy of the program,
     * each with its own tabs and its own idea of what is unsaved — and the second
     * one would fight the first over the same file.
     */
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        /* Imported here rather than at the top of the file: on Android neither
        this block nor the macOS one below is compiled, and an import nothing
        uses is an error under `-D warnings`. */
        use tauri::Emitter;
        /* A relative path is the second copy's, from where it was started:
        read against that folder, not this copy's. */
        let paths: Vec<String> = paths_from(argv.into_iter())
            .into_iter()
            .map(|path| {
                let given = std::path::Path::new(&path);
                if given.is_relative() {
                    std::path::Path::new(&cwd)
                        .join(given)
                        .to_string_lossy()
                        .into_owned()
                } else {
                    path
                }
            })
            .collect();
        if !paths.is_empty() {
            /* A second double-click is a gesture: granted here, in Rust, before
            the page is told (ADR 0005). */
            grant_gestures(&app.state::<AppState>(), &paths);
            let _ = app.emit("uleditor://open-paths", paths);
        }
        if let Some(window) = app.get_webview_window("main") {
            /*
             * Three calls, not one, and each answers a state the other two
             * cannot. `set_focus` alone leaves a **minimised** window
             * minimised — the document opens, the tab appears, and nothing
             * comes up on the screen, which reads as the program having
             * ignored the file. `unminimize` restores it, `show` handles a
             * window hidden rather than minimised, and only then is there a
             * window for the focus to go to.
             */
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    builder
        /* Alt+F4, the taskbar's Close, the window menu and the traffic light
        all arrive here as a close request; see `CloseGuard`. */
        .manage(CloseGuard::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<CloseGuard>().hold(std::time::Instant::now()) {
                    use tauri::Emitter;
                    api.prevent_close();
                    let _ = window.emit("ul://close-requested", ());
                }
            }
        })
        /* A drop onto the window is a gesture the operating system drew: the
        paths are granted here, in Rust, and the page is told to open them
        only then (ADR 0005) — it no longer adopts what it is handed by the
        drop itself, which code in the webview could fake. */
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                use tauri::Emitter;
                grant_gestures(&webview.state::<AppState>(), paths);
                let list: Vec<String> = paths
                    .iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect();
                let _ = webview.app_handle().emit("uleditor://open-paths", list);
            }
        })
        .on_page_load(|webview, payload| {
            // A page that is loading asks nothing until it says it will.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                webview.state::<CloseGuard>().set(false);
                /* Nor holds a reading: the page kept its tokens in memory, and
                the one loading has none (ADR 0006). */
                if let Some(state) = webview.try_state::<AppState>() {
                    if let Ok(mut workspace) = state.workspace.lock() {
                        workspace.forget_all_readings();
                    }
                }
            }
        })
        .setup(|app| {
            /* Where a yes to a project's code is kept (trust.rs).
            `UL_DATA_DIR` is for the desktop checks, in a debug build only:
            they start the program on a scratch profile and must not leave
            their projects in the person's own answers. The crash reports
            follow the same profile (`crash::scratch_profile`, an absolute
            path or nothing). */
            let answers = crash::scratch_profile().or_else(|| app.path().app_config_dir().ok());

            /* The program's own folders are never the page's, whatever it
            opens above them: a page that could write the answers could trust
            a project for the person (`Workspace::protect`). */
            let mut workspace = Workspace::new();
            for own in [
                answers.clone(),
                app.path().app_data_dir().ok(),
                /* The WebView's own profile and the crash reports — by name,
                not their folder: on Windows that folder is the cache too, and
                a converted PDF is opened from the cache. */
                app.path()
                    .app_local_data_dir()
                    .ok()
                    .map(|dir| dir.join("EBWebView")),
                crash::folder().map(std::path::Path::to_path_buf),
                /* The folder the program runs from: Windows looks there first
                for a DLL the program loads, so a file written there could run
                as the program next start (the review of 0676285). */
                #[cfg(windows)]
                std::env::current_exe()
                    .ok()
                    .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf)),
            ]
            .into_iter()
            .flatten()
            {
                workspace.protect(own);
            }
            /* The installed program's own folders, in whatever build this is:
            a check runs under an identifier of its own, and a folder opened
            above `%APPDATA%` must not let a page write the answers the
            installed ulEditor reads. */
            for installed in crash::installed_folders() {
                workspace.protect(installed);
            }
            /* What the person consented to before, kept beside the answers and
            shut to the page with them. A folder that cannot be made keeps the
            consents for this session only. */
            let consents = answers
                .clone()
                .filter(|dir| private_folder(dir).is_ok())
                .map(|dir| Consents::load(dir.join("consents.json")))
                .unwrap_or_else(Consents::in_memory);
            app.manage(AppState {
                workspace: Mutex::new(workspace),
                consents: Mutex::new(consents),
                library_declined: std::sync::atomic::AtomicBool::new(false),
                links: Mutex::new(trust::Links::default()),
                editing: Mutex::new(trust::Links::default()),
                dialogs: Mutex::new(trust::Quiet::default()),
            });
            app.manage(Questions(tokio::sync::Mutex::new(())));
            /* The files the program was started with are a gesture too: granted
            now, and opened when the page asks for them. */
            let launched = paths_from(std::env::args());
            grant_gestures(&app.state::<AppState>(), &launched);
            app.manage(LaunchPaths(Mutex::new(launched)));

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
            /* Where a yes is kept. A folder that cannot be made keeps it for
            this session only: the person is asked again next time, which is
            the safe way for this to fail. */
            let trusted = answers
                .filter(|dir| private_folder(dir).is_ok())
                .map(|dir| trust::ProjectTrust::load(dir.join("trusted-projects.json")))
                .unwrap_or_default();
            app.manage(LspState {
                servers: Mutex::new(Servers::new()),
                sink,
                trust: Mutex::new(trusted),
                asking: Mutex::new(trust::Links::default()),
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
            check_update,
            install_update,
            pick_directory,
            pick_files,
            pick_save_target,
            open_for_editing,
            adopt_paths,
            forget_consents,
            forget_root,
            roots,
            read_directory,
            stat,
            detect_format,
            read_file,
            read_document,
            forget_readings,
            forget_trusted_projects,
            write_file,
            image_info,
            image_preview,
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
            guard_close,
            close_acknowledged,
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
                    grant_gestures(&_app.state::<AppState>(), &paths);
                    let _ = _app.emit("uleditor://open-paths", paths);
                    /* And the window comes up with it. This path had none of
                    that at all: a file opened from Finder while the program was
                    already running arrived in a tab nobody could see.
                    `Manager` is already in scope from the top of the file —
                    unlike `Emitter` above, which is not — so importing it here
                    would be an unused import, and this crate is built with
                    `-D warnings`. */
                    if let Some(window) = _app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        });
}

/// Whether a navigation of the window stays on the application's own page.
///
/// Exactly the application's origin and nothing near it — `http://tauri.localhost`
/// on Windows and Android, `tauri://localhost` on macOS and Linux, with no port,
/// no user and no other scheme — and only its page, `/` or `/index.html`.
///
/// The first version let through anything on the host `tauri.localhost`: https,
/// any port, a user in front of it. Only plain http is the application on
/// Windows; the rest went to the network, which resolves `*.localhost` to this
/// machine, so a link in a Markdown file could put whatever answers on a local
/// port in the window. And another path on the application's own origin is
/// answered with the application itself — a relative link in a README reloaded
/// it, and the unsaved work went with it.
///
/// A `blob:` only when the page that made it is the application. A debug build
/// may also reach its dev server, exactly as `devUrl` names it.
fn stays_in_app(url: &tauri::Url, dev: Option<&tauri::Url>) -> bool {
    if url.scheme() == "blob" {
        return tauri::Url::parse(url.path()).is_ok_and(|maker| own_origin(&maker, dev));
    }
    /* `tauri://localhost` — the address macOS and Linux open the application
    at — has no path at all, not `/`: `tauri` is not a scheme the URL
    standard gives a path to. Refusing it left those builds an empty window. */
    /* And with no query: the page is never reached with one, and a query is
    what an injected navigation would carry its payload in (ADR 0005). */
    own_origin(url, dev) && matches!(url.path(), "" | "/" | "/index.html") && url.query().is_none()
}

/// Whether a URL is on the application's own origin.
fn own_origin(url: &tauri::Url, dev: Option<&tauri::Url>) -> bool {
    let nobody = url.username().is_empty() && url.password().is_none();
    let app = if cfg!(any(windows, target_os = "android")) {
        url.scheme() == "http" && url.host_str() == Some("tauri.localhost")
    } else {
        url.scheme() == "tauri" && url.host_str() == Some("localhost")
    };
    let dev_server = cfg!(debug_assertions)
        && dev.is_some_and(|dev| {
            url.scheme() == dev.scheme()
                && url.host_str() == dev.host_str()
                && url.port_or_known_default() == dev.port_or_known_default()
        });
    nobody && ((app && url.port().is_none()) || dev_server)
}

#[cfg(test)]
mod tests {
    use super::{paths_from, stays_in_app, within_limit, LONGEST_REPORT};

    /// A save refused over a changed file reaches the page with a code in
    /// front, which the shell knows it by; the words are for people.
    /// F12 offers a library's sources, and not a file a document made the
    /// server name.
    #[test]
    fn only_a_librarys_own_sources_are_offered_from_a_definition() {
        use super::library_source;
        use std::path::Path;
        for (language, path) in [
            ("rust", "C:/Users/a/.rustup/toolchains/stable/lib/rustlib/src/rust/library/core/src/option.rs"),
            ("rust", "C:/Users/a/.cargo/registry/src/index/serde-1.0.0/src/lib.rs"),
            ("typescript", "C:/p/node_modules/typescript/lib/lib.dom.d.ts"),
            ("javascript", "C:/p/node_modules/react/index.js"),
            ("python", "C:/Python312/Lib/site-packages/requests/api.py"),
            ("python", "C:/p/node_modules/pyright/dist/typeshed-fallback/stdlib/os/__init__.pyi"),
        ] {
            assert!(library_source(language, Path::new(path)), "{language} {path}");
        }
        for (language, path) in [
            ("rust", "C:/Users/a/.ssh/id_rsa"),
            ("rust", "C:/Users/a/.cargo/credentials.toml"),
            ("rust", "C:/work/private/src/main.rs"),
            ("typescript", "C:/p/.env"),
            ("typescript", "C:/p/node_modules/x/secrets.json"),
            ("typescript", "C:/work/private/index.ts"),
            ("python", "C:/Users/a/.aws/credentials"),
            ("markdown", "C:/p/node_modules/x/README.md"),
            ("rust", "C:/p/node_modules/x/lib.rs"),
        ] {
            assert!(
                !library_source(language, Path::new(path)),
                "{language} {path}"
            );
        }
    }

    #[test]
    fn a_changed_file_reaches_the_page_as_a_code() {
        use ul_core::vfs::{VfsError, CHANGED_OUTSIDE};
        let said = serde_json::to_value(VfsError::Changed(r"C:\a\b.md".into())).unwrap();
        assert_eq!(said, format!(r"{CHANGED_OUTSIDE}C:\a\b.md"));
        let said = serde_json::to_value(VfsError::NoWorkspace).unwrap();
        assert!(!said.as_str().unwrap().starts_with(CHANGED_OUTSIDE));
        /* And the same through the image commands, which wrap it. */
        let said = serde_json::to_value(super::ImageCommandError::Vfs(VfsError::Changed(
            r"C:\a\b.png".into(),
        )))
        .unwrap();
        assert_eq!(said, format!(r"{CHANGED_OUTSIDE}C:\a\b.png"));
    }

    /// A save naming a reading nobody made is a failure, not the question a
    /// changed file is: reaching the page as the code, it would offer
    /// "Overwrite" (ADR 0006).
    #[test]
    fn a_document_not_read_here_is_a_failure_not_a_question() {
        use ul_core::vfs::{VfsError, CHANGED_OUTSIDE};
        let said = serde_json::to_value(VfsError::NotRead(r"C:\a\b.md".into())).unwrap();
        assert!(
            !said.as_str().unwrap().starts_with(CHANGED_OUTSIDE),
            "{said}"
        );
        let said = serde_json::to_value(super::ImageCommandError::Vfs(VfsError::NotRead(
            r"C:\a\b.png".into(),
        )))
        .unwrap();
        assert!(
            !said.as_str().unwrap().starts_with(CHANGED_OUTSIDE),
            "{said}"
        );
    }

    /// "Save as" offers the page's suggestion as a name only: never a path,
    /// a stream, a device or a parent.
    #[test]
    fn a_save_target_is_offered_a_name_and_never_a_path() {
        use super::offered_name;
        assert_eq!(offered_name("Izvještaj.pdf"), "Izvještaj.pdf");
        assert_eq!(
            offered_name(
                r"C:\Users\x\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\x.bat"
            ),
            "x.bat"
        );
        assert_eq!(offered_name("../../x.bat"), "x.bat");
        assert_eq!(offered_name("notes.txt:stream"), "untitled");
        assert_eq!(offered_name("C:x.bat"), "untitled");
        assert_eq!(offered_name(".."), "untitled");
        assert_eq!(offered_name("a\u{0}b"), "untitled");
        assert_eq!(offered_name(""), "untitled");
        assert_eq!(offered_name("ugovor\u{202E}fdp.exe"), "untitled");
        assert_eq!(offered_name("a\u{2066}b.bat"), "untitled");
        assert_eq!(offered_name("x.bat."), "untitled");
        assert_eq!(offered_name("x.bat "), "untitled");
        assert_eq!(offered_name("CON"), "untitled");
        assert_eq!(offered_name("nul.txt"), "untitled");
        assert_eq!(offered_name("COM1"), "untitled");
        assert_eq!(offered_name("..."), "untitled");
        assert_eq!(offered_name(&"a".repeat(121)), "untitled");
        assert_eq!(
            offered_name("invoice.pdf\u{3164}\u{3164}\u{3164}.exe"),
            "untitled"
        );
        assert_eq!(
            offered_name(&format!("invoice.pdf{}.exe", " ".repeat(60))),
            "untitled"
        );
        assert_eq!(offered_name("a\u{115F}b"), "untitled");
        assert_eq!(offered_name("%APPDATA%.bat"), "untitled");
        assert_eq!(offered_name("CONIN$"), "untitled");
        assert_eq!(offered_name("COM\u{B9}.txt"), "untitled");
        // The review of 396a4f9: a space and a combining mark, fifty times.
        assert_eq!(
            offered_name(&format!("invoice.pdf{}.exe", " \u{345}".repeat(50))),
            "untitled"
        );
        assert_eq!(offered_name("a b c d e f g h i j.txt"), "untitled");
        assert_eq!(
            offered_name("Plan za 2026 godinu - verzija 2 final.pdf"),
            "Plan za 2026 godinu - verzija 2 final.pdf"
        );
        // Letters to Rust, drawn as nothing.
        assert!('\u{13441}'.is_alphanumeric() && '\u{13442}'.is_alphanumeric());
        assert_eq!(
            offered_name("invoice.pdf\u{13441}\u{13441}.exe"),
            "untitled"
        );
        assert_eq!(offered_name("a\u{13442}b"), "untitled");
        assert_eq!(offered_name("CLOCK$"), "untitled");
        assert_eq!(offered_name("COM0.txt"), "untitled");
        assert_eq!(offered_name("lpt0"), "untitled");
        assert_eq!(offered_name("\u{FF23}\u{FF2F}\u{FF2E}.txt"), "untitled"); // ＣＯＮ
        assert_eq!(offered_name("\u{FF2E}ul.txt"), "untitled"); // Ｎul
        assert_eq!(offered_name("Plan - stranice.pdf"), "Plan - stranice.pdf");
        assert_eq!(offered_name("console.log.txt"), "console.log.txt");
    }

    /// A gesture in one of the program's own folders grants nothing and
    /// remembers nothing.
    #[test]
    fn a_gesture_in_a_protected_folder_grants_and_remembers_nothing() {
        let base =
            std::env::temp_dir().join(format!("ul-protected-gesture-{}", std::process::id()));
        let own = base.join("own");
        std::fs::create_dir_all(&own).unwrap();
        let file = own.join("consents.json");
        std::fs::write(&file, "{}").unwrap();
        let mut workspace = ul_core::Workspace::new();
        workspace.protect(&own);
        let mut consents = ul_core::Consents::in_memory();
        super::grant_gesture(&mut workspace, &mut consents, &file).unwrap();
        super::grant_gesture(&mut workspace, &mut consents, &own).unwrap();
        assert!(consents.remembered().is_empty());
        assert!(workspace.read(&file).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The token in front of the bytes: eight, little-endian. The same vector
    /// is read back in tools/verify-readings.mjs.
    #[test]
    fn a_reading_crosses_in_front_of_its_bytes() {
        assert_eq!(
            super::framed(0x0102_0304_0506, b"doc".to_vec()),
            [0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0x00, 0x00, b'd', b'o', b'c']
        );
    }

    fn url(text: &str) -> tauri::Url {
        tauri::Url::parse(text).unwrap()
    }

    #[test]
    fn the_window_stays_on_the_applications_own_page() {
        let (own, other) = if cfg!(windows) {
            ("http://tauri.localhost", "tauri://localhost")
        } else {
            ("tauri://localhost", "http://tauri.localhost")
        };
        for here in [
            own.to_string(),
            format!("{own}/"),
            format!("{own}/index.html"),
            format!("{own}/#heading"),
            format!("blob:{own}/5c1d0f2e"),
        ] {
            assert!(stays_in_app(&url(&here), None), "{here}");
        }
        for away in [
            format!("{other}/"),
            format!("{own}/docs/upute.md"),
            "https://tauri.localhost/".to_string(),
            "http://tauri.localhost:8080/".to_string(),
            "http://somebody@tauri.localhost/".to_string(),
            "http://u:p@tauri.localhost/".to_string(),
            "tauri://evil.example/".to_string(),
            "blob:null/5c1d0f2e".to_string(),
            "blob:https://evil.example/5c1d0f2e".to_string(),
            "https://example.com/".to_string(),
            "http://tauri.localhost.example.com/".to_string(),
            "file:///C:/Windows/".to_string(),
            "data:text/html,<p>x</p>".to_string(),
            "javascript:alert(1)".to_string(),
        ] {
            assert!(!stays_in_app(&url(&away), None), "{away}");
        }
    }

    #[test]
    fn a_debug_build_reaches_its_dev_server_and_nothing_beside_it() {
        let dev = url("http://localhost:5273");
        assert!(stays_in_app(&url("http://localhost:5273/"), Some(&dev)));
        for away in [
            "http://localhost:5274/",
            "http://localhost/",
            "http://somebody@localhost:5273/",
            "http://localhost:5273/docs/upute.md",
            "http://127.0.0.1:5273/",
        ] {
            assert!(!stays_in_app(&url(away), Some(&dev)), "{away}");
        }
    }

    #[test]
    fn a_report_cut_in_the_middle_of_a_letter_is_cut_before_it() {
        /* A stack trace with Croatian in it — an error message, a file name —
        long enough to be cut, with the limit landing inside a `č` (two bytes).
        Slicing at the byte panicked, and with `panic = "abort"` in the release
        profile the report of a crash took the whole program down with it. */
        let text = format!("{}č{}", "a".repeat(LONGEST_REPORT - 1), "b".repeat(100));
        assert!(
            !text.is_char_boundary(LONGEST_REPORT),
            "the limit must fall inside the letter"
        );

        let cut = within_limit(text);
        let (kept, note) = cut.split_once('\n').expect("the kept part, then the note");
        assert_eq!(
            kept,
            "a".repeat(LONGEST_REPORT - 1),
            "cut before the letter, nothing past it"
        );
        assert!(note.contains("the rest was cut"));
    }

    #[test]
    fn a_close_is_held_only_while_the_page_says_it_will_ask() {
        use super::{CloseGuard, UNANSWERED};
        let now = std::time::Instant::now();
        let guard = CloseGuard::default();
        assert!(!guard.hold(now), "nobody asked to guard: the window closes");

        guard.set(true);
        assert!(guard.hold(now), "guarded: held for the page");
        guard.acknowledge();
        assert!(
            guard.hold(now + UNANSWERED * 2),
            "acknowledged, so a later close is held again"
        );

        /* A reload takes the guard back (`on_page_load`); the page that went
        away cannot hold the window any more. */
        guard.set(false);
        assert!(!guard.hold(now), "after set(false) the close goes through");
    }

    #[test]
    fn a_page_that_never_answers_does_not_keep_the_window_open() {
        use super::{CloseGuard, UNANSWERED};
        let now = std::time::Instant::now();
        let guard = CloseGuard::default();
        guard.set(true);
        assert!(guard.hold(now), "the first request goes to the page");
        assert!(
            guard.hold(now + UNANSWERED / 2),
            "a second one while it may still answer is held"
        );
        assert!(
            !guard.hold(now + UNANSWERED),
            "no answer in time: the close goes through"
        );
        assert!(
            !guard.hold(now + UNANSWERED * 2),
            "and stays released until the page guards again"
        );
    }

    #[test]
    fn a_short_report_is_kept_whole() {
        assert_eq!(within_limit("čćžšđ".to_string()), "čćžšđ");
    }

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
