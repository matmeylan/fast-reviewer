import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import Sidebar from "./Sidebar";
import { createMockBackend } from "../lib/mock";
import { createAppStore } from "../lib/store";
import type { Backend } from "../lib/api";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function openWith(backend: Backend) {
  let dispose!: () => void;
  const store = createRoot((d) => {
    dispose = d;
    return createAppStore(backend);
  });
  await store.init();
  await store.openPr({ owner: "acme", repo: "web", number: 482 });
  return { store, dispose };
}

describe("Sidebar", () => {
  it("warns when GitHub truncated the file list", async () => {
    const backend = createMockBackend({ latencyMs: 0 });
    const real = backend.getPr;
    backend.getPr = async (...args) => {
      const d = await real(...args);
      return { ...d, totalFiles: 3412, filesTruncated: true };
    };
    const { store, dispose } = await openWith(backend);
    const { getByTestId } = render(() => <Sidebar store={store} />);
    const n = store.pr()!.files.length;
    expect(getByTestId("files-truncated").textContent).toContain(
      `Showing ${n.toLocaleString()} of ${(3412).toLocaleString()} files — GitHub limits the file list`,
    );
    dispose();
  });

  it("shows no warning for a complete file list", async () => {
    const { store, dispose } = await openWith(createMockBackend({ latencyMs: 0 }));
    const { queryByTestId, getByTestId } = render(() => <Sidebar store={store} />);
    getByTestId("progress");
    expect(queryByTestId("files-truncated")).toBeNull();
    dispose();
  });
});
