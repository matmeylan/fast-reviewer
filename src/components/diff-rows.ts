// Pure row model for the diff viewer: split pairing, context expansion and the
// flat row list that the virtualized view renders.
import type { DiffLine, FileDiff, Hunk } from "../lib/types";

export type DiffMode = "split" | "unified";

/** Lines revealed per click on an expand control. */
export const EXPAND_STEP = 20;

/**
 * A run of unchanged lines around the hunks, in new-file line numbers.
 * Gap `i < hunks.length` sits before hunk `i`; gap `hunks.length` trails the last hunk.
 */
export interface Gap {
  /** First new line number (1-based, inclusive). */
  start: number;
  /** Exclusive end. */
  end: number;
  /** old line number = new line number + delta. */
  delta: number;
}

/** Lines revealed per gap: `top` just below the previous hunk, `bottom` just above the next one. */
export interface Expansion {
  top: number[];
  bottom: number[];
}

export type Row =
  | { t: "hunk"; gap: number; header: string; up: boolean; down: boolean; remaining: number }
  | { t: "line"; line: DiffLine }
  | { t: "pair"; left: DiffLine | null; right: DiffLine | null };

export interface RowModel {
  rows: Row[];
  /** Row index where each hunk starts (its header, or its first line when the header is gone). */
  hunkRows: number[];
  /** Longest line in columns (tabs count as 4), for horizontal scrolling. */
  maxCols: number;
  /** Largest line number, for gutter width. */
  maxLineNo: number;
}

const firstNew = (h: Hunk) => (h.newLines > 0 ? h.newStart : h.newStart + 1);
const firstOld = (h: Hunk) => (h.oldLines > 0 ? h.oldStart : h.oldStart + 1);

export function hunkHeader(h: Hunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

/** Split file text into display lines (no terminators, CRLF-aware, no phantom last line). */
export function splitTextLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 0 && l.charCodeAt(l.length - 1) === 13) lines[i] = l.slice(0, -1);
  }
  return lines;
}

/**
 * Gaps between hunks. Without `newLineCount` (new text unknown) nothing can be
 * expanded, so every gap is empty.
 */
export function computeGaps(hunks: readonly Hunk[], newLineCount: number | null): Gap[] {
  const gaps: Gap[] = [];
  let start = 1;
  let delta = 0;
  for (const h of hunks) {
    const end = firstNew(h);
    const d = firstOld(h) - end;
    gaps.push(newLineCount == null ? { start: end, end, delta: d } : { start, end: Math.max(start, end), delta: d });
    start = end + h.newLines;
    delta = firstOld(h) + h.oldLines - start;
  }
  const tailEnd = newLineCount == null ? start : Math.max(start, newLineCount + 1);
  gaps.push({ start, end: tailEnd, delta });
  return gaps;
}

export function emptyExpansion(gapCount: number): Expansion {
  return { top: new Array(gapCount).fill(0), bottom: new Array(gapCount).fill(0) };
}

/** Lines of a gap still hidden. */
export function hiddenLines(gap: Gap, exp: Expansion, i: number): number {
  return Math.max(0, gap.end - gap.start - (exp.top[i] ?? 0) - (exp.bottom[i] ?? 0));
}

/**
 * Reveal more lines of gap `i`. `up` reveals lines above the following hunk,
 * `down` lines below the preceding hunk, `all` the whole gap. Directions that
 * have no hunk on that side are redirected (the leading gap only grows up, the
 * trailing gap only down).
 */
export function expandGap(gaps: readonly Gap[], exp: Expansion, i: number, dir: "up" | "down" | "all"): Expansion {
  const gap = gaps[i];
  const hidden = gap ? hiddenLines(gap, exp, i) : 0;
  if (hidden === 0) return exp;
  const top = exp.top.slice();
  const bottom = exp.bottom.slice();
  const last = gaps.length - 1;
  if (dir === "all") {
    if (i === last) top[i] += hidden;
    else bottom[i] += hidden;
  } else if ((dir === "down" && i !== 0) || i === last) {
    top[i] += Math.min(EXPAND_STEP, hidden);
  } else {
    bottom[i] += Math.min(EXPAND_STEP, hidden);
  }
  return { top, bottom };
}

/**
 * Pair lines of a hunk for split view: context lines sit on both sides; inside
 * each contiguous change block the k-th deletion pairs with the k-th addition,
 * the longer side leaving blank filler cells.
 */
export function pairLines(lines: readonly DiffLine[], out: Row[] = []): Row[] {
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i];
    if (l.kind === "context") {
      out.push({ t: "pair", left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < n && lines[i].kind !== "context") {
      (lines[i].kind === "del" ? dels : adds).push(lines[i]);
      i++;
    }
    const m = Math.max(dels.length, adds.length);
    for (let k = 0; k < m; k++) out.push({ t: "pair", left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return out;
}

function cols(text: string): number {
  let c = text.length;
  for (let i = text.indexOf("\t"); i !== -1; i = text.indexOf("\t", i + 1)) c += 3;
  return c;
}

/** Build the flat, render-ready row list. */
export function buildRows(
  diff: FileDiff,
  mode: DiffMode,
  exp: Expansion,
  newLines: readonly string[] | null,
): RowModel {
  const hunks = diff.hunks;
  const gaps = computeGaps(hunks, newLines ? newLines.length : null);
  const rows: Row[] = [];
  const hunkRows: number[] = [];
  let maxCols = 0;
  let maxLineNo = 0;

  const pushContext = (gap: Gap, from: number, to: number) => {
    for (let no = from; no < to; no++) {
      const line: DiffLine = {
        kind: "context",
        oldNo: no + gap.delta,
        newNo: no,
        text: newLines![no - 1] ?? "",
        segments: null,
      };
      maxCols = Math.max(maxCols, cols(line.text));
      rows.push(mode === "split" ? { t: "pair", left: line, right: line } : { t: "line", line });
    }
  };

  const emitGap = (i: number, header: string) => {
    const gap = gaps[i];
    const top = exp.top[i] ?? 0;
    const bottom = exp.bottom[i] ?? 0;
    const size = gap.end - gap.start;
    const remaining = Math.max(0, size - top - bottom);
    const isLast = i === gaps.length - 1;
    pushContext(gap, gap.start, gap.start + Math.min(top, size));
    const headerRow = rows.length;
    if (remaining > 0 || (!isLast && size === 0)) {
      rows.push({
        t: "hunk",
        gap: i,
        header,
        up: remaining > 0 && !isLast,
        down: remaining > 0 && i !== 0,
        remaining,
      });
    }
    pushContext(gap, Math.max(gap.start + top, gap.end - bottom), gap.end);
    return headerRow;
  };

  hunks.forEach((h, i) => {
    const headerRow = emitGap(i, hunkHeader(h));
    hunkRows.push(rows[headerRow]?.t === "hunk" ? headerRow : rows.length);
    for (const l of h.lines) {
      maxCols = Math.max(maxCols, cols(l.text));
      maxLineNo = Math.max(maxLineNo, l.oldNo ?? 0, l.newNo ?? 0);
    }
    if (mode === "split") pairLines(h.lines, rows);
    else for (const line of h.lines) rows.push({ t: "line", line });
  });
  if (hunks.length > 0) emitGap(gaps.length - 1, "");

  const last = gaps[gaps.length - 1];
  maxLineNo = Math.max(maxLineNo, last.end - 1, last.end - 1 + last.delta);
  return { rows, hunkRows, maxCols, maxLineNo };
}
