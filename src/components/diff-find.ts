// Find-in-file over the diff's row model. The rows are virtualized, so the
// browser's own find cannot see off-screen lines; matching runs on the model.
import type { DiffLine } from "../lib/types";
import type { Row } from "./diff-rows";

export interface FindOptions {
  query: string;
  caseSensitive: boolean;
}

/** Number of matches, and the current one's index (-1: none yet). */
export interface FindStatus {
  count: number;
  index: number;
}

export interface FindMatch {
  /** Row index in the row model. */
  row: number;
  line: DiffLine;
  /** [start, end) UTF-16 offsets into `line.text`. */
  start: number;
  end: number;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every non-overlapping occurrence of `query` in the rows, in reading order:
 * row by row, the old side before the new side in split view. A context line
 * shows on both sides of a split row but is one line, so it matches once.
 */
export function findMatches(rows: readonly Row[], opts: FindOptions): FindMatch[] {
  const out: FindMatch[] = [];
  if (!opts.query) return out;
  // A regex (not toLowerCase + indexOf) keeps offsets exact where lowercasing changes a string's length.
  const re = new RegExp(escapeRegExp(opts.query), opts.caseSensitive ? "g" : "gi");
  const scan = (row: number, line: DiffLine) => {
    re.lastIndex = 0;
    for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
      out.push({ row, line, start: m.index, end: m.index + m[0].length });
    }
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.t === "line") scan(i, r.line);
    else if (r.t === "pair") {
      if (r.left) scan(i, r.left);
      if (r.right && r.right !== r.left) scan(i, r.right);
    }
  }
  return out;
}

/** Same source line and offset (context lines in expanded gaps are rebuilt, so identity is not enough). */
export function sameMatch(a: FindMatch, b: FindMatch): boolean {
  return (
    a.start === b.start &&
    a.line.kind === b.line.kind &&
    a.line.oldNo === b.line.oldNo &&
    a.line.newNo === b.line.newNo
  );
}

/**
 * Index of the match to step to from `current` in direction `dir`, wrapping.
 * With no current match, start from the viewport: the first match at or below
 * row `top` going forward, the last one above row `bottom` going back.
 */
export function stepMatch(
  matches: readonly FindMatch[],
  current: number,
  dir: 1 | -1,
  top: number,
  bottom: number,
): number {
  const n = matches.length;
  if (n === 0) return -1;
  if (current >= 0 && current < n) return (current + dir + n) % n;
  if (dir > 0) {
    const i = matches.findIndex((m) => m.row >= top);
    return i < 0 ? 0 : i;
  }
  for (let i = n - 1; i >= 0; i--) if (matches[i].row < bottom) return i;
  return n - 1;
}

/** First match at or after `from` (a match of the previous query), so refining a query stays in place. */
export function matchFrom(matches: readonly FindMatch[], row: number, start: number): number {
  const i = matches.findIndex((m) => m.row > row || (m.row === row && m.start >= start));
  return i < 0 ? 0 : i;
}
