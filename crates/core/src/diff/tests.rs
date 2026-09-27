use super::*;
use crate::model::LineKind::{Add, Context, Del};

/// Render hunks as a unified diff (without file headers) for readable assertions.
fn unified(hunks: &[Hunk]) -> String {
    let mut out = String::new();
    for h in hunks {
        out += &format!(
            "@@ -{},{} +{},{} @@\n",
            h.old_start, h.old_lines, h.new_start, h.new_lines
        );
        for l in &h.lines {
            let sign = match l.kind {
                Context => ' ',
                Add => '+',
                Del => '-',
            };
            out += &format!("{sign}{}\n", l.text);
        }
    }
    out
}

/// Invariants every hunk must satisfy regardless of input.
fn check_invariants(old: &str, new: &str, hunks: &[Hunk]) {
    let old_lines: Vec<&str> = old.split_inclusive('\n').map(strip).collect();
    let new_lines: Vec<&str> = new.split_inclusive('\n').map(strip).collect();
    let mut prev_old_end = 0;
    for h in hunks {
        let olds = h.lines.iter().filter(|l| l.kind != Add).count() as u32;
        let news = h.lines.iter().filter(|l| l.kind != Del).count() as u32;
        assert_eq!(olds, h.old_lines);
        assert_eq!(news, h.new_lines);
        assert!(
            h.old_start >= prev_old_end,
            "hunks overlap or are out of order"
        );
        prev_old_end = h.old_start + h.old_lines;
        let (mut o, mut n) = (
            first_no(h.old_start, h.old_lines),
            first_no(h.new_start, h.new_lines),
        );
        for l in &h.lines {
            match l.kind {
                Context => {
                    assert_eq!((l.old_no, l.new_no), (Some(o), Some(n)));
                    assert_eq!(l.text, old_lines[o as usize - 1]);
                    assert_eq!(l.text, new_lines[n as usize - 1]);
                    o += 1;
                    n += 1;
                }
                Del => {
                    assert_eq!((l.old_no, l.new_no), (Some(o), None));
                    assert_eq!(l.text, old_lines[o as usize - 1]);
                    o += 1;
                }
                Add => {
                    assert_eq!((l.old_no, l.new_no), (None, Some(n)));
                    assert_eq!(l.text, new_lines[n as usize - 1]);
                    n += 1;
                }
            }
            if let Some(segs) = &l.segments {
                let len = l.text.encode_utf16().count() as u32;
                let mut last = 0;
                for &(s, e) in segs {
                    assert!(
                        s >= last && s < e && e <= len,
                        "bad segment {s}..{e} in {:?}",
                        l.text
                    );
                    last = e;
                }
            }
        }
    }
}

fn strip(l: &str) -> &str {
    let l = l.strip_suffix('\n').unwrap_or(l);
    l.strip_suffix('\r').unwrap_or(l)
}

fn first_no(start: u32, lines: u32) -> u32 {
    if lines == 0 {
        start + 1
    } else {
        start
    }
}

fn diff(old: &str, new: &str) -> Vec<Hunk> {
    let hunks = diff_texts(old, new, 3);
    check_invariants(old, new, &hunks);
    hunks
}

/// The substrings of `text` covered by its segments (UTF-16 slicing, as JS does).
fn highlighted(line: &DiffLine) -> Vec<String> {
    let units: Vec<u16> = line.text.encode_utf16().collect();
    line.segments
        .as_ref()
        .expect("segments")
        .iter()
        .map(|&(s, e)| String::from_utf16(&units[s as usize..e as usize]).unwrap())
        .collect()
}

