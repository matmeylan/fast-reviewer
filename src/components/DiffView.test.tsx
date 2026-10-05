import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import DiffView, { ROW_HEIGHT, type DiffComments, type LineRef } from "./DiffView";
import { anchorRow, buildRows, emptyExpansion, splitTextLines, type Row } from "./diff-rows";
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

  it("opens comments from line numbers: hunk lines take new ones, other lines only show existing ones", () => {
    const newText = Array.from({ length: 60 }, (_, i) => `n${i + 1}`).join("\n");
    const diff: FileDiff = {
      ...base,
      newText,
      oldText: newText.replace("n40", "o40"),
      hunks: [
        {
          oldStart: 40, oldLines: 1, newStart: 40, newLines: 1,
          lines: [
            { kind: "del", oldNo: 40, newNo: null, text: "o40", segments: null },
            { kind: "add", oldNo: null, newNo: 40, text: "n40", segments: null },
          ],
        },
      ],
    };
    const opened: [LineRef, boolean][] = [];
    const [open, setOpen] = createSignal<LineRef | null>(null);
    const comments: DiffComments = {
      // An existing thread on line 30, outside the hunk.
      count: (side, line) => (side === "new" && line === 30 ? 2 : 0),
      onOpen: (at, canComment) => {
        opened.push([at, canComment]);
        setOpen(at);
      },
      get open() {
        return open();
      },
      popover: <div data-testid="pop">popover</div>,
    };
    const { container, queryByTestId } = render(() => <DiffView diff={diff} mode="split" comments={comments} />);
    const ln = (side: string, no: number) =>
      [...container.querySelectorAll<HTMLElement>(`.ln[data-side="${side}"]`)].find((e) => e.textContent === String(no));
    expect(ln("old", 40)!.classList.contains("cm")).toBe(true);
    ln("old", 40)!.click();
    expect(opened).toEqual([[{ side: "old", line: 40 }, true]]);
    // The popover sits under the opened line's row (after the hunk header).
    const pop = container.querySelector<HTMLElement>(".dv-popover")!;
    expect(queryByTestId("pop")).not.toBeNull();
    expect(pop.style.top).toBe(`${2 * ROW_HEIGHT}px`);
    expect(pop.classList.contains("right")).toBe(false);
    ln("new", 40)!.click();
    expect(container.querySelector(".dv-popover")!.classList.contains("right")).toBe(true);

    container.querySelector<HTMLButtonElement>('[title="Expand up"]')!.click();
    // Expanded context is not in GitHub's diff: no new comments there...
    expect(ln("new", 31)!.classList.contains("cm")).toBe(false);
    ln("new", 31)!.click();
    expect(opened).toHaveLength(2);
    // ...but existing ones still show and open.
    const marked = ln("new", 30)!;
    expect(marked.dataset.cmt).toBe("2");
    marked.click();
    expect(opened[2]).toEqual([{ side: "new", line: 30 }, false]);
  });

  it("c opens the line under the mouse: its side in split, its own side in unified", () => {
    const diff: FileDiff = {
      ...base,
      hunks: [
        {
          oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
          lines: [
            { kind: "context", oldNo: 1, newNo: 1, text: "same", segments: null },
            { kind: "del", oldNo: 2, newNo: null, text: "old", segments: null },
            { kind: "add", oldNo: null, newNo: 2, text: "new", segments: null },
          ],
        },
      ],
    };
    const opened: [LineRef, boolean, string][] = [];
    const [request, setRequest] = createSignal(0);
    const [mode, setMode] = createSignal<"split" | "unified">("split");
    const comments: DiffComments = {
      count: () => 0,
      onOpen: (at, canComment, how) => opened.push([at, canComment, how]),
      open: null,
      popover: null,
      get request() {
        return request();
      },
    };
    const { container } = render(() => <DiffView diff={diff} mode={mode()} comments={comments} />);
    const scroller = container.querySelector<HTMLElement>(".dv-scroll")!;
    // jsdom has no layout: the element "under the mouse" is picked by the test.
    let under: Element | null = null;
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => under;
    const press = (el: Element | null) => {
      under = el;
      scroller.dispatchEvent(new MouseEvent("pointermove", { clientX: 1, clientY: 1, bubbles: true }));
      setRequest((n) => n + 1);
    };
    try {
      const code = (text: string, side?: string) =>
        [...container.querySelectorAll(`.dc${side ? `[data-side="${side}"]` : ""} .dt`)].find((e) => e.textContent === text)!;
      press(code("new", "new"));
      press(code("old", "old"));
      press(code("same", "old"));
      // Nothing on the hunk header or the empty half of a pair.
      press(container.querySelector(".dh"));
      press(container.querySelector(".dc.fill"));
      expect(opened).toEqual([
        [{ side: "new", line: 2 }, true, "key"],
        [{ side: "old", line: 2 }, true, "key"],
        [{ side: "old", line: 1 }, true, "key"],
      ]);
      opened.length = 0;
      setMode("unified");
      press(code("old"));
      press(code("same"));
      press(container.querySelectorAll('.dr .ln[data-side="old"]')[0]);
      expect(opened.map(([at]) => at)).toEqual([
        { side: "old", line: 2 },
        { side: "new", line: 1 },
        { side: "old", line: 1 },
      ]);
      // After the mouse leaves the diff, c does nothing.
      scroller.dispatchEvent(new MouseEvent("pointerleave"));
      setRequest((n) => n + 1);
      expect(opened).toHaveLength(3);
    } finally {
      document.elementFromPoint = orig;
    }
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

  it("keeps the first visible source line anchored across split <-> unified switches", () => {
    const diff = bigDiff(5000);
    const lines = splitTextLines(diff.newText!);
    const split = buildRows(diff, "split", emptyExpansion(2), lines).rows;
    const unified = buildRows(diff, "unified", emptyExpansion(2), lines).rows;
    const firstLine = (r: Row) =>
      r.t === "pair" ? (r.left ?? r.right)! : r.t === "line" ? r.line : null;

    const [mode, setMode] = createSignal<"split" | "unified">("split");
    const { container } = render(() => <DiffView diff={diff} mode={mode()} />);
    const scroller = container.querySelector<HTMLElement>(".dv-scroll")!;
    const scrollTo = (px: number) => {
      scroller.scrollTop = px;
      scroller.dispatchEvent(new Event("scroll"));
    };

    // Deep in the file, 7px into row 1500 of the split view.
    const row = 1500;
    scrollTo(row * ROW_HEIGHT + 7);
    const anchor = firstLine(split[row])!;
    setMode("unified");
    const u = Math.floor(scroller.scrollTop / ROW_HEIGHT);
    expect(u).toBeGreaterThan(row); // unified has more rows above the same line
    expect(firstLine(unified[u])).toEqual(anchor);
    expect(scroller.scrollTop - u * ROW_HEIGHT).toBe(7);
    // The rendered rows follow the new position.
    const rendered = [...container.querySelectorAll(".dr .ln")].map((el) => el.textContent);
    expect(rendered).toContain(String(anchor.oldNo));

    // And back: the exact original position.
    setMode("split");
    expect(scroller.scrollTop).toBe(row * ROW_HEIGHT + 7);
  });
});

