//! Knjižnica dokumenata — pregled uređaja umjesto stabla direktorija.
//!
//! **Zašto uopće postoji.** Explorer sa stablom mapa je desktop metafora i na
//! telefonu ne radi: ondje nitko ne zna gdje mu datoteka fizički stoji, nego
//! zna da negdje ima nekakav PDF. Zato mobilni prikaz ne traži od korisnika da
//! otvori mapu, nego sam pregleda uobičajena mjesta i ponudi što je našao,
//! najnovije prvo.
//!
//! **Skeniranje, ne indeks** — iz istog razloga kao pretraga u [`crate::search`]:
//! indeks bi tražio invalidaciju, a knjižnica se ionako gleda rijetko i kratko.
//!
//! **Android ovdje ima zub.** Uz scoped storage `read_dir` nad dijeljenom
//! pohranom vrati **samo direktorije**, a datoteke tiho izostavi — bez ijedne
//! greške. Aplikacija tako izgleda kao da na uređaju nema dokumenata, iako ih
//! ima stotine. Zato skeniranje broji i pregledane mape: prazan rezultat uz
//! pregledane mape znači „nemaš dokumenata”, a prazan rezultat uz same mape bez
//! ijedne datoteke znači „nemaš dozvolu”. Ta se razlika vidi u
//! [`LibraryScan::looks_blocked`] i UI o njoj ovisi.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use ul_formats::{detect_by_name, FormatId};

use crate::vfs::{display, is_noise, VfsError, Workspace};

/// Dokle se ide u dubinu. Dijeljena pohrana zna imati duboka stabla predmemorije
/// koja nemaju veze s dokumentima, a svaka razina košta.
const MAX_DEPTH: usize = 6;

/// Gornja granica broja stavki; iznad toga popis ionako nitko ne pregledava.
const DEFAULT_LIMIT: usize = 2000;

/// Koliko se slika najviše zadržava.
///
/// Bez zasebnog proračuna fotografije potpuno progutaju knjižnicu: na
/// izmjerenom uređaju je od 2000 stavki bilo 1956 slika i 41 PDF, a granica je
/// udarila usred skeniranja — dokumenti u kasnije pregledanim mapama nisu ni
/// stigli u popis. Slike su ovdje zbog OCR-a nad fotografiranim dokumentom,
/// ne da budu galerija, pa dobivaju vlastitu, manju kvotu.
const MAX_IMAGES: usize = 400;

