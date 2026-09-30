import { describe, expect, it } from "vitest";
import { computeHunks, createMockBackend, intraLine, mockOpenedFiles, myers } from "./mock";

describe("mock diff helper", () => {
  it("myers produces a minimal edit script", () => {
    expect(myers([..."abc"], [..."abc"])).toEqual([0, 0, 0]);
    expect(myers([..."abc"], [..."axc"]).filter((e) => e !== 0)).toHaveLength(2);
    expect(myers([], [..."ab"])).toEqual([2, 2]);
  });

  it("computes hunks with context and line numbers", () => {
    const old = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const next = old.replace("line 10", "line ten").replace("line 20", "line 20\nline 21");
    const hunks = computeHunks(old, next);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 7, oldLines: 7, newStart: 7, newLines: 7 });
    const del = hunks[0].lines.find((l) => l.kind === "del")!;
    const add = hunks[0].lines.find((l) => l.kind === "add")!;
    expect([del.oldNo, del.text, add.newNo, add.text]).toEqual([10, "line 10", 10, "line ten"]);
    expect(add.segments).toEqual([[5, 8]]);
    expect(hunks[1].lines.at(-1)).toMatchObject({ kind: "add", newNo: 21, text: "line 21" });
  });

  it("marks only the changed words", () => {
    expect(intraLine("const a = 1;", "let a = 2;")).toEqual([
      [[0, 5], [10, 11]],
      [[0, 3], [8, 9]],
    ]);
  });

  it("handles added files", () => {
    const [h] = computeHunks("", "a\nb\n");
    expect(h).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
  });
});

describe("mock backend", () => {
  const backend = createMockBackend({ latencyMs: 0 });

  it("serves a realistic PR", async () => {
    const pr = await backend.getPr("acme", "web", 482);
    expect(pr.files.length).toBeGreaterThanOrEqual(25);
    const statuses = new Set(pr.files.map((f) => f.status));
    expect(statuses).toEqual(new Set(["added", "removed", "modified", "renamed"]));
    expect(pr.files.find((f) => f.path === "src/generated/schema.ts")!.additions).toBeGreaterThan(50);
    const d = await backend.getFileDiff("acme", "web", 482, "src/components/Button.tsx");
    expect(d.language).toBe("tsx");
    expect(d.hunks.some((h) => h.lines.some((l) => l.segments?.length))).toBe(true);
  });

  it("persists viewed state", async () => {
    const pr = await backend.getPr("acme", "web", 482);
    await backend.setFileViewed(pr.id, "web/index.html", true);
    const again = await backend.getPr("acme", "web", 482);
    expect(again.files.find((f) => f.path === "web/index.html")!.viewed).toBe("VIEWED");
  });

  it("can start unauthenticated", async () => {
    const b = createMockBackend({ latencyMs: 0, authenticated: false });
    expect((await b.authStatus()).authenticated).toBe(false);
    await expect(b.listInbox()).rejects.toThrow();
    expect((await b.setToken("ghp_abcdef")).login).toBe("octocat");
  });

  it("serves image, SVG and PDF contents consistent with their diffs", async () => {
    const text = (b: Uint8Array) => new TextDecoder().decode(b);
    const [png, svg, pdf] = await Promise.all(
      ["web/assets/logo.png", "web/assets/icon.svg", "docs/guide.pdf"].map((p) => backend.getFileDiff("acme", "web", 482, p)),
    );
    // Like Rust: PNG and PDF are binary, SVG is a text (XML) diff.
    expect([png.binary, pdf.binary, svg.binary]).toEqual([true, true, false]);
    expect(svg.language).toBe("xml");
    expect(svg.hunks.length).toBeGreaterThan(0);

    const oldPng = await backend.getFileContent("acme", "web", 482, "web/assets/logo.png", "old");
    const newPng = await backend.getFileContent("acme", "web", 482, "web/assets/logo.png", "new");
    for (const b of [oldPng, newPng]) expect(text(b.slice(1, 4))).toBe("PNG");
    expect(newPng).not.toEqual(oldPng);
    const newSvg = await backend.getFileContent("acme", "web", 482, "web/assets/icon.svg", "new");
    expect(text(newSvg)).toBe(svg.newText);

    const doc = text(await backend.getFileContent("acme", "web", 482, "docs/guide.pdf", "new"));
    expect(doc.startsWith("%PDF-1.4\n")).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(doc)![1]);
    expect(doc.slice(xref).startsWith("xref\n")).toBe(true);
    // Added: no old version.
    await expect(backend.getFileContent("acme", "web", 482, "docs/guide.pdf", "old")).rejects.toThrow(/Not found/);
  });

  it("records opened files", async () => {
    const before = mockOpenedFiles().length;
    await backend.openFile("acme", "web", 482, "docs/guide.pdf", "new");
    expect(mockOpenedFiles().slice(before)).toEqual([
      { owner: "acme", repo: "web", number: 482, path: "docs/guide.pdf", side: "new" },
    ]);
    await expect(backend.openFile("acme", "web", 482, "api/legacy_auth.py", "new")).rejects.toThrow();
    expect(mockOpenedFiles()).toHaveLength(before + 1);
  });

  it("a slow setFileViewed does not delay getFileDiff (no shared queue)", async () => {
    const b = createMockBackend({ latencyMs: 1, viewedDelayMs: 500 });
    const pr = await b.getPr("acme", "web", 482);
    let viewedDone = false;
    const write = b.setFileViewed(pr.id, "web/index.html", true).then(() => (viewedDone = true));
    const t0 = performance.now();
    const d = await b.getFileDiff("acme", "web", 482, "web/styles.css");
    expect(d.path).toBe("web/styles.css");
    expect(viewedDone).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
    await write;
  });
});

