import { createSignal, createUniqueId, For, onCleanup, Show, splitProps, type JSX, type Ref } from "solid-js";
import { Portal } from "solid-js/web";
import { closedShortcode, emojiTrigger, loadEmoji, type EmojiIndex, type EmojiMatch } from "../lib/emoji";
import { Textarea } from "./ui/textarea";

type Props = Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, "ref" | "onKeyDown" | "onInput"> & {
  ref?: Ref<HTMLTextAreaElement>;
  onKeyDown?: (e: KeyboardEvent) => void;
  onInput?: (e: InputEvent & { currentTarget: HTMLTextAreaElement }) => void;
};

interface Menu {
  start: number;
  items: EmojiMatch[];
  active: number;
  pos: { left: number; top?: number; bottom?: number };
}

/** Lets popovers that close on an outside click ignore clicks on the suggestions. */
export const EMOJI_MENU_ATTR = "data-emoji-menu";

const MENU_WIDTH = 240;
const MENU_MAX_HEIGHT = 8 * 28 + 8;

/**
 * A Textarea with Slack-style emoji: ":tad" lists 🎉 and friends (↑/↓, Enter or Tab to
 * pick, Esc to dismiss), and typing ":tada:" in full turns it into 🎉. Keys the
 * suggestions use never reach `onKeyDown`, so Esc doesn't also close the popover.
 */
