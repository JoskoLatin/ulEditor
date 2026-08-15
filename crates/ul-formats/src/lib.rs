//! Prepoznavanje formata dokumenata.
//!
//! Mjerodavan je sadržaj, ne ime datoteke — preimenovani `.txt` koji je
//! zapravo PDF mora otvoriti PDF preglednik, ne tekstualni editor.
//!
//! Ista logika postoji privremeno i u TypeScriptu (`shell-ui/src/host/detect.ts`);
//! ovo je verzija koja je preuzima na sva tri targeta. `FormatId` vrijednosti
//! moraju ostati identične onima u `@uleditor/plugin-sdk`.

#![deny(clippy::all)]

use serde::{Deserialize, Serialize};

/// Koliko bajtova s početka datoteke je dovoljno za sve potpise koje provjeravamo.
pub const PROBE_LEN: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FormatId {
    Text,
    Code,
    Markdown,
    Pdf,
    Docx,
    Xlsx,
    Pptx,
    Odf,
    Image,
    Archive,
    Binary,
    Unknown,
}

impl FormatId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Code => "code",
            Self::Markdown => "markdown",
            Self::Pdf => "pdf",
            Self::Docx => "docx",
            Self::Xlsx => "xlsx",
            Self::Pptx => "pptx",
            Self::Odf => "odf",
            Self::Image => "image",
            Self::Archive => "archive",
            Self::Binary => "binary",
            Self::Unknown => "unknown",
        }
    }
}

/// Kako je odluka donesena. `Magic` je pouzdan, `Extension` je nagovještaj.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DetectedVia {
    Magic,
    Extension,
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Detection {
    pub format: FormatId,
    pub via: DetectedVia,
    /// Jezik za bojanje sintakse, kad je primjenjiv.
    pub language: Option<String>,
}

impl Detection {
    fn new(format: FormatId, via: DetectedVia) -> Self {
        Self {
            format,
            via,
            language: None,
        }
    }

    fn with_language(format: FormatId, via: DetectedVia, language: &str) -> Self {
        Self {
            format,
            via,
            language: Some(language.to_owned()),
        }
    }
}

/* ── tablice ─────────────────────────────────────────────────────────── */

const CODE_LANGUAGES: &[(&str, &str)] = &[
    ("ts", "typescript"),
    ("tsx", "typescript"),
    ("mts", "typescript"),
    ("cts", "typescript"),
    ("js", "javascript"),
    ("jsx", "javascript"),
    ("mjs", "javascript"),
    ("cjs", "javascript"),
    ("json", "json"),
    ("jsonc", "json"),
    ("rs", "rust"),
    ("py", "python"),
    ("pyi", "python"),
    ("html", "html"),
    ("htm", "html"),
    ("css", "css"),
    ("scss", "css"),
    ("less", "css"),
    ("toml", "toml"),
    ("yaml", "yaml"),
    ("yml", "yaml"),
    ("xml", "xml"),
    ("svg", "xml"),
    ("sh", "shell"),
    ("bash", "shell"),
    ("zsh", "shell"),
    ("ps1", "shell"),
    ("sql", "sql"),
    ("go", "go"),
    ("java", "java"),
    ("kt", "java"),
    ("c", "cpp"),
    ("h", "cpp"),
    ("cpp", "cpp"),
    ("hpp", "cpp"),
    ("cc", "cpp"),
    ("cs", "cpp"),
    ("rb", "ruby"),
    ("php", "php"),
    ("swift", "swift"),
    ("lua", "lua"),
    ("vue", "html"),
    ("svelte", "html"),
];

const PLAIN_TEXT: &[&str] = &["txt", "log", "csv", "tsv", "ini", "cfg", "conf", "env"];
const MARKDOWN: &[&str] = &["md", "markdown", "mdx"];
const IMAGES: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"];

pub fn extension_of(name: &str) -> Option<&str> {
    let dot = name.rfind('.')?;
    if dot == 0 || dot + 1 >= name.len() {
        return None;
    }
    Some(&name[dot + 1..])
}

