//! LibreOffice, run headless, for the three formats nobody else implements.
//!
//! `.cdr` is CorelDRAW's own, and the only thing that reads it is libcdr, inside
//! LibreOffice. `.eps` and `.ps` are PostScript — a programming language rather
//! than a drawing, so showing one means running an interpreter. An `.ai` saved
//! without PDF compatibility is PostScript too.
//!
//! **This is the one place a four-hundred-megabyte office suite is the right
//! instrument.** `.odt` and `.ods` were supposed to arrive this way and do not:
//! an OpenDocument file is a ZIP of XML, and requiring an installation before a
//! spreadsheet will open was a bigger imposition than writing the reader. These
//! three are different. They hold drawing models nobody has reimplemented, and
//! there is no honest way to show one without the code that understands it.
//!
//! So LibreOffice is **optional and asked for by name**: if it is not installed,
//! the program says which formats that costs and where to get it, and every
//! other format is unaffected. Nothing is bundled and nothing is downloaded.
//!
//! Three things about driving it from a command line are not obvious, and each
//! one of them is a conversion that silently does nothing:
//!
//! 1. **A running LibreOffice takes the job and drops it.** The CLI talks to
//!    whichever instance already owns the user profile, and that instance is
//!    busy showing somebody a document — so the conversion exits 0 having
//!    produced no file. A profile of its own per run is the fix, and it is why
//!    `-env:UserInstallation` is not optional here.
//! 2. **On Windows `soffice.exe` returns immediately.** It is a launcher: the
//!    process that does the work is another one, and waiting on the one you
//!    started tells you nothing. `soffice.com` is the console wrapper that
//!    waits, so it is preferred when present.
//! 3. **The exit code is not the answer.** It is 0 for a file it could not
//!    read, for a filter it does not have, and for the case in (1). The answer
//!    is whether the output file appeared, so that is what is waited for.
//!
//! **PostScript reaches LibreOffice on Windows only.** Its EPS import runs
//! Ghostscript, `pstoedit` or ImageMagick's `convert` over any PostScript that
//! carries no preview of its own, which is exactly what a page can write, and
//! on Windows they are kept out of its reach (`harden`). Elsewhere nothing can
//! keep them out, and `to_pdf` refuses PostScript before LibreOffice is started
//! (`POSTSCRIPT_IS_CONVERTED`).

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConvertError {
    #[error("LibreOffice is not installed, or not where this program can find it")]
    NotInstalled,
    #[error("the file to convert is not there: {0}")]
    NoSource(String),
    #[error("LibreOffice could not be started: {0}")]
    Start(String),
    #[error("LibreOffice produced no file within {0} seconds")]
    Timeout(u64),
    #[error("LibreOffice produced no file, and said: {0}")]
    Refused(String),
    #[error("this file is not one of the drawing formats LibreOffice is used for here")]
    UnsupportedContent,
    #[error(
        "PostScript is not converted on this system: LibreOffice would hand it to Ghostscript, which runs it as the program it is"
    )]
    PostscriptNotRun,
    #[error("this CorelDRAW file is not laid out the way this program converts: {0}")]
    CorelLayout(String),
    #[error("this file is larger than the {0} MiB LibreOffice is given here")]
    TooLarge(u64),
    #[error("another file is being converted — try again when it is done")]
    Busy,
    #[error("file system error: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for ConvertError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// What the frontend is told about the backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backend {
    /// The binary that will be run, for the settings screen and for a bug report.
    pub path: String,
    /// What it can be asked for. Not a promise about any one file.
    pub formats: Vec<String>,
}

/// The formats this is for. Everything else in the program has its own reader.
pub const FORMATS: [&str; 4] = ["cdr", "eps", "ps", "ai"];

/// Whether PostScript is handed to LibreOffice on this platform: on Windows
/// only.
///
/// LibreOffice's EPS import draws a file with no preview of its own by running
/// `pstoedit`, then `gs`, then `convert` over it, whichever the PATH has
/// (`vcl/source/filter/ieps/ieps.cxx`), and a page can always write PostScript
/// with none. On Windows
/// `harden` gives LibreOffice a PATH none of them is on (measured, card 505).
/// On Linux and macOS no PATH can do that: Ghostscript is in `/usr/bin` beside
/// what LibreOffice's own start script needs, `convert` and `pstoedit` reach it
/// by absolute paths of their own, and a snap's or a flatpak's LibreOffice
/// looks in its sandbox, where no check from out here can see. Ghostscript's
/// `-dPARANOIDSAFER` has been bypassed more than once (CVE-2023-36664,
/// CVE-2024-29510). So there PostScript is refused before LibreOffice is
/// started (card 512) — losing only what LibreOffice would draw without a
/// helper: the preview the file carries, which the page shows itself, or a
/// box.
pub const POSTSCRIPT_IS_CONVERTED: bool = cfg!(windows);

/// The formats converted on this platform, for the settings screen and a bug
/// report: without PostScript only `.cdr` is left, since an `.ai` that reaches
/// this is one saved as PostScript.
pub fn formats() -> &'static [&'static str] {
    if POSTSCRIPT_IS_CONVERTED {
        &FORMATS
    } else {
        &["cdr"]
    }
}

/// The largest file handed to LibreOffice: a drawing's size, not a disk's.
/// Copied before it is checked (`to_pdf`), a file the page asks for can be
/// any size, and as many times as it likes (the review of 8784711); the
/// largest drawing among Čovik's files is under 15 MB, and a picture is held
/// to the same in ul-image.
pub const MOST_BYTES: u64 = 512 * 1024 * 1024;

/// The DOS EPS header: an `.eps` carrying a binary preview beside its
/// PostScript.
const DOS_EPS: [u8; 4] = [0xC5, 0xD0, 0xD3, 0xC6];

/// Whether `head` starts PostScript, plain or in a DOS EPS — `.eps`, `.ps`, and
/// an `.ai` saved without PDF compatibility; what LibreOffice hands to its EPS
/// import.
///
/// `%!PS`, not bare `%!`: that is the key LibreOffice routes to its PostScript
/// filter on, so accepting exactly it is accepting what it will actually treat
/// as PostScript, and nothing that might fall through to the web-document
/// filter instead. It must be the very first bytes — the EPSF spec requires
/// it, and anything allowed before is room for another kind of document to
/// hide.
fn is_postscript(head: &[u8]) -> bool {
    head.starts_with(b"%!PS") || head.starts_with(&DOS_EPS)
}

/// CorelDRAW as libcdr reads it (`getCDRVersion` in its `CDRDocument.cpp`):
/// a RIFF container whose form type is "CDR", in either case, followed by a
/// version byte libcdr knows — a space, `1` to `9`, or `A` and above. A
/// template ("CDT") or any other byte libcdr turns away, and LibreOffice then
/// tries its other imports on the file: one took a RIFF "CDT" for Writer text
/// (measured 2026-10-12, card 510). So only what libcdr will take is let in.
fn is_coreldraw(head: &[u8]) -> bool {
    head.len() >= 12
        && head.starts_with(b"RIFF")
        && head[8..11].eq_ignore_ascii_case(b"cdr")
        && matches!(head[11], 0x20 | 0x31..=0x39 | 0x41..=0xFF)
}

/// A ZIP: what CorelDRAW X6 and later save a drawing as. Never handed to
/// LibreOffice as it is — see `rebuild_coreldraw`.
fn is_zip(head: &[u8]) -> bool {
    head.starts_with(b"PK\x03\x04")
}

/// What `admit` lets through, and how.
#[derive(Debug, PartialEq)]
enum Admitted {
    /// The file as it is.
    AsIs,
    /// A ZIP, to be rebuilt from the parts libcdr reads before LibreOffice
    /// sees anything (`rebuild_coreldraw`).
    CorelZip,
}

/// The most names a CorelDRAW ZIP's list of drawing parts is taken with:
/// the real one has three.
const MOST_PARTS: usize = 1024;

/// The longest that list is read: three names are 34 bytes.
const MOST_LIST_BYTES: u64 = 64 * 1024;

/// The largest CorelDRAW ZIP taken: the real one is 113 KiB, and the largest
/// drawing among Čovik's files is under 15 MB. A ZIP is read by a parser over
/// bytes a page can write, before LibreOffice's time limit starts, so it is
/// held far below `MOST_BYTES` (the review of d561273).
pub const MOST_ZIP_BYTES: u64 = 64 * 1024 * 1024;

/// The most a CorelDRAW ZIP's parts may come to, made again: the real one's
/// come to eight times its size.
const MOST_REBUILT_BYTES: u64 = 256 * 1024 * 1024;

/// What `rebuild_coreldraw` is held to: the program's own bounds, smaller in
/// the tests that check each one holds.
struct Limits {
    bytes: u64,
    parts: usize,
    list: u64,
    /// When reading gives up: the same time the conversion is given.
    until: Instant,
}

/// Whether a name in that list is one this program writes back: a plain
/// file name — letters, digits, `.`, `_`, `-`, not starting with a dot, at
/// most 128 bytes. The real ones are `data1.dat`, `masterPage.dat`,
/// `page1.dat`; nothing that could name a path, or need escaping, is taken.
fn is_part_name(name: &[u8]) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name[0] != b'.'
        && name
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(b))
}

