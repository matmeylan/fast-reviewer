import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import App from "../App";
import ReviewForm, { OWN_PR_HINT } from "./ReviewForm";
import { createMockBackend, type MockBackend } from "../lib/mock";
import { createAppStore } from "../lib/store";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
// jsdom has no layout, so no scrollIntoView.
Element.prototype.scrollIntoView ??= () => {};

async function setup(opts: { failReview?: boolean; number?: number } = {}) {
  const backend = createMockBackend({ latencyMs: 0, failReview: opts.failReview });
  let dispose!: () => void;
  const store = createRoot((d) => {
    dispose = d;
    return createAppStore(backend);
  });
  await store.init();
  await store.openPr({ owner: "acme", repo: "web", number: opts.number ?? 482 });
  const view = render(() => <ReviewForm store={store} />);
  const body = view.getByTestId("review-body") as HTMLTextAreaElement;
  const comment = view.getByTestId("review-comment") as HTMLButtonElement;
  const approve = view.getByTestId("review-approve") as HTMLButtonElement;
  return { backend, store, dispose, view, body, comment, approve };
}

const type = (el: HTMLTextAreaElement, text: string) => fireEvent.input(el, { target: { value: text } });

describe("ReviewForm", () => {
  it("enables Comment only once there is text, and is not focused by default", async () => {
    const { dispose, body, comment, approve } = await setup();
    expect(document.activeElement).not.toBe(body);
    expect(comment.disabled).toBe(true);
    expect(approve.disabled).toBe(false);
    type(body, "  \n ");
    expect(comment.disabled).toBe(true);
    type(body, "Nit: rename this");
    expect(comment.disabled).toBe(false);
    dispose();
  });

  it("cannot approve your own PR, and says why", async () => {
    const { store, dispose, body, comment, approve } = await setup({ number: 475 });
    expect(store.ownPr()).toBe(true);
    expect(approve.disabled).toBe(true);
    expect(approve.parentElement!.title).toBe(OWN_PR_HINT);
    type(body, "Self-review");
    expect(comment.disabled).toBe(false);
    dispose();
  });

  it.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])("%s+Enter submits a comment, then offers another review", async (_name, mod) => {
    const { backend, dispose, view, body } = await setup();
    // Nothing to send yet.
    fireEvent.keyDown(body, { key: "Enter", ...mod });
    await Promise.resolve();
    expect(backend.reviews).toEqual([]);
    type(body, "Looks good, one nit");
    fireEvent.keyDown(body, { key: "Enter", ...mod });
    const success = await view.findByTestId("review-success");
    expect(success.textContent).toContain("Review submitted");
    expect(backend.reviews).toMatchObject([{ event: "COMMENT", body: "Looks good, one nit" }]);
    fireEvent.click(view.getByTestId("review-again"));
    expect(view.queryByTestId("review-success")).toBeNull();
    expect((view.getByTestId("review-body") as HTMLTextAreaElement).value).toBe("");
    dispose();
  });

  it("approves, disabling both buttons while it runs, and links to the review", async () => {
    const { backend, store, dispose, view, body, comment, approve } = await setup();
    const open = vi.spyOn(backend, "openUrl").mockResolvedValue();
    type(body, "Ship it");
    fireEvent.click(approve);
    expect(store.reviewSubmitting()).toBe(true);
    expect(comment.disabled).toBe(true);
    expect(approve.disabled).toBe(true);
    expect(approve.querySelector("[role=status]")).not.toBeNull();
    expect(comment.querySelector("[role=status]")).toBeNull();
    const success = await view.findByTestId("review-success");
    expect(success.textContent).toContain("Approved");
    expect(backend.reviews).toMatchObject([{ event: "APPROVE", body: "Ship it" }]);
    fireEvent.click(view.getByTestId("review-open"));
    expect(open).toHaveBeenCalledWith(store.reviewResult()!.url);
    dispose();
  });

  it("shows GitHub's error and keeps the draft", async () => {
    const { dispose, view, body, approve } = await setup({ failReview: true });
    type(body, "Ship it");
    fireEvent.click(approve);
    const error = await view.findByTestId("review-error");
    expect(error.textContent).toBe("GitHub API error 502: Server Error");
    expect(body.value).toBe("Ship it");
    expect(body.getAttribute("aria-invalid")).toBe("true");
    expect(view.queryByTestId("review-success")).toBeNull();
    dispose();
  });
});

describe("review in the app", () => {
  /** The app on a one-file PR (the mock's octocat/dotfiles#12), with its file marked viewed. */
  async function reviewedApp(backend: MockBackend) {
    localStorage.setItem("fr.lastPr", JSON.stringify({ owner: "octocat", repo: "dotfiles", number: 12 }));
    const view = render(() => <App backend={backend} />);
    await view.findByTestId("current-path");
    fireEvent.keyDown(window, { key: "r" });
    await view.findByTestId("all-reviewed");
    return view;
  }

  it("typing shortcut keys into the done screen's form does not navigate", async () => {
    const view = await reviewedApp(createMockBackend({ latencyMs: 0 }));
    const body = view.getByTestId("review-body") as HTMLTextAreaElement;
    body.focus();
    for (const key of ["j", "k", "r", "s", "a", "u"]) fireEvent.keyDown(body, { key });
    expect(view.queryByTestId("all-reviewed")).not.toBeNull();
    expect(view.queryByTestId("review-dialog")).toBeNull();
    // The same key outside the textarea does navigate.
    fireEvent.keyDown(document.body, { key: "k" });
    await waitFor(() => expect(view.queryByTestId("all-reviewed")).toBeNull());
  });

  it("a opens the review dialog focused on the comment; Esc closes it", async () => {
    const view = await reviewedApp(createMockBackend({ latencyMs: 0 }));
    fireEvent.keyDown(window, { key: "a" });
    const dialog = view.getByTestId("review-dialog");
    expect(document.activeElement).toBe(dialog.querySelector("textarea"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(view.queryByTestId("review-dialog")).toBeNull();
  });
});