/* ── detekcija po imenu ──────────────────────────────────────────────── */

/// Brza detekcija za popis datoteka, gdje sadržaj još nije pročitan.
pub fn detect_by_name(name: &str) -> Detection {
    let lower = name.to_ascii_lowercase();

    match lower.as_str() {
        "dockerfile" | "makefile" => {
            return Detection::with_language(FormatId::Code, DetectedVia::Extension, "shell")
        }
        "readme" => return Detection::new(FormatId::Markdown, DetectedVia::Extension),
        "license" | ".gitignore" | ".npmrc" | ".editorconfig" => {
            return Detection::new(FormatId::Text, DetectedVia::Extension)
        }
        _ => {}
    }

    let Some(ext) = extension_of(&lower) else {
        return Detection::new(FormatId::Unknown, DetectedVia::Fallback);
    };

    if MARKDOWN.contains(&ext) {
        return Detection::with_language(FormatId::Markdown, DetectedVia::Extension, "markdown");
    }
    if IMAGES.contains(&ext) {
        return Detection::new(FormatId::Image, DetectedVia::Extension);
    }
    if PLAIN_TEXT.contains(&ext) {
        return Detection::new(FormatId::Text, DetectedVia::Extension);
    }

    let format = match ext {
        "pdf" => FormatId::Pdf,
        "docx" | "doc" => FormatId::Docx,
        "xlsx" | "xls" => FormatId::Xlsx,
        "pptx" | "ppt" => FormatId::Pptx,
        "odt" | "ods" | "odp" => FormatId::Odf,
        "zip" | "7z" | "tar" | "gz" => FormatId::Archive,
        _ => {
            if let Some((_, language)) = CODE_LANGUAGES.iter().find(|(e, _)| *e == ext) {
                return Detection::with_language(FormatId::Code, DetectedVia::Extension, language);
            }
            return Detection::new(FormatId::Unknown, DetectedVia::Fallback);
        }
    };

    Detection::new(format, DetectedVia::Extension)
}

/* ── detekcija po sadržaju ───────────────────────────────────────────── */

fn find_ascii(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// DOCX, XLSX, PPTX i ODF su sve ZIP arhive. Razlikuju se po unutarnjim
/// putanjama, koje se u ZIP zaglavljima pojavljuju kao čist ASCII — dovoljno
/// za razlikovanje bez raspakiravanja.
fn classify_zip(bytes: &[u8]) -> FormatId {
    let head = &bytes[..bytes.len().min(128)];
    if find_ascii(head, b"mimetypeapplication/vnd.oasis.opendocument") {
        return FormatId::Odf;
    }

    let window = &bytes[..bytes.len().min(PROBE_LEN)];
    if find_ascii(window, b"word/document.xml") || find_ascii(window, b"word/") {
        return FormatId::Docx;
    }
    if find_ascii(window, b"xl/workbook.xml") || find_ascii(window, b"xl/") {
        return FormatId::Xlsx;
    }
    if find_ascii(window, b"ppt/presentation.xml") || find_ascii(window, b"ppt/") {
        return FormatId::Pptx;
    }
    FormatId::Archive
}

/// NUL bajt gotovo uvijek znači binarni sadržaj; iznad 5 % kontrolnih znakova
/// tekst više nije čitljiv ni u kojem kodiranju koje podržavamo.
fn looks_textual(bytes: &[u8]) -> bool {
    let window = &bytes[..bytes.len().min(2048)];
    if window.is_empty() {
        return true;
    }
    let mut suspicious = 0usize;
    for &b in window {
        if b == 0 {
            return false;
        }
        if b < 9 || (b > 13 && b < 32 && b != 27) {
            suspicious += 1;
        }
    }
    (suspicious as f32) / (window.len() as f32) < 0.05
}

/// Puna detekcija. `bytes` je početak datoteke — vidi [`PROBE_LEN`].
pub fn detect(name: &str, bytes: &[u8]) -> Detection {
    if bytes.starts_with(b"%PDF") {
        return Detection::new(FormatId::Pdf, DetectedVia::Magic);
    }

    if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") {
        return Detection::new(classify_zip(bytes), DetectedVia::Magic);
    }

    let is_image = bytes.starts_with(&[0x89, b'P', b'N', b'G'])
        || bytes.starts_with(&[0xFF, 0xD8, 0xFF])
        || bytes.starts_with(b"GIF8")
        || bytes.starts_with(b"BM")
        || (bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP");
    if is_image {
        return Detection::new(FormatId::Image, DetectedVia::Magic);
    }

    // Stari binarni Office (OLE2 compound file) — tip odlučuje ekstenzija.
    if bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        let by_name = detect_by_name(name);
        return if by_name.format == FormatId::Unknown {
            Detection::new(FormatId::Binary, DetectedVia::Magic)
        } else {
            Detection {
                via: DetectedVia::Magic,
                ..by_name
            }
        };
    }

    let by_name = detect_by_name(name);

    if !looks_textual(bytes) {
        return match by_name.format {
            FormatId::Unknown | FormatId::Text | FormatId::Code => {
                Detection::new(FormatId::Binary, DetectedVia::Magic)
            }
            _ => by_name,
        };
    }

    if by_name.format == FormatId::Unknown {
        return Detection::new(FormatId::Text, DetectedVia::Fallback);
    }
    by_name
}

