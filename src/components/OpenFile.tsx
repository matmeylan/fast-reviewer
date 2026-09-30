// "Open with default app" for files the diff pane can't show (PDFs, archives, fonts, huge files).
// Rust writes the chosen version to a temp file and hands it to the OS.
import { createSignal, Show } from "solid-js";
import ExternalLink from "lucide-solid/icons/external-link";
import type { FileStatus, Side } from "../lib/types";
import { Button, type ButtonProps } from "./ui/button";
import { Spinner } from "./ui/spinner";

/** The versions a file has: added files only a new one, removed files only an old one. */
export const sidesOf = (status: FileStatus): Side[] =>
  status === "added" ? ["new"] : status === "removed" ? ["old"] : ["old", "new"];

/** `onOpen` resolves when the app was launched (or the failure reported). */
export type OpenSide = (side: Side) => Promise<void>;

/** One button per version: "Open new version" first for modified files, else the only one. */
export function OpenFileActions(props: { status: FileStatus; onOpen: OpenSide }) {
  const sides = () => sidesOf(props.status);
  return (
    <div class="mt-2 flex items-center gap-2" data-testid="open-actions">
      <Show
        when={sides().length === 2}
        fallback={<OpenButton side={sides()[0]} onOpen={props.onOpen}>Open with default app</OpenButton>}
      >
        <OpenButton side="new" onOpen={props.onOpen}>
          Open new version
        </OpenButton>
        <OpenButton side="old" variant="outline" onOpen={props.onOpen}>
          Open old version
        </OpenButton>
      </Show>
    </div>
  );
}

/** Opens `side` on click, with a spinner in place of the icon until it's done. */
export function OpenButton(
  props: { side: Side; onOpen: OpenSide; children?: string; title?: string } & Pick<ButtonProps, "variant" | "size" | "class">,
) {
  const [busy, setBusy] = createSignal(false);
  const open = async () => {
    if (busy()) return;
    setBusy(true);
    try {
      await props.onOpen(props.side);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      variant={props.variant}
      size={props.size}
      class={props.class}
      title={props.title}
      aria-label={props.children ? undefined : props.title}
      aria-busy={busy()}
      disabled={busy()}
      onClick={open}
      data-testid="open-file"
      data-side={props.side}
    >
      <Show when={busy()} fallback={<ExternalLink />}>
        <Spinner class="text-current" />
      </Show>
      {props.children}
    </Button>
  );
}