/// Mape koje nose podatke aplikacija, ne korisnikove dokumente.
///
/// `Android/data` i `Android/obb` su predmemorije drugih programa i skeniranje
/// ondje traje dugo, a ne nađe ništa što bi korisnik prepoznao kao svoje.
const SKIP_DIRS: &[&str] = &[
    "Android",
    "MIUI",
    "LOST.DIR",
    ".thumbnails",
    ".trashed",
    "cache",
    "Cache",
    "node_modules",
    "downloaded_rom",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub uri: String,
    pub name: String,
    /// `pdf`, `epub`, `docx`, `image` …
    pub format: String,
    pub size: u64,
    /// Unix ms; `None` kad ga platforma ne daje.
    pub modified: Option<u64>,
    /// Mapa u kojoj je nađena, relativno na korijen — za grupiranje u prikazu.
    pub folder: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScan {
    pub entries: Vec<LibraryEntry>,
    /// Koliko je mapa uspješno pročitano.
    pub scanned_dirs: usize,
    /// Koliko je datoteka uopće viđeno, prije filtriranja po formatu.
    pub seen_files: usize,
    /// Je li skeniranje stalo na granici umjesto da je došlo do kraja.
    pub truncated: bool,
}

impl LibraryScan {
    /// Razlikuje „nema dokumenata” od „sustav ih skriva”.
    ///
    /// Ako smo prošli kroz više mapa a **nijednu datoteku** nismo ni vidjeli,
    /// to nije prazan telefon nego uskraćen pristup: prava prazna pohrana nema
    /// ni podmapa. Na temelju ovoga UI nudi uključivanje dozvole umjesto da
    /// slaže „nema ničega”.
    pub fn looks_blocked(&self) -> bool {
        self.seen_files == 0 && self.scanned_dirs > 1
    }
}

/// Formati koje knjižnica prikazuje.
///
/// Dokumenti i slike, bez koda i arhiva: na telefonu se otvara ono što se čita,
/// a `.ts` ili `.zip` u popisu bi bili šum. Na desktopu za to služi explorer.
fn is_library_format(format: FormatId) -> bool {
    matches!(
        format,
        FormatId::Pdf
            | FormatId::Epub
            | FormatId::Docx
            | FormatId::Xlsx
            | FormatId::Pptx
            | FormatId::Odf
            | FormatId::Markdown
            | FormatId::Image
    )
}

/// Mjesta na kojima se traže dokumenti, po platformi.
///
/// Vraćaju se i putanje kojih nema — pozivatelj ionako preskače sve što se ne
/// da otvoriti, a popis je time čitljiv kao namjera.
pub fn default_roots() -> Vec<PathBuf> {
    #[cfg(target_os = "android")]
    {
        // `/sdcard` je simbolički link na `/storage/emulated/0`; koristi se
        // drugi oblik jer ga `canonicalize` ionako tako vrati.
        let base = Path::new("/storage/emulated/0");
        [
            "Download",
            "Documents",
            "DCIM",
            "Pictures",
            "Books",
            "Audiobooks",
        ]
        .iter()
        .map(|dir| base.join(dir))
        .collect()
    }

    #[cfg(not(target_os = "android"))]
    {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from);
        let Some(home) = home else {
            return Vec::new();
        };
        ["Documents", "Downloads", "Desktop", "Pictures"]
            .iter()
            .map(|dir| home.join(dir))
            .collect()
    }
}

impl Workspace {
    /// Pregledava zadana mjesta i vraća dokumente, najnovije prvo.
    ///
    /// Korijeni se **ne** provlače kroz `resolve`: knjižnica namjerno gleda
    /// izvan usvojenog radnog prostora, jer bi inače na telefonu bila prazna sve
    /// dok korisnik ručno ne otvori mapu — a upravo to izbjegavamo.
    /// Zato je i čitanje ovdje jedina dopuštena radnja.
    pub fn scan_library(
        &self,
        roots: &[PathBuf],
        limit: Option<usize>,
    ) -> Result<LibraryScan, VfsError> {
        let limit = limit.unwrap_or(DEFAULT_LIMIT);
        let mut walked = Walked {
            documents: Vec::new(),
            images: Vec::new(),
            scanned_dirs: 0,
            seen_files: 0,
            truncated: false,
        };

        for root in roots {
            if walked.documents.len() >= limit {
                walked.truncated = true;
                break;
            }
            walk(root, root, 0, limit, &mut walked);
        }

        /*
         * Slike se skupljaju bez kvote pa se ovdje režu po vremenu, a ne po
         * redoslijedu obilaska: mapa se ne pregledava kronološki, pa bi rezanje
         * u hodu zadržalo nasumičnih 400 fotografija umjesto najnovijih.
         * Struktura po stavci je sitna, pa je prolazno držanje svih jeftino.
         */
        walked.images.sort_by(newest_first);
        if walked.images.len() > MAX_IMAGES {
            walked.images.truncate(MAX_IMAGES);
            walked.truncated = true;
        }

        let mut entries = walked.documents;
        entries.extend(walked.images);
        entries.sort_by(newest_first);
        if entries.len() > limit {
            entries.truncate(limit);
            walked.truncated = true;
        }

        Ok(LibraryScan {
            entries,
            scanned_dirs: walked.scanned_dirs,
            seen_files: walked.seen_files,
            truncated: walked.truncated,
        })
    }
}

