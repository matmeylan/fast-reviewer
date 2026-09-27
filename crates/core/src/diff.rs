//! Diff engine: line diff + intra-line (word-level) segments.
//! OWNER: diff-engine agent. Public signatures below are the contract used by the rest of the core.
use crate::model::Hunk;

/// Diff two texts into hunks with `context` lines of context.
/// Pairs deleted/added lines inside each change block and fills `segments` on both sides.
pub fn diff_texts(_old: &str, _new: &str, _context: usize) -> Vec<Hunk> {
    todo!("diff engine")
}

/// Heuristic: treat content as binary if it contains a NUL byte in the first 8 KiB.
pub fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

/// Map a file path to a Shiki language id (e.g. "typescript", "tsx", "python", "html", "css").
pub fn language_for_path(_path: &str) -> Option<&'static str> {
    None
}