export function EmojiTextarea(props: Props) {
  const [local, rest] = splitProps(props, ["ref", "onKeyDown", "onInput", "onBlur"]);
  let el!: HTMLTextAreaElement;
  let index: EmojiIndex | undefined;
  const [menu, setMenu] = createSignal<Menu | null>(null);
  const id = createUniqueId();

  function refresh() {
    const caret = el.selectionStart;
    const trigger = el.selectionEnd === caret ? emojiTrigger(el.value, caret) : null;
    if (!trigger) return setMenu(null);
    if (!index) {
      void loadEmoji().then((i) => {
        index = i;
        if (document.activeElement === el) refresh();
      });
      return;
    }
    const items = index.search(trigger.query);
    if (!items.length) return setMenu(null);
    const prev = menu();
    setMenu({
      start: trigger.start,
      items,
      active: prev?.start === trigger.start ? Math.min(prev.active, items.length - 1) : 0,
      pos: menuPosition(el, trigger.start),
    });
  }

  /** Replaces [start, end) with `text`, as typing would: undoable, and firing input. */
  function replace(start: number, end: number, text: string) {
    el.focus();
    el.setSelectionRange(start, end);
    let done = false;
    try {
      done = document.execCommand("insertText", false, text);
    } catch {
      // jsdom
    }
    if (!done) {
      el.setRangeText(text, start, end, "end");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  }

  function pick(m: EmojiMatch) {
    const start = menu()?.start;
    if (start === undefined) return;
    setMenu(null);
    const end = el.selectionStart;
    replace(start, end, /\s/.test(el.value[end] ?? "") ? m.emoji : `${m.emoji} `);
  }

  function onInput(e: InputEvent & { currentTarget: HTMLTextAreaElement }) {
    local.onInput?.(e);
    if (e.inputType === "insertText" && e.data === ":" && index) {
      const closed = closedShortcode(el.value, el.selectionStart);
      const emoji = closed && index.get(closed.name);
      if (closed && emoji) {
        const end = el.selectionStart;
        setMenu(null);
        // Not from inside this input event: some engines ignore a nested insertText.
        queueMicrotask(() => replace(closed.start, end, emoji));
        return;
      }
    }
    refresh();
  }

  function onKeyDown(e: KeyboardEvent) {
    const m = menu();
    if (m && !e.isComposing) {
      const move = (by: number) => setMenu({ ...m, active: (m.active + by + m.items.length) % m.items.length });
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      let handled = true;
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) move(1);
      else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) move(-1);
      else if ((e.key === "Enter" || e.key === "Tab") && plain && !e.shiftKey) pick(m.items[m.active]);
      else if (e.key === "Escape") setMenu(null);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") setMenu(null);
    }
    local.onKeyDown?.(e);
  }

  // The suggestions are fixed to the viewport: follow the caret if something scrolls.
  const onScroll = () => menu() && refresh();
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll);
  onCleanup(() => {
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
  });

  return (
    <>
      <Textarea
        {...rest}
        ref={(t) => {
          el = t;
          // Solid compiles `ref={variable}` on a component into a setter function.
          (local.ref as ((el: HTMLTextAreaElement) => void) | undefined)?.(t);
        }}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={!!menu()}
        aria-controls={menu() ? id : undefined}
        aria-activedescendant={menu() ? `${id}-${menu()!.active}` : undefined}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          setMenu(null);
          if (typeof local.onBlur === "function") local.onBlur(e);
        }}
      />
      <Show when={menu()}>
        {(m) => (
          <Portal>
            <div
              id={id}
              role="listbox"
              aria-label="Emoji"
              {...{ [EMOJI_MENU_ATTR]: "" }}
              class="fixed z-[60] overflow-y-auto rounded-lg border bg-popover p-1 font-sans text-sm text-popover-foreground shadow-lg dark:border-input"
              style={{
                left: `${m().pos.left}px`,
                top: m().pos.top !== undefined ? `${m().pos.top}px` : undefined,
                bottom: m().pos.bottom !== undefined ? `${m().pos.bottom}px` : undefined,
                width: `${MENU_WIDTH}px`,
                "max-height": `${MENU_MAX_HEIGHT}px`,
              }}
              // Keep the caret in the textarea.
              onMouseDown={(e) => e.preventDefault()}
              data-testid="emoji-menu"
            >
              <For each={m().items}>
                {(item, i) => (
                  <div
                    id={`${id}-${i()}`}
                    role="option"
                    aria-selected={i() === m().active}
                    class="flex h-7 cursor-default items-center gap-2 rounded-md px-2"
                    classList={{ "bg-accent text-accent-foreground": i() === m().active }}
                    onMouseMove={() => i() !== m().active && setMenu({ ...m(), active: i() })}
                    onClick={() => pick(item)}
                    data-testid="emoji-option"
                  >
                    <span class="w-5 text-center text-base leading-none">{item.emoji}</span>
                    <span class="truncate text-muted-foreground">:{item.name}:</span>
                  </div>
                )}
              </For>
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
}

/** Under the colon's line, or above it when there's no room below. */
function menuPosition(el: HTMLTextAreaElement, at: number): Menu["pos"] {
  const box = el.getBoundingClientRect();
  const caret = caretOffset(el, at);
  const x = box.left + caret.left - el.scrollLeft;
  const y = box.top + caret.top - el.scrollTop;
  const left = Math.max(8, Math.min(x - 8, window.innerWidth - MENU_WIDTH - 8));
  const below = y + caret.height + 4;
  return below + MENU_MAX_HEIGHT <= window.innerHeight || y < window.innerHeight / 2
    ? { left, top: below }
    : { left, bottom: window.innerHeight - y + 4 };
}

const MIRRORED = [
  "boxSizing", "width", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontFamily", "fontSize", "fontStyle",
  "fontWeight", "fontStretch", "fontVariant", "lineHeight", "letterSpacing", "wordSpacing", "tabSize",
  "textIndent", "textTransform",
] as const;

/** Where character `at` sits inside the textarea, measured on a hidden copy of it. */
function caretOffset(el: HTMLTextAreaElement, at: number) {
  const cs = getComputedStyle(el);
  const mirror = document.createElement("div");
  for (const p of MIRRORED) mirror.style[p] = cs[p];
  Object.assign(mirror.style, {
    position: "absolute",
    top: "0",
    left: "-9999px",
    visibility: "hidden",
    overflow: "hidden",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  });
  mirror.textContent = el.value.slice(0, at);
  const mark = document.createElement("span");
  mark.textContent = el.value.slice(at) || ".";
  mirror.append(mark);
  document.body.append(mirror);
  const fontSize = parseFloat(cs.fontSize) || 14;
  const offset = {
    left: mark.offsetLeft + (parseFloat(cs.borderLeftWidth) || 0),
    top: mark.offsetTop + (parseFloat(cs.borderTopWidth) || 0),
    height: parseFloat(cs.lineHeight) || fontSize * 1.4,
  };
  mirror.remove();
  return offset;
}
