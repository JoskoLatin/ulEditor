//! Integracijski test cijelog puta kroz VFS.
//!
//! Unit testovi u `vfs.rs` provjeravaju pojedine funkcije. Ovaj test vozi
//! stvarni redoslijed koji desktop aplikacija radi: otvori mapu → pročitaj
//! stablo → prepoznaj format → pročitaj → spremi → provjeri da je spremljeno.
//!
//! Bez ovoga se ne zna radi li desktop uopće otvoriti datoteku — Tauri
//! komande su tanak omotač oko ovih poziva.

use std::fs;
use std::path::PathBuf;

use ul_core::{FormatId, VfsError, Workspace};

/// Privremena mapa koja se sama briše. Bez vanjske ovisnosti (`tempfile`),
/// jer je jedina svrha držati nekoliko datoteka tijekom testa.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("uleditor-test-{tag}-{nanos}"));
        fs::create_dir_all(&path).expect("privremena mapa");
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
        fs::write(&path, contents).expect("zapis testne datoteke");
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Put koji desktop aplikacija prolazi pri otvaranju mape i uređivanju datoteke.
#[test]
fn open_folder_read_edit_save() {
    let dir = TempDir::new("flow");
    dir.write("main.rs", b"fn main() {}\n");
    dir.write("README.md", b"# Naslov\n");
    dir.write("src/lib.ts", b"export const x = 1;\n");
    dir.write("node_modules/paket/index.js", b"// ne smije se pojaviti\n");

    let mut workspace = Workspace::new();
    let root = workspace.add_root(dir.path()).expect("korijen");

    // 1 — stablo
    let entries = workspace.read_dir(&root).expect("čitanje korijena");
    let names: Vec<&str> = entries.iter().map(|e| e.stat.name.as_str()).collect();

    assert!(names.contains(&"main.rs"), "nedostaje main.rs: {names:?}");
    assert!(
        names.contains(&"README.md"),
        "nedostaje README.md: {names:?}"
    );
    assert!(names.contains(&"src"), "nedostaje src: {names:?}");
    assert!(
        !names.contains(&"node_modules"),
        "node_modules se ne smije pojaviti u stablu: {names:?}"
    );

    // Direktoriji prvi — inače je stablo nečitljivo.
    let first_file = entries.iter().position(|e| e.stat.kind == "file").unwrap();
    let last_dir = entries
        .iter()
        .rposition(|e| e.stat.kind == "directory")
        .unwrap();
    assert!(
        last_dir < first_file,
        "direktoriji moraju biti prvi: {names:?}"
    );

    // 2 — lijeno čitanje podmape
    let src = entries.iter().find(|e| e.stat.name == "src").expect("src");
    let nested = workspace.read_dir(&src.stat.uri).expect("čitanje src");
    assert_eq!(nested.len(), 1);
    assert_eq!(nested[0].stat.name, "lib.ts");
    assert_eq!(nested[0].detection.format, FormatId::Code);
    assert_eq!(nested[0].detection.language.as_deref(), Some("typescript"));

    // 3 — detekcija po sadržaju
    let rs = dir.path().join("main.rs");
    assert_eq!(
        workspace.detect_at(&rs).expect("detekcija").format,
        FormatId::Code
    );

    // 4 — čitanje
    let bytes = workspace.read(&rs).expect("čitanje");
    assert_eq!(bytes, b"fn main() {}\n");

    // 5 — spremanje i provjera da je stvarno na disku
    workspace
        .write(&rs, b"fn main() { println!(\"ok\"); }\n")
        .expect("spremanje");
    assert_eq!(
        fs::read_to_string(&rs).expect("ponovno čitanje"),
        "fn main() { println!(\"ok\"); }\n"
    );

    // Atomarno spremanje ne smije ostaviti privremenu datoteku.
    let leftovers: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("ultmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "zaostale privremene datoteke: {leftovers:?}"
    );
}

/// Preimenovani PDF mora otvoriti PDF preglednik, ne tekstualni editor.
#[test]
fn content_beats_extension() {
    let dir = TempDir::new("magic");
    let disguised = dir.write("biljeske.txt", b"%PDF-1.7\n1 0 obj\n<</Type/Catalog>>\n");

    let mut workspace = Workspace::new();
    workspace.add_root(dir.path()).expect("korijen");

    let detection = workspace.detect_at(&disguised).expect("detekcija");
    assert_eq!(detection.format, FormatId::Pdf);
}

/// Sandbox mora držati i kad putanja postoji i kad ne postoji.
#[test]
fn sandbox_holds_both_ways() {
    let outside = TempDir::new("vani");
    let outside_file = outside.write("tajna.txt", "ne smije se pročitati\n".as_bytes());

    let inside = TempDir::new("unutra");
    inside.write("ok.txt", b"smije\n");

    let mut workspace = Workspace::new();
    workspace.add_root(inside.path()).expect("korijen");

    // Postojeća datoteka izvan radnog prostora.
    assert!(
        matches!(
            workspace.read(&outside_file),
            Err(VfsError::OutsideWorkspace(_))
        ),
        "čitanje izvan radnog prostora mora biti odbijeno"
    );

    // Nepostojeća putanja s `..` — mora se odbiti prije nego dodirne disk.
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
        "bijeg kroz `..` mora biti odbijen"
    );

    // Pisanje izvan radnog prostora je jednako zabranjeno kao i čitanje.
    assert!(
        matches!(
            workspace.write(&outside_file, b"pokusaj"),
            Err(VfsError::OutsideWorkspace(_))
        ),
        "pisanje izvan radnog prostora mora biti odbijeno"
    );
    assert_eq!(
        fs::read_to_string(&outside_file).unwrap(),
        "ne smije se pročitati\n",
        "datoteka izvan radnog prostora ne smije biti dirnuta"
    );
}

/// Više otvorenih mapa istovremeno — svaka je vlastiti korijen.
#[test]
fn multiple_roots_are_independent() {
    let a = TempDir::new("a");
    let b = TempDir::new("b");
    let file_a = a.write("a.txt", b"A\n");
    let file_b = b.write("b.txt", b"B\n");

    let mut workspace = Workspace::new();
    workspace.add_root(a.path()).expect("korijen A");
    assert!(workspace.read(&file_b).is_err(), "B još nije otvoren");

    workspace.add_root(b.path()).expect("korijen B");
    assert_eq!(workspace.read(&file_a).expect("A"), b"A\n");
    assert_eq!(workspace.read(&file_b).expect("B"), b"B\n");
    assert_eq!(workspace.roots().len(), 2);

    // Ponovno dodavanje istog korijena ne smije ga duplicirati.
    workspace.add_root(a.path()).expect("ponovni korijen A");
    assert_eq!(workspace.roots().len(), 2);
}

/// Spremanje pod novim imenom — datoteka još ne postoji, ali je unutar mape.
#[test]
fn save_as_new_file_is_allowed() {
    let dir = TempDir::new("saveas");
    dir.write("postojeca.md", b"# Postoji\n");

    let mut workspace = Workspace::new();
    let root = workspace.add_root(dir.path()).expect("korijen");

    let fresh = root.join("nova.md");
    workspace
        .write(&fresh, b"# Nova\n")
        .expect("spremanje nove datoteke");
    assert_eq!(fs::read_to_string(&fresh).unwrap(), "# Nova\n");
}
