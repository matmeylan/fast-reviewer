import { describe, expect, it } from "vitest";
import { escapeHtml, mergeSpans, paletteCss, renderLineHtml, styleClass } from "./highlight-merge";
import { FONT_ITALIC, STYLE_FONT_SHIFT } from "./highlight-protocol";

const spans = (...args: Parameters<typeof mergeSpans>) =>
  mergeSpans(...args).map((s) => [s.start, s.end, s.style, s.mark ? 1 : 0]);

describe("mergeSpans", () => {
  it("returns tokens unchanged without segments", () => {
    expect(spans(10, [3, 1, 4, 2, 3, 1], null)).toEqual([
      [0, 3, 1, 0],
      [3, 7, 2, 0],
      [7, 10, 1, 0],
    ]);
  });

  it("returns segments over unstyled text without tokens", () => {
    expect(spans(10, null, [[2, 5]])).toEqual([
      [0, 2, -1, 0],
      [2, 5, -1, 1],
      [5, 10, -1, 0],
    ]);
  });

  it("splits at both token and segment boundaries", () => {
    // tokens: [0,4) s1, [4,8) s2, [8,12) s3 ; segment [2,10)
    expect(spans(12, [4, 1, 4, 2, 4, 3], [[2, 10]])).toEqual([
      [0, 2, 1, 0],
      [2, 4, 1, 1],
      [4, 8, 2, 1],
      [8, 10, 3, 1],
      [10, 12, 3, 0],
    ]);
  });

  it("handles multiple segments within one token", () => {
    expect(spans(10, [10, 7], [[1, 2], [4, 6]])).toEqual([
      [0, 1, 7, 0],
      [1, 2, 7, 1],
      [2, 4, 7, 0],
      [4, 6, 7, 1],
      [6, 10, 7, 0],
    ]);
  });

  it("coalesces adjacent segments and identical styles", () => {
    expect(spans(6, [2, 1, 2, 1, 2, 1], [[0, 3], [3, 6]])).toEqual([[0, 6, 1, 1]]);
  });

  it("clamps segments and tokens to the text and ignores bad segments", () => {
    expect(spans(5, [3, 1, 10, 2], [[4, 2], [3, 3], [4, 99]])).toEqual([
      [0, 3, 1, 0],
      [3, 4, 2, 0],
      [4, 5, 2, 1],
    ]);
  });

  it("leaves text past the last token unstyled and skips zero-length tokens", () => {
    expect(spans(6, [0, 9, 2, 1], null)).toEqual([
      [0, 2, 1, 0],
      [2, 6, -1, 0],
    ]);
  });

  it("uses UTF-16 offsets (emoji surrogate pairs)", () => {
    const text = "a😀b🎉c"; // a(1) 😀(2) b(1) 🎉(2) c(1) = 7 units
    expect(text.length).toBe(7);
    const out = mergeSpans(text.length, [3, 1, 4, 2], [[1, 3], [4, 6]]);
    expect(out.map((s) => text.slice(s.start, s.end))).toEqual(["a", "😀", "b", "🎉", "c"]);
    expect(out.map((s) => s.mark)).toEqual([false, true, false, true, false]);
    expect(out.map((s) => s.style)).toEqual([1, 1, 2, 2, 2]);
  });

  it("returns nothing for empty text", () => {
    expect(mergeSpans(0, [3, 1], [[0, 1]])).toEqual([]);
  });
});

describe("renderLineHtml", () => {
  it("escapes plain text", () => {
    expect(renderLineHtml("a < b && c > d", null, null)).toBe("a &lt; b &amp;&amp; c &gt; d");
  });

  it("renders styled and marked spans with edge classes", () => {
    const html = renderLineHtml("let x=1;", [3, 0, 5, 1], [[2, 6]]);
    expect(html).toBe(
      '<span class="k0">le</span><span class="k0 x xl">t</span><span class="k1 x xr"> x=</span><span class="k1">1;</span>',
    );
  });

  it("encodes font styles as classes", () => {
    expect(styleClass(3 | (FONT_ITALIC << STYLE_FONT_SHIFT))).toBe("k3 fi");
    expect(escapeHtml("plain")).toBe("plain");
    expect(paletteCss(["#fff", "#000"], ".v")).toBe(".v .k0{color:#fff}.v .k1{color:#000}");
  });
});
