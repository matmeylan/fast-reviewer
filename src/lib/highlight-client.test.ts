import { describe, expect, it } from "vitest";
import { highlightDiff, hunkSource, paletteOf, tokensFor, type DiffTokens } from "./highlight-client";
import type { SideTokens } from "./highlight-protocol";
import type { FileDiff } from "./types";

const diff: FileDiff = {
  path: "a.py",
  oldPath: null,
  language: "python",
  binary: false,
  tooLarge: false,
  oldText: null,
  newText: null,
  hunks: [
    {
      oldStart: 3, oldLines: 2, newStart: 3, newLines: 2,
      lines: [
        { kind: "context", oldNo: 3, newNo: 3, text: "a", segments: null },
        { kind: "del", oldNo: 4, newNo: null, text: "b", segments: null },
        { kind: "add", oldNo: null, newNo: 4, text: "c", segments: null },
      ],
    },
  ],
};

// Two lines: line 1 -> one token [1, style 5]; line 2 -> [2, style 6]
const side = (palette: string[], ready?: number): SideTokens => ({
  palette,
  data: Uint32Array.from([1, 5, 2, 6]),
  lineStarts: Uint32Array.from([0, 2, 4]),
  ready,
});

describe("highlight client helpers", () => {
  it("places hunk lines at their line numbers", () => {
    expect(hunkSource(diff, "old")).toEqual({ text: "\n\na\nb", lines: 2 });
    expect(hunkSource(diff, "new")).toEqual({ text: "\n\na\nc", lines: 2 });
    expect(hunkSource({ ...diff, hunks: [] }, "new")).toBeNull();
  });

  it("prefers whole-file tokens and falls back to the sketch beyond a partial result", () => {
    const sketch = side(["#a"]);
    const full = side(["#a", "#b", "#c"], 1);
    const t: DiffTokens = { old: { full: null, sketch: null }, new: { full, sketch } };
    expect([...tokensFor(t, "new", 1)!]).toEqual([1, 5]);
    // Line 2 is not ready in `full`: comes from the sketch.
    expect([...tokensFor(t, "new", 2)!]).toEqual([2, 6]);
    expect(tokensFor(t, "old", 1)).toBeNull();
    expect(tokensFor(t, "new", null)).toBeNull();
    expect(tokensFor(null, "new", 1)).toBeNull();
    expect(paletteOf(t)).toEqual(["#a", "#b", "#c"]);
  });

  it("degrades to no tokens without a worker (jsdom) or language", async () => {
    const h = highlightDiff(diff, "light");
    await Promise.resolve();
    expect(h.tokens().new.full).toBeNull();
    const plain = highlightDiff({ ...diff, language: null }, "light");
    expect(plain.tokens()).toEqual({ old: { full: null, sketch: null }, new: { full: null, sketch: null } });
  });
});
