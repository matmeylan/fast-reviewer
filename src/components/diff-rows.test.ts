import { describe, expect, it } from "vitest";
import type { DiffLine, FileDiff, Hunk } from "../lib/types";
import {
  buildRows,
  computeGaps,
  emptyExpansion,
  expandGap,
  hiddenLines,
  pairLines,
  splitTextLines,
  type Row,
} from "./diff-rows";

const ctx = (o: number, n: number, text = `l${n}`): DiffLine => ({ kind: "context", oldNo: o, newNo: n, text, segments: null });
const del = (o: number, text = `old${o}`): DiffLine => ({ kind: "del", oldNo: o, newNo: null, text, segments: null });
const add = (n: number, text = `new${n}`): DiffLine => ({ kind: "add", oldNo: null, newNo: n, text, segments: null });

const pairsOf = (rows: Row[]) =>
  rows.map((r) => (r.t === "pair" ? [r.left?.text ?? null, r.right?.text ?? null] : r.t));

function fileDiff(hunks: Hunk[], newText: string | null, extra: Partial<FileDiff> = {}): FileDiff {
  return { path: "a.ts", oldPath: null, language: "typescript", binary: false, tooLarge: false, hunks, oldText: null, newText, ...extra };
}

describe("pairLines", () => {
  it("pairs deletions with additions inside a change block, with fillers", () => {
    const rows = pairLines([ctx(1, 1, "c"), del(2, "d1"), del(3, "d2"), del(4, "d3"), add(2, "a1"), ctx(5, 3, "c2"), add(4, "a2")]);
    expect(pairsOf(rows)).toEqual([
      ["c", "c"],
      ["d1", "a1"],
      ["d2", null],
      ["d3", null],
      ["c2", "c2"],
      [null, "a2"],
    ]);
  });

  it("treats interleaved del/add runs as one block", () => {
    const rows = pairLines([del(1, "d1"), add(1, "a1"), del(2, "d2"), add(2, "a2"), add(3, "a3")]);
    expect(pairsOf(rows)).toEqual([
      ["d1", "a1"],
      ["d2", "a2"],
      [null, "a3"],
    ]);
  });

  it("shares the same object on both sides for context lines", () => {
    const c = ctx(1, 1);
    const [r] = pairLines([c]);
    expect(r).toEqual({ t: "pair", left: c, right: c });
  });
});

describe("splitTextLines", () => {
  it("drops the terminator and strips CR", () => {
    expect(splitTextLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitTextLines("a\nb")).toEqual(["a", "b"]);
    expect(splitTextLines("")).toEqual([]);
  });
});

// new file: 100 lines; old file had one extra line before line 50.
// hunk A: old 8..14 / new 8..13 (a deletion at old 11); hunk B: old 48..54 / new 47..54 (an insertion at new 50)
const hunkA: Hunk = {
  oldStart: 8, oldLines: 7, newStart: 8, newLines: 6,
  lines: [ctx(8, 8), ctx(9, 9), ctx(10, 10), del(11), ctx(12, 11), ctx(13, 12), ctx(14, 13)],
};
const hunkB: Hunk = {
  oldStart: 48, oldLines: 6, newStart: 47, newLines: 7,
  lines: [ctx(48, 47), ctx(49, 48), ctx(50, 49), add(50), ctx(51, 51), ctx(52, 52), ctx(53, 53)],
};
const newText = Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join("\n") + "\n";

describe("context expansion math", () => {
  it("computes gaps and old/new deltas", () => {
    const gaps = computeGaps([hunkA, hunkB], 100);
    expect(gaps).toEqual([
      { start: 1, end: 8, delta: 0 },
      { start: 14, end: 47, delta: 1 },
      { start: 54, end: 101, delta: 0 },
    ]);
  });

  it("has only empty gaps when the new text is unknown", () => {
    const gaps = computeGaps([hunkA, hunkB], null);
    expect(gaps.every((g) => g.end === g.start)).toBe(true);
  });

  it("handles empty-range hunks (unified-diff start convention)", () => {
    // pure deletion after new line 5: newStart=5, newLines=0
    const h: Hunk = { oldStart: 6, oldLines: 1, newStart: 5, newLines: 0, lines: [del(6)] };
    expect(computeGaps([h], 10)).toEqual([
      { start: 1, end: 6, delta: 0 },
      { start: 6, end: 11, delta: 1 },
    ]);
  });

  it("expands in steps of 20 and redirects directions at the edges", () => {
    const gaps = computeGaps([hunkA, hunkB], 100);
    let exp = emptyExpansion(gaps.length);
    exp = expandGap(gaps, exp, 1, "down");
    expect(exp.top[1]).toBe(20);
    expect(hiddenLines(gaps[1], exp, 1)).toBe(13);
    exp = expandGap(gaps, exp, 1, "up");
    expect(exp.bottom[1]).toBe(13);
    expect(hiddenLines(gaps[1], exp, 1)).toBe(0);
    expect(expandGap(gaps, exp, 1, "up")).toBe(exp);
    // Leading gap only grows upwards; trailing gap only downwards.
    exp = expandGap(gaps, exp, 0, "down");
    expect([exp.top[0], exp.bottom[0]]).toEqual([0, 7]);
    exp = expandGap(gaps, exp, 2, "up");
    expect([exp.top[2], exp.bottom[2]]).toEqual([20, 0]);
    exp = expandGap(gaps, exp, 2, "all");
    expect(hiddenLines(gaps[2], exp, 2)).toBe(0);
  });
});

