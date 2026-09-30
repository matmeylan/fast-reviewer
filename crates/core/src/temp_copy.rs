//! Copies of PR files written to a temp dir so the OS can open them in their default app.
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::model::Side;

/// Characters of the commit SHA in the directory name.
const SHORT_SHA: usize = 12;

/// Extensions the OS may run rather than view: scripts, installers, launchers and link files.
/// A PR can add any file, so these are never handed to the default app.
const RUNNABLE: &[&str] = &[
    "app",
    "applescript",
    "bash",
    "bat",
    "cmd",
    "com",
    "command",
    "cpl",
    "csh",
    "deb",
    "desktop",
    "dmg",
    "exe",
    "fileloc",
    "fish",
    "hta",
    "inetloc",
    "jar",
    "js",
    "jse",
    "ksh",
    "lnk",
    "mpkg",
    "msi",
    "pif",
    "pkg",
    "ps1",
    "rpm",
    "scpt",
    "scr",
    "sh",
    "terminal",
    "tool",
    "url",
    "vbe",
    "vbs",
    "webloc",
    "workflow",
    "ws",
    "wsf",
    "zsh",
];

/// Refuse file types the OS might execute instead of opening in a viewer.
pub fn check_openable(path: &str) -> Result<()> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    match ext {
        Some(ext) if RUNNABLE.contains(&ext.as_str()) => Err(Error::Other(format!(
            "{name} could run code, so it isn't opened outside the app. View it on GitHub instead."
        ))),
        _ => Ok(()),
    }
}

/// `<root>/<owner>/<repo>/<number>/<side>-<short sha>/<file name>`. The file keeps its name and
/// extension so the OS picks the right app; the side and commit keep the old and new versions
/// (and versions from earlier pushes) apart. Only the base name of `path` is used, and every
/// component must be a plain name, so nothing can land outside `root`.
pub fn path_for(
    root: &Path,
    owner: &str,
    repo: &str,
    number: u64,
    side: Side,
    sha: &str,
    path: &str,
) -> Result<PathBuf> {
    let name = path.rsplit(['/', '\\']).next().and_then(component);
    let Some(name) = name else {
        return Err(Error::Other(format!(
            "Can't open {path}: it has no file name"
        )));
    };
    let (Some(owner), Some(repo)) = (component(owner), component(repo)) else {
        return Err(Error::Other(format!("Invalid repository {owner}/{repo}")));
    };
    let short: String = sha
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(SHORT_SHA)
        .collect();
    let side = match side {
        Side::Old => "old",
        Side::New => "new",
    };
    let version = if short.is_empty() {
        side.to_owned()
    } else {
        format!("{side}-{short}")
    };
    Ok(root
        .join(owner)
        .join(repo)
        .join(number.to_string())
        .join(version)
        .join(name))
}

/// `s` if it is a single path component that stays where it is joined: not empty, `.` or `..`,
/// and without separators or NUL.
fn component(s: &str) -> Option<&str> {
    let plain = !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\', '\0']);
    plain.then_some(s)
}

/// Write `bytes` to `target`, creating its directory. Writes a temp file and renames it, so an
/// app that has an earlier copy open never reads a half-written file.
pub async fn write(target: &Path, bytes: &[u8]) -> Result<()> {
    let fail =
        |e: std::io::Error| Error::Other(format!("Couldn't write {}: {e}", target.display()));
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
        return Err(Error::Other(format!("Couldn't write {}", target.display())));
    };
    tokio::fs::create_dir_all(dir).await.map_err(fail)?;
    let tmp = dir.join(format!(
        ".{}.tmp{}",
        name.to_string_lossy(),
        std::process::id()
    ));
    tokio::fs::write(&tmp, bytes).await.map_err(fail)?;
    if let Err(e) = tokio::fs::rename(&tmp, target).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(fail(e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    fn p(owner: &str, repo: &str, side: Side, sha: &str, path: &str) -> Result<PathBuf> {
        path_for(Path::new("/tmp/fr"), owner, repo, 7, side, sha, path)
    }

    #[test]
    fn keeps_the_file_name_under_side_and_commit() {
        assert_eq!(
            p("octo", "app", Side::New, SHA, "docs/guide.pdf").unwrap(),
            Path::new("/tmp/fr/octo/app/7/new-0123456789ab/guide.pdf")
        );
        assert_eq!(
            p("octo", "app", Side::Old, SHA, "fonts/Inter.woff2").unwrap(),
            Path::new("/tmp/fr/octo/app/7/old-0123456789ab/Inter.woff2")
        );
    }

    #[test]
    fn old_and_new_never_share_a_file() {
        let old = p("o", "r", Side::Old, SHA, "a.pdf").unwrap();
        let new = p("o", "r", Side::New, SHA, "a.pdf").unwrap();
        assert_ne!(old, new);
        // Without a usable SHA the side still keeps them apart.
        let old = p("o", "r", Side::Old, "", "a.pdf").unwrap();
        let new = p("o", "r", Side::New, "../", "a.pdf").unwrap();
        assert_eq!(old, Path::new("/tmp/fr/o/r/7/old/a.pdf"));
        assert_eq!(new, Path::new("/tmp/fr/o/r/7/new/a.pdf"));
    }

    #[test]
    fn only_the_base_name_is_used() {
        for path in [
            "../../etc/passwd",
            "a/../../passwd",
            "/abs/passwd",
            "dir\\..\\passwd",
        ] {
            let out = p("o", "r", Side::New, SHA, path).unwrap();
            assert_eq!(
                out,
                Path::new("/tmp/fr/o/r/7/new-0123456789ab/passwd"),
                "{path}"
            );
        }
        // Dots in the SHA are dropped rather than becoming `..`.
        let out = p("o", "r", Side::New, "../..", "a.png").unwrap();
        assert_eq!(out, Path::new("/tmp/fr/o/r/7/new/a.png"));
    }

    #[test]
    fn rejects_names_that_would_escape() {
        for path in ["", "dir/", "..", "a/..", "a/.", "nul\0.pdf"] {
            assert!(p("o", "r", Side::New, SHA, path).is_err(), "{path:?}");
        }
        for (owner, repo) in [
            ("..", "r"),
            ("o", ".."),
            ("o/x", "r"),
            ("", "r"),
            ("o", "a\\b"),
        ] {
            assert!(
                p(owner, repo, Side::New, SHA, "a.pdf").is_err(),
                "{owner}/{repo}"
            );
        }
    }

    #[test]
    fn refuses_runnable_files() {
        for path in [
            "x/run.command",
            "Setup.EXE",
            "a/b/launch.terminal",
            "tool.jar",
            "go.sh",
        ] {
            assert!(check_openable(path).is_err(), "{path}");
        }
        for path in [
            "docs/guide.pdf",
            "fonts/Inter.woff2",
            "Makefile",
            "archive.zip",
            "sh/notes.pdf",
        ] {
            assert!(check_openable(path).is_ok(), "{path}");
        }
    }

    #[tokio::test]
    async fn write_replaces_an_earlier_copy() {
        let dir = tempfile::tempdir().unwrap();
        let target = path_for(dir.path(), "o", "r", 1, Side::New, SHA, "docs/a.pdf").unwrap();
        write(&target, b"one").await.unwrap();
        write(&target, b"two").await.unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"two");
        // No temp files left behind.
        let names: Vec<_> = std::fs::read_dir(target.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["a.pdf"]);
    }
}
