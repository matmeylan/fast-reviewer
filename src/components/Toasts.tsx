import { For } from "solid-js";
import CircleAlert from "lucide-solid/icons/circle-alert";
import Info from "lucide-solid/icons/info";
import type { AppStore } from "../lib/store";

export default function Toasts(props: { store: AppStore }) {
  return (
    <div class="fixed right-4 bottom-4 z-[100] flex max-w-sm flex-col gap-2" aria-live="polite">
      <For each={props.store.toasts()}>
        {(t) => (
          <div
            class="flex items-start gap-2.5 rounded-xl bg-popover px-3.5 py-3 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-200 animate-in fade-in-0 slide-in-from-bottom-2"
            data-testid="toast"
            onClick={() => props.store.dismissToast(t.id)}
          >
            {t.kind === "info" ? (
              <Info class="mt-0.5 size-4 flex-none text-primary" />
            ) : (
              <CircleAlert class="mt-0.5 size-4 flex-none text-destructive" />
            )}
            <span>{t.text}</span>
          </div>
        )}
      </For>
    </div>
  );
}
