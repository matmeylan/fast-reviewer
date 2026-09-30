import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import MainPane from "./MainPane";
import type { Backend } from "../lib/api";
import { createMockBackend } from "../lib/mock";
import { createAppStore, SWAP_DELAY_MS } from "../lib/store";

const { createObjectURL, revokeObjectURL } = URL;

afterEach(() => {
  cleanup();
  localStorage.clear();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** The fixture PR open in a store, on `path`. */
async function openAt(path: string, backend: Backend = createMockBackend({ latencyMs: 0 })) {
  let dispose!: () => void;
  const store = createRoot((d) => {
    dispose = d;
    return createAppStore(backend);
  });
  await store.init();
  await store.openPr({ owner: "acme", repo: "web", number: 482 });
  store.select(path);
  await tick(SWAP_DELAY_MS + 20);
  return { store, dispose, backend };
}

describe("MainPane", () => {
  it("shows +N −M line counts for a file too large to display", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    const real = backend.getFileDiff;
    backend.getFileDiff = async (...args) => ({ ...(await real(...args)), tooLarge: true, hunks: [] });
    let dispose!: () => void;
    const store = createRoot((d) => {
      dispose = d;
      return createAppStore(backend);
    });
    await store.init();
    await store.openPr({ owner: "acme", repo: "web", number: 482 });
    await tick();
    const file = store.pr()!.files.find((f) => f.path === store.selected())!;
    const { container, getByText } = render(() => <MainPane store={store} />);
    getByText(/File too large to display/);
    const stats = container.querySelector(".diff-stats")!;
    expect(stats).not.toBeNull();
    expect(stats.querySelector(".add")!.textContent).toBe(`+${file.additions}`);
    expect(stats.querySelector(".del")!.textContent).toBe(`−${file.deletions}`);
    dispose();
  });

  it("offers to open a binary file in its default app, with the version it has", async () => {
    const { store, backend, dispose } = await openAt("docs/guide.pdf");
    const open = vi.spyOn(backend, "openFile");
    const { getByText, getAllByTestId } = render(() => <MainPane store={store} />);
    getByText("Binary file not shown");
    // Added: only the new version.
    const [button, ...rest] = getAllByTestId("open-file");
    expect(rest).toHaveLength(0);
    expect(button.textContent).toBe("Open with default app");
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith("acme", "web", 482, "docs/guide.pdf", "new");
    dispose();
  });

  it("offers both versions of a modified binary or too-large file", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    const real = backend.getFileDiff;
    backend.getFileDiff = async (...args) => {
      const d = await real(...args);
      return d.path === "src/lib/api.ts" ? { ...d, binary: true, hunks: [] } : d;
    };
    const open = vi.spyOn(backend, "openFile");
    const { store, dispose } = await openAt("src/lib/api.ts", backend);
    const { getAllByTestId } = render(() => <MainPane store={store} />);
    const buttons = getAllByTestId("open-file");
    expect(buttons.map((b) => [b.textContent, b.dataset.side])).toEqual([
      ["Open new version", "new"],
      ["Open old version", "old"],
    ]);
    fireEvent.click(buttons[1]);
    expect(open).toHaveBeenCalledWith("acme", "web", 482, "src/lib/api.ts", "old");
    await waitFor(() => expect(buttons[1].hasAttribute("disabled")).toBe(false));
    dispose();
  });

  it("toasts when opening fails", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    backend.openFile = () => Promise.reject(new Error("No application knows how to open this file"));
    const { store, dispose } = await openAt("docs/guide.pdf", backend);
    const { getByTestId } = render(() => <MainPane store={store} />);
    fireEvent.click(getByTestId("open-file"));
    await waitFor(() => expect(store.toasts()).toHaveLength(1));
    expect(store.toasts()[0].text).toBe("Couldn't open guide.pdf: No application knows how to open this file");
    dispose();
  });

  it("shows images as images, and SVGs as image or source", async () => {
    // jsdom has no blob URLs.
    Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
    const { store, dispose } = await openAt("web/assets/logo.png");
    const { container, getByTestId, queryByTestId, getByText } = render(() => <MainPane store={store} />);
    expect(getByTestId("image-diff").dataset.path).toBe("web/assets/logo.png");
    expect(queryByTestId("svg-toggle")).toBeNull();
    await waitFor(() => expect(container.querySelectorAll("img[src='blob:test']")).toHaveLength(2));

    store.select("web/assets/icon.svg");
    await tick(SWAP_DELAY_MS + 20);
    expect(getByTestId("image-diff").dataset.path).toBe("web/assets/icon.svg");
    const toggle = getByTestId("svg-toggle");
    expect(toggle.querySelector(".on")!.textContent).toBe("Image");
    fireEvent.click(getByText("Source"));
    expect(queryByTestId("image-diff")).toBeNull();
    expect(container.querySelector('.diff-view[data-path="web/assets/icon.svg"]')).not.toBeNull();
    fireEvent.click(getByText("Image"));
    expect(getByTestId("image-diff")).not.toBeNull();
    dispose();
  });
});