/// Dokumenti i slike se skupljaju odvojeno da fotografije ne pojedu kvotu.
struct Walked {
    documents: Vec<LibraryEntry>,
    images: Vec<LibraryEntry>,
    scanned_dirs: usize,
    seen_files: usize,
    truncated: bool,
}

/// Najnovije prvo; bez podatka o vremenu na dno, jer se ne da smisleno poredati.
fn newest_first(a: &LibraryEntry, b: &LibraryEntry) -> std::cmp::Ordering {
    match (b.modified, a.modified) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.name.cmp(&b.name),
    }
}

fn walk(root: &Path, dir: &Path, depth: usize, limit: usize, walked: &mut Walked) {
    if depth > MAX_DEPTH || walked.documents.len() >= limit {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    walked.scanned_dirs += 1;

    for entry in entries.flatten() {
        if walked.documents.len() >= limit {
            walked.truncated = true;
            return;
        }

        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };

        // `file_type` je jeftiniji od `metadata`: ne dira inode za svaku stavku.
        let Ok(kind) = entry.file_type() else {
            continue;
        };

        if kind.is_dir() {
            if is_noise(&name) || SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            walk(root, &path, depth + 1, limit, walked);
            continue;
        }

        if !kind.is_file() {
            continue;
        }

        walked.seen_files += 1;

        let format = detect_by_name(&name).format;
        if !is_library_format(format) {
            continue;
        }

        let meta = entry.metadata().ok();
        let item = LibraryEntry {
            uri: display(&path),
            name,
            format: format.as_str().to_owned(),
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            modified: meta.as_ref().and_then(modified_ms),
            folder: folder_label(root, &path),
        };

        if format == FormatId::Image {
            walked.images.push(item);
        } else {
            walked.documents.push(item);
        }
    }
}

/// Mapa u kojoj datoteka leži, relativno na korijen skeniranja.
///
/// Korijen sam daje ime (`Download`), a dublje se dopisuje putanja
/// (`Download/Foxit`) — dovoljno da se u popisu vidi odakle je nešto došlo, bez
/// prikazivanja cijele apsolutne putanje koja na telefonu ništa ne znači.
fn folder_label(root: &Path, path: &Path) -> String {
    let root_name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_owned();

    let Some(parent) = path.parent() else {
        return root_name;
    };

    match parent.strip_prefix(root) {
        Ok(rest) if rest.as_os_str().is_empty() => root_name,
        Ok(rest) => format!("{root_name}/{}", rest.to_string_lossy().replace('\\', "/")),
        Err(_) => root_name,
    }
}

fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ul-library-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn nalazi_dokumente_i_slike_a_preskace_kod() {
        let dir = temp_dir("mix");
        fs::write(dir.join("ugovor.pdf"), b"%PDF-1.4").unwrap();
        fs::write(dir.join("slika.png"), b"\x89PNG").unwrap();
        fs::write(dir.join("biljeske.md"), b"# naslov").unwrap();
        fs::write(dir.join("main.rs"), b"fn main() {}").unwrap();
        fs::write(dir.join("arhiva.zip"), b"PK").unwrap();

        let workspace = Workspace::new();
        let scan = workspace
            .scan_library(std::slice::from_ref(&dir), None)
            .unwrap();

        let mut formats: Vec<_> = scan.entries.iter().map(|e| e.format.as_str()).collect();
        formats.sort_unstable();
        assert_eq!(formats, ["image", "markdown", "pdf"]);
        assert_eq!(scan.seen_files, 5);
    }

    #[test]
    fn preskace_mape_s_podacima_aplikacija() {
        let dir = temp_dir("skip");
        fs::create_dir_all(dir.join("Android/data")).unwrap();
        fs::write(dir.join("Android/data/tudje.pdf"), b"%PDF").unwrap();
        fs::write(dir.join("moje.pdf"), b"%PDF").unwrap();

        let workspace = Workspace::new();
        let scan = workspace
            .scan_library(std::slice::from_ref(&dir), None)
            .unwrap();

        assert_eq!(scan.entries.len(), 1);
        assert_eq!(scan.entries[0].name, "moje.pdf");
    }

    #[test]
    fn najnovije_dolazi_prvo() {
        let dir = temp_dir("order");
        fs::write(dir.join("staro.pdf"), b"%PDF").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dir.join("novo.pdf"), b"%PDF").unwrap();

        let workspace = Workspace::new();
        let scan = workspace
            .scan_library(std::slice::from_ref(&dir), None)
            .unwrap();

        assert_eq!(scan.entries[0].name, "novo.pdf");
    }

    #[test]
    fn mapa_se_prijavljuje_relativno_na_korijen() {
        let dir = temp_dir("folder");
        fs::create_dir_all(dir.join("racuni")).unwrap();
        fs::write(dir.join("racuni/r1.pdf"), b"%PDF").unwrap();

        let workspace = Workspace::new();
        let scan = workspace
            .scan_library(std::slice::from_ref(&dir), None)
            .unwrap();

        let root_name = dir.file_name().unwrap().to_str().unwrap();
        assert_eq!(scan.entries[0].folder, format!("{root_name}/racuni"));
    }

    /// Scoped storage izgleda upravo ovako: mape se vide, datoteke ne.
    #[test]
    fn same_mape_bez_datoteka_znace_uskracen_pristup() {
        let dir = temp_dir("blocked");
        fs::create_dir_all(dir.join("Download")).unwrap();
        fs::create_dir_all(dir.join("Documents")).unwrap();

        let workspace = Workspace::new();
        let scan = workspace
            .scan_library(std::slice::from_ref(&dir), None)
            .unwrap();

        assert!(scan.entries.is_empty());
        assert!(scan.looks_blocked());
    }

    /// Bez zasebne kvote fotografije istisnu dokumente iz popisa.
    #[test]
    fn slike_ne_mogu_istisnuti_dokumente() {
        let dir = temp_dir("photos");
        for i in 0..(MAX_IMAGES + 50) {
            fs::write(dir.join(format!("IMG_{i:04}.jpg")), b"\xff\xd8").unwrap();
        }
        fs::write(dir.join("ugovor.pdf"), b"%PDF").unwrap();

        let workspace = Workspace::new();
        let scan = workspace
            .scan_library(std::slice::from_ref(&dir), None)
            .unwrap();

        let images = scan.entries.iter().filter(|e| e.format == "image").count();
        assert_eq!(images, MAX_IMAGES, "slike moraju biti ograničene kvotom");
        assert!(
            scan.entries.iter().any(|e| e.name == "ugovor.pdf"),
            "dokument mora ostati u popisu bez obzira na broj fotografija"
        );
        assert!(scan.truncated);
    }

    /// Knjižnica smije čitati svoje mape, ali ih ne smije gurnuti u explorer.
    #[test]
    fn korijeni_knjiznice_ne_ulaze_u_stablo() {
        let dir = temp_dir("roots");
        fs::write(dir.join("ugovor.pdf"), b"%PDF").unwrap();

        let mut workspace = Workspace::new();
        workspace.add_library_root(&dir).unwrap();

        assert!(
            workspace.roots().is_empty(),
            "explorer ne smije dobiti mapu koju je otvorila knjižnica"
        );
        assert!(
            workspace.read(dir.join("ugovor.pdf")).is_ok(),
            "dokument iz knjižnice se mora dati otvoriti"
        );
    }

    #[test]
    fn prazna_mapa_nije_uskracen_pristup() {
        let dir = temp_dir("empty");

        let workspace = Workspace::new();
        let scan = workspace.scan_library(&[dir], None).unwrap();

        assert!(!scan.looks_blocked());
    }
}
