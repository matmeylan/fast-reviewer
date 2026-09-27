import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import Picker from "./Picker";
import type { AppStore } from "../lib/store";
import type { PrSummary, RepoSummary } from "../lib/types";

afterEach(cleanup);
// jsdom has no layout, so no scrollIntoView.
Element.prototype.scrollIntoView ??= () => {};

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
/** Longer than the picker's search debounce. */
const DEBOUNCE = 260;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const pr = (number: number, updatedAt: string): PrSummary => ({
  owner: "acme",
  repo: "web",
  number,
  title: `Change number ${number}`,
  author: "mona",
  url: `https://github.com/acme/web/pull/${number}`,
  isDraft: false,
  updatedAt,
  reason: "reviewRequested",
});

const repo = (name: string): RepoSummary => ({
  owner: "acme",
  name,
  description: null,
  private: false,
  updatedAt: "2026-01-01T00:00:00Z",
});

function fakeStore(inbox: PrSummary[]) {
  const [inboxSig, setInbox] = createSignal<PrSummary[] | null>(inbox);
  const store = {
    inbox: inboxSig,
    openPr: vi.fn(async () => true),
    setOverlay: vi.fn(),
    searchRepos: vi.fn(async (_q: string): Promise<RepoSummary[]> => []),
    listRepoPrs: vi.fn(async (_o: string, _r: string): Promise<PrSummary[]> => []),
  };
  return { store, setInbox, asApp: store as unknown as AppStore };
}

const activeTitle = (c: HTMLElement) => c.querySelector(".picker-item.active .pi-title")?.textContent;

describe("Picker", () => {
  it("keeps the highlighted PR when a refreshed inbox arrives, so Enter opens it", () => {
    const inbox = [1, 2, 3, 4, 5].map((n) => pr(n, `2026-01-0${9 - n}T00:00:00Z`));
    const { store, setInbox, asApp } = fakeStore(inbox);
    const { container, getByTestId } = render(() => <Picker store={asApp} dismissable />);
    const input = getByTestId("picker-input");
    for (let i = 0; i < 3; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeTitle(container)).toBe("Change number 4");
    // Background refresh: fresh objects, new order (PR 5 was updated most recently).
    setInbox([pr(5, "2026-02-01T00:00:00Z"), ...inbox.slice(0, 4).map((p) => ({ ...p }))]);
    expect(activeTitle(container)).toBe("Change number 4");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(store.openPr).toHaveBeenCalledWith({ owner: "acme", repo: "web", number: 4 });
  });

  it("clamps the highlight when the highlighted PR disappears, and resets on a new query", () => {
    const inbox = [1, 2, 3].map((n) => pr(n, `2026-01-0${9 - n}T00:00:00Z`));
    const { setInbox, asApp } = fakeStore(inbox);
    const { container, getByTestId } = render(() => <Picker store={asApp} dismissable />);
    const input = getByTestId("picker-input") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    setInbox(inbox.slice(0, 2));
    expect(activeTitle(container)).toBe("Change number 2");
    fireEvent.input(input, { target: { value: "Change" } });
    expect(activeTitle(container)).toBe("Change number 1");
  });

  it("keeps the highlight when repo search results land after arrow navigation", async () => {
    const inbox = [1, 2, 3].map((n) => pr(n, `2026-01-0${9 - n}T00:00:00Z`));
    const { store, asApp } = fakeStore(inbox);
    const search = deferred<RepoSummary[]>();
    store.searchRepos.mockReturnValue(search.promise);
    const { container, getByTestId } = render(() => <Picker store={asApp} dismissable />);
    const input = getByTestId("picker-input");
    fireEvent.input(input, { target: { value: "acme" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeTitle(container)).toBe("Change number 2");
    await tick(DEBOUNCE);
    search.resolve([repo("aaa"), repo("bbb")]);
    await tick();
    expect(container.querySelectorAll(".picker-item").length).toBe(5);
    expect(activeTitle(container)).toBe("Change number 2");
  });

  it("drops a late failure of a repo the user already left", async () => {
    const { store, asApp } = fakeStore([]);
    store.searchRepos.mockResolvedValue([repo("alpha"), repo("beta")]);
    const alpha = deferred<PrSummary[]>();
    const beta = deferred<PrSummary[]>();
    store.listRepoPrs.mockImplementation((_o: string, r: string) => (r === "alpha" ? alpha.promise : beta.promise));
    const { container, getByTestId, getAllByTestId } = render(() => <Picker store={asApp} dismissable />);
    const input = () => getByTestId("picker-input");
    const openRepo = async (name: string) => {
      fireEvent.input(input(), { target: { value: "acme" } });
      await tick(DEBOUNCE);
      const item = getAllByTestId("picker-item").find((el) => el.textContent?.includes(name))!;
      fireEvent.click(item);
    };
    await openRepo("alpha");
    fireEvent.keyDown(input(), { key: "Escape" }); // back to the main stage
    await openRepo("beta");
    alpha.reject(new Error("alpha exploded"));
    await tick();
    const empty = () => container.querySelector(".picker-empty")?.textContent;
    expect(empty()).toBe("Loading…");
    beta.resolve([]);
    await tick();
    expect(empty()).toBe("No open pull requests");
  });

  it("clears a repo search error once a new search starts", async () => {
    const { store, asApp } = fakeStore([]);
    store.searchRepos.mockRejectedValueOnce(new Error("rate limited")).mockResolvedValue([]);
    const { container, getByTestId } = render(() => <Picker store={asApp} dismissable />);
    const input = getByTestId("picker-input");
    const empty = () => container.querySelector(".picker-empty")?.textContent;
    fireEvent.input(input, { target: { value: "zz" } });
    await tick(DEBOUNCE);
    expect(empty()).toBe("rate limited");
    fireEvent.input(input, { target: { value: "zzz" } });
    await tick(DEBOUNCE);
    expect(empty()).toBe("No matches");
  });
});