/* ── WASM most (spike faze 0) ────────────────────────────────────────── */

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// Ista funkcija koju zove i desktop — dokaz da jedna jezgra pokriva
    /// oba targeta bez grananja u pozivatelju.
    #[wasm_bindgen(js_name = detectFormat)]
    pub fn detect_format(name: &str, bytes: &[u8]) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&super::detect(name, bytes))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

/* ── testovi ─────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_wins_over_extension() {
        // Ovo je cijela poanta detekcije po sadržaju.
        let d = detect("biljeske.txt", b"%PDF-1.7\n1 0 obj");
        assert_eq!(d.format, FormatId::Pdf);
        assert_eq!(d.via, DetectedVia::Magic);
    }

    #[test]
    fn ooxml_containers_are_distinguished() {
        let mut docx = b"PK\x03\x04".to_vec();
        docx.extend_from_slice(b"........word/document.xml");
        assert_eq!(detect("a.bin", &docx).format, FormatId::Docx);

        let mut xlsx = b"PK\x03\x04".to_vec();
        xlsx.extend_from_slice(b"........xl/workbook.xml");
        assert_eq!(detect("a.bin", &xlsx).format, FormatId::Xlsx);
    }

    #[test]
    fn odf_detected_from_mimetype_entry() {
        let mut odt = b"PK\x03\x04".to_vec();
        odt.extend_from_slice(b"mimetypeapplication/vnd.oasis.opendocument.text");
        assert_eq!(detect("a.odt", &odt).format, FormatId::Odf);
    }

    #[test]
    fn binary_without_signature_is_not_text() {
        let blob = [0x00u8, 0x01, 0x02, 0x03, 0x00, 0xFF];
        assert_eq!(detect("data.txt", &blob).format, FormatId::Binary);
    }

    #[test]
    fn source_files_carry_language() {
        let d = detect("main.rs", b"fn main() {}");
        assert_eq!(d.format, FormatId::Code);
        assert_eq!(d.language.as_deref(), Some("rust"));
    }

    #[test]
    fn markdown_beats_plain_text() {
        assert_eq!(detect("README.md", b"# Naslov").format, FormatId::Markdown);
    }

    #[test]
    fn extensionless_text_falls_back() {
        assert_eq!(detect("CHANGELOG", b"neki tekst").format, FormatId::Text);
    }

    #[test]
    fn empty_file_is_text_not_binary() {
        assert_eq!(detect("prazno.txt", b"").format, FormatId::Text);
    }
}
