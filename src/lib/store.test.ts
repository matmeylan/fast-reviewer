import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "./api";
import { createMockBackend } from "./mock";
import { nextUnviewed } from "./keys";
import { createAppStore, PREFETCH, type AppStore } from "./store";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function setup(backend: Backend = createMockBackend({ latencyMs: 0 })) {
  let dispose!: () => void;
  const store = createRoot((d) => {
    dispose = d;
    return createAppStore(backend);
  });
  return { store, dispose, backend };
}

async function openMain(store: AppStore) {
  await store.init();
  await store.openPr({ owner: "acme", repo: "web", number: 482 });
  await tick();
}

afterEach(() => localStorage.clear());

interface Deferred {
  path: string;
  viewed: boolean;
  resolve: () => void;
  reject: (e: Error) => void;
}

/** Mock backend whose setFileViewed calls stay pending until the test settles them. */
function manualViewedBackend() {
  const backend = createMockBackend({ latencyMs: 0 });
  const calls: Deferred[] = [];
  backend.setFileViewed = (_prId, path, viewed) =>
    new Promise<void>((resolve, reject) => calls.push({ path, viewed, resolve, reject }));
  return { backend, calls };
}

describe("app store", () => {
  it("opens a PR, selects the first unviewed file and loads its diff", async () => {
    const { store, dispose } = setup();
    await openMain(store);
    const first = store.order().find((p) => !store.viewed[p]);
    expect(store.selected()).toBe(first);
    expect(store.diff().diff?.path).toBe(first);
    expect(store.viewedCount()).toBe(2);
    dispose();
  });

  it("prefetches the next files so r/s swap instantly", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    const spy = vi.spyOn(backend, "getFileDiff");
    const { store, dispose } = setup(backend);
    await openMain(store);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4);
    const current = store.selected()!;
    store.dispatch("skip");
    const next = store.selected()!;
    expect(next).not.toBe(current);
    // Synchronous: the prefetched diff is already on screen.
    expect(store.diff().diff?.path).toBe(next);
    dispose();
  });

  it("r marks viewed optimistically and moves on", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    const spy = vi.spyOn(backend, "setFileViewed");
    const { store, dispose } = setup(backend);
    await openMain(store);
    const current = store.selected()!;
    store.dispatch("review");
    expect(store.viewed[current]).toBe(true);
    expect(store.viewedCount()).toBe(3);
    expect(store.selected()).not.toBe(current);
    expect(spy).toHaveBeenCalledWith(store.pr()!.id, current, true);
    dispose();
  });

  it("rolls back and toasts when GitHub rejects the change", async () => {
    const { store, dispose } = setup(createMockBackend({ latencyMs: 0, failViewed: true }));
    await openMain(store);
    const current = store.selected()!;
    store.dispatch("review");
    expect(store.viewed[current]).toBe(true);
    await tick();
    expect(store.viewed[current]).toBe(false);
    expect(store.viewedCount()).toBe(2);
    expect(store.toasts()).toHaveLength(1);
    dispose();
  });

  it("shows the done state after reviewing the last file", async () => {
    const { store, dispose } = setup();
    await openMain(store);
    const total = store.order().length;
    for (let i = 0; i < total && !store.done(); i++) store.dispatch("review");
    expect(store.done()).toBe(true);
    expect(store.viewedCount()).toBe(total);
    store.dispatch("prev");
    expect(store.done()).toBe(false);
    dispose();
  });

  it("persists mode and reopens the last PR", async () => {
    const { store, dispose } = setup();
    await openMain(store);
    store.dispatch("toggleMode");
    expect(store.mode()).toBe("unified");
    dispose();

    const again = setup();
    await again.store.init();
    expect(again.store.mode()).toBe("unified");
    expect(again.store.pr()?.number).toBe(482);
    again.dispose();
  });

  it("filter narrows the navigation order", async () => {
    const { store, dispose } = setup();
    await openMain(store);
    store.setFilter("web/");
    expect(store.order()).toEqual(["web/assets/logo.png", "web/index.html", "web/styles.css"]);
    dispose();
  });

  it("prefetches the next unviewed files in tree order (where r/s go), skipping viewed ones", async () => {
    const { backend } = manualViewedBackend();
    const spy = vi.spyOn(backend, "getFileDiff");
    const { store, dispose } = setup(backend);
    await openMain(store);
    const o = store.order();
    const at = o.indexOf("api/server.py");
    // The two files right after api/server.py are already viewed.
    store.markViewed(o[at + 1], true);
    store.markViewed(o[at + 2], true);
    spy.mockClear();
    store.select("api/server.py");
    const fetched = spy.mock.calls.map((c) => c[3]);
    const upcoming = [o[at + 3], o[at + 4], o[at + 5]];
    expect(PREFETCH).toBe(3);
    for (const p of upcoming) expect(fetched).toContain(p);
    expect(fetched).not.toContain(o[at + 6]);
    // They are exactly the next r / s targets, so those swaps are synchronous.
    await tick();
    for (const p of upcoming) {
      store.dispatch("skip");
      expect(store.selected()).toBe(p);
      expect(store.diff().diff?.path).toBe(p);
    }
    dispose();
  });

  it("prefetch wraps around to unviewed files before the current one", async () => {
    const { backend } = manualViewedBackend();
    const spy = vi.spyOn(backend, "getFileDiff");
    const { store, dispose } = setup(backend);
    await openMain(store);
    const o = store.order();
    // Only o[5] and o[6] stay unviewed; from o[10] the next unviewed files wrap around to them.
    for (const p of o) if (p !== o[5] && p !== o[6]) store.markViewed(p, true);
    spy.mockClear();
    store.select(o[10]);
    const fetched = spy.mock.calls.map((c) => c[3]);
    expect(fetched).toEqual(expect.arrayContaining([o[5], o[6]]));
    expect(fetched).toContain(o[11]); // the next file in order, for j
    dispose();
  });
});