describe("DiffView find", () => {
  it("highlights matches, steps through them and scrolls the current one into view", () => {
    const diff = bigDiff(3000);
    const [nav, setNav] = createSignal<{ dir: 1 | -1; seq: number } | undefined>();
    const [find, setFind] = createSignal<{ query: string; caseSensitive: boolean } | undefined>();
    const statuses: { count: number; index: number }[] = [];
    const { container } = render(() => (
      <DiffView diff={diff} mode="split" find={find()} findNav={nav()} onFindStatus={(st) => statuses.push(st)} />
    ));
    const scroller = container.querySelector<HTMLElement>(".dv-scroll")!;
    const status = () => statuses[statuses.length - 1];

    // Only the changed lines say "computeFast": lines 3, 6, ... (new side only).
    setFind({ query: "computefast", caseSensitive: false });
    expect(status()).toEqual({ count: 1000, index: 0 });
    expect(container.querySelectorAll(".fm").length).toBeGreaterThan(5);
    expect(container.querySelectorAll(".fc").length).toBe(1);
    expect(container.querySelector(".fc")!.textContent).toBe("computeFast");
    expect(container.querySelector(".fc")!.closest(".dc")!.getAttribute("data-side")).toBe("new");

    // Previous from the first wraps to the last match, deep in the file.
    setNav({ dir: -1, seq: 1 });
    expect(status()).toEqual({ count: 1000, index: 999 });
    expect(scroller.scrollTop).toBeGreaterThan(2900 * ROW_HEIGHT);
    expect(container.querySelector(".fc")!.closest(".dr")!.querySelector(".ln")!.textContent).toBe("3000");

    setNav({ dir: 1, seq: 2 });
    expect(status()).toEqual({ count: 1000, index: 0 });

    // Case-sensitive: no match. Closing the bar clears the highlights.
    setFind({ query: "computefast", caseSensitive: true });
    expect(status()).toEqual({ count: 0, index: -1 });
    setFind({ query: "compute", caseSensitive: false });
    expect(status().count).toBe(3000 + 1000);
    setFind(undefined);
    expect(status()).toEqual({ count: 0, index: -1 });
    expect(container.querySelector(".fm")).toBeNull();
  });

  it("keeps the current match across a mode switch and starts unpositioned on a new file", () => {
    const [mode, setMode] = createSignal<"split" | "unified">("split");
    const [diff, setDiff] = createSignal(bigDiff(300));
    const [nav, setNav] = createSignal<{ dir: 1 | -1; seq: number } | undefined>();
    let st = { count: 0, index: -1 };
    const { container } = render(() => (
      <DiffView
        diff={diff()}
        mode={mode()}
        find={{ query: "value12", caseSensitive: false }}
        findNav={nav()}
        onFindStatus={(x) => (st = x)}
      />
    ));
    // A file shown with the bar open starts unpositioned; the first step goes to the first match.
    expect(st).toEqual({ count: 16, index: -1 });
    setNav({ dir: 1, seq: 1 });
    expect(st.index).toBe(0);
    setNav({ dir: 1, seq: 2 });
    setNav({ dir: 1, seq: 3 });
    // The third match: line 120's deleted side.
    const current = () => {
      const dc = container.querySelector(".fc")!.closest(".dc")!;
      return [dc.classList.contains("del"), dc.querySelector(".dt")!.textContent];
    };
    const before = current();
    expect(before[0]).toBe(true);
    expect(before[1]).toContain("value120 ");
    setMode("unified");
    expect(st.index).toBe(2);
    expect(current()).toEqual(before);
    setDiff(bigDiff(301));
    expect(st.index).toBe(-1);
    expect(container.querySelector(".fc")).toBeNull();
    expect(container.querySelectorAll(".fm").length).toBeGreaterThan(0);
  });
});

