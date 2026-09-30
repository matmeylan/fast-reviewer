import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import ImageDiff from "./ImageDiff";
import type { Side } from "../lib/types";

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
let blobs: Blob[] = [];
let revoked: string[] = [];

beforeEach(() => {
  blobs = [];
  revoked = [];
  // jsdom has no blob URLs.
  URL.createObjectURL = (b: Blob | MediaSource) => `blob:test/${blobs.push(b as Blob)}`;
  URL.revokeObjectURL = (url: string) => void revoked.push(url);
});

afterEach(() => {
  cleanup();
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

const bytes = (s: string) => new TextEncoder().encode(s);
/** A fake backend: each side's bytes are its name. */
const fakeLoad = () => vi.fn((side: Side) => Promise.resolve(bytes(side === "old" ? "old!" : "brand new")));

const panels = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLElement>('[data-testid="image-side"]')].map((p) => p.dataset.side);

/** jsdom never decodes images: give one a natural size and fire its load event. */
function loadImage(img: HTMLImageElement, w: number, h: number) {
  Object.defineProperty(img, "naturalWidth", { value: w });
  Object.defineProperty(img, "naturalHeight", { value: h });
  fireEvent.load(img);
}

describe("ImageDiff", () => {
  it("shows before and after side by side for a modified image", async () => {
    const load = fakeLoad();
    const { container, getByText } = render(() => (
      <ImageDiff path="web/logo.png" status="modified" mode="split" load={load} />
    ));
    expect(panels(container)).toEqual(["old", "new"]);
    getByText("Before");
    getByText("After");
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    expect(load.mock.calls.map((c) => c[0]).sort()).toEqual(["new", "old"]);
    expect(blobs.map((b) => b.type)).toEqual(["image/png", "image/png"]);
    const [before, after] = container.querySelectorAll("img");
    expect(before.getAttribute("src")).not.toBe(after.getAttribute("src"));
    expect(container.querySelector(".grid-cols-2")).not.toBeNull();

    loadImage(after, 96, 64);
    const meta = () => [...container.querySelectorAll('[data-testid="image-meta"]')].map((m) => m.textContent);
    expect(meta()).toEqual(["4 B", "96 × 64·9 B"]);
  });

  it("stacks the versions in unified mode", async () => {
    const { container } = render(() => (
      <ImageDiff path="web/logo.png" status="modified" mode="unified" load={fakeLoad()} />
    ));
    expect(panels(container)).toEqual(["old", "new"]);
    expect(container.querySelector(".grid-cols-2")).toBeNull();
  });

  it("shows only the version an added or removed image has", async () => {
    const load = fakeLoad();
    const added = render(() => <ImageDiff path="a.gif" status="added" mode="split" load={load} />);
    expect(panels(added.container)).toEqual(["new"]);
    added.getByText("After");
    expect(added.queryByText("Before")).toBeNull();
    await waitFor(() => expect(added.container.querySelector("img")).not.toBeNull());
    expect(load.mock.calls).toEqual([["new"]]);
    added.unmount();

    const load2 = fakeLoad();
    const removed = render(() => <ImageDiff path="a.webp" status="removed" mode="split" load={load2} />);
    expect(panels(removed.container)).toEqual(["old"]);
    removed.getByText("Before");
    expect(load2.mock.calls).toEqual([["old"]]);
  });

  it("shows SVGs as <img> with the SVG type, never as inline markup", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const { container } = render(() => (
      <ImageDiff path="icons/x.SVG" status="added" mode="split" load={() => Promise.resolve(bytes(svg))} />
    ));
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(blobs.map((b) => b.type)).toEqual(["image/svg+xml"]);
    expect(container.querySelector("svg script, script")).toBeNull();
  });

  it("shows a load error in the panel", async () => {
    const load = vi.fn((side: Side) =>
      side === "old" ? Promise.reject(new Error("Not found on GitHub: a.png")) : Promise.resolve(bytes("x")),
    );
    const { container, findByText } = render(() => <ImageDiff path="a.png" status="modified" mode="split" load={load} />);
    await findByText("Not found on GitHub: a.png");
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });

  it("revokes blob URLs when it goes away or the file changes", async () => {
    const [path, setPath] = createSignal("a.png");
    const { container, unmount } = render(() => (
      <ImageDiff path={path()} status="modified" mode="split" load={fakeLoad()} />
    ));
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    expect(revoked).toEqual([]);
    setPath("b.jpg");
    expect(revoked.sort()).toEqual(["blob:test/1", "blob:test/2"]);
    await waitFor(() => expect(blobs.map((b) => b.type)).toContain("image/jpeg"));
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    unmount();
    expect(revoked.sort()).toEqual(["blob:test/1", "blob:test/2", "blob:test/3", "blob:test/4"]);
  });

  it("opens a version from its caption", async () => {
    const onOpen = vi.fn((_side: Side) => Promise.resolve());
    const { getAllByTestId } = render(() => (
      <ImageDiff path="a.png" status="modified" mode="split" load={fakeLoad()} onOpen={onOpen} />
    ));
    const buttons = getAllByTestId("open-file");
    expect(buttons.map((b) => b.dataset.side)).toEqual(["old", "new"]);
    fireEvent.click(buttons[0]);
    expect(onOpen).toHaveBeenCalledWith("old");
  });
});
