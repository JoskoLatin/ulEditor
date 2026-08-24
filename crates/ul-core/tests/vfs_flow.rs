//! Integration test of the whole path through the VFS.
//!
//! The unit tests in `vfs.rs` check individual functions. This test drives the
//! real sequence the desktop app performs: open a folder → read the tree →
//! detect the format → read → save → verify it was saved.
//!
//! Without this there is no telling whether the desktop can open a file at all —
//! the Tauri commands are a thin wrapper around these calls.

use std::fs;
use std::path::PathBuf;

use ul_core::{FormatId, VfsError, Workspace};

/// A temporary folder that deletes itself. No external dependency (`tempfile`),
/// because its only purpose is to hold a few files for the duration of a test.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("uleditor-test-{tag}-{nanos}"));
        fs::create_dir_all(&path).expect("a temporary folder");
        Self(path)
    }

    fn path(&self) -> &PathBuf {
        &self.0
    }

    fn write(&self, name: &str, contents: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("nadmapa");
        }
        fs::write(&path, contents).expect("writing the test file");
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The path the desktop app walks when opening a folder and editing a file.
#[test]
fn open_folder_read_edit_save() {
    let dir = TempDir::new("flow");
    dir.write("main.rs", b"fn main() {}\n");
    dir.write("README.md", b"# Naslov\n");
    dir.write("src/lib.ts", b"export const x = 1;\n");
    dir.write("node_modules/paket/index.js", b"// must not show up\n");

    let mut workspace = Workspace::new();
    let root = workspace.add_root(dir.path()).expect("korijen");

    // 1 — the tree
    let entries = workspace.read_dir(&root).expect("reading the root");
    let names: Vec<&str> = entries.iter().map(|e| e.stat.name.as_str()).collect();

    assert!(names.contains(&"main.rs"), "nedostaje main.rs: {names:?}");
    assert!(
        names.contains(&"README.md"),
        "nedostaje README.md: {names:?}"
    );
    assert!(names.contains(&"src"), "nedostaje src: {names:?}");
    assert!(
        !names.contains(&"node_modules"),
        "node_modules must not show up in the tree: {names:?}"
    );

    // Directories first — otherwise the tree is unreadable.
    let first_file = entries.iter().position(|e| e.stat.kind == "file").unwrap();
    let last_dir = entries
        .iter()
        .rposition(|e| e.stat.kind == "directory")
        .unwrap();
    assert!(
        last_dir < first_file,
        "directories have to come first: {names:?}"
    );

    // 2 — lazy read of a subfolder
    let src = entries.iter().find(|e| e.stat.name == "src").expect("src");
    let nested = workspace.read_dir(&src.stat.uri).expect("reading src");
    assert_eq!(nested.len(), 1);
    assert_eq!(nested[0].stat.name, "lib.ts");
    assert_eq!(nested[0].detection.format, FormatId::Code);
    assert_eq!(nested[0].detection.language.as_deref(), Some("typescript"));

    // 3 — detection by content
    let rs = dir.path().join("main.rs");
    assert_eq!(
        workspace.detect_at(&rs).expect("detekcija").format,
        FormatId::Code
    );

    // 4 — reading
    let bytes = workspace.read(&rs).expect("reading");
    assert_eq!(bytes, b"fn main() {}\n");

    // 5 — saving, and checking it really landed on disk
    workspace
        .write(&rs, b"fn main() { println!(\"ok\"); }\n")
        .expect("saving");
    assert_eq!(
        fs::read_to_string(&rs).expect("reading back"),
        "fn main() { println!(\"ok\"); }\n"
    );

    // An atomic save must not leave a temporary file behind.
    let leftovers: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("ultmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "leftover temporary files: {leftovers:?}"
    );
}

/// A renamed PDF must open the PDF viewer, not the text editor.
#[test]
fn content_beats_extension() {
    let dir = TempDir::new("magic");
    let disguised = dir.write("biljeske.txt", b"%PDF-1.7\n1 0 obj\n<</Type/Catalog>>\n");

    let mut workspace = Workspace::new();
    workspace.add_root(dir.path()).expect("korijen");

    let detection = workspace.detect_at(&disguised).expect("detekcija");
    assert_eq!(detection.format, FormatId::Pdf);
}

/// The sandbox must hold whether the path exists or not.
#[test]
fn sandbox_holds_both_ways() {
    let outside = TempDir::new("outside");
    let outside_file = outside.write("secret.txt", "must not be readable\n".as_bytes());

    let inside = TempDir::new("inside");
    inside.write("ok.txt", b"allowed\n");

    let mut workspace = Workspace::new();
    workspace.add_root(inside.path()).expect("korijen");

    // An existing file outside the workspace.
    assert!(
        matches!(
            workspace.read(&outside_file),
            Err(VfsError::OutsideWorkspace(_))
        ),
        "reading outside the workspace must be refused"
    );

    // A non-existent path with `..` — must be refused before touching the disk.
    let traversal = inside
        .path()
        .join("..")
        .join("..")
        .join("etc")
        .join("passwd");
    assert!(
        matches!(
            workspace.resolve(&traversal),
            Err(VfsError::OutsideWorkspace(_))
        ),
        "an escape through `..` has to be rejected"
    );

    // Writing outside the workspace is forbidden just as reading is.
    assert!(
        matches!(
            workspace.write(&outside_file, b"attempt"),
            Err(VfsError::OutsideWorkspace(_))
        ),
        "writing outside the workspace has to be rejected"
    );
    assert_eq!(
        fs::read_to_string(&outside_file).unwrap(),
        "must not be readable\n",
        "a file outside the workspace must not be touched"
    );
}

/// Several folders open at once — each one its own root.
#[test]
fn multiple_roots_are_independent() {
    let a = TempDir::new("a");
    let b = TempDir::new("b");
    let file_a = a.write("a.txt", b"A\n");
    let file_b = b.write("b.txt", b"B\n");

    let mut workspace = Workspace::new();
    workspace.add_root(a.path()).expect("korijen A");
    assert!(workspace.read(&file_b).is_err(), "B is not open yet");

    workspace.add_root(b.path()).expect("korijen B");
    assert_eq!(workspace.read(&file_a).expect("A"), b"A\n");
    assert_eq!(workspace.read(&file_b).expect("B"), b"B\n");
    assert_eq!(workspace.roots().len(), 2);

    // Adding the same root again must not duplicate it.
    workspace.add_root(a.path()).expect("ponovni korijen A");
    assert_eq!(workspace.roots().len(), 2);
}

/// Save-as — the file does not exist yet, but it is inside the folder.
#[test]
fn save_as_new_file_is_allowed() {
    let dir = TempDir::new("saveas");
    dir.write("postojeca.md", b"# Postoji\n");

    let mut workspace = Workspace::new();
    workspace.add_root(dir.path()).expect("korijen");

    /*
     * Built from the plain folder path, not from what `add_root` handed back.
     * That distinction is the whole test: `add_root` returns the canonical form,
     * and on Windows that is `\\?\C:\…` — so a target built from it matched by
     * accident while the application, which passes the path the save dialog
     * gave it, was refused. This test used to pass over a save that failed.
     */
    let fresh = dir.path().join("new.md");
    workspace
        .write(&fresh, b"# New\n")
        .expect("saving the new file");
    assert_eq!(fs::read_to_string(&fresh).unwrap(), "# New\n");
}