/// A CorelDRAW ZIP made again from the parts libcdr reads, and only those:
/// `content/root.dat` — itself a CorelDRAW RIFF libcdr takes —, the list
/// `content/dataFileList.dat`, and `content/data/<name>` for each name in it,
/// stored, into `to`, a new file. LibreOffice is given that, never the ZIP
/// the page wrote (ADR 0008).
///
/// A ZIP is a container LibreOffice opens as whatever its members say: one
/// named `.cdr` holding OpenDocument members was imported as a Writer
/// document (measured 2026-10-12, card 510), and two ZIP readers need not
/// agree on what one holds. Rebuilt, there is one reading of it — this one —
/// and nothing in it but what libcdr asks for by name. Split as libcdr splits
/// the list: at every `\n`, and a last name with none after it.
///
/// Everything read is bounded (`Limits`): the parts together by bytes, the
/// list by its length and how many names it holds, and all of it by time; a
/// part is read to its end, so its checksum is checked, or not used at all.
/// The archive is read as one that starts at the file's first byte, as a
/// CorelDRAW ZIP does: asked to find where an archive starts, the reader
/// tries every end-of-directory record it finds against the whole file, and a
/// file of them took 64 s at 2 MB, four times as long for twice the size (the
/// review of d561273). A layout not measured here — `content/riffData.cdr`
/// alone, say — is refused.
fn rebuild_coreldraw(from: &Path, to: &Path, limits: &Limits) -> Result<(), ConvertError> {
    use std::io::{Read, Write};
    use zip::result::ZipError;

    let layout = |why: &str| ConvertError::CorelLayout(why.to_string());
    let config = zip::read::Config {
        archive_offset: zip::read::ArchiveOffset::Known(0),
    };
    let mut archive = zip::ZipArchive::with_config(config, open_regular(from)?)
        .map_err(|_| layout("it is not a ZIP this program can read"))?;
    if Instant::now() > limits.until {
        return Err(layout(
            "reading it took longer than the conversion is given",
        ));
    }
    let mut budget = limits.bytes;

    let mut out = zip::ZipWriter::new(std::fs::File::create_new(to)?);
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    /* A part, opened by its exact name, a folder or anything unreadable
    refused. */
    fn open<'a>(
        archive: &'a mut zip::ZipArchive<std::fs::File>,
        name: &str,
    ) -> Result<Option<zip::read::ZipFile<'a, std::fs::File>>, ConvertError> {
        match archive.by_name(name) {
            Ok(part) if part.is_file() => Ok(Some(part)),
            Ok(_) => Err(ConvertError::CorelLayout(format!("{name} is not a file"))),
            Err(ZipError::FileNotFound) => Ok(None),
            Err(err) => Err(ConvertError::CorelLayout(format!(
                "{name} could not be read: {err}"
            ))),
        }
    }
    /* Copied into the new ZIP, to its end, within what is left of the
    budget and before the time is up. */
    fn copy(
        part: &mut zip::read::ZipFile<'_, std::fs::File>,
        name: &str,
        into: &mut zip::ZipWriter<std::fs::File>,
        budget: &mut u64,
        limits: &Limits,
    ) -> Result<(), ConvertError> {
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            if Instant::now() > limits.until {
                return Err(ConvertError::CorelLayout(
                    "reading it took longer than the conversion is given".into(),
                ));
            }
            let read = part.read(&mut chunk).map_err(|err| {
                ConvertError::CorelLayout(format!("{name} could not be read: {err}"))
            })?;
            if read == 0 {
                return Ok(());
            }
            if read as u64 > *budget {
                return Err(ConvertError::TooLarge(limits.bytes / (1024 * 1024)));
            }
            *budget -= read as u64;
            into.write_all(&chunk[..read])?;
        }
    }

    {
        let name = "content/root.dat";
        let Some(mut root) = open(&mut archive, name)? else {
            return Err(layout("it has no content/root.dat"));
        };
        let mut head = [0u8; 12];
        root.read_exact(&mut head)
            .map_err(|_| layout("its content/root.dat is not a CorelDRAW drawing"))?;
        if !is_coreldraw(&head) {
            return Err(layout("its content/root.dat is not a CorelDRAW drawing"));
        }
        out.start_file(name, stored)
            .map_err(|err| ConvertError::Io(err.into()))?;
        out.write_all(&head)?;
        budget = budget
            .checked_sub(head.len() as u64)
            .ok_or(ConvertError::TooLarge(limits.bytes / (1024 * 1024)))?;
        copy(&mut root, name, &mut out, &mut budget, limits)?;
    }

    let mut names: Vec<Vec<u8>> = Vec::new();
    if let Some(list) = open(&mut archive, "content/dataFileList.dat")? {
        let mut bytes = Vec::new();
        list.take(limits.list + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| layout("its list of drawing parts could not be read"))?;
        if bytes.len() as u64 > limits.list {
            return Err(layout("its list of drawing parts is too long"));
        }
        let mut name = Vec::new();
        for byte in bytes {
            if byte == b'\n' {
                names.push(std::mem::take(&mut name));
            } else {
                name.push(byte);
            }
        }
        if !name.is_empty() {
            names.push(name);
        }
        if names.len() > limits.parts || !names.iter().all(|n| is_part_name(n)) {
            return Err(layout(
                "its list of drawing parts names something other than a part",
            ));
        }
    }
    let joined = names.join(&b'\n');
    out.start_file("content/dataFileList.dat", stored)
        .map_err(|err| ConvertError::Io(err.into()))?;
    out.write_all(&joined)?;

    let mut written = HashSet::new();
    for name in &names {
        if !written.insert(name.clone()) {
            continue;
        }
        let path = format!(
            "content/data/{}",
            std::str::from_utf8(name).expect("checked by is_part_name")
        );
        let Some(mut part) = open(&mut archive, &path)? else {
            return Err(layout("a drawing part its list names is missing"));
        };
        out.start_file(path.as_str(), stored)
            .map_err(|err| ConvertError::Io(err.into()))?;
        copy(&mut part, &path, &mut out, &mut budget, limits)?;
    }
    out.finish().map_err(|err| ConvertError::Io(err.into()))?;
    Ok(())
}

/// Whether LibreOffice may be given a file that begins with `head`, here: a
/// CorelDRAW drawing everywhere, PostScript on Windows only, nothing else.
///
/// LibreOffice decides what a document is by its content, not its name. A file
/// named `drawing.cdr` whose bytes are HTML is imported as a web page — and a
/// web page fetches every linked image as it loads, from a process with no
/// content-security policy over it, carrying whatever the author put in the URL
/// to wherever it points (measured through `convert-to pdf`, card 505). So a
/// document the program is handed could reach the network with no gesture and
/// no way for the sandbox to stop it.
///
/// The formats this is for begin with bytes nothing else does, so the file is
/// checked against them before LibreOffice is ever told about it. Everything
/// else is refused — the cost is a genuine but unusual file turned away with a
/// clear message, against the whole class of documents that reach out. What
/// may go is listed, not what may not, and this is the only answer there is:
/// a second, wider one is a check somebody will one day take for this one (the
/// review of 8784711).
///
/// A PDF is not one of them. A modern `.ai` is a PDF and opens in the PDF
/// viewer, so nothing sends one here, and LibreOffice's PDF import would only
/// be one more parser over bytes a page wrote (the review of 0f215cf).
///
/// A ZIP is let through only to be made again (`Admitted::CorelZip`): what
/// LibreOffice then sees is `rebuild_coreldraw`'s, or nothing.
fn admit(head: &[u8]) -> Result<Admitted, ConvertError> {
    if is_coreldraw(head) {
        return Ok(Admitted::AsIs);
    }
    if is_zip(head) {
        return Ok(Admitted::CorelZip);
    }
    if is_postscript(head) {
        return if POSTSCRIPT_IS_CONVERTED {
            Ok(Admitted::AsIs)
        } else {
            Err(ConvertError::PostscriptNotRun)
        };
    }
    Err(ConvertError::UnsupportedContent)
}

/// A directory of this conversion's own, made new under `workdir` and removed,
/// with what is in it, when the conversion is over.
///
/// The caller's `workdir` is one per document, and the page can ask for the
/// same document to be converted as often as it likes, at once, with no
/// gesture. Sharing one copy, a second conversion could write the page's next
/// bytes over it after the first had checked it and before the LibreOffice the
/// first started had opened it — bytes no check had passed (the review of
/// 0f215cf). `create_dir` fails on a directory that is already there, so no
/// two conversions are ever handed the same one.
struct Staging(PathBuf);

/// What this run of the program names its directories after: the process id
/// and when the run first converted, so that no name is made again in a later
/// run. With the process id alone, a run that died mid-conversion — `panic =
/// "abort"`, so no `Drop` — could leave a LibreOffice behind that had not yet
/// opened its copy, and a later run given the same id would clear that copy
/// and make the same name again, with new bytes in it (the review of 7e695ea).
fn run() -> &'static str {
    static RUN: OnceLock<String> = OnceLock::new();
    RUN.get_or_init(|| {
        let since = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("{}-{since:x}", std::process::id())
    })
}

/// The directories conversions in this process are using now, which no
/// clearing touches.
fn running() -> std::sync::MutexGuard<'static, HashSet<PathBuf>> {
    static RUNNING: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    RUNNING
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Staging {
    /// First clearing away whatever earlier conversions left and no running
    /// one is using: on Windows the LibreOffice a finished conversion started
    /// can still be closing its copy when the conversion ends, so the copy
    /// cannot go then (once in two runs, measured 2026-10-10). Which ones are
    /// running is known, not guessed from their age — a copy can take longer
    /// than any allowance, and a clock can jump (the review of 8784711).
    fn new(workdir: &Path) -> std::io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        /* Held until the new directory is listed, so that no other conversion
        clears it between its making and its listing. */
        let mut running = running();
        std::fs::create_dir_all(workdir)?;
        for entry in std::fs::read_dir(workdir)?.flatten() {
            let path = entry.path();
            if running.contains(&path) {
                continue;
            }
            // A file is a copy from before each conversion had a directory.
            let _ = match entry.metadata() {
                Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&path),
                _ => std::fs::remove_file(&path),
            };
        }
        loop {
            let next = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir = workdir.join(format!("{}-{next}", run()));
            match std::fs::create_dir(&dir) {
                Ok(()) => {
                    running.insert(dir.clone());
                    return Ok(Self(dir));
                }
                // Made since the clearing, by nobody this lock holds back.
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(err),
            }
        }
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        /* On Windows a LibreOffice still closing the copy can keep it from
        going; what stays is in a folder the page never reaches, and the next
        conversion of the document clears it (`new`). Gone first and only then
        no longer running, so that nothing clears it under this. */
        let _ = std::fs::remove_dir_all(&self.0);
        running().remove(&self.0);
    }
}

/// The first bytes of a file, for `admit`.
fn head_of(source: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut file = std::fs::File::open(source)?;
    let mut head = [0u8; 16];
    let read = file.read(&mut head)?;
    Ok(head[..read].to_vec())
}

/// Where LibreOffice puts itself, per platform.
///
/// The PATH is asked first, because somebody who installed it somewhere unusual
/// has usually put it on the PATH — and because that is the answer a
/// distribution package gives. The rest are the defaults of the three
/// installers, which is where it is on a machine nobody has configured.
pub fn candidates() -> Vec<PathBuf> {
    /* On a platform with no office suite to find — Android, iOS — every block
    below is compiled out and nothing ever pushes. `-D warnings` in CI turns
    that into a build failure, which is how this was found: the Android job
    went red on a crate the phone build has no use for. */
    #[allow(unused_mut)]
    let mut found = Vec::new();

    #[cfg(target_os = "windows")]
    {
        /* `.com` before `.exe`: see the note at the top of this file — the `.exe`
        is a launcher that returns before the work is done. */
        for root in [
            r"C:\Program Files\LibreOffice",
            r"C:\Program Files (x86)\LibreOffice",
        ] {
            found.push(PathBuf::from(format!(r"{root}\program\soffice.com")));
            found.push(PathBuf::from(format!(r"{root}\program\soffice.exe")));
        }
    }

    #[cfg(target_os = "macos")]
    {
        found.push(PathBuf::from(
            "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        ));
    }

    /* Android and iOS are unix and neither has an office suite to find; saying
    so here is cheaper than a list of paths that cannot exist. */
    #[cfg(all(
        unix,
        not(any(target_os = "macos", target_os = "android", target_os = "ios"))
    ))]
    {
        for path in [
            "/usr/bin/soffice",
            "/usr/local/bin/soffice",
            "/usr/lib/libreoffice/program/soffice",
            "/opt/libreoffice/program/soffice",
            // A snap or a flatpak: the wrapper, not the binary inside the sandbox.
            "/snap/bin/libreoffice",
            "/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice",
        ] {
            found.push(PathBuf::from(path));
        }
    }

    found
}