describe("buildRows", () => {
  const diff = fileDiff([hunkA, hunkB], newText);
  const lines = splitTextLines(newText);

  it("emits a header per hunk plus a trailing expander (unified)", () => {
    const m = buildRows(diff, "unified", emptyExpansion(3), lines);
    const kinds = m.rows.map((r) => r.t);
    expect(kinds.filter((k) => k === "hunk").length).toBe(3);
    expect(m.rows[0]).toMatchObject({ t: "hunk", gap: 0, header: "@@ -8,7 +8,6 @@", up: true, down: false, remaining: 7 });
    expect(m.rows[m.rows.length - 1]).toMatchObject({ t: "hunk", gap: 2, up: false, down: true, remaining: 47 });
    expect(m.hunkRows).toEqual([0, 8]);
    expect(m.rows.length).toBe(1 + 7 + 1 + 7 + 1);
    expect(m.maxLineNo).toBe(100);
  });

  it("inserts expanded context with correct old numbers from the new text", () => {
    const gaps = computeGaps(diff.hunks, lines.length);
    let exp = expandGap(gaps, emptyExpansion(3), 1, "down");
    exp = expandGap(gaps, exp, 1, "up");
    const m = buildRows(diff, "unified", exp, lines);
    const ctxRows = m.rows.filter((r): r is Extract<Row, { t: "line" }> => r.t === "line" && r.line.newNo! >= 14 && r.line.newNo! < 47);
    expect(ctxRows.length).toBe(33);
    expect(ctxRows[0].line).toMatchObject({ kind: "context", newNo: 14, oldNo: 15, text: "l14" });
    expect(ctxRows[32].line).toMatchObject({ newNo: 46, oldNo: 47, text: "l46" });
    // Gap fully expanded: its header disappears and hunk B starts at its first line.
    expect(m.rows.filter((r) => r.t === "hunk").length).toBe(2);
    expect(m.rows[m.hunkRows[1]]).toMatchObject({ t: "line", line: { newNo: 47 } });
  });

  it("places partial expansions around the header", () => {
    const gaps = computeGaps(diff.hunks, lines.length);
    const exp = expandGap(gaps, expandGap(gaps, emptyExpansion(3), 1, "down"), 1, "up");
    const partial = expandGap(gaps, emptyExpansion(3), 1, "up");
    const m = buildRows(diff, "split", partial, lines);
    const h = m.hunkRows[1];
    expect(m.rows[h]).toMatchObject({ t: "hunk", remaining: 13 });
    expect(m.rows[h + 1]).toMatchObject({ t: "pair", left: { oldNo: 28, newNo: 27 } });
    expect(exp.top[1] + exp.bottom[1]).toBe(33);
  });

  it("builds split rows with pairing", () => {
    const m = buildRows(diff, "split", emptyExpansion(3), lines);
    expect(m.rows.filter((r) => r.t === "pair").length).toBe(14);
  });

  it("renders added files as all additions without expanders", () => {
    const added = fileDiff(
      [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: [add(1), add(2)] }],
      "new1\nnew2\n",
    );
    const m = buildRows(added, "split", emptyExpansion(2), splitTextLines(added.newText!));
    expect(pairsOf(m.rows)).toEqual(["hunk", [null, "new1"], [null, "new2"]]);
    expect(m.rows[0]).toMatchObject({ up: false, down: false });
  });

  it("tracks the widest line with tabs counted as 4 columns", () => {
    const d = fileDiff([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [ctx(1, 1, "\t\tab")] }], null);
    expect(buildRows(d, "unified", emptyExpansion(2), null).maxCols).toBe(10);
  });
});