describe("r never waits for GitHub", () => {
  it("advances synchronously through 5 files while every setFileViewed is still pending", async () => {
    const { backend, calls } = manualViewedBackend();
    const { store, dispose } = setup(backend);
    await openMain(store);
    const isViewed = (x: string) => !!store.viewed[x];
    const start = store.viewedCount();
    const first = store.selected()!;
    const second = nextUnviewed(store.order(), first, isViewed);
    // The prefetched next file is on screen in the same tick as the key press.
    store.dispatch("review");
    expect(store.viewed[first]).toBe(true);
    expect(store.selected()).toBe(second);
    expect(store.diff().diff?.path).toBe(second);
    // Four more presses, back to back, without awaiting anything.
    const visited = [first, second!];
    for (let i = 0; i < 4; i++) {
      const cur = store.selected()!;
      const expected = nextUnviewed(store.order(), cur, (x) => x === cur || isViewed(x));
      store.dispatch("review");
      expect(store.viewed[cur]).toBe(true);
      expect(store.selected()).toBe(expected);
      visited.push(store.selected()!);
    }
    expect(new Set(visited).size).toBe(6);
    expect(store.viewedCount()).toBe(start + 5);
    expect(calls.map((c) => c.path)).toEqual(visited.slice(0, 5));
    expect(calls.every((c) => c.viewed)).toBe(true);
    // Nothing resolved yet, nothing rolled back.
    await tick(20);
    expect(store.viewedCount()).toBe(start + 5);
    expect(store.toasts()).toHaveLength(0);
    dispose();
  });

  it("with a 2s GitHub write, each r shows the next (prefetched) diff immediately", async () => {
    const backend = createMockBackend({ latencyMs: 0, viewedDelayMs: 2000 });
    const { store, dispose } = setup(backend);
    await openMain(store);
    for (let i = 0; i < 5; i++) {
      const cur = store.selected()!;
      const t0 = performance.now();
      store.dispatch("review");
      const next = store.selected()!;
      expect(next).not.toBe(cur);
      expect(store.viewed[cur]).toBe(true);
      expect(store.diff().diff?.path).toBe(next);
      expect(performance.now() - t0).toBeLessThan(50);
      // Give the prefetch of the following files (0ms mock latency) a moment; the writes are still pending.
      await tick();
    }
    dispose();
  });

  it("loads a diff that was not prefetched while setFileViewed is pending", async () => {
    const { backend, calls } = manualViewedBackend();
    const { store, dispose } = setup(backend);
    await openMain(store);
    store.dispatch("review");
    expect(calls).toHaveLength(1);
    const far = store.order().at(-3)!;
    store.select(far);
    await tick();
    expect(store.diff()).toMatchObject({ path: far, loading: false, error: null });
    expect(store.diff().diff?.path).toBe(far);
    dispose();
  });

  it("rolls back and toasts when a pending write is rejected later", async () => {
    const { backend, calls } = manualViewedBackend();
    const { store, dispose } = setup(backend);
    await openMain(store);
    const first = store.selected()!;
    store.dispatch("review");
    store.dispatch("review");
    const second = calls[1].path;
    expect(store.viewedCount()).toBe(4);
    calls[0].reject(new Error("GitHub API error: 502"));
    calls[1].resolve();
    await tick();
    expect(store.viewed[first]).toBe(false);
    expect(store.viewed[second]).toBe(true);
    expect(store.viewedCount()).toBe(3);
    expect(store.toasts()).toHaveLength(1);
    expect(store.toasts()[0].text).toContain("502");
    // Navigation is unaffected by the rollback.
    expect(store.selected()).not.toBe(first);
    dispose();
  });

  it("a late rejection of an older toggle does not clobber a newer state", async () => {
    const { backend, calls } = manualViewedBackend();
    const { store, dispose } = setup(backend);
    await openMain(store);
    const path = store.selected()!;
    store.dispatch("toggleViewed"); // -> viewed (call 0)
    store.dispatch("toggleViewed"); // -> unviewed (call 1)
    expect(calls.map((c) => c.viewed)).toEqual([true, false]);
    calls[1].resolve();
    await tick();
    calls[0].reject(new Error("timeout"));
    await tick();
    expect(store.viewed[path]).toBe(false);
    expect(store.viewedCount()).toBe(2);
    expect(store.toasts()).toHaveLength(0);

    // Same when the older write fails while the newer one is still pending.
    store.dispatch("toggleViewed"); // -> viewed (call 2)
    store.dispatch("toggleViewed"); // -> unviewed (call 3)
    store.dispatch("toggleViewed"); // -> viewed (call 4)
    calls[2].reject(new Error("late"));
    calls[3].reject(new Error("late"));
    await tick();
    expect(store.viewed[path]).toBe(true);
    expect(store.viewedCount()).toBe(3);
    expect(store.toasts()).toHaveLength(0);
    // The newest one failing does roll back.
    calls[4].reject(new Error("502"));
    await tick();
    expect(store.viewed[path]).toBe(false);
    expect(store.toasts()).toHaveLength(1);
    dispose();
  });
});
