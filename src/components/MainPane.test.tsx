import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import MainPane from "./MainPane";
import { createMockBackend } from "../lib/mock";
import { createAppStore } from "../lib/store";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

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
});
