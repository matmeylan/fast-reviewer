//! Diff engine: line diff + intra-line (word-level) segments.
//!
//! Lines are interned to integer ids and diffed with Patience (falls back to Myers inside
//! non-unique regions), which aligns on unique lines such as function signatures and so
//! produces the most readable diffs for code. A deadline bounds pathological inputs.
use std::collections::HashMap;
use std::ops::Range;
use std::time::{Duration, Instant};

use similar::{Algorithm, DiffOp, DiffTag};

use crate::model::{DiffLine, Hunk, LineKind};

mod inline;
mod language;

pub use language::language_for_path;

/// Past this, `similar` returns a coarser (still correct) diff instead of the minimal one.
const LINE_DIFF_DEADLINE: Duration = Duration::from_millis(250);

/// Diff two texts into hunks with `context` lines of context.
/// Pairs deleted/added lines inside each change block and fills `segments` on both sides.
pub fn diff_texts(old: &str, new: &str, context: usize) -> Vec<Hunk> {
    let old_lines = split_lines(old);
    let new_lines = split_lines(new);
    let (old_ids, new_ids) = intern(&old_lines, &new_lines);
    similar::group_diff_ops(line_ops(&old_ids, &new_ids), context)
        .iter()
        .map(|group| build_hunk(group, &old_lines, &new_lines))
        .collect()
}

/// Line-level diff ops over interned ids.
///
/// Lines that occur on only one side can never match, so (like GNU diff) they are dropped
/// before diffing. This keeps rewrites and unrelated files from hitting Myers' O(N·D) worst
/// case. Ops are then rebuilt from the matched pairs, which also sidesteps `similar`'s
/// Patience reporting a wrong `new_index` on some `Delete` ops.
fn line_ops(old: &[u32], new: &[u32]) -> Vec<DiffOp> {
    let id_count = old.iter().chain(new).max().map_or(0, |m| *m as usize + 1);
    let mut in_old = vec![false; id_count];
    let mut in_new = vec![false; id_count];
    old.iter().for_each(|&id| in_old[id as usize] = true);
    new.iter().for_each(|&id| in_new[id as usize] = true);
    let old_keep: Vec<usize> = (0..old.len())
        .filter(|&i| in_new[old[i] as usize])
        .collect();
    let new_keep: Vec<usize> = (0..new.len())
        .filter(|&j| in_old[new[j] as usize])
        .collect();
    let a: Vec<u32> = old_keep.iter().map(|&i| old[i]).collect();
    let b: Vec<u32> = new_keep.iter().map(|&j| new[j]).collect();

    let deadline = Instant::now() + LINE_DIFF_DEADLINE;
    let filtered =
        similar::capture_diff_slices_deadline(Algorithm::Patience, &a, &b, Some(deadline));

    let mut ops = Vec::new();
    let (mut oi, mut ni) = (0, 0);
    for op in filtered {
        if let DiffOp::Equal {
            old_index,
            new_index,
            len,
        } = op
        {
            for k in 0..len {
                let (i, j) = (old_keep[old_index + k], new_keep[new_index + k]);
                debug_assert_eq!(old[i], new[j]);
                push_gap(&mut ops, oi..i, ni..j);
                match ops.last_mut() {
                    Some(DiffOp::Equal { len, .. }) if i == oi && j == ni => *len += 1,
                    _ => ops.push(DiffOp::Equal {
                        old_index: i,
                        new_index: j,
                        len: 1,
                    }),
                }
                (oi, ni) = (i + 1, j + 1);
            }
        }
    }
    push_gap(&mut ops, oi..old.len(), ni..new.len());
    ops
}

/// Emit the unmatched lines between two matches as a Delete, Insert or Replace.
fn push_gap(ops: &mut Vec<DiffOp>, old: Range<usize>, new: Range<usize>) {
    let (old_index, old_len, new_index, new_len) = (old.start, old.len(), new.start, new.len());
    match (old_len, new_len) {
        (0, 0) => {}
        (_, 0) => ops.push(DiffOp::Delete {
            old_index,
            old_len,
            new_index,
        }),
        (0, _) => ops.push(DiffOp::Insert {
            old_index,
            new_index,
            new_len,
        }),
        _ => ops.push(DiffOp::Replace {
            old_index,
            old_len,
            new_index,
            new_len,
        }),
    }
}

/// Heuristic: treat content as binary if it contains a NUL byte in the first 8 KiB.
pub fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

/// Lines *with* their terminators, so that a changed line ending (CRLF vs LF, or a missing
/// final newline) is still detected as a change.
fn split_lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

/// Display text: strip `\n` / `\r\n` (or a lone trailing `\r` on the last line).
fn display(line: &str) -> String {
    let line = line.strip_suffix('\n').unwrap_or(line);
    line.strip_suffix('\r').unwrap_or(line).to_owned()
}

/// Map lines to small integer ids so the diff compares `u32`s instead of strings.
fn intern<'a>(old: &[&'a str], new: &[&'a str]) -> (Vec<u32>, Vec<u32>) {
    let mut ids: HashMap<&'a str, u32> = HashMap::with_capacity(old.len() + new.len());
    let mut id_of = |line: &'a str| {
        let next = ids.len() as u32;
        *ids.entry(line).or_insert(next)
    };
    let a = old.iter().map(|l| id_of(l)).collect();
    let b = new.iter().map(|l| id_of(l)).collect();
    (a, b)
}

fn build_hunk(group: &[DiffOp], old: &[&str], new: &[&str]) -> Hunk {
    let (first, last) = (&group[0], &group[group.len() - 1]);
    let old_range = first.old_range().start..last.old_range().end;
    let new_range = first.new_range().start..last.new_range().end;

    let mut lines = Vec::with_capacity(old_range.len().max(new_range.len()) + 8);
    for op in group {
        let (tag, o, n) = op.as_tag_tuple();
        match tag {
            DiffTag::Equal => {
                for (i, j) in o.zip(n) {
                    lines.push(line(LineKind::Context, Some(i), Some(j), old[i]));
                }
            }
            DiffTag::Delete | DiffTag::Insert | DiffTag::Replace => {
                for i in o {
                    lines.push(line(LineKind::Del, Some(i), None, old[i]));
                }
                for j in n {
                    lines.push(line(LineKind::Add, None, Some(j), new[j]));
                }
            }
        }
    }
    inline::annotate(&mut lines);

    Hunk {
        old_start: hunk_start(&old_range),
        old_lines: old_range.len() as u32,
        new_start: hunk_start(&new_range),
        new_lines: new_range.len() as u32,
        lines,
    }
}

/// Unified-diff semantics: 1-based first line, or the line *after which* an empty range sits.
fn hunk_start(range: &Range<usize>) -> u32 {
    if range.is_empty() {
        range.start as u32
    } else {
        range.start as u32 + 1
    }
}

fn line(kind: LineKind, old_idx: Option<usize>, new_idx: Option<usize>, raw: &str) -> DiffLine {
    DiffLine {
        kind,
        old_no: old_idx.map(|i| i as u32 + 1),
        new_no: new_idx.map(|i| i as u32 + 1),
        text: display(raw),
        segments: None,
    }
}

#[cfg(test)]
mod tests;
