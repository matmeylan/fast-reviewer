import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "./api";
import { createMockBackend } from "./mock";
import { createAppStore, type AppStore } from "./store";

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
});
