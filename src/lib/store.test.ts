import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "./api";
import { createMockBackend } from "./mock";
import { nextUnviewed } from "./keys";
import { createAppStore, DIFF_CACHE_MAX, PREFETCH, type AppStore } from "./store";
import type { PrDetail } from "./types";

const SWAP_WAIT = 100;
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

  it("shows added files unified, then returns to the preferred split", async () => {
    const { store, dispose } = setup();
    await openMain(store);
    const show = async (path: string) => {
      store.select(path);
      await vi.waitFor(() => expect(store.diff().diff?.path).toBe(path));
    };
    await show("api/server.py");
    expect(store.viewMode()).toBe("split");

    await show("api/__init__.py");
    expect(store.viewMode()).toBe("unified");
    expect(store.mode()).toBe("split");
    // Picking the mode already shown doesn't change the preference.
    store.setMode("unified");
    expect(store.mode()).toBe("split");

    await show("api/server.py");
    expect(store.viewMode()).toBe("split");

    // v on an added file shows it split, and keeps split as the preference.
    await show("tests/test_orders.py");
    store.dispatch("toggleMode");
    expect(store.viewMode()).toBe("split");
    expect(store.mode()).toBe("split");
    // Another added file is unified again.
    await show("api/__init__.py");
    expect(store.viewMode()).toBe("unified");
    dispose();
  });

  it("keeps a unified preference on added files", async () => {
    const { store, dispose } = setup();
    await openMain(store);
    store.setMode("unified");
    store.select("api/__init__.py");
    await vi.waitFor(() => expect(store.diff().diff?.path).toBe("api/__init__.py"));
    expect(store.viewMode()).toBe("unified");
    store.dispatch("toggleMode");
    expect(store.viewMode()).toBe("split");
    expect(store.mode()).toBe("split");
    dispose();
  });

  it("filter narrows the navigation order", async () => {
    const { store, dispose } = setup();
    await openMain(store);
    store.setFilter("web/");
    expect(store.order()).toEqual(["web/assets/icon.svg", "web/assets/logo.png", "web/index.html", "web/styles.css"]);
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

describe("PR switching", () => {
  it("ignores review and navigation keys while another PR is loading", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    const { store, dispose } = setup(backend);
    await openMain(store);
    const before = store.selected()!;
    const viewedSpy = vi.spyOn(backend, "setFileViewed");
    let release!: () => void;
    const realGetPr = backend.getPr;
    backend.getPr = (...args) => new Promise<void>((r) => (release = r)).then(() => realGetPr(...args));
    const opening = store.openPr({ owner: "acme", repo: "api", number: 91 });
    expect(store.prLoading()).not.toBeNull();
    for (const a of ["review", "toggleViewed", "skip", "next", "prev", "toggleMode"] as const) store.dispatch(a);
    expect(viewedSpy).not.toHaveBeenCalled();
    expect(store.viewed[before]).toBe(false);
    expect(store.selected()).toBe(before);
    expect(store.mode()).toBe("split");
    // The picker still opens.
    store.dispatch("picker");
    expect(store.overlay()).toBe("picker");
    release();
    await opening;
    expect(store.pr()!.repo).toBe("api");
    dispose();
  });

  it("drops a slow diff from the previous PR when the new PR has no files", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    const { store, dispose } = setup(backend);
    await openMain(store);
    const realGetFileDiff = backend.getFileDiff;
    let release!: () => void;
    backend.getFileDiff = (...args) => new Promise<void>((r) => (release = r)).then(() => realGetFileDiff(...args));
    // The last file of PR A is outside the prefetch window, so its diff is not cached yet.
    const slow = store.order()[store.order().length - 1];
    store.select(slow);
    expect(store.diff().path).not.toBe(slow);
    const realGetPr = backend.getPr;
    backend.getPr = async (...args): Promise<PrDetail> => ({ ...(await realGetPr(...args)), files: [] });
    await store.openPr({ owner: "acme", repo: "api", number: 91 });
    await tick(SWAP_WAIT);
    release();
    await tick();
    expect(store.pr()!.files).toHaveLength(0);
    expect(store.diff()).toEqual({ path: null, diff: null, loading: false, error: null });
    dispose();
  });
});

describe("diff cache", () => {
  it("keeps at most DIFF_CACHE_MAX diffs and re-fetches evicted ones", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    const spy = vi.spyOn(backend, "getFileDiff");
    const { store, dispose } = setup(backend);
    await store.init();
    await store.openPr({ owner: "acme", repo: "monorepo", number: 9000 });
    await tick();
    const order = store.order();
    const first = order[0];
    store.select(first);
    await tick();
    // Walk well past the cache size.
    for (let i = 1; i <= DIFF_CACHE_MAX * 2; i++) {
      store.select(order[i]);
      await tick(1);
    }
    await tick();
    const calls = (p: string) => spy.mock.calls.filter((c) => c[3] === p).length;
    expect(calls(first)).toBe(1);
    // A recent file is still cached: no new request, shown synchronously.
    const recent = order[DIFF_CACHE_MAX * 2 - 1];
    store.select(recent);
    expect(store.diff().diff?.path).toBe(recent);
    expect(calls(recent)).toBe(1);
    // The first file was evicted: it is fetched again.
    store.select(first);
    expect(calls(first)).toBe(2);
    await tick();
    expect(store.diff().diff?.path).toBe(first);
    dispose();
  });

  it("reads and opens files of the current PR; a failed open becomes a toast", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    const open = vi.spyOn(backend, "openFile");
    const { store, dispose } = setup(backend);
    await openMain(store);
    const png = await store.fileContent("web/assets/logo.png", "new");
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
    await store.openFile("docs/guide.pdf", "new");
    expect(open).toHaveBeenCalledWith("acme", "web", 482, "docs/guide.pdf", "new");
    expect(store.toasts()).toHaveLength(0);
    // An added file has no old version.
    await store.openFile("docs/guide.pdf", "old");
    expect(store.toasts()).toHaveLength(1);
    expect(store.toasts()[0].text).toMatch(/^Couldn't open guide\.pdf: Not found/);
    dispose();
  });
});

