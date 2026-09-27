import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import DiffView, { ROW_HEIGHT } from "./DiffView";
import { buildRows, emptyExpansion, splitTextLines } from "./diff-rows";
import type { DiffLine, FileDiff, Hunk } from "../lib/types";

afterEach(cleanup);

const base: FileDiff = {
  path: "src/a.ts",
  oldPath: null,
  language: "typescript",
  binary: false,
  tooLarge: false,
  hunks: [],
  oldText: null,
  newText: null,
};

/** A modified file of `n` lines where every 3rd line changed (del+add pairs with segments). */
function bigDiff(n: number): FileDiff {
  const lines: DiffLine[] = [];
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (let i = 1; i <= n; i++) {
    const text = `  const value${i} = compute(${i}, "some string literal", { nested: true });`;
    if (i % 3 === 0) {
      oldLines.push(text);
      newLines.push(text.replace("compute", "computeFast"));
      lines.push({ kind: "del", oldNo: i, newNo: null, text, segments: [[17, 24]] });
      lines.push({ kind: "add", oldNo: null, newNo: i, text: newLines[newLines.length - 1], segments: [[17, 28]] });
    } else {
      oldLines.push(text);
      newLines.push(text);
      lines.push({ kind: "context", oldNo: i, newNo: i, text, segments: null });
    }
  }
  const hunk: Hunk = { oldStart: 1, oldLines: n, newStart: 1, newLines: n, lines };
  return { ...base, hunks: [hunk], oldText: oldLines.join("\n") + "\n", newText: newLines.join("\n") + "\n" };
}

describe("DiffView", () => {
  it("shows placeholders for binary, too large and renamed-only files", () => {
    const { getByText, unmount } = render(() => <DiffView diff={{ ...base, binary: true }} mode="split" />);
    getByText("Binary file not shown");
    unmount();
    const r2 = render(() => (
      <DiffView diff={{ ...base, tooLarge: true }} mode="split" stats={{ additions: 12, deletions: 3 }} />
    ));
    r2.getByText(/File too large to display/);
    r2.getByText("+12");
    r2.unmount();
    const r3 = render(() => <DiffView diff={{ ...base, oldPath: "src/old.ts" }} mode="unified" />);
    r3.getByText("File renamed without changes");
  });

  it("renders split rows with fillers and intra-line highlights", () => {
    const diff: FileDiff = {
      ...base,
      hunks: [
        {
          oldStart: 1, oldLines: 2, newStart: 1, newLines: 1,
          lines: [
            { kind: "del", oldNo: 1, newNo: null, text: "let a = 1;", segments: [[8, 9]] },
            { kind: "del", oldNo: 2, newNo: null, text: "gone <b>", segments: null },
            { kind: "add", oldNo: null, newNo: 1, text: "let a = 2;", segments: [[8, 9]] },
          ],
        },
      ],
    };
    const { container } = render(() => <DiffView diff={diff} mode="split" />);
    const rows = container.querySelectorAll(".dr:not(.dh)");
    expect(rows.length).toBe(2);
    expect(rows[1].querySelectorAll(".dc.fill").length).toBe(1);
    const marks = container.querySelectorAll(".dc .x");
    expect([...marks].map((m) => m.textContent)).toEqual(["1", "2"]);
    expect(container.querySelector(".dc.del .x")).not.toBeNull();
    expect(container.textContent).toContain("gone <b>");
    expect(container.querySelector(".dh")!.textContent).toContain("@@ -1,2 +1,1 @@");
  });

  it("expands context from the new text", () => {
    const newText = Array.from({ length: 60 }, (_, i) => `n${i + 1}`).join("\n");
    const diff: FileDiff = {
      ...base,
      newText,
      oldText: newText,
      hunks: [
        {
          oldStart: 40, oldLines: 1, newStart: 40, newLines: 1,
          lines: [{ kind: "context", oldNo: 40, newNo: 40, text: "n40", segments: null }],
        },
      ],
    };
    const { container } = render(() => <DiffView diff={diff} mode="unified" />);
    const header = () => container.querySelector(".dh .dhh")?.firstChild?.textContent ?? null;
    expect(header()).toBe("@@ -40,1 +40,1 @@");
    const up = container.querySelector<HTMLButtonElement>('[title="Expand up"]')!;
    up.click();
    // The header follows the visible range: 20 revealed lines above line 40.
    expect(header()).toBe("@@ -20,21 +20,21 @@");
    const texts = [...container.querySelectorAll(".dr:not(.dh) .dt")].map((e) => e.textContent);
    expect(texts[0]).toBe("n20");
    expect(texts).toContain("n39");
    // 19 lines above still hidden -> a single "expand all" control.
    container.querySelector<HTMLButtonElement>('[title="Expand all 19 lines"]')!.click();
    const all = [...container.querySelectorAll(".dr:not(.dh) .dt")].map((e) => e.textContent);
    expect(all[0]).toBe("n1");
    // Nothing hidden above any more: the header is gone.
    expect(container.querySelector(".dh .dhh")?.textContent ?? "").not.toContain("@@");
  });

  it("virtualizes a 5000-line diff and switches modes quickly", () => {
    const diff = bigDiff(5000);
    const t0 = performance.now();
    const model = buildRows(diff, "split", emptyExpansion(2), splitTextLines(diff.newText!));
    const buildMs = performance.now() - t0;
    expect(model.rows.length).toBeGreaterThan(5000);
    expect(buildMs).toBeLessThan(50);

    const [mode, setMode] = createSignal<"split" | "unified">("split");
    const t1 = performance.now();
    const { container } = render(() => <DiffView diff={diff} mode={mode()} />);
    const renderMs = performance.now() - t1;
    const rendered = container.querySelectorAll(".dr").length;
    expect(rendered).toBeGreaterThan(10);
    expect(rendered).toBeLessThan(120);
    const spacer = container.querySelector<HTMLElement>(".dv-spacer")!;
    expect(parseInt(spacer.style.height)).toBe(model.rows.length * ROW_HEIGHT);

    const t2 = performance.now();
    setMode("unified");
    const switchMs = performance.now() - t2;
    expect(container.querySelectorAll(".dr").length).toBeLessThan(120);
    // Generous bounds for slow CI; typical numbers are a few ms.
    expect(renderMs).toBeLessThan(250);
    expect(switchMs).toBeLessThan(150);
    console.info(`5000-line diff: build ${buildMs.toFixed(1)}ms, render ${renderMs.toFixed(1)}ms, mode switch ${switchMs.toFixed(1)}ms`);
  });
});
