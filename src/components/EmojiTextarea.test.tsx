import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { EmojiTextarea } from "./EmojiTextarea";

afterEach(cleanup);

function setup() {
  const onKeyDown = vi.fn();
  const [value, setValue] = createSignal("");
  const view = render(() => (
    <EmojiTextarea value={value()} onInput={(e) => setValue(e.currentTarget.value)} onKeyDown={onKeyDown} data-testid="box" />
  ));
  const box = view.getByTestId("box") as HTMLTextAreaElement;
  box.focus();
  const type = (text: string, data = text.slice(-1)) =>
    fireEvent.input(box, { target: { value: text }, inputType: "insertText", data });
  const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(box, { key: k, ...init });
  const menu = () => document.querySelector("[data-testid=emoji-menu]");
  const options = () => [...document.querySelectorAll("[data-testid=emoji-option]")].map((o) => o.textContent);
  return { box, value, onKeyDown, type, key, menu, options };
}

describe("EmojiTextarea", () => {
  it("suggests emoji for a :shortcode and inserts the picked one", async () => {
    const { box, value, onKeyDown, type, key, menu, options } = setup();
    type("ship it :tad");
    await waitFor(() => expect(options()[0]).toBe("🎉:tada:"));
    expect(box.getAttribute("aria-expanded")).toBe("true");
    key("Enter");
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(value()).toBe("ship it 🎉 ");
    expect(menu()).toBeNull();
  });

  it("moves through suggestions with the arrows and wraps", async () => {
    const { value, type, key, options } = setup();
    type(":thumbs");
    await waitFor(() => expect(options().length).toBeGreaterThan(1));
    const second = document.querySelectorAll("[data-testid=emoji-option] span")[2].textContent;
    key("ArrowUp");
    key("ArrowDown");
    key("ArrowDown");
    key("Tab");
    expect(value()).toBe(`${second} `);
  });

  it("Esc dismisses the suggestions without reaching the parent", async () => {
    const { type, key, menu, options, onKeyDown } = setup();
    type(":rock");
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    key("Escape");
    expect(menu()).toBeNull();
    expect(onKeyDown).not.toHaveBeenCalled();
    key("Escape");
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("turns a closed :shortcode: into its emoji", async () => {
    const { value, type, options } = setup();
    type("lgtm :+1");
    await waitFor(() => expect(options()).toContain("👍:+1:"));
    type("lgtm :+1:");
    await waitFor(() => expect(value()).toBe("lgtm 👍"));
  });

  it("ignores colons that don't start a shortcode", async () => {
    const { type, key, menu, onKeyDown } = setup();
    type(":ta");
    await waitFor(() => expect(menu()).not.toBeNull());
    type("nit: rename");
    expect(menu()).toBeNull();
    key("Enter", { metaKey: true });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });
});