describe("review submission", () => {
  it("comments on the reviewed head commit, clears the draft and toasts", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    const { store, dispose } = setup(backend);
    await openMain(store);
    store.setReviewDraft("  Looks good, one nit  ");
    const done = store.submitReview("COMMENT");
    expect(store.reviewSubmitting()).toBe(true);
    expect(await done).toBe(true);
    expect(store.reviewSubmitting()).toBe(false);
    expect(store.reviewDraft()).toBe("");
    expect(store.reviewResult()).toMatchObject({ event: "COMMENT", state: "COMMENTED" });
    expect(store.reviewResult()!.url).toContain(store.pr()!.url);
    expect(store.toasts()).toMatchObject([{ text: "Review submitted", kind: "info" }]);
    expect(backend.reviews).toMatchObject([
      { owner: "acme", repo: "web", number: 482, event: "COMMENT", body: "Looks good, one nit", commitId: store.pr()!.headSha },
    ]);
    dispose();
  });

  it("approves without a comment", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    const { store, dispose } = setup(backend);
    await openMain(store);
    expect(store.ownPr()).toBe(false);
    expect(await store.submitReview("APPROVE")).toBe(true);
    expect(store.reviewResult()?.state).toBe("APPROVED");
    expect(store.toasts()).toMatchObject([{ text: "Approved", kind: "info" }]);
    expect(backend.reviews[0]).toMatchObject({ event: "APPROVE", body: "" });
    dispose();
  });

  it("does not send a comment without text", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    const spy = vi.spyOn(backend, "submitReview");
    const { store, dispose } = setup(backend);
    await openMain(store);
    store.setReviewDraft(" \n ");
    expect(await store.submitReview("COMMENT")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(store.reviewSubmitting()).toBe(false);
    dispose();
  });

  it("keeps the draft and shows the error when GitHub rejects the review", async () => {
    const { store, dispose } = setup(createMockBackend({ latencyMs: 0, failReview: true }));
    await openMain(store);
    store.setReviewDraft("Ship it");
    expect(await store.submitReview("APPROVE")).toBe(false);
    expect(store.reviewError()).toBe("GitHub API error 502: Server Error");
    expect(store.reviewDraft()).toBe("Ship it");
    expect(store.reviewSubmitting()).toBe(false);
    expect(store.reviewResult()).toBeNull();
    // A retry clears the old error while it runs.
    const retry = store.submitReview("COMMENT");
    expect(store.reviewError()).toBeNull();
    await retry;
    dispose();
  });

  it("knows the viewer's own PR, which GitHub will not let them approve", async () => {
    const { store, dispose } = setup();
    await store.init();
    await store.openPr({ owner: "acme", repo: "web", number: 475 });
    expect(store.ownPr()).toBe(true);
    expect(await store.submitReview("APPROVE")).toBe(false);
    expect(store.reviewError()).toBe("GitHub API error 422: Can not approve your own pull request");
    dispose();
  });

  it("keeps the draft per PR: reset when another PR opens, kept when the same one reloads", async () => {
    const { store, dispose } = setup();
    await openMain(store);
    store.setReviewDraft("half-written");
    await store.openPr({ owner: "acme", repo: "web", number: 482 });
    expect(store.reviewDraft()).toBe("half-written");
    await store.openPr({ owner: "acme", repo: "api", number: 91 });
    expect(store.reviewDraft()).toBe("");
    dispose();
  });

  it("a review that finishes after switching PRs only toasts", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    let finish!: () => void;
    const submit = backend.submitReview;
    backend.submitReview = (...args) =>
      new Promise((resolve, reject) => {
        finish = () => void submit(...args).then(resolve, reject);
      });
    const { store, dispose } = setup(backend);
    await openMain(store);
    store.setReviewDraft("LGTM");
    const pending = store.submitReview("COMMENT");
    await store.openPr({ owner: "acme", repo: "api", number: 91 });
    expect(store.reviewSubmitting()).toBe(false);
    finish();
    expect(await pending).toBe(false);
    expect(store.reviewResult()).toBeNull();
    expect(store.toasts().at(-1)).toMatchObject({ text: "Review submitted on acme/web#482", kind: "info" });
    dispose();
  });

  it("opens the submitted review on GitHub and can start over", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    const open = vi.spyOn(backend, "openUrl").mockResolvedValue();
    const { store, dispose } = setup(backend);
    await openMain(store);
    await store.submitReview("APPROVE");
    store.openReview();
    expect(open).toHaveBeenCalledWith(store.reviewResult()!.url);
    store.newReview();
    expect(store.reviewResult()).toBeNull();
    dispose();
  });
});