describe("DiffView selection", () => {
  const select = (from: Node, fromOffset: number, to: Node, toOffset: number) => {
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    const r = document.createRange();
    r.setStart(from, fromOffset);
    r.setEnd(to, toOffset);
    sel.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
  };
  const copy = () => {
    let text = null as string | null;
    const e = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", { value: { setData: (_t: string, v: string) => (text = v) } });
    document.dispatchEvent(e);
    return { text, prevented: e.defaultPrevented };
  };

  it("copies only the code of the side the selection started on", () => {
    const diff = bigDiff(30);
    const { container } = render(() => <DiffView diff={diff} mode="split" />);
    const cells = (side: string) => [...container.querySelectorAll(`.dc[data-side="${side}"] .dt`)];
    const newCells = cells("new");
    // Rows 1..3 of the file; line 3 changed. Start 8 chars into line 1, end 5 chars into line 3.
    newCells[2].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(container.querySelector(".diff-view")!.getAttribute("data-sel")).toBe("new");
    const first = newCells[0].firstChild!;
    const last = newCells[2];
    select(first, 8, last, 0);
    const r = document.getSelection()!.getRangeAt(0);
    r.setEnd(last.firstChild!.nodeType === Node.TEXT_NODE ? last.firstChild! : last.firstChild!.firstChild!, 5);
    const { text, prevented } = copy();
    expect(prevented).toBe(true);
    const lines = text!.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(diff.hunks[0].lines[0].text.slice(8));
    expect(lines[1]).toBe(diff.hunks[0].lines[1].text);
    expect(lines[2]).toBe("  con");
  });

  it("leaves copies outside the diff alone", () => {
    render(() => <DiffView diff={bigDiff(30)} mode="unified" />);
    const outside = document.body.appendChild(document.createElement("p"));
    outside.textContent = "elsewhere";
    select(outside.firstChild!, 0, outside.firstChild!, 4);
    expect(copy()).toEqual({ text: null, prevented: false });
    outside.remove();
  });

  it("keeps the selection's anchor row rendered while scrolled away", () => {
    const { container } = render(() => <DiffView diff={bigDiff(3000)} mode="unified" />);
    const scroller = container.querySelector<HTMLElement>(".dv-scroll")!;
    const dt = container.querySelectorAll(".dt")[1];
    select(dt.firstChild!, 0, dt.firstChild!, 3);
    scroller.scrollTop = 2000 * ROW_HEIGHT;
    scroller.dispatchEvent(new Event("scroll"));
    expect(dt.isConnected).toBe(true);
    // Collapsing the selection releases it.
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(dt.isConnected).toBe(false);
  });
});

describe("anchorRow", () => {
  const ctx = (no: number): DiffLine => ({ kind: "context", oldNo: no, newNo: no, text: "", segments: null });
  const del = (no: number): DiffLine => ({ kind: "del", oldNo: no, newNo: null, text: "", segments: null });
  const add = (no: number): DiffLine => ({ kind: "add", oldNo: null, newNo: no, text: "", segments: null });
  const hunk: FileDiff = {
    ...base,
    hunks: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 3, lines: [ctx(1), del(2), del(3), add(2), ctx(4)] }],
  };
  hunk.hunks[0].lines[4] = { ...ctx(4), newNo: 3 };
  const split = buildRows(hunk, "split", emptyExpansion(2), null).rows;
  const unified = buildRows(hunk, "unified", emptyExpansion(2), null).rows;

  it("maps rows to the row showing the same line in the other mode", () => {
    // split: @@ [ctx1] [del2|add2] [del3|-] [ctx4]; unified: @@ ctx1 del2 del3 add2 ctx4
    expect(split).toHaveLength(5);
    expect(unified).toHaveLength(6);
    expect(anchorRow(split, 0, unified)).toBe(0); // hunk header
    expect(anchorRow(split, 1, unified)).toBe(1);
    expect(anchorRow(split, 2, unified)).toBe(2);
    expect(anchorRow(split, 3, unified)).toBe(3);
    expect(anchorRow(split, 4, unified)).toBe(5);
    expect(anchorRow(unified, 4, split)).toBe(2); // add2 sits beside del2
    expect(anchorRow(unified, 5, split)).toBe(4);
    expect(anchorRow(unified, 99, split)).toBeUndefined();
  });
});