/// The first candidate that is there.
///
/// `exists` is a parameter so that the answer can be checked on a machine that
/// has LibreOffice and on one that does not, which is the whole difficulty with
/// testing anything that looks for an installation.
pub fn find_in(candidates: &[PathBuf], exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.iter().find(|path| exists(path)).cloned()
}

/// Whatever is on the PATH, if anything.
fn on_path() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|path| on_path_in(&path))
        .unwrap_or_default()
}

/// The places a PATH names, absolute ones only.
///
/// A relative entry — `.`, or an empty one, which means the same — is whatever
/// folder the program happens to be running in, and a `soffice` found there is
/// not the LibreOffice this machine has installed. It was tried, and started by
/// that relative path.
fn on_path_in(path: &std::ffi::OsStr) -> Vec<PathBuf> {
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["soffice.com", "soffice.exe"]
    } else {
        &["soffice", "libreoffice"]
    };

    let mut found = Vec::new();
    for directory in std::env::split_paths(path) {
        if !directory.is_absolute() {
            continue;
        }
        for name in names {
            found.push(directory.join(name));
        }
    }
    found
}

/// LibreOffice, if this machine has it.
pub fn backend() -> Option<Backend> {
    let mut all = on_path();
    all.extend(candidates());

    find_in(&all, |path| path.is_file()).map(|path| Backend {
        path: path.to_string_lossy().into_owned(),
        formats: formats().iter().map(|f| (*f).to_string()).collect(),
    })
}

/// LibreOffice started so that nothing it starts in turn is looked for in a
/// relative place: a PATH of absolute entries only, and on Windows
/// `NoDefaultCurrentDirectoryInExePath`. The same as a language server is
/// started with — see `harden` in ul-lsp. That variable does not reach
/// LibreOffice's own search for helpers (`SearchPathW`, which still looks in
/// the current folder first, measured by the review of card 505); what keeps
/// a planted helper out of it is that `soffice.bin` runs in LibreOffice's own
/// program folder, whatever folder it was started from (measured too).
///
/// **And on Windows nothing the person put on the PATH at all.** LibreOffice's
/// EPS import looks on the PATH for `pstoedit.exe`, ImageMagick's
/// `convert.exe` and Ghostscript's `gswin64c.exe` or `gswin32c.exe`, and
/// hands each the file being converted — Ghostscript with `-dPARANOIDSAFER`,
/// the other two with no such switch (measured 2026-10-08, card 505, with
/// stand-ins that wrote down how they were called). A `.ps` is a program, and
/// whichever of them is installed would run one the page wrote, with no
/// gesture. Given the system's own folders only, LibreOffice finds none of
/// them — only System32's own `convert.exe`, the FAT-to-NTFS converter, which
/// fails on arguments that name no volume — and converts as it does on a
/// machine without them: a DOS EPS as the preview stored in it, plain
/// PostScript as a placeholder. Started with no PATH at all it never finishes.
///
/// On Unix the PATH stays, absolute entries only. No list of folders keeps
/// Ghostscript out there — see `POSTSCRIPT_IS_CONVERTED` — so PostScript never
/// reaches LibreOffice instead.
fn harden(command: &mut Command) {
    #[cfg(windows)]
    harden_with(command, Some(system_folders()));
    #[cfg(not(windows))]
    harden_with(command, std::env::var_os("PATH"));
}

/// Windows' own folders, the PATH LibreOffice is given there.
#[cfg(windows)]
fn system_folders() -> std::ffi::OsString {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|root| root.is_absolute())
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let system = root.join("System32");
    std::env::join_paths([system.clone(), root, system.join("Wbem")]).unwrap_or_default()
}

/// The same, with the PATH it starts from given.
fn harden_with(command: &mut Command, path: Option<std::ffi::OsString>) {
    if let Some(path) = path {
        let absolute = std::env::split_paths(&path).filter(|entry| entry.is_absolute());
        // One that cannot be put back together leaves no PATH, not the old one.
        command.env("PATH", std::env::join_paths(absolute).unwrap_or_default());
    }
    #[cfg(windows)]
    command.env("NoDefaultCurrentDirectoryInExePath", "1");
}

/// The command LibreOffice is started with, apart from the start so the
/// environment it is given can be checked.
fn soffice_command(backend: &Backend, source: &Path, outdir: &Path, profile: &Path) -> Command {
    let mut command = Command::new(&backend.path);
    harden(&mut command);
    tree::separate(&mut command);
    command.args(arguments(source, outdir, profile));
    command
}

/// Everything a conversion started, so that a conversion given up on takes
/// all of it with it.
///
/// On Windows the program started is a launcher, `soffice.com`, which starts
/// `soffice.bin` and can be gone before it is; the timeout killed only the
/// launcher, and a document that never finished converting — a `.ps` is a
/// program, and one can loop for ever — kept a processor busy until the
/// person logged out. So the launcher goes into a job the moment it exists,
/// what it starts after is in the job with it, and the timeout ends the job.
/// On Unix the conversion is a process group of its own, ended the same way.
///
/// Only a timeout ends the tree. A conversion that finished is left to exit
/// by itself: `soffice.bin` may still be closing the file the PDF is in.
mod tree {
    use std::process::{Child, Command};

    /// Makes what `command` starts a tree that can be ended whole.
    pub(crate) fn separate(command: &mut Command) {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(not(unix))]
        let _ = command;
    }

    pub(crate) struct Tree {
        #[cfg(windows)]
        job: Option<windows::Job>,
        #[cfg(unix)]
        group: i32,
    }

    impl Tree {
        /// The tree `child` is the root of — on Windows, from here on: what it
        /// started before this is not in it, which is why this is asked right
        /// after the start, while it is still loading.
        pub(crate) fn of(child: &Child) -> Self {
            #[cfg(windows)]
            {
                Self {
                    job: windows::Job::holding(child),
                }
            }
            #[cfg(unix)]
            {
                Self {
                    group: child.id() as i32,
                }
            }
            #[cfg(not(any(windows, unix)))]
            {
                let _ = child;
                Self {}
            }
        }

        /// Ends everything in the tree.
        pub(crate) fn end(&self) {
            #[cfg(windows)]
            if let Some(job) = &self.job {
                job.end();
            }
            #[cfg(unix)]
            {
                extern "C" {
                    fn kill(pid: i32, signal: i32) -> i32;
                }
                const SIGKILL: i32 = 9;
                // SAFETY: a negative pid is the process group the child leads
                // (`process_group(0)`); the call takes plain integers.
                unsafe { kill(-self.group, SIGKILL) };
            }
        }
    }

    #[cfg(windows)]
    mod windows {
        use std::ffi::c_void;
        use std::os::windows::io::AsRawHandle;
        use std::process::Child;
        use std::ptr::null_mut;

        #[link(name = "kernel32")]
        extern "system" {
            fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
            fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
            fn TerminateJobObject(job: *mut c_void, exit_code: u32) -> i32;
            fn CloseHandle(handle: *mut c_void) -> i32;
        }

        /// A job without "kill on close": closing it leaves what is in it
        /// running, so only `end` ends anything.
        pub(crate) struct Job(*mut c_void);

        impl Job {
            /// `None` where a job cannot be made or joined; the conversion
            /// runs as it did before, and only the launcher is killed.
            pub(crate) fn holding(child: &Child) -> Option<Self> {
                // SAFETY: no attributes and no name; the handle is closed on drop.
                let job = unsafe { CreateJobObjectW(null_mut(), std::ptr::null()) };
                if job.is_null() {
                    return None;
                }
                let job = Self(job);
                // SAFETY: a job just made, and the handle of a child that has
                // not been waited for, so still valid.
                (unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) } != 0)
                    .then_some(job)
            }

            pub(crate) fn end(&self) {
                // SAFETY: a job handle this owns.
                unsafe { TerminateJobObject(self.0, 1) };
            }
        }

        impl Drop for Job {
            fn drop(&mut self) {
                // SAFETY: closed once, here.
                unsafe { CloseHandle(self.0) };
            }
        }
    }
}

/// What the output of a conversion is called.
///
/// LibreOffice names it after the input with the extension replaced, in the
/// directory it was given — there is no way to ask for a name, so the name has
/// to be predicted in order to be waited for.
pub fn output_name(source: &Path) -> String {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "converted".to_string());
    format!("{stem}.pdf")
}

/// The arguments, built where they can be read and checked.
///
/// `profile` is a directory of its own for this run. Without it the command
/// reaches whichever instance already holds the user's profile, and a
/// LibreOffice that is showing somebody a document accepts the job and does
/// nothing with it — exit code 0, no file, no message.
pub fn arguments(source: &Path, outdir: &Path, profile: &Path) -> Vec<String> {
    vec![
        format!("-env:UserInstallation={}", file_url(profile)),
        "--headless".to_string(),
        "--norestore".to_string(),
        "--invisible".to_string(),
        "--nolockcheck".to_string(),
        "--nodefault".to_string(),
        "--nofirststartwizard".to_string(),
        "--convert-to".to_string(),
        "pdf".to_string(),
        "--outdir".to_string(),
        outdir.to_string_lossy().into_owned(),
        source.to_string_lossy().into_owned(),
    ]
}

/// A path as LibreOffice wants it in `-env:` — a URL, with the separators the
/// URL form uses even on Windows.
pub fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if text.starts_with('/') {
        format!("file://{text}")
    } else {
        format!("file:///{text}")
    }
}