fn numbered(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

#[test]
fn identical_texts_have_no_hunks() {
    assert!(diff("a\nb\n", "a\nb\n").is_empty());
    assert!(diff("", "").is_empty());
}

#[test]
fn single_line_change_with_context() {
    let old = numbered(10);
    let new = old.replace("line 5\n", "line five\n");
    assert_eq!(
        unified(&diff(&old, &new)),
        "@@ -2,7 +2,7 @@\n line 2\n line 3\n line 4\n-line 5\n+line five\n line 6\n line 7\n line 8\n"
    );
}

#[test]
fn added_file() {
    let hunks = diff("", "a\nb\n");
    assert_eq!(unified(&hunks), "@@ -0,0 +1,2 @@\n+a\n+b\n");
    assert!(hunks[0].lines.iter().all(|l| l.segments.is_none()));
}

#[test]
fn deleted_file() {
    assert_eq!(unified(&diff("a\nb\n", "")), "@@ -1,2 +0,0 @@\n-a\n-b\n");
}

#[test]
fn pure_insertion_start_points_at_preceding_line() {
    let old = numbered(10);
    let new = old.replace("line 5\n", "line 5\ninserted\n");
    let hunks = diff_texts(&old, &new, 0);
    check_invariants(&old, &new, &hunks);
    assert_eq!(unified(&hunks), "@@ -5,0 +6,1 @@\n+inserted\n");
}

#[test]
fn zero_context_deletion() {
    let old = numbered(5);
    let new = old.replace("line 3\n", "");
    let hunks = diff_texts(&old, &new, 0);
    check_invariants(&old, &new, &hunks);
    assert_eq!(unified(&hunks), "@@ -3,1 +2,0 @@\n-line 3\n");
}

#[test]
fn distant_changes_make_separate_hunks() {
    let old = numbered(30);
    let new = old
        .replace("line 3\n", "line three\n")
        .replace("line 25\n", "line xxv\n");
    let hunks = diff(&old, &new);
    assert_eq!(hunks.len(), 2);
    assert_eq!((hunks[0].old_start, hunks[0].old_lines), (1, 6));
    assert_eq!((hunks[1].old_start, hunks[1].old_lines), (22, 7));
}

#[test]
fn overlapping_context_merges_hunks() {
    let old = numbered(30);
    // 6 unchanged lines between the edits = exactly 2 * context: still one hunk.
    let new = old.replace("line 10\n", "X\n").replace("line 17\n", "Y\n");
    let hunks = diff(&old, &new);
    assert_eq!(hunks.len(), 1);
    assert_eq!((hunks[0].old_start, hunks[0].old_lines), (7, 14));
    // 7 unchanged lines between: two hunks.
    let new = old.replace("line 10\n", "X\n").replace("line 18\n", "Y\n");
    assert_eq!(diff(&old, &new).len(), 2);
}

#[test]
fn missing_trailing_newline_is_a_change() {
    let hunks = diff("a\nb", "a\nb\n");
    assert_eq!(unified(&hunks), "@@ -1,2 +1,2 @@\n a\n-b\n+b\n");
    // Same text on both sides: paired, but nothing to highlight within the line.
    assert_eq!(hunks[0].lines[1].segments, Some(vec![]));
    assert_eq!(hunks[0].lines[2].segments, Some(vec![]));
}

#[test]
fn no_trailing_newline_on_both_sides() {
    assert_eq!(
        unified(&diff("a\nb", "a\nc")),
        "@@ -1,2 +1,2 @@\n a\n-b\n+c\n"
    );
}

#[test]
fn crlf_is_stripped_from_display_text() {
    let hunks = diff("a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n");
    assert_eq!(unified(&hunks), "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
}

#[test]
fn line_ending_change_is_detected() {
    let hunks = diff("a\nb\n", "a\r\nb\n");
    assert_eq!(unified(&hunks), "@@ -1,2 +1,2 @@\n-a\n+a\n b\n");
}

#[test]
fn intra_line_word_segments() {
    let hunks = diff(
        "fn main() {\n    let total = compute(a, b);\n}\n",
        "fn main() {\n    let total = compute(a, c);\n}\n",
    );
    let lines = &hunks[0].lines;
    assert_eq!(lines[1].kind, Del);
    assert_eq!(highlighted(&lines[1]), vec!["b"]);
    assert_eq!(highlighted(&lines[2]), vec!["c"]);
    assert_eq!(lines[1].segments, Some(vec![(27, 28)]));
}

#[test]
fn adjacent_changed_words_merge() {
    let hunks = diff("const x = foo bar baz;\n", "const x = one two baz;\n");
    assert_eq!(highlighted(&hunks[0].lines[0]), vec!["foo bar"]);
    assert_eq!(highlighted(&hunks[0].lines[1]), vec!["one two"]);
}

#[test]
fn insertion_within_line_only_highlights_added_side() {
    let hunks = diff("call(a, b)\n", "call(a, b, c)\n");
    assert_eq!(hunks[0].lines[0].segments, Some(vec![]));
    assert_eq!(highlighted(&hunks[0].lines[1]), vec![", c"]);
}

#[test]
fn very_different_lines_are_not_segmented() {
    let hunks = diff(
        "import { a } from 'x';\n",
        "export default function Page() {}\n",
    );
    assert!(hunks[0].lines.iter().all(|l| l.segments.is_none()));
}

#[test]
fn mostly_changed_pair_drops_segments() {
    // Shares only `let` and punctuation: passes nothing useful to highlight.
    let hunks = diff(
        "let alpha = beta(gamma);\n",
        "let omega = delta(epsilon);\n",
    );
    assert!(hunks[0].lines.iter().all(|l| l.segments.is_none()));
}

#[test]
fn pairs_by_similarity_not_position() {
    let old = "a\nconst foo = 1;\nconst bar = 2;\nz\n";
    let new = "a\n// a brand new comment\nconst foo = 10;\nconst bar = 20;\nz\n";
    let hunks = diff(old, new);
    let lines = &hunks[0].lines;
    let texts: Vec<_> = lines
        .iter()
        .map(|l| (l.kind, l.text.as_str(), l.segments.is_some()))
        .collect();
    assert_eq!(
        texts,
        vec![
            (Context, "a", false),
            (Del, "const foo = 1;", true),
            (Del, "const bar = 2;", true),
            (Add, "// a brand new comment", false),
            (Add, "const foo = 10;", true),
            (Add, "const bar = 20;", true),
            (Context, "z", false),
        ]
    );
    assert_eq!(highlighted(&lines[4]), vec!["10"]);
}

#[test]
fn utf16_offsets_with_emoji_and_cjk() {
    let hunks = diff(
        "let s = \"🎉 你好 world\";\n",
        "let s = \"🎉 你们 world\";\n",
    );
    let (del, add) = (&hunks[0].lines[0], &hunks[0].lines[1]);
    assert_eq!(highlighted(del), vec!["好"]);
    assert_eq!(highlighted(add), vec!["们"]);
    // `let s = "` is 9 units, 🎉 is 2 (surrogate pair), then space, 你 → 好 at 13.
    assert_eq!(del.segments, Some(vec![(13, 14)]));

    let hunks = diff("msg = \"done 👍\"\n", "msg = \"done 🚀\"\n");
    assert_eq!(highlighted(&hunks[0].lines[1]), vec!["🚀"]);
    assert_eq!(hunks[0].lines[1].segments, Some(vec![(12, 14)]));
}

#[test]
fn line_numbers_across_hunks() {
    let old = numbered(40);
    let new = old
        .replace("line 5\n", "")
        .replace("line 30\n", "line 30\nextra\n");
    let hunks = diff(&old, &new);
    assert_eq!(hunks.len(), 2);
    let extra = hunks[1].lines.iter().find(|l| l.kind == Add).unwrap();
    assert_eq!(extra.new_no, Some(30));
    assert_eq!(hunks[1].new_start, 27);
}

#[test]
fn patience_aligns_on_unique_lines() {
    // Myers tends to match the lone braces; Patience anchors on the function names.
    let old = "fn a() {\n    one();\n}\n\nfn b() {\n    two();\n}\n";
    let new =
        "fn a() {\n    one();\n}\n\nfn inserted() {\n    three();\n}\n\nfn b() {\n    two();\n}\n";
    let hunks = diff(old, new);
    assert!(hunks[0].lines.iter().filter(|l| l.kind == Del).count() == 0);
    assert_eq!(hunks[0].lines.iter().filter(|l| l.kind == Add).count(), 4);
}

#[test]
fn huge_change_block_is_bounded() {
    let old: String = (0..3000)
        .map(|i| format!("value_{i} = compute({i});\n"))
        .collect();
    let new: String = (0..3000)
        .map(|i| format!("value_{i} = compute({});\n", i + 1))
        .collect();
    let hunks = diff(&old, &new);
    let segmented = hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| l.segments.is_some())
        .count();
    assert!(
        segmented > 1000,
        "greedy pairing should still pair most lines: {segmented}"
    );
}

#[test]
fn pseudo_random_edits_keep_invariants() {
    // Tiny deterministic LCG; mixes edits, inserts, deletes, CRLF and unicode.
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut rand = move |n: u64| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) % n
    };
    let words = [
        "foo", "bar", "é", "🎉", "日本", "  ", "{", "}", "x = 1;", "\r",
    ];
    for _ in 0..200 {
        let mut old = String::new();
        for _ in 0..rand(40) {
            for _ in 0..rand(5) {
                old += words[rand(words.len() as u64) as usize];
            }
            old.push('\n');
        }
        let mut new = String::new();
        for line in old.split_inclusive('\n') {
            match rand(6) {
                0 => {}
                1 => new += &format!("{}{line}", words[rand(words.len() as u64) as usize]),
                2 => new += &format!("{line}inserted\n"),
                _ => new += line,
            }
        }
        if rand(2) == 0 {
            new.pop();
        }
        for ctx in [0, 3] {
            let hunks = diff_texts(&old, &new, ctx);
            check_invariants(&old, &new, &hunks);
        }
    }
}

#[test]
fn leading_deletion_has_correct_new_start() {
    // Regression: similar's Patience reports a wrong new_index for a leading Delete op.
    let old = "\n}x\n  \n\n}\n\nx = 1;\n  foo\n";
    let new = "}\nx = 1;  \n}\ninserted\nx = 1;\n";
    let hunks = diff(old, new);
    assert_eq!((hunks[0].old_start, hunks[0].new_start), (1, 1));
}
