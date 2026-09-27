// Integrity of what DiffView puts on screen: read the rendered rows back and check that the
// old side (context + deleted) and the new side (context + added) are exactly the diff's
// lines, in order, with the right line numbers, in split and unified mode. With every gap
// expanded, the two sides must be the whole old and new files.
//
// Inputs: the real `git diff` output of the fixture PR (crates/core/tests/fixtures/git_compare,
// parsed here independently of our diff engine) and pseudo-random edits.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import DiffView, { type DiffMode } from "./DiffView";
import { splitTextLines } from "./diff-rows";
import { computeHunks } from "../lib/mock";
import type { DiffLine, FileDiff, Hunk } from "../lib/types";

const fixtureFiles = import.meta.glob<string>("../../crates/core/tests/fixtures/git_compare/*", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Fixture name -> { old, new, git }. */
function fixtures(): Map<string, { old: string; new: string; git: string }> {
  const out = new Map<string, { old: string; new: string; git: string }>();
  for (const [path, text] of Object.entries(fixtureFiles)) {
    const file = path.slice(path.lastIndexOf("/") + 1);
    const m = /^(.*)\.(old|new|git\.diff)$/.exec(file);
    if (!m) continue;
    const entry = out.get(m[1]) ?? { old: "", new: "", git: "" };
    entry[m[2] === "git.diff" ? "git" : (m[2] as "old" | "new")] = text;
    out.set(m[1], entry);
  }
  return out;
}

/** git's unified output as hunks with explicit line numbers ("\ No newline" markers dropped). */
function parseGit(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let o = 0;
  let n = 0;
  for (const line of diff.split("\n")) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      const [oldStart, oldLines, newStart, newLines] = [h[1], h[2] ?? "1", h[3], h[4] ?? "1"].map(Number);
      hunks.push({ oldStart, oldLines, newStart, newLines, lines: [] });
      o = Math.max(oldStart, 1);
      n = Math.max(newStart, 1);
      continue;
    }
    const cur = hunks[hunks.length - 1];
    if (!cur || line === "" || line.startsWith("\\")) continue;
    const text = line.slice(1);
    const add = (l: DiffLine) => cur.lines.push(l);
    if (line[0] === " ") add({ kind: "context", oldNo: o++, newNo: n++, text, segments: null });
    else if (line[0] === "-") add({ kind: "del", oldNo: o++, newNo: null, text, segments: null });
    else if (line[0] === "+") add({ kind: "add", oldNo: null, newNo: n++, text, segments: null });
  }
  return hunks;
}

function fileDiff(path: string, oldText: string | null, newText: string | null, hunks: Hunk[]): FileDiff {
  return { path, oldPath: null, language: null, binary: false, tooLarge: false, hunks, oldText, newText };
}

type Side = [lineNo: number, text: string][];

/** Old and new side of what is on screen: every numbered cell with its text, top to bottom. */
function readSides(container: HTMLElement, mode: DiffMode): { old: Side; new: Side } {
  const old: Side = [];
  const neu: Side = [];
  for (const row of container.querySelectorAll<HTMLElement>(".dr:not(.dh)")) {
    const cells = [...row.children] as HTMLElement[];
    const text = (dc: HTMLElement) => dc.querySelector(".dt")?.textContent ?? "";
    const no = (ln: HTMLElement) => (ln.textContent ? Number(ln.textContent) : null);
    if (mode === "split") {
      const [lnO, dcO, lnN, dcN] = cells;
      if (no(lnO) !== null) old.push([no(lnO)!, text(dcO)]);
      if (no(lnN) !== null) neu.push([no(lnN)!, text(dcN)]);
      // A row never shows one side's text without its line number.
      if (no(lnO) === null) expect(dcO.classList.contains("fill")).toBe(true);
      if (no(lnN) === null) expect(dcN.classList.contains("fill")).toBe(true);
    } else {
      const [lnO, lnN, dc] = cells;
      if (no(lnO) !== null) old.push([no(lnO)!, text(dc)]);
      if (no(lnN) !== null) neu.push([no(lnN)!, text(dc)]);
    }
  }
  return { old, new: neu };
}

