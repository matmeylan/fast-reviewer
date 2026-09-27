// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHighlightCore, HighlightCancelled } from "./highlight-core";
import { lineTokens, STYLE_COLOR_MASK, tokenLineCount, type SideTokens } from "./highlight-protocol";

const core = createHighlightCore();

function colorsOf(t: SideTokens): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < t.data.length; i += 2) set.add(t.palette[t.data[i + 1] & STYLE_COLOR_MASK]);
  return set;
}

function lineLength(t: SideTokens, line: number): number {
  const toks = lineTokens(t, line)!;
  let n = 0;
  for (let i = 0; i < toks.length; i += 2) n += toks[i];
  return n;
}

describe("highlight core", () => {
  it("highlights TypeScript with varied colors and exact line lengths", async () => {
    const src = 'const greet = (name: string): string => `hi ${name}`;\n/* block\n comment */\nexport default 42;\n';
    const t = (await core.tokenize(src, "typescript", "light"))!;
    expect(t).not.toBeNull();
    const lines = src.split("\n");
    expect(tokenLineCount(t)).toBe(lines.length);
    lines.forEach((l, i) => expect(lineLength(t, i)).toBe(l.length));
    expect(colorsOf(t).size).toBeGreaterThanOrEqual(3);
    // Multi-line state: both comment lines share the comment color.
    const c1 = lineTokens(t, 1)!;
    const c2 = lineTokens(t, 2)!;
    expect(c1[1]).toBe(c2[1]);
  });

  it("highlights Python in both themes with different palettes", async () => {
    const src = "def f(x: int) -> int:\n    # comment\n    return x + 1  # ok\n";
    const light = (await core.tokenize(src, "python", "light"))!;
    const dark = (await core.tokenize(src, "python", "dark"))!;
    expect(colorsOf(light).size).toBeGreaterThanOrEqual(3);
    expect([...colorsOf(light)].sort()).not.toEqual([...colorsOf(dark)].sort());
  });

  it("supports the required languages and aliases", async () => {
    const langs = ["typescript", "tsx", "javascript", "jsx", "html", "css", "scss", "python", "json", "markdown",
      "yaml", "rust", "go", "bash", "sql", "toml", "ts", "py", "sh"];
    for (const l of langs) expect(core.resolveLanguage(l), l).not.toBeNull();
    expect(core.resolveLanguage("no-such-lang")).toBeNull();
    expect(core.resolveLanguage(null)).toBeNull();
    expect(await core.tokenize("x", "no-such-lang", "light")).toBeNull();
    const html = (await core.tokenize('<div class="a"><style>a{color:red}</style></div>', "html", "dark"))!;
    expect(colorsOf(html).size).toBeGreaterThanOrEqual(3);
  });

  it("keeps grammar state across chunks and handles CRLF", async () => {
    const body = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\r\n");
    const src = "const s = `\r\n" + body + "\r\n`;\r\nconst n = 1;";
    const t = (await core.tokenize(src, "typescript", "light"))!;
    const lines = src.split("\r\n");
    expect(tokenLineCount(t)).toBe(lines.length);
    expect(lineLength(t, 1500)).toBe(lines[1500].length);
    // Line 1500 is inside the template string: a single string-colored token.
    const mid = lineTokens(t, 1500)!;
    expect(mid.length).toBe(2);
    expect(mid[1]).toBe(lineTokens(t, 2)![1]);
  });

  it("reports progressive partial results", async () => {
    const src = Array.from({ length: 1500 }, (_, i) => `let a${i} = "s";`).join("\n");
    const partials: SideTokens[] = [];
    const t = (await core.tokenize(src, "javascript", "light", { onProgress: (p) => partials.push(p) }))!;
    expect(partials.map((p) => p.ready)).toEqual([200, 1200]);
    expect(lineTokens(partials[0], 199)).toEqual(lineTokens(t, 199));
    expect(lineTokens(partials[0], 200)).toBeNull();
    expect(t.ready).toBeUndefined();
  });

  it("aborts between chunks when cancelled", async () => {
    const src = Array.from({ length: 3000 }, (_, i) => `let a${i} = ${i};`).join("\n");
    await expect(
      core.tokenize(src, "javascript", "light", { isCancelled: () => true, yieldFn: async () => {} }),
    ).rejects.toBeInstanceOf(HighlightCancelled);
  });
});