/// Converts one file to PDF and returns where the PDF is.
///
/// The output directory is the caller's business: this writes one file into it
/// and nothing else. Nothing is ever written beside the original — a program
/// that leaves a PDF next to somebody's drawing without being asked is a
/// program that litters.
///
/// `profile` is the LibreOffice user profile this run uses, and the caller
/// keeps it somewhere nobody else can write: the profile is where macro
/// security and every other setting of that LibreOffice live, so a profile
/// somebody planted is a LibreOffice that runs their macros in the document.
/// It is apart from `outdir` for that reason — the PDF is handed to the
/// interface to open, the profile never is.
pub fn to_pdf(
    backend: &Backend,
    source: &Path,
    outdir: &Path,
    profile: &Path,
    workdir: &Path,
    timeout: Duration,
) -> Result<PathBuf, ConvertError> {
    if !source.is_file() {
        return Err(ConvertError::NoSource(
            source.to_string_lossy().into_owned(),
        ));
    }
    let name = source
        .file_name()
        .ok_or_else(|| ConvertError::NoSource(source.to_string_lossy().into_owned()))?;

    /* A private copy, in a directory the page cannot write, is what is checked
    and what is converted — the same bytes for both. Reading the source to
    classify it and then letting LibreOffice open it again by name would be two
    opens of a path the page controls: it could pass the check with `%!PS…` and
    swap in HTML before LibreOffice looked, and the web import that reaches the
    network (card 505) would run on bytes that were never checked. Copied once
    here, into a directory of this conversion's own (`Staging`), there is
    nothing left for the page to swap. */
    /* One time limit for all of it — the copy, a ZIP made again, and
    LibreOffice — not for LibreOffice alone (the review of d561273). */
    let started = Instant::now();
    let staging = Staging::new(workdir)?;
    let staged = staging.0.join(name);
    copy_at_most(source, &staged, MOST_BYTES)?;

    // The content, not the name: a file whose bytes are not one of the four
    // formats — HTML wearing a `.cdr` name, say — would be imported for what it
    // really is, and a web page reaches the network as it loads (card 505).
    // And PostScript only where what LibreOffice would hand it to is kept out
    // of its reach (card 512).
    let staged = match admit(&head_of(&staged)?)? {
        Admitted::AsIs => staged,
        /* Rebuilt beside it, under the drawing's own name with `.cdr` — the
        extension LibreOffice tries libcdr on first — and the page's ZIP gone
        before LibreOffice is started. */
        /* Only under the name it is: a ZIP named anything else is not a
        CorelDRAW drawing, and is not told it is laid out wrongly as one. */
        Admitted::CorelZip => {
            let named_cdr = Path::new(name)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("cdr"));
            if !named_cdr {
                return Err(ConvertError::UnsupportedContent);
            }
            if std::fs::metadata(&staged)?.len() > MOST_ZIP_BYTES {
                return Err(ConvertError::TooLarge(MOST_ZIP_BYTES / (1024 * 1024)));
            }
            let rebuilt_dir = staging.0.join("cdr");
            std::fs::create_dir(&rebuilt_dir)?;
            let stem = Path::new(name)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "drawing".to_string());
            let rebuilt = rebuilt_dir.join(format!("{stem}.cdr"));
            let limits = Limits {
                bytes: MOST_REBUILT_BYTES,
                parts: MOST_PARTS,
                list: MOST_LIST_BYTES,
                until: started + timeout,
            };
            rebuild_coreldraw(&staged, &rebuilt, &limits)?;
            std::fs::remove_file(&staged)?;
            rebuilt
        }
    };
    std::fs::create_dir_all(outdir)?;

    let expected = outdir.join(output_name(&staged));
    // A stale file from a previous run would be mistaken for this run's answer.
    let _ = std::fs::remove_file(&expected);

    let child = soffice_command(backend, &staged, outdir, profile)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| ConvertError::Start(err.to_string()))?;
    watch(child, &expected, timeout.saturating_sub(started.elapsed()))
}

/// `source` copied to `to`, a new file, so long as it is no larger than
/// `most`: the copy stops one byte past it and is refused, so a file of any
/// size costs at most that much room. A new file rather than `fs::copy`, which
/// would carry a read-only source's flag onto a copy that then could not be
/// cleared away.
fn copy_at_most(source: &Path, to: &Path, most: u64) -> Result<(), ConvertError> {
    let mut from = open_regular(source)?.take(most + 1);
    let mut into = std::fs::File::create_new(to)?;
    let copied = std::io::copy(&mut from, &mut into)?;
    if copied > most {
        drop(into);
        let _ = std::fs::remove_file(to);
        return Err(ConvertError::TooLarge(most / (1024 * 1024)));
    }
    Ok(())
}

/// `O_NONBLOCK` where LibreOffice is converted with: Linux on the
/// architectures it is built for, and macOS — the same table as
/// `ul_core::vfs`'s, which this crate does not depend on.
#[cfg(all(
    target_os = "linux",
    any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "arm",
        target_arch = "x86"
    )
))]
const O_NONBLOCK: Option<i32> = Some(0o4000);
#[cfg(target_vendor = "apple")]
const O_NONBLOCK: Option<i32> = Some(0x4);
#[cfg(all(
    unix,
    not(any(
        target_vendor = "apple",
        all(
            target_os = "linux",
            any(
                target_arch = "x86_64",
                target_arch = "aarch64",
                target_arch = "arm",
                target_arch = "x86"
            )
        )
    ))
))]
const O_NONBLOCK: Option<i32> = None;

/// `source` opened to be copied — and only if it is a file. `to_pdf` asked
/// its name first, and a FIFO put there since would hold the open for ever,
/// and with it the one conversion allowed at a time (the review of efb974a).
/// So it is opened without waiting, and the open file is asked what it is.
fn open_regular(source: &Path) -> Result<std::fs::File, ConvertError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    if let Some(flag) = O_NONBLOCK {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(flag);
    }
    let file = options.open(source)?;
    if !file.metadata()?.is_file() {
        return Err(ConvertError::NoSource(
            source.to_string_lossy().into_owned(),
        ));
    }
    Ok(file)
}

/// How much of what LibreOffice says is kept for the message: a reason is in
/// the first lines, and the rest is not worth the memory.
const KEPT: usize = 64 * 1024;

/// A pipe read to its end on a thread of its own from the moment the process
/// starts, keeping the first `KEPT` bytes.
///
/// Read at the end instead, a pipe fills while nobody is reading it — 4 KiB on
/// Windows, 64 on Linux — and a LibreOffice with that much to say about a
/// document blocks on its next write, produces nothing, and is killed at the
/// timeout two minutes later with its reason still in the pipe. What has been
/// read is shared rather than joined: on Windows the launcher hands the pipe to
/// the real process, which may hold it open long after the launcher has gone.
fn drain(pipe: Option<impl Read + Send + 'static>) -> Arc<Mutex<Vec<u8>>> {
    let kept = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut pipe) = pipe {
        let into = Arc::clone(&kept);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(read) = pipe.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                let mut kept = into.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                let room = KEPT.saturating_sub(kept.len());
                kept.extend_from_slice(&buffer[..read.min(room)]);
            }
        });
    }
    kept
}

fn said(kept: &Arc<Mutex<Vec<u8>>>) -> String {
    let kept = kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    String::from_utf8_lossy(&kept).trim().to_string()
}

