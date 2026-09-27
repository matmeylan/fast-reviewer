import { For } from "solid-js";
import type { AppStore } from "../lib/store";

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
  [["o"], "Open PR in browser"],
  [[isMac ? "⌘K" : "Ctrl+K"], "Open pull request"],
  [["?"], "Show shortcuts"],
  [["esc"], "Close"],
];

export default function HelpOverlay(props: { store: AppStore }) {
  return (
    <div
      class="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && props.store.setOverlay("none")}
    >
      <div class="help" role="dialog" aria-label="Keyboard shortcuts" data-testid="help">
        <h2>Keyboard shortcuts</h2>
        <table>
          <tbody>
            <For each={SHORTCUTS}>
              {([keys, label]) => (
                <tr>
                  <td>
                    <For each={keys}>{(k) => <kbd>{k}</kbd>}</For>
                  </td>
                  <td>{label}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
}