/** The sides the hunks describe: context + deleted lines, and context + added lines. */
function hunkSides(hunks: Hunk[]): { old: Side; new: Side } {
  const lines = hunks.flatMap((h) => h.lines);
  return {
    old: lines.filter((l) => l.kind !== "add").map((l) => [l.oldNo!, l.text]),
    new: lines.filter((l) => l.kind !== "del").map((l) => [l.newNo!, l.text]),
  };
}

const wholeFile = (text: string | null): Side =>
  text === null ? [] : splitTextLines(text).map((t, i) => [i + 1, t.replace(/\r$/, "")]);

/** Clicks expand controls until none are left. */
function expandEverything(container: HTMLElement) {
  for (let i = 0; i < 1000; i++) {
    const btn = container.querySelector<HTMLButtonElement>(".dhb, .dha");
    if (!btn) return;
    btn.click();
  }
  throw new Error("expansion did not converge");
}

/** Checks a diff in both modes, collapsed and fully expanded. */
function checkIntegrity(name: string, diff: FileDiff) {
  for (const mode of ["split", "unified"] as const) {
    const { container, unmount } = render(() => <DiffView diff={diff} mode={mode} />);
    const shown = readSides(container, mode);
    const expected = hunkSides(diff.hunks);
    expect(shown.old, `${name} ${mode}: old side`).toEqual(expected.old);
    expect(shown.new, `${name} ${mode}: new side`).toEqual(expected.new);

    // Hunk headers carry the hunk ranges (the trailing expander row has none).
    const headers = [...container.querySelectorAll(".dh .dhh")]
      .map((e) => e.firstChild?.textContent ?? "")
      .filter((t) => t.startsWith("@@"));
    expect(headers, `${name} ${mode}: headers`).toEqual(
      diff.hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`),
    );

    // Expanded, the whole files are on screen. Without the new text there is nothing to expand.
    if (diff.newText !== null) {
      expandEverything(container);
      const all = readSides(container, mode);
      expect(all.old, `${name} ${mode} expanded: old file`).toEqual(wholeFile(diff.oldText));
      expect(all.new, `${name} ${mode} expanded: new file`).toEqual(wholeFile(diff.newText));
    }
    unmount();
  }
}

/** Tiny deterministic LCG. */
function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

// Render every row: the view windows rows to the viewport height (jsdom has no layout).
let innerHeight: number;
beforeAll(() => {
  innerHeight = window.innerHeight;
  Object.defineProperty(window, "innerHeight", { value: 1_000_000, configurable: true });
});
afterAll(() => Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true }));
afterEach(cleanup);

describe("DiffView integrity", () => {
  it("shows git's diff of every fixture file exactly, collapsed and expanded", () => {
    const all = fixtures();
    expect(all.size).toBeGreaterThanOrEqual(8);
    let checked = 0;
    for (const [name, f] of all) {
      const hunks = parseGit(f.git);
      if (hunks.length === 0) continue; // pure rename: placeholder, covered in DiffView.test
      const added = /\nnew file mode/.test(f.git);
      const deleted = /\ndeleted file mode/.test(f.git);
      checkIntegrity(name, fileDiff(name, added ? null : f.old, deleted ? null : f.new, hunks));
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(7);
  });

  it("keeps both sides intact on pseudo-random edits", () => {
    const rand = rng(0x5eed);
    const words = ["foo", "bar", "\t", "  ", "é", "🎉", "日本", "{", "}", "x = 1;", "return"];
    for (let iter = 0; iter < 60; iter++) {
      const oldLines: string[] = [];
      for (let i = 0, n = rand(120); i < n; i++) {
        let line = "";
        for (let j = 0, m = rand(5); j < m; j++) line += words[rand(words.length)];
        oldLines.push(line);
      }
      const newLines: string[] = [];
      for (const line of oldLines) {
        switch (rand(8)) {
          case 0: // delete
            break;
          case 1: // edit
            newLines.push(words[rand(words.length)] + line);
            break;
          case 2: // insert after
            newLines.push(line, `inserted ${rand(1000)}`);
            break;
          default:
            newLines.push(line);
        }
      }
      const oldText = oldLines.length ? oldLines.join("\n") + "\n" : "";
      const newText = newLines.length ? newLines.join("\n") + (rand(4) ? "\n" : "") : "";
      const hunks = computeHunks(oldText, newText);
      if (hunks.length === 0) continue;
      checkIntegrity(`random #${iter}`, fileDiff(`random-${iter}.ts`, oldText, newText, hunks));
    }
  });
});
