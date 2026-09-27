import { describe, expect, it } from "vitest";
import { buildTree, compareNames, filterFiles, flattenFiles, visibleRows, type DirNode } from "./tree";
import type { ChangedFile } from "./types";

const f = (path: string, additions = 1, deletions = 0): ChangedFile => ({
  path,
  previousPath: null,
  status: "modified",
  additions,
  deletions,
  viewed: "UNVIEWED",
});

const names = (dir: DirNode) => dir.children.map((c) => c.name);

describe("compareNames", () => {
  it("is case-insensitive and natural", () => {
    const list = ["b.ts", "A.ts", "file10.ts", "file2.ts", "a.ts", "File1.ts"];
    expect([...list].sort(compareNames)).toEqual(["A.ts", "a.ts", "b.ts", "File1.ts", "file2.ts", "file10.ts"]);
  });
});

describe("buildTree", () => {
  it("puts folders first, then files, alphabetically", () => {
    const t = buildTree([f("z.md"), f("b/x.ts"), f("A.md"), f("a/y.ts"), f("C/z.ts")]);
    expect(names(t)).toEqual(["a", "b", "C", "A.md", "z.md"]);
  });

  it("compacts single-child folder chains", () => {
    const t = buildTree([f("src/lib/utils/a.ts"), f("src/lib/utils/b.ts"), f("README.md")]);
    expect(names(t)).toEqual(["src/lib/utils", "README.md"]);
    const dir = t.children[0] as DirNode;
    expect(dir.path).toBe("src/lib/utils");
    expect(names(dir)).toEqual(["a.ts", "b.ts"]);
  });

  it("stops compaction where a folder has files or several children", () => {
    const t = buildTree([f("src/a.ts"), f("src/lib/x/b.ts"), f("src/lib/y/c.ts")]);
    const src = t.children[0] as DirNode;
    expect(src.name).toBe("src");
    expect(names(src)).toEqual(["lib", "a.ts"]);
    expect(names(src.children[0] as DirNode)).toEqual(["x", "y"]);
  });

  it("aggregates additions, deletions and file counts on folders", () => {
    const t = buildTree([f("a/b/one.ts", 3, 1), f("a/b/two.ts", 2, 5), f("a/c.ts", 1, 1)]);
    const a = t.children[0] as DirNode;
    expect([a.additions, a.deletions, a.fileCount]).toEqual([6, 7, 3]);
    const b = a.children[0] as DirNode;
    expect([b.additions, b.deletions, b.fileCount]).toEqual([5, 6, 2]);
    expect([t.additions, t.deletions, t.fileCount]).toEqual([6, 7, 3]);
  });
});

describe("flattenFiles", () => {
  it("returns files in visual order", () => {
    const t = buildTree([
      f("web/styles.css"),
      f("README.md"),
      f("src/components/Button.tsx"),
      f("src/lib/api.ts"),
      f("src/App.tsx"),
      f("api/server.py"),
      f("docs/step10.md"),
      f("docs/step2.md"),
    ]);
    expect(flattenFiles(t)).toEqual([
      "api/server.py",
      "docs/step2.md",
      "docs/step10.md",
      "src/components/Button.tsx",
      "src/lib/api.ts",
      "src/App.tsx",
      "web/styles.css",
      "README.md",
    ]);
  });

  it("handles 5000 files quickly", () => {
    const files = Array.from({ length: 5000 }, (_, i) => f(`pkg${i % 50}/src/dir${i % 7}/file${i}.ts`));
    const t0 = performance.now();
    const t = buildTree(files);
    const order = flattenFiles(t);
    expect(order).toHaveLength(5000);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("visibleRows", () => {
  it("omits children of collapsed folders and tracks depth", () => {
    const t = buildTree([f("a/x.ts"), f("a/b/y.ts"), f("a/b/z.ts"), f("r.md")]);
    const all = visibleRows(t, () => false).map((r) => `${r.depth}:${r.node.name}`);
    expect(all).toEqual(["0:a", "1:b", "2:y.ts", "2:z.ts", "1:x.ts", "0:r.md"]);
    const collapsed = visibleRows(t, (p) => p === "a/b").map((r) => r.node.name);
    expect(collapsed).toEqual(["a", "b", "x.ts", "r.md"]);
  });
});

describe("filterFiles", () => {
  const files = [f("src/lib/api.ts"), f("src/components/Api.tsx"), f("web/index.html")];
  it("matches every token case-insensitively", () => {
    expect(filterFiles(files, "API").map((x) => x.path)).toEqual(["src/lib/api.ts", "src/components/Api.tsx"]);
    expect(filterFiles(files, "src tsx").map((x) => x.path)).toEqual(["src/components/Api.tsx"]);
    expect(filterFiles(files, "  ")).toBe(files);
  });
});
