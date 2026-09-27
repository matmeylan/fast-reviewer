//! Shared by the diff integration tests: git's unified output parsed into comparable hunks,
//! and the checks that our hunks agree with it.
#![allow(dead_code)]
use std::path::{Path, PathBuf};

use fast_reviewer_core::model::{Hunk, LineKind};

/// Hunk header plus lines, each as `(' ' | '-' | '+', text)`.
#[derive(Debug, PartialEq, Eq)]
pub struct UHunk {
    pub header: (u32, u32, u32, u32),
    pub lines: Vec<(char, String)>,
}

pub fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/git_compare")
}

pub fn parse_range(s: &str) -> (u32, u32) {
    match s.split_once(',') {
        Some((a, b)) => (a.parse().unwrap(), b.parse().unwrap()),
        None => (s.parse().unwrap(), 1),
    }
}

/// Parse git's unified output. `\ No newline at end of file` markers are dropped: we show the
/// line as changed (like git) but don't render the marker.
pub fn parse_git(diff: &str) -> Vec<UHunk> {
    let mut out: Vec<UHunk> = Vec::new();
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("@@ -") {
            let (ranges, _) = rest.split_once(" @@").unwrap();
            let (old, new) = ranges.split_once(" +").unwrap();
            let (os, ol) = parse_range(old);
            let (ns, nl) = parse_range(new);
            out.push(UHunk {
                header: (os, ol, ns, nl),
                lines: Vec::new(),
            });
        } else if let Some(h) = out.last_mut() {
            let mut chars = line.chars();
            match chars.next() {
                Some(k @ (' ' | '-' | '+')) => h.lines.push((k, chars.as_str().to_owned())),
                Some('\\') => {}
                _ => panic!("unexpected diff line {line:?}"),
            }
        }
    }
    out
}

pub fn ours(hunks: &[Hunk]) -> Vec<UHunk> {
    hunks
        .iter()
        .map(|h| UHunk {
            header: (h.old_start, h.old_lines, h.new_start, h.new_lines),
            lines: h
                .lines
                .iter()
                .map(|l| {
                    let k = match l.kind {
                        LineKind::Context => ' ',
                        LineKind::Del => '-',
                        LineKind::Add => '+',
                    };
                    (k, l.text.clone())
                })
                .collect(),
        })
        .collect()
}

/// Line numbers inside each hunk must follow from the header and the line kinds.
pub fn assert_consistent(name: &str, hunks: &[Hunk]) {
    for h in hunks {
        let (mut o, mut n) = (h.old_start.max(1), h.new_start.max(1));
        let (mut dels, mut adds) = (0, 0);
        for l in &h.lines {
            match l.kind {
                LineKind::Context => {
                    assert_eq!((l.old_no, l.new_no), (Some(o), Some(n)), "{name}");
                    o += 1;
                    n += 1;
                    dels += 1;
                    adds += 1;
                }
                LineKind::Del => {
                    assert_eq!((l.old_no, l.new_no), (Some(o), None), "{name}");
                    o += 1;
                    dels += 1;
                }
                LineKind::Add => {
                    assert_eq!((l.old_no, l.new_no), (None, Some(n)), "{name}");
                    n += 1;
                    adds += 1;
                }
            }
        }
        assert_eq!(
            (dels, adds),
            (h.old_lines, h.new_lines),
            "{name}: header counts"
        );
    }
}

/// Files where we pair lines differently from git, with both diffs equally valid and minimal.
/// `styles.css`: git keeps the *last* `}` as context, we keep the first (Patience matches the
/// first unique-ish anchor); headers and add/del counts are identical.
pub const PAIRING_DIFFERS: &[&str] = &["sample__web__styles.css"];

/// Both hunk lists describe the same edit: same headers, same add/del counts per hunk, and
/// the same old side (context + deleted) and new side (context + added) text.
pub fn assert_equivalent(name: &str, ours: &[UHunk], git: &[UHunk]) {
    assert_eq!(ours.len(), git.len(), "{name}: hunk count");
    for (a, b) in ours.iter().zip(git) {
        assert_eq!(a.header, b.header, "{name}: hunk header");
        let side = |h: &UHunk, skip: char| -> Vec<String> {
            h.lines
                .iter()
                .filter(|(k, _)| *k != skip)
                .map(|(_, t)| t.clone())
                .collect()
        };
        let count = |h: &UHunk, k: char| h.lines.iter().filter(|(x, _)| *x == k).count();
        assert_eq!(side(a, '+'), side(b, '+'), "{name}: old side");
        assert_eq!(side(a, '-'), side(b, '-'), "{name}: new side");
        assert_eq!(
            (count(a, '-'), count(a, '+')),
            (count(b, '-'), count(b, '+')),
            "{name}: edit size"
        );
    }
}

/// Fixture names (`<path with / as __>`), sorted.
pub fn fixture_names() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(fixtures())
        .unwrap()
        .filter_map(|e| {
            let name = e.unwrap().file_name().into_string().unwrap();
            name.strip_suffix(".git.diff").map(str::to_owned)
        })
        .collect();
    names.sort();
    names
}

/// A fixture file: `old`, `new` or `git.diff`.
pub fn read_fixture(name: &str, ext: &str) -> String {
    std::fs::read_to_string(fixtures().join(format!("{name}.{ext}"))).unwrap()
}

/// Our hunks match git's: exactly, or (for `PAIRING_DIFFERS`) as the same edit.
pub fn assert_matches_git(name: &str, hunks: &[Hunk], git_diff: &str) {
    assert_consistent(name, hunks);
    let (ours, git) = (ours(hunks), parse_git(git_diff));
    assert_equivalent(name, &ours, &git);
    if PAIRING_DIFFERS.contains(&name) {
        assert_ne!(
            ours, git,
            "{name} now matches git exactly; drop it from PAIRING_DIFFERS"
        );
    } else {
        assert_eq!(ours, git, "{name}");
    }
}
