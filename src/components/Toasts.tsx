import { For } from "solid-js";
import type { AppStore } from "../lib/store";

export default function Toasts(props: { store: AppStore }) {
  return (
    <div class="toasts" aria-live="polite">
      <For each={props.store.toasts()}>
        {(t) => (
          <div class="toast" data-testid="toast" onClick={() => props.store.dismissToast(t.id)}>
            {t.text}
          </div>
        )}
      </For>
    </div>
  );
}
