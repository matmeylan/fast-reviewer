import { describe, expect, it } from "vitest";
import { computeHunks, createMockBackend, intraLine, myers } from "./mock";

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
});
