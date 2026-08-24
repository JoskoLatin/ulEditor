//! Document format detection.
//!
//! Content decides, not the file name — a renamed `.txt` that is really a PDF
//! must open the PDF viewer, not the text editor.
//!
//! The same logic temporarily also exists in TypeScript
//! (`shell-ui/src/host/detect.ts`); this is the version that takes over on all
//! three targets. `FormatId` values must stay identical to those in
//! `@uleditor/plugin-sdk`.

#![deny(clippy::all)]

use serde::{Deserialize, Serialize};

/// How many bytes from the start of a file suffice for every signature we check.
pub const PROBE_LEN: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FormatId {
    Text,
    Code,
    Markdown,
    Pdf,
    Epub,
    Docx,
    /// The old binary Word (97–2003) — read, never written. Its own id for the
    /// reason `Xls` has one: nothing but the name is shared with `Docx`, and
    /// the two open in different editors.
    Doc,
    Xlsx,
    /// The old binary Excel (97–2003) — read, never written.
    Xls,
    Pptx,
    /// A text document and a spreadsheet open in different editors, so — as
    /// with `Xls` — each gets its own id. `Odf` stays for the rest of the
    /// family: presentations, drawings, formulas.
    Odt,
    Ods,
    Odf,
    Image,
    Vector,
    Model,
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
            Self::Epub => "epub",
            Self::Docx => "docx",
            Self::Doc => "doc",
            Self::Xlsx => "xlsx",
            Self::Xls => "xls",
            Self::Pptx => "pptx",
            Self::Odt => "odt",
            Self::Ods => "ods",
            Self::Odf => "odf",
            Self::Image => "image",
            Self::Vector => "vector",
            Self::Model => "model",
            Self::Archive => "archive",
            Self::Binary => "binary",
            Self::Unknown => "unknown",
        }
    }
}

/// How the decision was reached. `Magic` is reliable, `Extension` is a hint.
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
    /// Language for syntax highlighting, where applicable.
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

/* ── tables ──────────────────────────────────────────────────────────── */

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
    ("sh", "shell"),
    ("bash", "shell"),
    ("zsh", "shell"),
    // PowerShell is not a shell script; it was coloured as one.
    ("ps1", "powershell"),
    ("psm1", "powershell"),
    // Batch has no mode anywhere, so the editor carries its own.
    ("bat", "batch"),
    ("cmd", "batch"),
    ("ini", "properties"),
    ("cfg", "properties"),
    ("conf", "properties"),
    ("properties", "properties"),
    ("env", "properties"),
    ("diff", "diff"),
    ("patch", "diff"),
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

// `ini`, `cfg`, `conf` and `env` moved to the `properties` language above:
// configuration has a shape, and seeing it makes the file easier to read.
const PLAIN_TEXT: &[&str] = &["txt", "log", "csv", "tsv"];
const MARKDOWN: &[&str] = &["md", "markdown", "mdx"];
const IMAGES: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"];

/// Vector drawings. `svg` is here rather than among the code languages: it is
/// markup, but somebody opening one wants to see the picture, and the viewer
/// shows the source one button away.
///
/// `ai` is in the list and almost never reaches it. Illustrator has written a
/// complete PDF inside its files by default since version 9, and the `%PDF`
/// signature is checked before any extension is, so those open in the PDF
/// viewer. What arrives here is one saved with that compatibility switched off.
const VECTORS: &[&str] = &["svg", "svgz", "ai", "eps", "ps", "cdr"];

/// Interchange formats for 3D, not the native files of any one modeller.
const MODELS: &[&str] = &["stl", "obj", "ply", "gltf", "glb", "3mf"];

pub fn extension_of(name: &str) -> Option<&str> {
    let dot = name.rfind('.')?;
    if dot == 0 || dot + 1 >= name.len() {
        return None;
    }
    Some(&name[dot + 1..])
}

/* ── detection by name ───────────────────────────────────────────────── */

