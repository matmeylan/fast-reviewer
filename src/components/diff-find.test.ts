import { describe, expect, it } from "vitest";
import { findMatches, matchFrom, sameMatch, stepMatch, type FindMatch } from "./diff-find";
import type { Row } from "./diff-rows";
import type { DiffLine } from "../lib/types";

const line = (kind: DiffLine["kind"], no: number, text: string): DiffLine => ({
  kind,
  oldNo: kind === "add" ? null : no,
  newNo: kind === "del" ? null : no,
  text,
  segments: null,
});

const at = (ms: FindMatch[]) => ms.map((m) => [m.row, m.line.kind, m.start, m.end]);

describe("findMatches", () => {
  const ctx = line("context", 1, "const Foo = foo();");
  const del = line("del", 2, "foo(1)");
  const add = line("add", 2, "bar(FOO)");
  const split: Row[] = [
    { t: "hunk", gap: 0, header: "@@ foo @@", up: false, down: false, remaining: 0 },
    { t: "pair", left: ctx, right: ctx },
    { t: "pair", left: del, right: add },
    { t: "pair", left: null, right: line("add", 3, "no match") },
  ];

  it("finds every occurrence, ignoring case by default, in reading order", () => {
    // Hunk headers are not searched; the context line matches once although it shows on both sides.
    expect(at(findMatches(split, { query: "foo", caseSensitive: false }))).toEqual([
      [1, "context", 6, 9],
      [1, "context", 12, 15],
      [2, "del", 0, 3],
      [2, "add", 4, 7],
    ]);
  });

  it("matches case when asked", () => {
    expect(at(findMatches(split, { query: "foo", caseSensitive: true }))).toEqual([
      [1, "context", 12, 15],
      [2, "del", 0, 3],
    ]);
  });

  it("returns nothing for an empty query", () => {
    expect(findMatches(split, { query: "", caseSensitive: false })).toEqual([]);
  });

  it("treats the query as literal text and does not overlap matches", () => {
    const rows: Row[] = [{ t: "line", line: line("context", 1, "a.b(a*b) aaaa") }];
    expect(at(findMatches(rows, { query: "(a*b)", caseSensitive: false }))).toEqual([[0, "context", 3, 8]]);
    expect(at(findMatches(rows, { query: "aa", caseSensitive: false }))).toEqual([
      [0, "context", 9, 11],
      [0, "context", 11, 13],
    ]);
  });

  it("keeps offsets exact where lowercasing would change the text's length", () => {
    // "İ".toLowerCase() is two code units long.
    const rows: Row[] = [{ t: "line", line: line("context", 1, "İİ x") }];
    expect(at(findMatches(rows, { query: "x", caseSensitive: false }))).toEqual([[0, "context", 3, 4]]);
  });
});

describe("stepping", () => {
  const l = line("context", 1, "");
  const ms: FindMatch[] = [10, 20, 20, 30].map((row, i) => ({ row, line: l, start: i, end: i + 1 }));

  it("steps forward and back from the current match, wrapping", () => {
    expect(stepMatch(ms, 0, 1, 0, 0)).toBe(1);
    expect(stepMatch(ms, 3, 1, 0, 0)).toBe(0);
    expect(stepMatch(ms, 0, -1, 0, 0)).toBe(3);
    expect(stepMatch([], 0, 1, 0, 0)).toBe(-1);
  });

  it("starts from the viewport when no match is current", () => {
    expect(stepMatch(ms, -1, 1, 15, 25)).toBe(1); // first at or below the top
    expect(stepMatch(ms, -1, 1, 31, 40)).toBe(0); // none below: wrap to the first
    expect(stepMatch(ms, -1, -1, 0, 25)).toBe(2); // last above the bottom
    expect(stepMatch(ms, -1, -1, 0, 5)).toBe(3); // none above: wrap to the last
  });

  it("refines a query from the previous match", () => {
    expect(matchFrom(ms, 20, 2)).toBe(2);
    expect(matchFrom(ms, 20, 3)).toBe(3);
    expect(matchFrom(ms, 40, 0)).toBe(0);
  });

  it("recognizes the same match in rebuilt rows", () => {
    const a: FindMatch = { row: 1, line: line("context", 7, "x"), start: 0, end: 1 };
    expect(sameMatch(a, { ...a, row: 9, line: { ...a.line } })).toBe(true);
    expect(sameMatch(a, { ...a, start: 1 })).toBe(false);
    expect(sameMatch(a, { ...a, line: line("context", 8, "x") })).toBe(false);
  });
});
