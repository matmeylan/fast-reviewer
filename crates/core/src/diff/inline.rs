//! Intra-line highlighting: pair deleted/added lines inside a change block and compute
//! word-level changed ranges (UTF-16 offsets) for each pair.
use std::ops::Range;

use similar::{Algorithm, DiffTag};

use crate::model::{DiffLine, LineKind};

/// Minimum similarity (weighted token Dice coefficient) for two lines to be paired.
const PAIR_THRESHOLD: f32 = 0.5;
/// Above this changed fraction, whole-line tint reads better than word highlights.
const MAX_CHANGED_FRACTION: f32 = 0.7;
/// Blocks up to this many del×add candidates get optimal (DP) pairing; larger ones greedy.
const DP_MAX_CELLS: usize = 64 * 64;
/// How far ahead greedy pairing looks for a partner.
const GREEDY_WINDOW: usize = 16;
/// Lines with more tokens than this skip word diffing (minified code etc.).
const MAX_TOKENS: usize = 2000;

/// Fill `segments` for every paired Del/Add line in `lines` (one hunk, in display order).
pub(super) fn annotate(lines: &mut [DiffLine]) {
    let mut i = 0;
    while i < lines.len() {
        if lines[i].kind != LineKind::Del {
            i += 1;
            continue;
        }
        let del_start = i;
        while i < lines.len() && lines[i].kind == LineKind::Del {
            i += 1;
        }
        let add_start = i;
        while i < lines.len() && lines[i].kind == LineKind::Add {
            i += 1;
        }
        if add_start < i {
            annotate_block(lines, del_start..add_start, add_start..i);
        }
    }
}

struct LineInfo<'a> {
    tokens: Vec<&'a str>,
    /// Sorted `(hash, len)` of non-whitespace tokens: a multiset signature for similarity.
    sig: Vec<(u64, u32)>,
    weight: u32,
}

impl<'a> LineInfo<'a> {
    fn new(text: &'a str) -> Self {
        let tokens = tokenize(text);
        let mut sig: Vec<(u64, u32)> = tokens
            .iter()
            .filter(|t| !is_space(t))
            .map(|t| (fx_hash(t.as_bytes()), t.chars().count() as u32))
            .collect();
        sig.sort_unstable();
        let weight = sig.iter().map(|s| s.1).sum();
        LineInfo {
            tokens,
            sig,
            weight,
        }
    }

    fn similarity(&self, other: &LineInfo) -> f32 {
        let total = self.weight + other.weight;
        if total == 0 {
            return 1.0;
        }
        let (a, b) = (&self.sig, &other.sig);
        let (mut i, mut j, mut common) = (0, 0, 0u32);
        while i < a.len() && j < b.len() {
            match a[i].0.cmp(&b[j].0) {
                std::cmp::Ordering::Less => i += 1,
                std::cmp::Ordering::Greater => j += 1,
                std::cmp::Ordering::Equal => {
                    common += a[i].1;
                    i += 1;
                    j += 1;
                }
            }
        }
        2.0 * common as f32 / total as f32
    }
}

fn annotate_block(lines: &mut [DiffLine], dels: Range<usize>, adds: Range<usize>) {
    let results = {
        let del_info: Vec<LineInfo> = lines[dels.clone()]
            .iter()
            .map(|l| LineInfo::new(&l.text))
            .collect();
        let add_info: Vec<LineInfo> = lines[adds.clone()]
            .iter()
            .map(|l| LineInfo::new(&l.text))
            .collect();
        let pairs = if del_info.len() * add_info.len() <= DP_MAX_CELLS {
            pair_optimal(&del_info, &add_info)
        } else {
            pair_greedy(&del_info, &add_info)
        };
        pairs
            .into_iter()
            .map(|(d, a)| {
                let segs = word_segments(
                    &lines[dels.start + d].text,
                    &del_info[d],
                    &lines[adds.start + a].text,
                    &add_info[a],
                );
                (d, a, segs)
            })
            .collect::<Vec<_>>()
    };
    for (d, a, segs) in results {
        if let Some((old, new)) = segs {
            lines[dels.start + d].segments = Some(old);
            lines[adds.start + a].segments = Some(new);
        }
    }
}

