//! Virtualni datotečni sustav sa sandboxom po korijenu radnog prostora.
//!
//! Korisnik otvara mapu; sve nakon toga mora ostati unutar nje. Bez te
//! provjere svaki bug u UI-u — ili plugin treće strane — postaje čitanje
//! proizvoljne datoteke s diska.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use ul_formats::{detect, detect_by_name, Detection, PROBE_LEN};

#[derive(Debug, Error)]
pub enum VfsError {
    #[error("putanja izlazi izvan radnog prostora: {0}")]
    OutsideWorkspace(String),
    #[error("nije otvoren nijedan radni prostor")]
    NoWorkspace,
    #[error("nije direktorij: {0}")]
    NotADirectory(String),
    #[error("greška datotečnog sustava: {0}")]
    Io(#[from] io::Error),
}

impl Serialize for VfsError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub uri: String,
    pub name: String,
    pub parent: Option<String>,
    /// `"file"` ili `"directory"` — usklađeno s `FileStat` u plugin-sdk-u.
    pub kind: String,
    pub size: u64,
    /// Unix ms, `None` kad ga platforma ne daje.
    pub modified: Option<u64>,
    pub readonly: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    #[serde(flatten)]
    pub stat: Stat,
    pub detection: Detection,
}

/// Direktoriji koji nikad ne zaslužuju mjesto u stablu.
const NOISE: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    ".next",
    ".turbo",
    ".venv",
];

/// Direktorij koji se nikad ne obilazi — ni u stablu ni u pretrazi.
pub(crate) fn is_noise(name: &str) -> bool {
    NOISE.contains(&name)
}

#[derive(Debug, Default)]
pub struct Workspace {
    roots: Vec<PathBuf>,
}

impl Workspace {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    pub fn add_root(&mut self, path: impl AsRef<Path>) -> Result<PathBuf, VfsError> {
        let canonical = fs::canonicalize(path.as_ref())?;
        if !canonical.is_dir() {
            return Err(VfsError::NotADirectory(display(&canonical)));
        }
        if !self.roots.contains(&canonical) {
            self.roots.push(canonical.clone());
        }
        Ok(canonical)
    }

    /// Razrješava putanju i provjerava da ostaje unutar nekog korijena.
    ///
    /// Ne oslanja se na `canonicalize` za nepostojeće datoteke (spremanje pod
    /// novim imenom), pa se `..` uklanja leksički prije provjere.
    pub fn resolve(&self, path: impl AsRef<Path>) -> Result<PathBuf, VfsError> {
        if self.roots.is_empty() {
            return Err(VfsError::NoWorkspace);
        }

        let normalized = normalize(path.as_ref());

        // Simbolički link može voditi van; za postojeće putanje provjeravamo i stvarnu.
        let effective = fs::canonicalize(&normalized).unwrap_or_else(|_| normalized.clone());

        if self.roots.iter().any(|root| effective.starts_with(root)) {
            Ok(effective)
        } else {
            Err(VfsError::OutsideWorkspace(display(&normalized)))
        }
    }

    pub fn stat(&self, path: impl AsRef<Path>) -> Result<Stat, VfsError> {
        let resolved = self.resolve(path)?;
        stat_of(&resolved)
    }

    pub fn read_dir(&self, path: impl AsRef<Path>) -> Result<Vec<DirEntry>, VfsError> {
        let resolved = self.resolve(path)?;
        if !resolved.is_dir() {
            return Err(VfsError::NotADirectory(display(&resolved)));
        }

        let mut entries = Vec::new();
        for entry in fs::read_dir(&resolved)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

            if is_noise(&name) {
                continue;
            }
            if is_dir && name.starts_with('.') {
                continue;
            }

            let stat = stat_of(&entry.path())?;
            let detection = if is_dir {
                detect_by_name("")
            } else {
                detect_by_name(&name)
            };
            entries.push(DirEntry { stat, detection });
        }

