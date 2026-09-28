//! `diff_texts` against `git diff -U3` on the files of the real test PR
//! (matmeylan/fast-reviewer#1, `claude/test-fixture-base...claude/test-fixture-pr`).
//!
//! `tests/fixtures/git_compare/<path with / as __>.{old,new}` hold the merge-base and head
//! contents (empty when the file is absent on that side) and `.git.diff` holds the output of
//! `git diff --no-color -U3 -M <merge-base> <head> -- <old path> <new path>`.
//! To check the live app path against git instead, run the `compare_git` example.
mod common;

use common::{assert_matches_git, fixture_names, ours, parse_git, read_fixture, UHunk};
use fast_reviewer_core::diff::diff_texts;

#[test]
fn matches_git_on_fixture_pr_files() {
    let names = fixture_names();
    assert!(names.len() >= 8, "fixtures missing: {names:?}");
    for name in &names {
        let (old, new) = (read_fixture(name, "old"), read_fixture(name, "new"));
        assert_matches_git(
            name,
            &diff_texts(&old, &new, 3),
            &read_fixture(name, "git.diff"),
        );
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
