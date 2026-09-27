import { describe, expect, it } from "vitest";
import { isTypingTarget, keyToAction, nextUnviewed, reduce, upcomingUnviewed, type NavState } from "./keys";

const order = ["a", "b", "c", "d"];
const state = (over: Partial<NavState> & { viewed?: string[] } = {}): NavState => {
  const viewed = new Set(over.viewed ?? []);
  return {
    order,
    current: "a",
    isViewed: (p) => viewed.has(p),
    mode: "split",
    overlay: "none",
    done: false,
    ...over,
  };
};

describe("keyToAction", () => {
  it("maps plain keys", () => {
    expect(keyToAction({ key: "r" }, false)).toBe("review");
    expect(keyToAction({ key: "s" }, false)).toBe("skip");
    expect(keyToAction({ key: "j" }, false)).toBe("next");
    expect(keyToAction({ key: "ArrowDown" }, false)).toBe("next");
    expect(keyToAction({ key: "k" }, false)).toBe("prev");
    expect(keyToAction({ key: "?" }, false)).toBe("help");
    expect(keyToAction({ key: "x" }, false)).toBeNull();
  });

  it("opens the picker with Cmd+K or Ctrl+K, even while typing", () => {
    expect(keyToAction({ key: "k", metaKey: true }, true)).toBe("picker");
    expect(keyToAction({ key: "K", ctrlKey: true }, false)).toBe("picker");
  });

  it("ignores plain shortcuts while typing or with modifiers", () => {
    expect(keyToAction({ key: "r" }, true)).toBeNull();
    expect(keyToAction({ key: "r", metaKey: true }, false)).toBeNull();
    expect(keyToAction({ key: "r", altKey: true }, false)).toBeNull();
    expect(keyToAction({ key: "Escape" }, true)).toBe("escape");
  });

  it("detects typing targets", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("does not treat a focused checkbox or button input as typing", () => {
    const input = (type: string) => Object.assign(document.createElement("input"), { type });
    // The toolbar "Viewed" checkbox keeps focus after a click on WebKitGTK.
    expect(isTypingTarget(input("checkbox"))).toBe(false);
    expect(isTypingTarget(input("radio"))).toBe(false);
    expect(isTypingTarget(input("button"))).toBe(false);
    expect(isTypingTarget(input("range"))).toBe(false);
    expect(isTypingTarget(input("text"))).toBe(true);
    expect(isTypingTarget(input("search"))).toBe(true);
    expect(isTypingTarget(input("password"))).toBe(true);
  });
});

describe("nextUnviewed", () => {
  it("searches forward, wraps, and excludes the start", () => {
    const viewed = new Set(["b"]);
    expect(nextUnviewed(order, "a", (p) => viewed.has(p))).toBe("c");
    expect(nextUnviewed(order, "d", (p) => viewed.has(p))).toBe("a");
    expect(nextUnviewed(order, null, (p) => viewed.has(p))).toBe("a");
    expect(nextUnviewed(["a"], "a", () => false)).toBeNull();
  });
});

describe("reduce", () => {
  it("r marks viewed and jumps to the next unviewed file", () => {
    const u = reduce(state({ current: "a", viewed: ["b"] }), "review");
    expect(u.effects).toEqual([{ type: "setViewed", path: "a", viewed: true }]);
    expect(u.current).toBe("c");
  });

  it("r on an already-viewed file does not re-mark it", () => {
    const u = reduce(state({ current: "a", viewed: ["a"] }), "review");
    expect(u.effects).toEqual([]);
    expect(u.current).toBe("b");
  });

  it("r on the last unviewed file shows the done state", () => {
    const u = reduce(state({ current: "c", viewed: ["a", "b", "d"] }), "review");
    expect(u.effects).toEqual([{ type: "setViewed", path: "c", viewed: true }]);
    expect(u.current).toBeUndefined();
    expect(u.done).toBe(true);
  });

  it("s skips to the next unviewed file without marking", () => {
    const u = reduce(state({ current: "a", viewed: ["b", "c"] }), "skip");
    expect(u.effects).toEqual([]);
    expect(u.current).toBe("d");
  });

  it("s falls back to plain next when everything is viewed", () => {
    expect(reduce(state({ current: "b", viewed: order }), "skip").current).toBe("c");
    expect(reduce(state({ current: "d", viewed: order }), "skip").current).toBe("d");
  });

  it("j/k move in order and clamp at the ends", () => {
    expect(reduce(state({ current: "b" }), "next").current).toBe("c");
    expect(reduce(state({ current: "d" }), "next").current).toBe("d");
    expect(reduce(state({ current: "a" }), "prev").current).toBe("a");
    expect(reduce(state({ current: null }), "next").current).toBe("a");
    expect(reduce(state({ current: "b", done: true }), "prev")).toMatchObject({ current: "a", done: false });
  });

  it("u toggles viewed on the current file", () => {
    expect(reduce(state({ current: "a" }), "toggleViewed").effects).toEqual([
      { type: "setViewed", path: "a", viewed: true },
    ]);
    expect(reduce(state({ current: "a", viewed: ["a"] }), "toggleViewed").effects).toEqual([
      { type: "setViewed", path: "a", viewed: false },
    ]);
  });

  it("v toggles mode", () => {
    expect(reduce(state({ mode: "split" }), "toggleMode").mode).toBe("unified");
    expect(reduce(state({ mode: "unified" }), "toggleMode").mode).toBe("split");
  });

  it("overlays: picker toggles, escape closes, other keys are ignored while open", () => {
    expect(reduce(state(), "picker").overlay).toBe("picker");
    expect(reduce(state({ overlay: "picker" }), "picker").overlay).toBe("none");
    expect(reduce(state({ overlay: "help" }), "escape").overlay).toBe("none");
    expect(reduce(state({ overlay: "help" }), "review")).toEqual({ effects: [] });
    expect(reduce(state(), "escape")).toEqual({ effects: [] });
  });

  it("hunk navigation and open browser are effects", () => {
    expect(reduce(state(), "nextHunk").effects).toEqual([{ type: "nextHunk" }]);
    expect(reduce(state(), "prevHunk").effects).toEqual([{ type: "prevHunk" }]);
    expect(reduce(state(), "openBrowser").effects).toEqual([{ type: "openBrowser" }]);
  });
});

describe("upcomingUnviewed", () => {
  const files = ["a", "b", "c", "d", "e", "f"];
  it("lists the next unviewed files in order, the same ones repeated r visits", () => {
    const viewed = new Set(["c", "d"]);
    const isViewed = (p: string) => viewed.has(p);
    expect(upcomingUnviewed(files, "b", isViewed, 3)).toEqual(["e", "f", "a"]);
    // Cross-check against r: each press lands on the next entry.
    let cur = "b";
    const seen = new Set(viewed);
    for (const want of upcomingUnviewed(files, "b", isViewed, 3)) {
      seen.add(cur);
      const u = reduce({ order: files, current: cur, isViewed: (p) => seen.has(p), mode: "split", overlay: "none", done: false }, "review");
      expect(u.current).toBe(want);
      cur = u.current!;
    }
  });
  it("excludes the current file and stops when everything is viewed", () => {
    expect(upcomingUnviewed(files, "a", (p) => p !== "a", 3)).toEqual([]);
    expect(upcomingUnviewed(files, null, () => false, 2)).toEqual(["a", "b"]);
    expect(upcomingUnviewed([], null, () => false, 3)).toEqual([]);
  });
});