/// Fast detection for file listings, where the content has not been read yet.
pub fn detect_by_name(name: &str) -> Detection {
    let lower = name.to_ascii_lowercase();

    match lower.as_str() {
        "dockerfile" => {
            return Detection::with_language(FormatId::Code, DetectedVia::Extension, "dockerfile")
        }
        "makefile" => {
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
    if VECTORS.contains(&ext) {
        return Detection::new(FormatId::Vector, DetectedVia::Extension);
    }
    if MODELS.contains(&ext) {
        return Detection::new(FormatId::Model, DetectedVia::Extension);
    }
    if PLAIN_TEXT.contains(&ext) {
        return Detection::new(FormatId::Text, DetectedVia::Extension);
    }

    let format = match ext {
        "pdf" => FormatId::Pdf,
        "epub" => FormatId::Epub,
        "docx" => FormatId::Docx,
        // Its own id for the reason `.xls` has one — see `FormatId::Doc`.
        "doc" => FormatId::Doc,
        "xlsx" => FormatId::Xlsx,
        // Its own id, not a variant of xlsx: when content decides, the format is
        // what routes the file to an editor, and the two need different ones.
        "xls" => FormatId::Xls,
        "pptx" | "ppt" => FormatId::Pptx,
        "odt" | "ott" => FormatId::Odt,
        "ods" | "ots" => FormatId::Ods,
        "odp" | "odg" | "odf" => FormatId::Odf,
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

/* ── detection by content ────────────────────────────────────────────── */

fn find_ascii(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// DOCX, XLSX, PPTX, EPUB and ODF are all ZIP archives. They differ by their
/// internal paths, which appear in ZIP headers as plain ASCII — enough to tell
/// them apart without unpacking.
fn classify_zip(bytes: &[u8]) -> FormatId {
    let head = &bytes[..bytes.len().min(128)];
    if find_ascii(head, b"mimetypeapplication/epub+zip") {
        return FormatId::Epub;
    }
    // The kind is in the mimetype itself, and it decides which editor opens the
    // file. The template variants (`.ott`, `.ots`) carry `-template` after this
    // prefix and land in the same place, which is where they belong.
    if find_ascii(head, b"mimetypeapplication/vnd.oasis.opendocument.text") {
        return FormatId::Odt;
    }
    if find_ascii(
        head,
        b"mimetypeapplication/vnd.oasis.opendocument.spreadsheet",
    ) {
        return FormatId::Ods;
    }
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
    // EPUB without the uncompressed `mimetype` entry — the container is
    // mandatory, so it serves as a fallback signature.
    if find_ascii(window, b"META-INF/container.xml") {
        return FormatId::Epub;
    }
    FormatId::Archive
}

/// A NUL byte almost always means binary content; above 5 % control characters
/// the text is no longer readable in any encoding we support.
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

/// Full detection. `bytes` is the start of the file — see [`PROBE_LEN`].
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

    // Legacy binary Office (OLE2 compound file) — the extension decides the type.
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

/* ── WASM bridge (phase 0 spike) ─────────────────────────────────────── */

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// The same function the desktop calls — proof that one core covers both
    /// targets without branching in the caller.
    #[wasm_bindgen(js_name = detectFormat)]
    pub fn detect_format(name: &str, bytes: &[u8]) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&super::detect(name, bytes))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

/* ── tests ───────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_and_configuration_name_a_language() {
        // Every one of these was either uncoloured or coloured as the wrong
        // thing before the editor grew the modes for them.
        assert_eq!(
            detect_by_name("install.bat").language.as_deref(),
            Some("batch")
        );
        assert_eq!(
            detect_by_name("build.cmd").language.as_deref(),
            Some("batch")
        );
        assert_eq!(
            detect_by_name("deploy.ps1").language.as_deref(),
            Some("powershell")
        );
        assert_eq!(
            detect_by_name("app.ini").language.as_deref(),
            Some("properties")
        );
        assert_eq!(
            detect_by_name("Dockerfile").language.as_deref(),
            Some("dockerfile")
        );
        assert_eq!(
            detect_by_name("fix.patch").language.as_deref(),
            Some("diff")
        );
    }

    #[test]
    fn vector_and_model_extensions() {
        assert_eq!(detect("logo.svg", b"<svg xmlns=").format, FormatId::Vector);
        assert_eq!(
            detect("logo.svgz", &[0x1f, 0x8b, 0x08]).format,
            FormatId::Vector
        );
        assert_eq!(detect("part.stl", b"solid part").format, FormatId::Model);
        assert_eq!(detect("scan.glb", b"glTF").format, FormatId::Model);
    }

    #[test]
    fn illustrator_with_pdf_inside_is_a_pdf() {
        // The reason `.ai` needs no reader of its own: the signature decides,
        // and Illustrator writes a whole PDF into the file by default.
        let d = detect("poster.ai", b"%PDF-1.5\n1 0 obj");
        assert_eq!(d.format, FormatId::Pdf);
        assert_eq!(d.via, DetectedVia::Magic);
    }

    #[test]
    fn pdf_wins_over_extension() {
        // This is the whole point of content-based detection.
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
    fn old_binary_excel_is_its_own_format() {
        // When content decides, the format routes the file to an editor — and
        // the old binary format must reach the reader, not the .xlsx editor.
        let mut xls = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        xls.extend_from_slice(&[0u8; 16]);
        let d = detect("Promet po lokalima.xls", &xls);
        assert_eq!(d.format, FormatId::Xls);
        assert_eq!(d.via, DetectedVia::Magic);

        assert_eq!(detect_by_name("a.xls").format, FormatId::Xls);
        assert_eq!(detect_by_name("a.xlsx").format, FormatId::Xlsx);
    }

    #[test]
    fn old_binary_word_is_its_own_format_too() {
        // It used to be routed to the .docx editor, which opened the compound
        // file, found no archive in it, and told the user the file was damaged.
        let mut doc = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        doc.extend_from_slice(&[0u8; 16]);
        let d = detect("Zapisnik sa sastanka.doc", &doc);
        assert_eq!(d.format, FormatId::Doc);
        assert_eq!(d.via, DetectedVia::Magic);

        assert_eq!(detect_by_name("a.doc").format, FormatId::Doc);
        assert_eq!(detect_by_name("a.docx").format, FormatId::Docx);
    }

    #[test]
    fn epub_is_not_just_another_zip() {
        // Without this an e-book would end up as "archive" and nobody would open it.
        let mut epub = b"PK\x03\x04".to_vec();
        epub.extend_from_slice(b"mimetypeapplication/epub+zip");
        assert_eq!(detect("book.bin", &epub).format, FormatId::Epub);

        // The variant without the uncompressed `mimetype` entry.
        let mut loose = b"PK\x03\x04".to_vec();
        loose.extend_from_slice(b"........META-INF/container.xml");
        assert_eq!(detect("book.bin", &loose).format, FormatId::Epub);
    }

    #[test]
    fn odf_detected_from_mimetype_entry() {
        let mut odt = b"PK\x03\x04".to_vec();
        odt.extend_from_slice(b"mimetypeapplication/vnd.oasis.opendocument.text");
        assert_eq!(detect("a.odt", &odt).format, FormatId::Odt);

        let mut ods = b"PK\x03\x04".to_vec();
        ods.extend_from_slice(b"mimetypeapplication/vnd.oasis.opendocument.spreadsheet");
        assert_eq!(detect("a.ods", &ods).format, FormatId::Ods);

        // A presentation is the rest of the family — still recognised, still
        // without an editor of its own.
        let mut odp = b"PK\x03\x04".to_vec();
        odp.extend_from_slice(b"mimetypeapplication/vnd.oasis.opendocument.presentation");
        assert_eq!(detect("a.odp", &odp).format, FormatId::Odf);
    }

    /// The extension is a hint, and a wrong one has to lose to the bytes: a
    /// spreadsheet saved as `.odt` by hand opens the grid, not the reader.
    #[test]
    fn odf_content_outranks_the_extension() {
        let mut mislabelled = b"PK\x03\x04".to_vec();
        mislabelled.extend_from_slice(b"mimetypeapplication/vnd.oasis.opendocument.spreadsheet");
        assert_eq!(detect("tablica.odt", &mislabelled).format, FormatId::Ods);
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
        assert_eq!(detect("CHANGELOG", b"some text").format, FormatId::Text);
    }

    #[test]
    fn empty_file_is_text_not_binary() {
        assert_eq!(detect("empty.txt", b"").format, FormatId::Text);
    }
}