        // Direktoriji prvi, zatim abecedno — bez toga je stablo nečitljivo.
        entries.sort_by(|a, b| {
            let dir_a = a.stat.kind == "directory";
            let dir_b = b.stat.kind == "directory";
            dir_b
                .cmp(&dir_a)
                .then_with(|| a.stat.name.to_lowercase().cmp(&b.stat.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub fn read(&self, path: impl AsRef<Path>) -> Result<Vec<u8>, VfsError> {
        let resolved = self.resolve(path)?;
        Ok(fs::read(resolved)?)
    }

    /// Čita samo početak datoteke — dovoljno za detekciju formata bez
    /// učitavanja stostraničnog PDF-a u memoriju.
    pub fn detect_at(&self, path: impl AsRef<Path>) -> Result<Detection, VfsError> {
        use std::io::Read;

        let resolved = self.resolve(path)?;
        let name = resolved
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        let mut file = fs::File::open(&resolved)?;
        let mut probe = vec![0u8; PROBE_LEN];
        let read = file.read(&mut probe)?;
        probe.truncate(read);

        Ok(detect(&name, &probe))
    }

    /// Piše atomarno: prvo u susjednu privremenu datoteku, pa preimenovanje.
    /// Prekid struje usred spremanja tako ne ostavlja krnji dokument.
    pub fn write(&self, path: impl AsRef<Path>, data: &[u8]) -> Result<(), VfsError> {
        let resolved = self.resolve(path)?;
        let temp = resolved.with_extension(format!(
            "{}.ultmp",
            resolved
                .extension()
                .map(|e| e.to_string_lossy().into_owned())
                .unwrap_or_default()
        ));

        fs::write(&temp, data)?;
        if let Err(err) = fs::rename(&temp, &resolved) {
            let _ = fs::remove_file(&temp);
            return Err(err.into());
        }
        Ok(())
    }
}

/* ── pomoćno ─────────────────────────────────────────────────────────── */

/// Putanja kakvu vidi korisnik.
///
/// `fs::canonicalize` na Windowsu vraća verbatim oblik (`\\?\C:\...`), koji je
/// detalj Win32 API-ja i nema što raditi u naslovu kartice ni u rezultatu
/// pretrage. `resolve` ga svejedno vraća kad zatreba, pa je skidanje na
/// granici prema UI-u sigurno.
pub(crate) fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned(),
    }
}

/// Leksička normalizacija: uklanja `.` i razrješava `..` bez diranja diska.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub(crate) fn stat_of(path: &Path) -> Result<Stat, VfsError> {
    let meta = fs::metadata(path)?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    Ok(Stat {
        uri: display(path),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        parent: path.parent().map(display),
        kind: if meta.is_dir() {
            "directory".into()
        } else {
            "file".into()
        },
        size: meta.len(),
        modified,
        readonly: meta.permissions().readonly(),
    })
}

/* ── testovi ─────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_resolves_parent_segments() {
        assert_eq!(normalize(Path::new("a/b/../c")), PathBuf::from("a/c"));
        assert_eq!(normalize(Path::new("./a/./b")), PathBuf::from("a/b"));
    }

    #[test]
    fn resolve_without_workspace_fails() {
        let workspace = Workspace::new();
        assert!(matches!(
            workspace.resolve("bilo/sto"),
            Err(VfsError::NoWorkspace)
        ));
    }

    #[test]
    fn escape_attempt_is_rejected() {
        let mut workspace = Workspace::new();
        let dir = std::env::temp_dir();
        workspace.add_root(&dir).expect("temp mora postojati");

        // Klasični pokušaj bijega iz sandboxa.
        let escaped = dir.join("..").join("..").join("etc").join("passwd");
        assert!(matches!(
            workspace.resolve(escaped),
            Err(VfsError::OutsideWorkspace(_))
        ));
    }

    #[test]
    fn root_itself_resolves() {
        let mut workspace = Workspace::new();
        let dir = std::env::temp_dir();
        let root = workspace.add_root(&dir).expect("temp mora postojati");
        assert!(workspace.resolve(&root).is_ok());
    }

    #[test]
    fn read_dir_skips_noise() {
        assert!(NOISE.contains(&"node_modules"));
        assert!(NOISE.contains(&".git"));
    }
}
