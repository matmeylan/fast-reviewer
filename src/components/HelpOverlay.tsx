import { For } from "solid-js";
import type { AppStore } from "../lib/store";
import { DialogContent, DialogHeader, DialogOverlay, DialogTitle } from "./ui/dialog";
import { Kbd, KbdGroup } from "./ui/kbd";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

const SHORTCUTS: [string[], string][] = [
  [["r"], "Mark viewed, go to next unviewed file"],
  [["s"], "Skip to next unviewed file"],
  [["j", "↓"], "Next file"],
  [["k", "↑"], "Previous file"],
  [["u"], "Toggle viewed"],
  [["v"], "Toggle split / unified"],
  [["n"], "Next hunk"],
  [["p"], "Previous hunk"],
  [["/"], "Filter files"],
  [[isMac ? "⌘F" : "Ctrl+F"], "Find in file"],
  [[isMac ? "⌘G" : "Ctrl+G", isMac ? "⇧⌘G" : "Shift+Ctrl+G"], "Next / previous match"],
  [["c"], "Comment on the line under the mouse"],
  [["a"], "Comment or approve"],
  [["o"], "Open PR in browser"],
  [[isMac ? "⌘K" : "Ctrl+K"], "Open pull request"],
  [["?"], "Show shortcuts"],
  [["esc"], "Close"],
];

export default function HelpOverlay(props: { store: AppStore }) {
  return (
    <DialogOverlay onMouseDown={(e) => e.target === e.currentTarget && props.store.setOverlay("none")}>
      <DialogContent class="w-[440px] gap-3 p-5" aria-label="Keyboard shortcuts" data-testid="help">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div class="flex flex-col">
          <For each={SHORTCUTS}>
            {([keys, label]) => (
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2 last:border-0">
                <span class="text-muted-foreground">{label}</span>
                <KbdGroup>
                  <For each={keys}>{(k) => <Kbd>{k}</Kbd>}</For>
                </KbdGroup>
              </div>
            )}
          </For>
        </div>
      </DialogContent>
    </DialogOverlay>
  );
}