/// Order-preserving pairing maximizing total similarity (LCS-style DP). O(D·A).
fn pair_optimal(dels: &[LineInfo], adds: &[LineInfo]) -> Vec<(usize, usize)> {
    let (n, m) = (dels.len(), adds.len());
    let w = m + 1;
    let mut score = vec![0f32; (n + 1) * w];
    let mut sim = vec![0f32; n * m];
    for i in 0..n {
        for j in 0..m {
            let s = dels[i].similarity(&adds[j]);
            sim[i * m + j] = s;
            let diag = if s >= PAIR_THRESHOLD {
                score[i * w + j] + s
            } else {
                f32::MIN
            };
            let up = score[i * w + j + 1];
            let left = score[(i + 1) * w + j];
            score[(i + 1) * w + j + 1] = diag.max(up).max(left);
        }
    }
    let mut pairs = Vec::new();
    let (mut i, mut j) = (n, m);
    while i > 0 && j > 0 {
        let s = sim[(i - 1) * m + j - 1];
        let cur = score[i * w + j];
        if s >= PAIR_THRESHOLD && cur == score[(i - 1) * w + j - 1] + s {
            pairs.push((i - 1, j - 1));
            i -= 1;
            j -= 1;
        } else if cur == score[(i - 1) * w + j] {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    pairs.reverse();
    pairs
}

/// Bounded pairing for huge blocks: each deletion looks at the next few unpaired additions.
fn pair_greedy(dels: &[LineInfo], adds: &[LineInfo]) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    let mut cursor = 0;
    for (d, del) in dels.iter().enumerate() {
        if cursor >= adds.len() {
            break;
        }
        let end = (cursor + GREEDY_WINDOW).min(adds.len());
        let best = (cursor..end)
            .map(|a| (a, del.similarity(&adds[a])))
            .filter(|&(_, s)| s >= PAIR_THRESHOLD)
            .max_by(|x, y| x.1.total_cmp(&y.1).then(y.0.cmp(&x.0)));
        if let Some((a, _)) = best {
            pairs.push((d, a));
            cursor = a + 1;
        }
    }
    pairs
}

type Segments = Vec<(u32, u32)>;

/// Word-level changed ranges for a paired line, or `None` if the lines are too different.
fn word_segments(
    old_text: &str,
    old: &LineInfo,
    new_text: &str,
    new: &LineInfo,
) -> Option<(Segments, Segments)> {
    if old.tokens.len() > MAX_TOKENS || new.tokens.len() > MAX_TOKENS {
        return None;
    }
    let ops = similar::capture_diff_slices(Algorithm::Myers, &old.tokens, &new.tokens);
    let old_offsets = offsets(&old.tokens);
    let new_offsets = offsets(&new.tokens);
    let mut old_ranges = Vec::new();
    let mut new_ranges = Vec::new();
    for op in &ops {
        let (tag, o, n) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            continue;
        }
        if !o.is_empty() {
            old_ranges.push(old_offsets[o.start]..old_offsets[o.end]);
        }
        if !n.is_empty() {
            new_ranges.push(new_offsets[n.start]..new_offsets[n.end]);
        }
    }
    let changed = changed_weight(old_text, &old_ranges) + changed_weight(new_text, &new_ranges);
    let total = old.weight + new.weight;
    if total > 0 && changed as f32 / total as f32 > MAX_CHANGED_FRACTION {
        return None;
    }
    Some((
        to_utf16(old_text, &merge(old_text, old_ranges)),
        to_utf16(new_text, &merge(new_text, new_ranges)),
    ))
}

/// Byte offset of each token start, plus the end of the line.
fn offsets(tokens: &[&str]) -> Vec<usize> {
    let mut out = Vec::with_capacity(tokens.len() + 1);
    let mut pos = 0;
    out.push(0);
    for t in tokens {
        pos += t.len();
        out.push(pos);
    }
    out
}

/// Non-whitespace chars covered by `ranges`.
fn changed_weight(text: &str, ranges: &[Range<usize>]) -> u32 {
    ranges
        .iter()
        .map(|r| {
            text[r.clone()]
                .chars()
                .filter(|c| !c.is_whitespace())
                .count() as u32
        })
        .sum()
}

/// Merge ranges that touch or are separated only by whitespace.
fn merge(text: &str, ranges: Vec<Range<usize>>) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::with_capacity(ranges.len());
    for r in ranges {
        if let Some(last) = out.last_mut() {
            if text[last.end..r.start].chars().all(char::is_whitespace) {
                last.end = r.end;
                continue;
            }
        }
        out.push(r);
    }
    out
}