/// Waits for LibreOffice's answer, which is a file rather than an exit code.
fn watch(mut child: Child, expected: &Path, timeout: Duration) -> Result<PathBuf, ConvertError> {
    let tree = tree::Tree::of(&child);
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    /*
     * The file is what is waited for, not the process. On Windows the process
     * that was started is a launcher and has usually exited before the work
     * begins; everywhere, the exit code is 0 for a file it could not read. So:
     * poll for the output, and treat the process ending without one as the
     * refusal it is — with whatever it wrote on the way out, since that is the
     * only place a reason is ever given.
     */
    let deadline = Instant::now() + timeout;
    loop {
        if expected.is_file()
            && std::fs::metadata(expected)
                .map(|m| m.len() > 0)
                .unwrap_or(false)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(expected.to_path_buf());
        }

        match child.try_wait() {
            Ok(Some(_)) => {
                /* One more look before giving up: the file may have appeared in
                the same moment the process ended. */
                std::thread::sleep(Duration::from_millis(250));
                if expected.is_file() {
                    return Ok(expected.to_path_buf());
                }
                let said = match said(&stderr) {
                    text if text.is_empty() => said(&stdout),
                    text => text,
                };
                return Err(ConvertError::Refused(if said.is_empty() {
                    "nothing".to_string()
                } else {
                    said.chars().take(300).collect()
                }));
            }
            Ok(None) => {}
            Err(err) => return Err(ConvertError::Start(err.to_string())),
        }

        if Instant::now() > deadline {
            tree.end();
            let _ = child.kill();
            let _ = child.wait();
            return Err(ConvertError::Timeout(timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not a check of its own: the noisy child the next test starts — this
    /// same test binary, asked for this one test, with the variable set.
    #[test]
    fn noisy_child() {
        if std::env::var_os("UL_CONVERT_NOISY_CHILD").is_some() {
            use std::io::Write;
            let line = [b'x'; 1024];
            let mut err = std::io::stderr().lock();
            for _ in 0..1024 {
                let _ = err.write_all(&line);
            }
            std::process::exit(3);
        }
    }

    /// Not a check of its own: the child of the next test, which starts a
    /// grandchild, says which, and waits for ever — as a launcher that left
    /// its `soffice.bin` stuck would.
    #[test]
    fn tree_child() {
        if let Some(pids) = std::env::var_os("UL_CONVERT_TREE_PIDS") {
            let mut grandchild = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "tests::tree_grandchild", "--nocapture"])
                .env("UL_CONVERT_TREE_GRANDCHILD", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            std::fs::write(pids, grandchild.id().to_string()).unwrap();
            // Waits as long as the grandchild does, which is the point.
            let _ = grandchild.wait();
        }
    }

    /// Not a check of its own: the grandchild, which only waits.
    #[test]
    fn tree_grandchild() {
        if std::env::var_os("UL_CONVERT_TREE_GRANDCHILD").is_some() {
            std::thread::sleep(Duration::from_secs(120));
        }
    }

    fn running(pid: u32) -> bool {
        if cfg!(windows) {
            let listed = Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&listed.stdout).contains(&pid.to_string())
        } else {
            Command::new("kill")
                .args(["-0", &pid.to_string()])
                .status()
                .is_ok_and(|status| status.success())
        }
    }

    #[test]
    fn a_conversion_given_up_on_ends_everything_it_started() {
        /* A launcher that started a process and never returns: at the
        timeout, the process it started goes too, not only the launcher. */
        let pids = std::env::temp_dir().join(format!("ul-convert-tree-{}", std::process::id()));
        let _ = std::fs::remove_file(&pids);
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "tests::tree_child", "--nocapture"])
            .env("UL_CONVERT_TREE_PIDS", &pids)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        tree::separate(&mut command);
        let child = command.spawn().unwrap();

        let nowhere = std::env::temp_dir().join("ul-convert-tree-never-written.pdf");
        let answer = watch(child, &nowhere, Duration::from_secs(4));
        assert!(
            matches!(answer, Err(ConvertError::Timeout(4))),
            "{answer:?}"
        );

        let grandchild: u32 = std::fs::read_to_string(&pids)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let _ = std::fs::remove_file(&pids);
        let deadline = Instant::now() + Duration::from_secs(5);
        while running(grandchild) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(
            !running(grandchild),
            "process {grandchild} outlived the conversion"
        );
    }

    #[test]
    fn a_libreoffice_with_a_lot_to_say_is_heard_rather_than_left_to_time_out() {
        /* A megabyte on stderr and no file: the refusal it is, at once, with
        the start of what it said. With its pipes read only at the end it
        filled them, blocked on the next write, and was killed at the timeout
        with its reason still inside. */
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::noisy_child", "--nocapture"])
            .env("UL_CONVERT_NOISY_CHILD", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let nowhere = std::env::temp_dir().join("ul-convert-never-written.pdf");
        let started = Instant::now();
        match watch(child, &nowhere, Duration::from_secs(20)) {
            Err(ConvertError::Refused(said)) => {
                assert!(said.starts_with("xxxx"), "{}", &said[..said.len().min(80)]);
                assert!(
                    started.elapsed() < Duration::from_secs(10),
                    "{:?}",
                    started.elapsed()
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn libreoffice_is_started_with_nothing_relative_to_look_in() {
        /* The command the conversion really uses, not `harden` on its own. */
        let backend = Backend {
            path: "soffice".to_string(),
            formats: Vec::new(),
        };
        let here = Path::new("x");
        let command = soffice_command(&backend, here, here, here);
        let envs: Vec<_> = command.get_envs().collect();
        let path = envs
            .iter()
            .find(|(key, _)| *key == "PATH")
            .and_then(|(_, value)| *value);
        if let Some(path) = path {
            assert!(std::env::split_paths(path).all(|entry| entry.is_absolute()));
        }
        if cfg!(windows) {
            assert!(envs.iter().any(|(key, value)| {
                *key == "NoDefaultCurrentDirectoryInExePath" && *value == Some("1".as_ref())
            }));
        }
    }

    /// The PostScript helpers LibreOffice would hand a file to are looked for
    /// on the PATH, so on Windows it gets the system's folders and nothing
    /// else — not the folder Ghostscript, pstoedit or ImageMagick was put in.
    /// Cargo puts its own folders on the PATH a test runs with, so a PATH
    /// passed on from here would show up as one outside the system's.
    #[cfg(windows)]
    #[test]
    fn on_windows_libreoffice_is_given_the_system_folders_only() {
        let backend = Backend {
            path: "soffice".to_string(),
            formats: Vec::new(),
        };
        let here = Path::new("x");
        let command = soffice_command(&backend, here, here, here);
        let path = command
            .get_envs()
            .find(|(key, _)| *key == "PATH")
            .and_then(|(_, value)| value)
            .expect("a PATH is given");
        let root = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
        let entries: Vec<_> = std::env::split_paths(path).collect();
        assert_eq!(
            entries,
            vec![
                root.join("System32"),
                root.clone(),
                root.join("System32").join("Wbem")
            ]
        );
        let ours = std::env::var_os("PATH").unwrap();
        assert!(
            std::env::split_paths(&ours).any(|entry| !entry.starts_with(&root)),
            "the test's own PATH has a folder outside the system's, or it proves nothing"
        );
    }

    #[test]
    fn whatever_path_it_starts_from_only_absolute_entries_are_passed_on() {
        let messy = std::env::join_paths([
            std::path::PathBuf::from("."),
            std::path::PathBuf::from("relative"),
            std::env::temp_dir(),
        ])
        .unwrap();
        let mut probe = Command::new("probe");
        harden_with(&mut probe, Some(messy));
        let path = probe
            .get_envs()
            .find(|(key, _)| *key == "PATH")
            .and_then(|(_, value)| value)
            .unwrap();
        let entries: Vec<_> = std::env::split_paths(path).collect();
        assert_eq!(entries, vec![std::env::temp_dir()]);
    }

    #[test]
    fn only_an_absolute_path_entry_is_looked_in() {
        let absolute = if cfg!(windows) {
            r"C:\Program Files\LibreOffice\program"
        } else {
            "/usr/bin"
        };
        let path = std::env::join_paths([".", "", "relative/bin", absolute]).unwrap();
        let looked = on_path_in(&path);
        assert!(!looked.is_empty());
        assert!(
            looked.iter().all(|candidate| candidate.is_absolute()),
            "{looked:?}"
        );
    }

    #[test]
    fn the_first_candidate_that_exists_wins() {
        let candidates = vec![
            PathBuf::from("/nowhere/soffice"),
            PathBuf::from("/somewhere/soffice"),
            PathBuf::from("/elsewhere/soffice"),
        ];
        let found = find_in(&candidates, |path| path.starts_with("/somewhere"));
        assert_eq!(found, Some(PathBuf::from("/somewhere/soffice")));
    }

    #[test]
    fn nothing_installed_is_nothing_found() {
        assert_eq!(find_in(&candidates(), |_| false), None);
    }

    #[test]
    fn windows_prefers_the_console_wrapper() {
        /* The `.exe` is a launcher that returns before the work is done, so the
        `.com` beside it has to be tried first — the whole reason this order
        is written down rather than left to a directory listing. */
        if cfg!(target_os = "windows") {
            let all = candidates();
            let com = all.iter().position(|p| p.ends_with("soffice.com"));
            let exe = all.iter().position(|p| p.ends_with("soffice.exe"));
            assert!(com.is_some() && exe.is_some());
            assert!(com < exe, "{all:?}");
        }
    }

    #[test]
    fn the_output_is_named_after_the_input() {
        assert_eq!(output_name(Path::new("/tmp/plakat.cdr")), "plakat.pdf");
        assert_eq!(output_name(Path::new("/tmp/crtež 2.eps")), "crtež 2.pdf");
        assert_eq!(
            output_name(Path::new("/tmp/noextension")),
            "noextension.pdf"
        );
    }

    #[test]
    fn a_profile_of_its_own_is_asked_for() {
        let args = arguments(
            Path::new("/in/plakat.cdr"),
            Path::new("/out"),
            Path::new("/out/profile"),
        );
        /* Without this the command reaches a LibreOffice that is already open,
        which accepts the job, produces nothing and exits 0. It is the first
        argument because it is the one that must not be forgotten. */
        assert!(
            args[0].starts_with("-env:UserInstallation=file://"),
            "{args:?}"
        );
        assert!(args.contains(&"--headless".to_string()));
        assert!(args.contains(&"--convert-to".to_string()));
        assert!(args.contains(&"pdf".to_string()));
    }

    #[test]
    fn the_source_is_the_last_word() {
        let args = arguments(Path::new("/in/a.cdr"), Path::new("/out"), Path::new("/p"));
        assert_eq!(args.last().unwrap(), "/in/a.cdr");
        let outdir = args.iter().position(|a| a == "--outdir").unwrap();
        assert_eq!(args[outdir + 1], "/out");
    }

    #[test]
    fn a_windows_path_becomes_a_url_with_three_slashes() {
        assert_eq!(
            file_url(Path::new(r"C:\Users\x\AppData\Local\Temp\p")),
            "file:///C:/Users/x/AppData/Local/Temp/p"
        );
        assert_eq!(file_url(Path::new("/tmp/p")), "file:///tmp/p");
    }

    #[test]
    fn a_file_that_is_not_there_is_refused_before_libreoffice_is_started() {
        let backend = Backend {
            path: "/definitely/not/soffice".to_string(),
            formats: vec![],
        };
        let error = to_pdf(
            &backend,
            Path::new("/definitely/not/a/drawing.cdr"),
            Path::new("/tmp/ul-convert-test"),
            Path::new("/tmp/ul-convert-test-profile"),
            Path::new("/tmp/ul-convert-test-in"),
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(matches!(error, ConvertError::NoSource(_)), "{error}");
    }

    /**
     * A PDF that shows a picture — which is not the same as a PDF.
     *
     * `%PDF` and a size are all the live test used to ask, and neither can fail:
     * with no PostScript interpreter on the machine LibreOffice answers a
     * PostScript file with its *placeholder* — a frame carrying the file's title
     * and creator, 6–15 KB — which starts with `%PDF` and clears any size bar
     * that a real page of a drawing would. A test that passes on the placeholder
     * says nothing about whether anything was drawn.
     *
     * What the two differ in: the page LibreOffice makes from a DOS EPS carries
     * the stored preview as an image object, whose dictionary is written in the
     * clear; the placeholder is a frame and some text, with no image in it.
     */
    fn pdf_shows_a_picture(pdf: &[u8]) -> bool {
        contains(pdf, b"/Subtype/Image") || contains(pdf, b"/Subtype /Image")
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    #[test]
    fn a_pdf_with_an_image_object_shows_a_picture_and_a_frame_of_text_does_not() {
        let spaced = b"%PDF-1.7\n5 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 >>\nstream\n";
        let packed = b"%PDF-1.7\n5 0 obj\n<</Type/XObject/Subtype/Image/Width 8>>\nstream\n";
        let frame = b"%PDF-1.7\n5 0 obj\n<< /Type /Page /Subtype /Form >>\nstream\n";
        assert!(pdf_shows_a_picture(spaced));
        assert!(pdf_shows_a_picture(packed));
        assert!(!pdf_shows_a_picture(frame));
        assert!(!pdf_shows_a_picture(b""));
    }

    /// A small uncompressed RGB TIFF of one colour, made here so that nothing
    /// binary is committed.
    fn tiff_of(width: u16, height: u16, [r, g, b]: [u8; 3]) -> Vec<u8> {
        const ENTRIES: u16 = 9;
        const SHORT: u16 = 3;
        const LONG: u16 = 4;
        let pixels: Vec<u8> = (0..usize::from(width) * usize::from(height))
            .flat_map(|_| [r, g, b])
            .collect();
        // The header, the directory and its next-image link, then three shorts.
        let bits_at = 8 + 2 + u32::from(ENTRIES) * 12 + 4;
        let data_at = bits_at + 6;

        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II*\0");
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&ENTRIES.to_le_bytes());
        let mut entry = |tag: u16, kind: u16, count: u32, value: u32| {
            tiff.extend_from_slice(&tag.to_le_bytes());
            tiff.extend_from_slice(&kind.to_le_bytes());
            tiff.extend_from_slice(&count.to_le_bytes());
            tiff.extend_from_slice(&value.to_le_bytes());
        };
        entry(256, SHORT, 1, u32::from(width));
        entry(257, SHORT, 1, u32::from(height));
        entry(258, SHORT, 3, bits_at);
        entry(259, SHORT, 1, 1); // no compression
        entry(262, SHORT, 1, 2); // RGB
        entry(273, LONG, 1, data_at);
        entry(277, SHORT, 1, 3);
        entry(278, SHORT, 1, u32::from(height));
        entry(279, LONG, 1, pixels.len() as u32);
        tiff.extend_from_slice(&0u32.to_le_bytes()); // no next image
        for _ in 0..3 {
            tiff.extend_from_slice(&8u16.to_le_bytes());
        }
        tiff.extend_from_slice(&pixels);
        tiff
    }

    /// The PostScript a drawing program leaves in an EPS: no preview in it.
    const PROGRAM: &[u8] = b"%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 200 100
%%Title: ul-convert probe
%%Creator: the live test
/Helvetica findfont 18 scalefont setfont
20 50 moveto (Pozdrav iz EPS-a) show
0 0 1 setrgbcolor 20 20 160 15 rectfill
showpage
%%EOF
";

    /// The same program in the DOS EPS container with a TIFF preview behind it:
    /// the magic, the offset and length of the PostScript, of the (absent) WMF
    /// and of the TIFF, then a checksum nobody checks.
    fn dos_eps(program: &[u8], tiff: &[u8]) -> Vec<u8> {
        let mut eps = vec![0xC5, 0xD0, 0xD3, 0xC6];
        for field in [
            30,
            program.len() as u32,
            0,
            0,
            30 + program.len() as u32,
            tiff.len() as u32,
        ] {
            eps.extend_from_slice(&field.to_le_bytes());
        }
        eps.extend_from_slice(&0xFFFFu16.to_le_bytes());
        eps.extend_from_slice(program);
        eps.extend_from_slice(tiff);
        eps
    }

    /// Converts `bytes`, named `<name>.eps`, with the real LibreOffice in a
    /// folder of its own and gives back the PDF.
    fn convert_with_libreoffice(name: &str, bytes: &[u8]) -> Vec<u8> {
        let Some(backend) = backend() else {
            panic!(
                "LibreOffice was not found — this test is only meaningful where it is installed"
            );
        };

        let dir =
            std::env::temp_dir().join(format!("ul-convert-live-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let source = dir.join(format!("{name}.eps"));
        std::fs::write(&source, bytes).unwrap();

        let out = dir.join("out");
        let profile = dir.join("profile");
        let workdir = dir.join("in");
        let pdf = to_pdf(
            &backend,
            &source,
            &out,
            &profile,
            &workdir,
            Duration::from_secs(180),
        )
        .unwrap();

        assert_eq!(
            pdf.file_name().unwrap().to_string_lossy(),
            format!("{name}.pdf")
        );
        let bytes = std::fs::read(&pdf).unwrap();
        assert!(
            bytes.starts_with(b"%PDF"),
            "not a PDF: {:?}",
            &bytes[..8.min(bytes.len())]
        );

        /* And the profile really was its own, which is the argument that stops
        this failing whenever somebody has LibreOffice open. */
        assert!(profile.exists());
        assert!(!out.join("profile").exists());
        println!("{name}: {} bytes, kept in {}", bytes.len(), dir.display());
        bytes
    }

    /**
     * The whole pipeline against the real thing — and what comes out is a page
     * that **shows something**, not merely a file that is a PDF.
     *
     * `#[ignore]` rather than a self-skip: a test that passes on a machine
     * without LibreOffice is a test that lies, and this repository has already
     * been bitten once by a check whose only failure mode was a pass. CI has no
     * office suite, so this is run by hand — `cargo test -p ul-convert --
     * --ignored` — on a machine that has one.
     *
     * The fixture is a DOS EPS assembled here: PostScript is text and a TIFF
     * can be written in forty lines, so nothing binary is committed. It is the
     * form 13 of the 19 real files in ADR 0003 have, and the one LibreOffice
     * turns into a page without any PostScript interpreter (ADR 0007).
     */
    #[test]
    #[ignore = "needs LibreOffice installed; run with: cargo test -p ul-convert -- --ignored"]
    fn a_real_libreoffice_shows_the_preview_stored_in_a_dos_eps() {
        let eps = dos_eps(PROGRAM, &tiff_of(64, 32, [200, 30, 30]));
        let pdf = convert_with_libreoffice("preview", &eps);

        assert!(
            pdf_shows_a_picture(&pdf),
            "{} bytes and %PDF, but no picture in it — this is the placeholder",
            pdf.len()
        );
        // Ours, not some other image the page happened to carry.
        assert!(
            contains(&pdf, b"/Width 64") && contains(&pdf, b"/Height 32"),
            "a picture, but not the 64 x 32 one stored in the file"
        );
    }

    /**
     * The other half, kept so the first cannot be satisfied by accident: the
     * same program *without* a preview comes back as the placeholder on a
     * machine with no PostScript interpreter (ADR 0007, measured 2026-10-08),
     * and the discriminator says so.
     *
     * This one is about the machine and not about the code: with Ghostscript
     * installed LibreOffice runs the program and the assertion fails — which
     * would be news worth having (ADR 0007, trigger 2; card 505), not a
     * regression.
     */
    #[test]
    #[ignore = "needs LibreOffice installed; run with: cargo test -p ul-convert -- --ignored"]
    fn a_real_libreoffice_gives_a_postscript_without_a_preview_only_its_placeholder() {
        let pdf = convert_with_libreoffice("program", PROGRAM);

        assert!(
            !pdf_shows_a_picture(&pdf),
            "a PostScript program with no preview drew a picture — is Ghostscript installed? \
             then the placeholder is no longer the whole story (ADR 0007)"
        );
    }

    /* A document wearing one of the four names, whose bytes are HTML with a
     * linked image, is refused before LibreOffice is started — so the fetch
     * that import would make (measured, card 505) never happens. No office
     * suite is needed for this one: the refusal is before LibreOffice. */
    #[test]
    fn html_wearing_a_drawing_name_is_refused_before_libreoffice() {
        let backend = Backend {
            path: "soffice".into(),
            formats: FORMATS.iter().map(|f| (*f).to_string()).collect(),
        };
        let dir = std::env::temp_dir().join(format!("ul-convert-sniff-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let source = dir.join("drawing.cdr");
        std::fs::write(
            &source,
            b"<!DOCTYPE html><html><body><img src=\"http://127.0.0.1:1/x?data=secret\"></body></html>",
        )
        .unwrap();

        let result = to_pdf(
            &backend,
            &source,
            &dir.join("out"),
            &dir.join("profile"),
            &dir.join("in"),
            Duration::from_secs(5),
        );
        assert!(
            matches!(result, Err(ConvertError::UnsupportedContent)),
            "{result:?}"
        );
        // LibreOffice was never told about it, so there is nowhere a PDF could be.
        assert!(!dir.join("out").join("drawing.pdf").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_four_formats_own_first_bytes_are_accepted() {
        // Which of them goes on to LibreOffice where is `admit`'s, and is
        // checked through `to_pdf` below.
        let content_is_supported = |head: &[u8]| is_postscript(head) || is_coreldraw(head);
        // The real start of each of the four, which must be let through.
        assert!(content_is_supported(b"%!PS-Adobe-3.0 EPSF-3.0\n"));
        assert!(content_is_supported(b"%!PS-Adobe-2.0\n")); // a .ps
        assert!(content_is_supported(b"%!PS\n")); // the shortest PostScript key
        assert!(content_is_supported(&[0xC5, 0xD0, 0xD3, 0xC6, 0, 0])); // EPS with a preview
        assert!(content_is_supported(b"RIFFxxxxCDRA")); // CorelDRAW
        assert!(content_is_supported(b"RIFFxxxxcdrA")); // and in lower case
        assert!(content_is_supported(b"RIFFxxxxCDR9")); // version 9
        assert!(content_is_supported(b"RIFFxxxxCDR ")); // version 3
        assert!(content_is_supported(b"RIFFxxxxCDR\xFF")); // libcdr takes any byte from A up
                                                           // What libcdr turns away, and LibreOffice then tries as something
                                                           // else (card 510): a template, a version byte it does not know, none.
        assert!(!content_is_supported(b"RIFFxxxxCDTA"));
        assert!(!content_is_supported(b"RIFFxxxxCDR\x05"));
        assert!(!content_is_supported(b"RIFFxxxxCDR0"));
        assert!(!content_is_supported(b"RIFFxxxxCDR@"));
        assert!(!content_is_supported(b"RIFFxxxxCDR"));

        // What a document would be wearing one of those four names: each is
        // sniffed by LibreOffice for what it is, and each reaches out.
        assert!(!content_is_supported(
            b"<!DOCTYPE html><img src=http://e/x>"
        ));
        assert!(!content_is_supported(b"<html>"));
        assert!(!content_is_supported(b"<?xml version=\"1.0\"?><svg")); // SVG, XML
        assert!(!content_is_supported(b"PK\x03\x04")); // a .odt/.docx ZIP
        assert!(!content_is_supported(b"{\\rtf1")); // RTF
        assert!(!content_is_supported(&[0xD0, 0xCF, 0x11, 0xE0])); // an old .doc
        assert!(!content_is_supported(b"RIFFxxxxWEBP")); // a RIFF that is not CorelDRAW
        assert!(!content_is_supported(b" %!PS")); // not PostScript if anything is before it
        assert!(!content_is_supported(b"%!\n<html>")); // bare %! then HTML is not the PS key
        assert!(!content_is_supported(b"%! some other thing")); // bare %! is not %!PS
        assert!(!content_is_supported(b"%!ps-adobe-3.0\n")); // LibreOffice would take it; not here
        assert!(!content_is_supported(b"%PDF-1.5\n")); // a modern .ai: the PDF viewer's
        assert!(!content_is_supported(b""));
    }

    /// A ZIP written here, of `members` in order, deflated as CorelDRAW
    /// writes them.
    fn zip_of(members: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;
        let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let deflated = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in members {
            out.start_file(*name, deflated).unwrap();
            out.write_all(bytes).unwrap();
        }
        out.finish().unwrap().into_inner()
    }

    /// The members of a ZIP, in order, with how each is stored.
    fn members_of(path: &Path) -> Vec<(String, zip::CompressionMethod, Vec<u8>)> {
        let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
        (0..archive.len())
            .map(|i| {
                let mut part = archive.by_index(i).unwrap();
                let mut bytes = Vec::new();
                part.read_to_end(&mut bytes).unwrap();
                (part.name().to_string(), part.compression(), bytes)
            })
            .collect()
    }

    const ROOT: &[u8] = b"RIFF\x10\0\0\0CDRGfver\x04\0\0\0abcd";

    /// The layout of the one real CorelDRAW ZIP (X6, card 510), and what
    /// libcdr does not read beside it: thumbnails, styles — and OpenDocument
    /// members, which LibreOffice would open as a Writer document.
    fn a_coreldraw_zip() -> Vec<u8> {
        zip_of(&[
            ("mimetype", b"application/vnd.oasis.opendocument.text"),
            ("content/data/data1.dat", b"first part"),
            ("content/data/page1.dat", b"the page"),
            ("content/dataFileList.dat", b"data1.dat\npage1.dat"),
            ("content/root.dat", ROOT),
            ("metadata/thumbnails/thumbnail.bmp", b"BM a picture"),
            ("content.xml", b"<office:document-content/>"),
            ("styles/document.cdss", b"styles"),
        ])
    }

    /// The program's own bounds, with a minute to do it in.
    fn usual() -> Limits {
        Limits {
            bytes: MOST_REBUILT_BYTES,
            parts: MOST_PARTS,
            list: MOST_LIST_BYTES,
            until: Instant::now() + Duration::from_secs(60),
        }
    }

    /// A ZIP made again under `limits`, and what is in it — its folder gone
    /// once it has been read, as each test's should be.
    #[allow(clippy::type_complexity)]
    fn rebuilt_within(
        name: &str,
        zip: &[u8],
        limits: &Limits,
    ) -> Result<Vec<(String, zip::CompressionMethod, Vec<u8>)>, ConvertError> {
        let dir =
            std::env::temp_dir().join(format!("ul-convert-zip-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let from = dir.join("drawing.cdr");
        std::fs::write(&from, zip).unwrap();
        let to = dir.join("rebuilt.cdr");
        let made = rebuild_coreldraw(&from, &to, limits).map(|()| members_of(&to));
        let _ = std::fs::remove_dir_all(&dir);
        made
    }

    #[allow(clippy::type_complexity)]
    fn rebuilt(
        name: &str,
        zip: &[u8],
    ) -> Result<Vec<(String, zip::CompressionMethod, Vec<u8>)>, ConvertError> {
        rebuilt_within(name, zip, &usual())
    }

    /// A CorelDRAW ZIP is made again of the parts libcdr reads and nothing
    /// else, stored, the bytes of each as they were (ADR 0008).
    #[test]
    fn a_coreldraw_zip_is_made_again_of_what_libcdr_reads() {
        let members = rebuilt("whole", &a_coreldraw_zip()).unwrap();
        let names: Vec<&str> = members.iter().map(|(n, _, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "content/root.dat",
                "content/dataFileList.dat",
                "content/data/data1.dat",
                "content/data/page1.dat"
            ]
        );
        assert!(members
            .iter()
            .all(|(_, how, _)| *how == zip::CompressionMethod::Stored));
        assert_eq!(members[0].2, ROOT);
        assert_eq!(members[1].2, b"data1.dat\npage1.dat");
        assert_eq!(members[2].2, b"first part");
        assert_eq!(members[3].2, b"the page");

        // Split as libcdr splits it: a last newline ends nothing more, and a
        // name named twice is one part.
        let members = rebuilt(
            "twice",
            &zip_of(&[
                ("content/root.dat", ROOT),
                ("content/dataFileList.dat", b"page1.dat\npage1.dat\n"),
                ("content/data/page1.dat", b"the page"),
            ]),
        )
        .unwrap();
        assert_eq!(members.len(), 3);
        assert_eq!(members[1].2, b"page1.dat\npage1.dat");

        // No list: the drawing alone, and an empty list beside it.
        let members = rebuilt("alone", &zip_of(&[("content/root.dat", ROOT)])).unwrap();
        assert_eq!(members.len(), 2);
    }

    /// What is not that layout is refused, and no ZIP is left to hand on.
    #[test]
    fn a_zip_that_is_not_a_coreldraw_drawing_is_refused() {
        let refusals: [(&str, Vec<u8>); 10] = [
            (
                "odf",
                zip_of(&[
                    ("mimetype", b"application/vnd.oasis.opendocument.text"),
                    ("content.xml", b"<x/>"),
                ]),
            ),
            (
                "no-root",
                zip_of(&[
                    ("content/dataFileList.dat", b""),
                    ("content/riffData.cdr", ROOT),
                ]),
            ),
            (
                "template",
                zip_of(&[("content/root.dat", b"RIFF\x10\0\0\0CDTGfver")]),
            ),
            (
                "version",
                zip_of(&[("content/root.dat", b"RIFF\x10\0\0\0CDR\x05fver")]),
            ),
            ("short", zip_of(&[("content/root.dat", b"RIFF")])),
            (
                "climb",
                zip_of(&[
                    ("content/root.dat", ROOT),
                    ("content/dataFileList.dat", b"../../x.dat"),
                    ("x.dat", b"x"),
                ]),
            ),
            (
                "crlf",
                zip_of(&[
                    ("content/root.dat", ROOT),
                    ("content/dataFileList.dat", b"page1.dat\r\n"),
                    ("content/data/page1.dat", b"p"),
                ]),
            ),
            (
                "gap",
                zip_of(&[
                    ("content/root.dat", ROOT),
                    ("content/dataFileList.dat", b"page1.dat\n\npage2.dat"),
                    ("content/data/page1.dat", b"p"),
                ]),
            ),
            (
                "missing",
                zip_of(&[
                    ("content/root.dat", ROOT),
                    ("content/dataFileList.dat", b"page1.dat"),
                ]),
            ),
            (
                "not-a-zip",
                b"PK\x03\x04 and then nothing a ZIP reader can follow".to_vec(),
            ),
        ];
        for (name, zip) in refusals {
            let made = rebuilt(name, &zip);
            assert!(
                matches!(made, Err(ConvertError::CorelLayout(_))),
                "{name}: {made:?}"
            );
        }
        assert!(!is_part_name(b".hidden"));
        assert!(!is_part_name(b"a/b"));
        assert!(!is_part_name(b"a\\b"));
        assert!(!is_part_name(&[b'a'; 129]));
        assert!(is_part_name(b"masterPage.dat"));
    }

    /// Each bound holds (the review of d561273): the names in the list, its
    /// length, the bytes of the parts, and the time.
    #[test]
    fn a_coreldraw_zip_is_made_again_within_its_bounds() {
        let list = |names: usize| {
            let listed: Vec<String> = (0..names).map(|i| format!("p{i}.dat")).collect();
            let mut members: Vec<(String, Vec<u8>)> = vec![
                ("content/root.dat".into(), ROOT.to_vec()),
                (
                    "content/dataFileList.dat".into(),
                    listed.join("\n").into_bytes(),
                ),
            ];
            members.extend(
                listed
                    .iter()
                    .map(|n| (format!("content/data/{n}"), b"x".to_vec())),
            );
            let borrowed: Vec<(&str, &[u8])> = members
                .iter()
                .map(|(n, b)| (n.as_str(), b.as_slice()))
                .collect();
            zip_of(&borrowed)
        };
        let within = |parts, list, bytes| Limits {
            bytes,
            parts,
            list,
            until: Instant::now() + Duration::from_secs(60),
        };

        assert!(rebuilt_within("parts-ok", &list(4), &within(4, 1024, 1 << 20)).is_ok());
        let made = rebuilt_within("parts", &list(5), &within(4, 1024, 1 << 20));
        assert!(
            matches!(made, Err(ConvertError::CorelLayout(_))),
            "{made:?}"
        );
        // Five names of six bytes and the four newlines between: 34 bytes.
        assert!(rebuilt_within("list-ok", &list(5), &within(16, 34, 1 << 20)).is_ok());
        let made = rebuilt_within("list", &list(5), &within(16, 33, 1 << 20));
        assert!(
            matches!(made, Err(ConvertError::CorelLayout(_))),
            "{made:?}"
        );
        // The root's 24 bytes and five parts of one: 29 in all.
        assert!(rebuilt_within("bytes-ok", &list(5), &within(16, 1024, 29)).is_ok());
        let made = rebuilt_within("bytes", &list(5), &within(16, 1024, 28));
        assert!(matches!(made, Err(ConvertError::TooLarge(_))), "{made:?}");
        let made = rebuilt_within("tiny", &list(1), &within(16, 1024, 11));
        assert!(matches!(made, Err(ConvertError::TooLarge(_))), "{made:?}");

        let late = Limits {
            until: Instant::now() - Duration::from_secs(1),
            ..usual()
        };
        let made = rebuilt_within("late", &a_coreldraw_zip(), &late);
        assert!(
            matches!(made, Err(ConvertError::CorelLayout(_))),
            "{made:?}"
        );
    }

    /// A file of end-of-directory records behind a ZIP's first bytes is read
    /// in one pass: asked to find where the archive starts, the reader tried
    /// each record against the whole file, and 2 MB of them took 64 s (the
    /// review of d561273).
    #[test]
    fn a_zip_full_of_directory_ends_is_turned_away_at_once() {
        /* The shape the review measured: a ZIP's first bytes, a megabyte of
        nothing, then records each claiming one entry in a 46-byte directory
        at offset 0 — which is never there, so each is looked for again. */
        let mut hostile = b"PK\x03\x04".to_vec();
        hostile.resize(1024 * 1024, 0);
        let mut end = b"PK\x05\x06".to_vec();
        end.extend_from_slice(&[0, 0, 0, 0, 1, 0, 1, 0, 46, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        while hostile.len() < 2 * 1024 * 1024 {
            hostile.extend_from_slice(&end);
        }
        let started = Instant::now();
        let made = rebuilt("directory-ends", &hostile);
        let took = started.elapsed();
        assert!(
            matches!(made, Err(ConvertError::CorelLayout(_))),
            "{made:?}"
        );
        assert!(took < Duration::from_secs(3), "{took:?}");
    }

    /// Through `to_pdf`: a ZIP is made again only under a `.cdr` name, and
    /// only one no larger than `MOST_ZIP_BYTES`. The backend is a name
    /// nothing answers to, so a refusal here is before LibreOffice.
    #[test]
    fn only_a_zip_named_cdr_and_not_too_large_is_made_again() {
        use std::io::Write;
        let backend = Backend {
            path: "no-such-soffice".into(),
            formats: FORMATS.iter().map(|f| (*f).to_string()).collect(),
        };
        let dir = std::env::temp_dir().join(format!("ul-convert-zip-name-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let convert = |source: &Path| {
            to_pdf(
                &backend,
                source,
                &dir.join("out"),
                &dir.join("profile"),
                &dir.join("in"),
                Duration::from_secs(5),
            )
        };

        let eps = dir.join("drawing.eps");
        std::fs::write(&eps, a_coreldraw_zip()).unwrap();
        let refused = convert(&eps);
        assert!(
            matches!(refused, Err(ConvertError::UnsupportedContent)),
            "{refused:?}"
        );

        let large = dir.join("large.cdr");
        let file = std::fs::File::create(&large).unwrap();
        file.set_len(MOST_ZIP_BYTES + 1).unwrap();
        drop(file);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&large)
            .unwrap()
            .write_all(b"PK\x03\x04")
            .unwrap();
        let refused = convert(&large);
        assert!(
            matches!(refused, Err(ConvertError::TooLarge(64))),
            "{refused:?}"
        );

        // Named so, and small: made again, and only then is LibreOffice
        // asked for — which here is not there.
        let cdr = dir.join("drawing.cdr");
        std::fs::write(&cdr, a_coreldraw_zip()).unwrap();
        let started = convert(&cdr);
        assert!(
            matches!(started, Err(ConvertError::Start(_))),
            "{started:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Through `to_pdf`, a ZIP that is not CorelDRAW is refused before
    /// LibreOffice: the backend here is a name nothing answers to.
    #[test]
    fn an_opendocument_wearing_a_coreldraw_name_is_refused_before_libreoffice() {
        let backend = Backend {
            path: "no-such-soffice".into(),
            formats: FORMATS.iter().map(|f| (*f).to_string()).collect(),
        };
        let dir = std::env::temp_dir().join(format!("ul-convert-odf-cdr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("drawing.cdr");
        std::fs::write(
            &source,
            zip_of(&[
                ("mimetype", b"application/vnd.oasis.opendocument.text"),
                ("content.xml", b"<x/>"),
            ]),
        )
        .unwrap();
        let refused = to_pdf(
            &backend,
            &source,
            &dir.join("out"),
            &dir.join("profile"),
            &dir.join("in"),
            Duration::from_secs(5),
        );
        assert!(
            matches!(refused, Err(ConvertError::CorelLayout(_))),
            "{refused:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /**
     * The real drawing, through a real LibreOffice: what it draws from the
     * ZIP made again is what it draws from the one CorelDRAW wrote, pixel for
     * pixel — as a PNG, which LibreOffice writes the same for the same page,
     * where a PDF carries a time (ADR 0008, measured 2026-10-12).
     *
     * The drawing is Čovik's and stays out of the repository: its path is
     * `UL_CDR_SAMPLE`. Without it, or without LibreOffice, this fails rather
     * than passing on nothing.
     */
    #[test]
    #[ignore = "needs LibreOffice and UL_CDR_SAMPLE; run with: cargo test -p ul-convert -- --ignored"]
    fn a_real_coreldraw_zip_made_again_draws_what_the_original_draws() {
        let sample = PathBuf::from(
            std::env::var_os("UL_CDR_SAMPLE")
                .expect("UL_CDR_SAMPLE names a CorelDRAW X6+ drawing (a ZIP)"),
        );
        let backend = backend().expect("LibreOffice was not found");
        let dir = std::env::temp_dir().join(format!("ul-convert-live-cdr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let original = dir.join("original.cdr");
        std::fs::copy(&sample, &original).unwrap();
        assert!(
            is_zip(&head_of(&original).unwrap()),
            "UL_CDR_SAMPLE is not a ZIP"
        );
        let again = dir.join("again.cdr");
        rebuild_coreldraw(&original, &again, &usual()).unwrap();

        let png = |source: &Path, tag: &str| -> Vec<u8> {
            let out = dir.join(format!("out-{tag}"));
            let mut args = arguments(source, &out, &dir.join(format!("profile-{tag}")));
            let to = args.iter().position(|a| a == "pdf").unwrap();
            args[to] = "png".to_string();
            let mut command = Command::new(&backend.path);
            harden(&mut command);
            let status = command
                .args(args)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "{tag}: {status}");
            let made = out.join(format!(
                "{}.png",
                source.file_stem().unwrap().to_string_lossy()
            ));
            let deadline = Instant::now() + Duration::from_secs(120);
            while !made.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(250));
            }
            std::thread::sleep(Duration::from_millis(500));
            std::fs::read(&made).unwrap_or_else(|err| panic!("{tag}: no PNG ({err})"))
        };
        let drawn = png(&original, "original");
        let redrawn = png(&again, "again");
        assert!(drawn.starts_with(b"\x89PNG"), "the original drew no PNG");
        assert!(
            drawn == redrawn,
            "the ZIP made again draws something else: {} and {} bytes",
            drawn.len(),
            redrawn.len()
        );

        // And through `to_pdf`, the way the program asks for it.
        let pdf = to_pdf(
            &backend,
            &original,
            &dir.join("out-pdf"),
            &dir.join("profile-pdf"),
            &dir.join("in"),
            Duration::from_secs(180),
        )
        .unwrap();
        assert!(std::fs::read(&pdf).unwrap().starts_with(b"%PDF"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_formats_are_the_ones_with_no_reader_of_their_own() {
        // Everything else in this program is read without an office suite, and
        // adding one here would mean a document that opens differently depending
        // on what somebody has installed.
        assert_eq!(FORMATS.len(), 4);
        for format in ["cdr", "eps", "ps", "ai"] {
            assert!(FORMATS.contains(&format), "{format}");
        }
        for format in ["odt", "ods", "docx", "xlsx", "pdf", "rtf", "doc"] {
            assert!(
                !FORMATS.contains(&format),
                "{format} has a reader of its own"
            );
        }
    }

    /* ── PostScript outside Windows (card 512) ──────────────────────────── */

    /// The first bytes of a PostScript file: plain, an `.eps`, and a DOS EPS.
    const POSTSCRIPT: [(&str, &[u8]); 3] = [
        ("plain.ps", b"%!PS\n0 0 moveto\n"),
        (
            "drawing.eps",
            b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n",
        ),
        (
            "preview.eps",
            &[0xC5, 0xD0, 0xD3, 0xC6, 30, 0, 0, 0, 0, 0, 0, 0],
        ),
    ];

    /// `to_pdf` of `bytes` named `name`, with a LibreOffice that is not there:
    /// what comes back says how far the file got.
    fn converting(name: &str, bytes: &[u8]) -> Result<PathBuf, ConvertError> {
        let dir = std::env::temp_dir().join(format!(
            "ul-convert-ps-{}-{}",
            std::process::id(),
            name.replace('.', "-")
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join(name);
        std::fs::write(&source, bytes).unwrap();
        /* Absolute, and nowhere: a bare `soffice` would be looked for on the
        PATH, and a gate that let the file through would start the real one. */
        let backend = Backend {
            path: dir
                .join("no-libreoffice-here")
                .to_string_lossy()
                .into_owned(),
            formats: Vec::new(),
        };
        let result = to_pdf(
            &backend,
            &source,
            &dir.join("out"),
            &dir.join("profile"),
            &dir.join("in"),
            Duration::from_secs(5),
        );
        // Whatever happened, no private copy is left behind.
        let left: Vec<_> = std::fs::read_dir(dir.join("in"))
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default();
        assert!(left.is_empty(), "{name}: {left:?} left after {result:?}");
        let _ = std::fs::remove_dir_all(&dir);
        result
    }

    #[test]
    fn postscript_is_known_by_its_first_bytes() {
        for (name, head) in POSTSCRIPT {
            assert!(is_postscript(head), "{name}");
        }
        assert!(!is_postscript(b"%PDF-1.4"));
        assert!(!is_postscript(b"RIFF\x10\0\0\0CDRXvrsn"));
        assert!(!is_postscript(b" %!PS"));
        assert!(!is_postscript(b""));
    }

    #[test]
    fn the_formats_offered_are_the_ones_converted_here() {
        if POSTSCRIPT_IS_CONVERTED {
            assert_eq!(formats(), &FORMATS);
        } else {
            assert_eq!(formats(), &["cdr"]);
        }
        assert_eq!(POSTSCRIPT_IS_CONVERTED, cfg!(windows));
    }

    /// Outside Windows LibreOffice would hand PostScript with no preview of its
    /// own to Ghostscript, and nothing out here can stop it: refused before it
    /// is started, by content whatever the name, while a CorelDRAW drawing
    /// still goes through to it.
    #[cfg(not(windows))]
    #[test]
    fn outside_windows_postscript_never_reaches_libreoffice() {
        for (name, bytes) in POSTSCRIPT {
            let result = converting(name, bytes);
            assert!(
                matches!(result, Err(ConvertError::PostscriptNotRun)),
                "{name}: {result:?}"
            );
        }
        let disguised = converting("drawing.cdr", POSTSCRIPT[0].1);
        assert!(
            matches!(disguised, Err(ConvertError::PostscriptNotRun)),
            "{disguised:?}"
        );
        let corel = converting("drawing.cdr", b"RIFF\x10\0\0\0CDRXvrsn");
        assert!(matches!(corel, Err(ConvertError::Start(_))), "{corel:?}");
    }

    /// On Windows LibreOffice is given no PATH its helpers are on (`harden`),
    /// measured in card 505, so PostScript still goes to it.
    /// A file the page asks for can be any size: no more than `most` is
    /// copied, and a larger one is refused with nothing left behind.
    #[test]
    fn a_file_too_large_is_refused_before_it_is_all_copied() {
        let dir = std::env::temp_dir().join(format!("ul-convert-large-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("drawing.cdr");
        std::fs::write(&source, vec![b'x'; 2048]).unwrap();

        let refused = copy_at_most(&source, &dir.join("over.cdr"), 2047);
        assert!(
            matches!(refused, Err(ConvertError::TooLarge(_))),
            "{refused:?}"
        );
        assert!(!dir.join("over.cdr").exists());

        copy_at_most(&source, &dir.join("at.cdr"), 2048).unwrap();
        assert_eq!(std::fs::read(dir.join("at.cdr")).unwrap().len(), 2048);
        const { assert!(MOST_BYTES >= 15 * 1024 * 1024) };
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A FIFO in a file's place is refused, not waited on for ever.
    #[cfg(unix)]
    #[test]
    fn a_fifo_in_a_files_place_is_refused_at_once() {
        let dir = std::env::temp_dir().join(format!("ul-convert-fifo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join("drawing.cdr");
        let made = Command::new("mkfifo").arg(&fifo).status();
        if !made.is_ok_and(|status| status.success()) {
            eprintln!("no mkfifo here; nothing to check");
            return;
        }
        let refused = copy_at_most(&fifo, &dir.join("copy.cdr"), 1024);
        assert!(
            matches!(refused, Err(ConvertError::NoSource(_))),
            "{refused:?}"
        );
        assert!(!dir.join("copy.cdr").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Nothing sends a PDF here, so LibreOffice's PDF import is not one more
    /// parser a page can feed, on any platform (the review of 0f215cf).
    #[test]
    fn a_pdf_is_never_given_to_libreoffice() {
        let result = converting("drawing.ai", b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
        assert!(
            matches!(result, Err(ConvertError::UnsupportedContent)),
            "{result:?}"
        );
    }

    /// The page can ask for one document to be converted many times at once:
    /// each conversion copies it into a directory no other one is handed, so
    /// none can write over a copy another has checked, and each takes its
    /// directory with it when it is over.
    #[test]
    fn each_conversion_has_a_copy_of_its_own() {
        let workdir = std::env::temp_dir().join(format!("ul-convert-apart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&workdir);

        let first = Staging::new(&workdir).unwrap();
        let second = Staging::new(&workdir).unwrap();
        assert_ne!(first.0, second.0);
        assert!(first.0.starts_with(&workdir) && second.0.starts_with(&workdir));
        /* Named after this run, not the process id alone, which a later run
        can be given again. */
        for staging in [&first, &second] {
            let name = staging
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let (run, next) = name.rsplit_once('-').unwrap();
            assert_eq!(run, super::run(), "{name}");
            assert!(
                run.len() > std::process::id().to_string().len() + 1,
                "{name}"
            );
            assert!(next.parse::<u64>().is_ok(), "{name}");
        }
        std::fs::write(first.0.join("drawing.cdr"), b"RIFF").unwrap();
        assert!(!second.0.join("drawing.cdr").exists());

        let gone = first.0.clone();
        drop(first);
        assert!(!gone.exists(), "a finished conversion's copy stayed");
        assert!(second.0.is_dir(), "another conversion's copy went with it");
        drop(second);
        let _ = std::fs::remove_dir_all(&workdir);
    }

    /// What a conversion could not take with it — on Windows a LibreOffice
    /// still closing the copy — the next conversion of the document clears; a
    /// copy of the layout before is cleared the same. One still running is
    /// left alone, however long its copy has taken.
    #[test]
    fn a_conversion_clears_what_earlier_ones_left_and_not_a_running_one() {
        let dir = std::env::temp_dir().join(format!("ul-convert-left-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let workdir = dir.join("in");
        std::fs::create_dir_all(workdir.join("1-0")).unwrap();
        std::fs::write(workdir.join("1-0").join("drawing.cdr"), b"RIFF").unwrap();
        std::fs::write(workdir.join("drawing.cdr"), b"RIFF").unwrap();

        let running = Staging::new(&workdir).unwrap();
        assert!(!workdir.join("1-0").exists(), "an earlier directory stayed");
        assert!(
            !workdir.join("drawing.cdr").exists(),
            "an earlier copy stayed"
        );
        std::fs::write(running.0.join("drawing.cdr"), b"RIFF").unwrap();

        // A second conversion of the same document, while the first runs.
        let source = dir.join("drawing.cdr");
        std::fs::write(&source, b"RIFF\x10\0\0\0CDRXvrsn").unwrap();
        let backend = Backend {
            path: dir
                .join("no-libreoffice-here")
                .to_string_lossy()
                .into_owned(),
            formats: Vec::new(),
        };
        let second = to_pdf(
            &backend,
            &source,
            &dir.join("out"),
            &dir.join("profile"),
            &workdir,
            Duration::from_secs(5),
        );
        assert!(matches!(second, Err(ConvertError::Start(_))), "{second:?}");
        assert!(
            running.0.join("drawing.cdr").exists(),
            "a running conversion's copy was cleared"
        );

        let gone = running.0.clone();
        drop(running);
        assert!(!gone.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_postscript_still_reaches_libreoffice() {
        for (name, bytes) in POSTSCRIPT {
            let result = converting(name, bytes);
            assert!(
                matches!(result, Err(ConvertError::Start(_))),
                "{name}: {result:?}"
            );
        }
    }
}
