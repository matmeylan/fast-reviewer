//! `diff_texts` against `git diff -U3` on the files of the real test PR
//! (matmeylan/fast-reviewer#1, `claude/test-fixture-base...claude/test-fixture-pr`).
//!
//! `tests/fixtures/git_compare/<path with / as __>.{old,new}` hold the merge-base and head
//! contents (empty when the file is absent on that side) and `.git.diff` holds the output of
//! `git diff --no-color -U3 -M <merge-base> <head> -- <old path> <new path>`.
//! To check the live app path against git instead, run the `compare_git` example.
use std::path::{Path, PathBuf};

use fast_reviewer_core::diff::diff_texts;
use fast_reviewer_core::model::{Hunk, LineKind};

/// Hunk header plus lines, each as `(' ' | '-' | '+', text)`.
#[derive(Debug, PartialEq, Eq)]
struct UHunk {
    header: (u32, u32, u32, u32),
    lines: Vec<(char, String)>,
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/git_compare")
}

fn parse_range(s: &str) -> (u32, u32) {
    match s.split_once(',') {
        Some((a, b)) => (a.parse().unwrap(), b.parse().unwrap()),
        None => (s.parse().unwrap(), 1),
    }
}

/// Parse git's unified output. `\ No newline at end of file` markers are dropped: we show the
/// line as changed (like git) but don't render the marker.
fn parse_git(diff: &str) -> Vec<UHunk> {
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

fn ours(hunks: &[Hunk]) -> Vec<UHunk> {
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
fn assert_consistent(name: &str, hunks: &[Hunk]) {
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
const PAIRING_DIFFERS: &[&str] = &["sample__web__styles.css"];

/// Both hunk lists describe the same edit: same headers, same add/del counts per hunk, and
/// the same old side (context + deleted) and new side (context + added) text.
fn assert_equivalent(name: &str, ours: &[UHunk], git: &[UHunk]) {
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

#[test]
fn matches_git_on_fixture_pr_files() {
    let dir = fixtures();
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| {
            let name = e.unwrap().file_name().into_string().unwrap();
            name.strip_suffix(".git.diff").map(str::to_owned)
        })
        .collect();
    names.sort();
    assert!(names.len() >= 8, "fixtures missing: {names:?}");

    for name in &names {
        let read = |ext: &str| std::fs::read_to_string(dir.join(format!("{name}.{ext}"))).unwrap();
        let (old, new, git) = (read("old"), read("new"), read("git.diff"));
        let hunks = diff_texts(&old, &new, 3);
        assert_consistent(name, &hunks);
        let (ours, git) = (ours(&hunks), parse_git(&git));
        assert_equivalent(name, &ours, &git);
        if PAIRING_DIFFERS.contains(&name.as_str()) {
            assert_ne!(
                ours, git,
                "{name} now matches git exactly; drop it from PAIRING_DIFFERS"
            );
        } else {
            assert_eq!(ours, git, "{name}");
        }
    }
}

#[test]
fn git_parser_handles_markers_and_implicit_counts() {
    let git = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@ fn\n-a\n\\ No newline at end of file\n+a\n+b\n";
    assert_eq!(
        parse_git(git),
        vec![UHunk {
            header: (1, 1, 1, 2),
            lines: vec![('-', "a".into()), ('+', "a".into()), ('+', "b".into())],
        }]
    );
    // And diff_texts agrees on that case (missing final newline counts as a change).
    assert_eq!(ours(&diff_texts("a", "a\nb\n", 3)), parse_git(git));
}
