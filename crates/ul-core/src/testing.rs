//! What the tests share: links made the way anybody can make them, and taken
//! away again.

use std::fs;
use std::path::{Path, PathBuf};

/// A link to a folder: a junction on Windows, which needs no rights, and a
/// symbolic link elsewhere.
fn link_folder(link: &Path, target: &Path) {
    #[cfg(windows)]
    {
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            made.status.success(),
            "{}",
            String::from_utf8_lossy(&made.stderr)
        );
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
}

/// A test that cannot do what it is for on this machine says so and ends —
/// except on CI (`CI` is set on GitHub's runners), which can, and where a
/// test that ended so would pass a check that never ran.
pub(crate) fn skip(why: &str) {
    assert!(
        std::env::var_os("CI").is_none(),
        "{why}: on CI the check has to run"
    );
    eprintln!("skipped: {why}");
}

/// The links a test made, taken away when it ends, passed or failed: a loop
/// left in the temporary folder waits for the next tool that follows links.
/// Taking a link away leaves what it points at.
#[derive(Default)]
pub(crate) struct Links(Vec<PathBuf>);

impl Links {
    pub(crate) fn folder(&mut self, link: &Path, target: &Path) {
        link_folder(link, target);
        self.0.push(link.to_path_buf());
    }

    /// A symbolic link to a file, and whether it could be made: on Windows it
    /// takes an administrator or Developer Mode, which an ordinary account
    /// does not have and the CI runner does.
    pub(crate) fn file(&mut self, link: &Path, target: &Path) -> bool {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(target, link).is_err() {
            return false;
        }
        self.0.push(link.to_path_buf());
        true
    }
}

impl Drop for Links {
    fn drop(&mut self) {
        for link in &self.0 {
            #[cfg(windows)]
            let _ = fs::remove_dir(link).or_else(|_| fs::remove_file(link));
            #[cfg(unix)]
            let _ = fs::remove_file(link);
        }
    }
}
