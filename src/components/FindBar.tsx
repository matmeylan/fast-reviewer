// Find in the current file's diff (Cmd/Ctrl+F). Matching and highlighting live
// in DiffView; this bar edits the query and steps through the matches.
import { createEffect, on } from "solid-js";
import type { AppStore } from "../lib/store";
import CaseSensitive from "lucide-solid/icons/case-sensitive";
import ChevronDown from "lucide-solid/icons/chevron-down";
import ChevronUp from "lucide-solid/icons/chevron-up";
import Search from "lucide-solid/icons/search";
import X from "lucide-solid/icons/x";
import { Button } from "./ui/button";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl+";
/** Longest selection that prefills the query. */
const MAX_PREFILL = 200;

/**
 * Text selected in the diff, if it fits on one line: what Cmd+F searches for.
 * Read it before opening the bar: highlighting the previous query re-renders
 * the lines it matches, which can drop the selection.
 */
export function selectedDiffText(): string | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const node = sel.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement;
  if (!el?.closest(".diff-view")) return null;
  const text = sel.toString();
  return text && !text.includes("\n") && text.length <= MAX_PREFILL ? text : null;
}

export default function FindBar(props: { store: AppStore }) {
  const s = props.store;
  let input!: HTMLInputElement;

  // Runs on mount too: the bar mounts when Cmd+F opens it.
  createEffect(
    on(s.focusFindSeq, () => {
      input.focus();
      input.select();
    }),
  );

  const count = () => s.findStatus().count;
  const status = () => {
    if (!s.findQuery()) return "";
    const { count, index } = s.findStatus();
    if (count === 0) return "No results";
    return index >= 0 ? `${index + 1} of ${count}` : `${count} ${count === 1 ? "result" : "results"}`;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    s.dispatch(e.shiftKey ? "findPrev" : "findNext");
  };

  return (
    <div
      class="absolute top-2 right-5 z-20 flex items-center gap-0.5 rounded-lg border bg-popover p-1 pl-2.5 text-popover-foreground shadow-md"
      role="search"
      data-testid="find-bar"
      // Keep focus in the input so Enter keeps stepping after a button click.
      onMouseDown={(e) => e.target !== input && e.preventDefault()}
    >
      <Search class="size-3.5 flex-none text-muted-foreground" />
      <input
        ref={input}
        type="text"
        class="h-7 w-52 min-w-0 bg-transparent px-1.5 font-mono text-[0.8125rem] outline-none placeholder:font-sans placeholder:text-muted-foreground"
        placeholder="Find in file"
        aria-label="Find in file"
        spellcheck={false}
        autocomplete="off"
        value={s.findQuery()}
        onInput={(e) => s.setFindQuery(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        data-testid="find-input"
      />
      <span class="min-w-18 px-1 text-right text-xs text-muted-foreground tabular-nums" data-testid="find-status">
        {status()}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        class="aria-pressed:bg-muted aria-pressed:text-foreground"
        aria-pressed={s.findCase()}
        title="Match case"
        onClick={() => s.setFindCase((c) => !c)}
      >
        <CaseSensitive />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title={`Previous match (⇧Enter, ⇧${mod}G)`}
        disabled={count() === 0}
        onClick={() => s.dispatch("findPrev")}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title={`Next match (Enter, ${mod}G)`}
        disabled={count() === 0}
        onClick={() => s.dispatch("findNext")}
      >
        <ChevronDown />
      </Button>
      <Button variant="ghost" size="icon-sm" title="Close (Esc)" onClick={() => s.setFindOpen(false)}>
        <X />
      </Button>
    </div>
  );
}