/// Convert sorted, non-overlapping byte ranges to UTF-16 code unit ranges.
fn to_utf16(text: &str, ranges: &[Range<usize>]) -> Segments {
    if text.is_ascii() {
        return ranges
            .iter()
            .map(|r| (r.start as u32, r.end as u32))
            .collect();
    }
    let mut out = Vec::with_capacity(ranges.len());
    let (mut byte, mut unit) = (0usize, 0u32);
    let mut chars = text.chars();
    let mut advance_to = |target: usize| {
        while byte < target {
            let c = chars.next().expect("range within text");
            byte += c.len_utf8();
            unit += c.len_utf16() as u32;
        }
        unit
    };
    for r in ranges {
        let start = advance_to(r.start);
        let end = advance_to(r.end);
        out.push((start, end));
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
    Word,
    Space,
    Single,
}

fn class_of(c: char) -> Class {
    if c.is_whitespace() {
        Class::Space
    } else if c == '_' || c.is_ascii_alphanumeric() || (c.is_alphanumeric() && !is_cjk(c)) {
        Class::Word
    } else {
        Class::Single
    }
}

/// CJK scripts have no word separators, so each ideograph/kana/hangul syllable is a token.
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x2E80..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF | 0x20000..=0x3FFFF)
}

/// Split into identifiers/words, whitespace runs and single other characters.
/// Tokens are contiguous and cover the whole line.
pub(super) fn tokenize(s: &str) -> Vec<&str> {
    let mut out = Vec::with_capacity(s.len() / 3 + 1);
    let mut iter = s.char_indices().peekable();
    while let Some((start, c)) = iter.next() {
        let class = class_of(c);
        let mut end = start + c.len_utf8();
        if class != Class::Single {
            while let Some(&(i, c2)) = iter.peek() {
                if class_of(c2) != class {
                    break;
                }
                end = i + c2.len_utf8();
                iter.next();
            }
        }
        out.push(&s[start..end]);
    }
    out
}

fn is_space(t: &str) -> bool {
    t.starts_with(char::is_whitespace)
}

/// FxHash: fast, non-cryptographic; collisions only affect the pairing heuristic.
fn fx_hash(bytes: &[u8]) -> u64 {
    const K: u64 = 0x517c_c1b7_2722_0a95;
    let mut h = 0u64;
    for chunk in bytes.chunks(8) {
        let mut buf = [0u8; 8];
        buf[..chunk.len()].copy_from_slice(chunk);
        h = (h.rotate_left(5) ^ u64::from_le_bytes(buf)).wrapping_mul(K);
    }
    h ^ bytes.len() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_covers_line() {
        let s = "  let fooBar_1 = x.y(\"日本\") 🎉;";
        let toks = tokenize(s);
        assert_eq!(toks.concat(), s);
        assert_eq!(
            toks,
            vec![
                "  ", "let", " ", "fooBar_1", " ", "=", " ", "x", ".", "y", "(", "\"", "日", "本",
                "\"", ")", " ", "🎉", ";"
            ]
        );
    }

    #[test]
    fn utf16_offsets() {
        // "é" is 2 bytes / 1 unit, "🎉" is 4 bytes / 2 units.
        let s = "é🎉ab";
        assert_eq!(
            to_utf16(s, &[0..2, 2..6, 6..8]),
            vec![(0, 1), (1, 3), (3, 5)]
        );
        assert_eq!(to_utf16("abc", &[1..2, 2..3]), vec![(1, 2), (2, 3)]);
    }

    #[test]
    fn merge_across_whitespace_only() {
        let t = "a b, c";
        assert_eq!(merge(t, vec![0..1, 2..3, 5..6]), vec![0..3, 5..6]);
    }

    #[test]
    fn similarity_bounds() {
        let a = LineInfo::new("return foo(bar);");
        let b = LineInfo::new("return foo(baz);");
        let c = LineInfo::new("}");
        assert!(a.similarity(&b) > 0.7);
        assert!(a.similarity(&c) < PAIR_THRESHOLD);
        assert_eq!(a.similarity(&a), 1.0);
    }

    #[test]
    fn optimal_pairing_skips_unrelated_lines() {
        let dels: Vec<_> = ["let a = 1;", "let b = 2;"]
            .iter()
            .map(|s| LineInfo::new(s))
            .collect();
        let adds: Vec<_> = ["// new comment here", "let a = 10;", "let b = 20;"]
            .iter()
            .map(|s| LineInfo::new(s))
            .collect();
        assert_eq!(pair_optimal(&dels, &adds), vec![(0, 1), (1, 2)]);
        assert_eq!(pair_greedy(&dels, &adds), vec![(0, 1), (1, 2)]);
    }
}
