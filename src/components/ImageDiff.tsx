// Before / after view of an image file. Each version is fetched as bytes and shown through a
// blob URL in an <img>: SVG markup is never put in the DOM, so scripts in it never run.
import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import TriangleAlert from "lucide-solid/icons/triangle-alert";
import type { FileStatus, Side } from "../lib/types";
import { formatBytes, imageMime } from "../lib/media";
import { errorMessage } from "../lib/store";
import type { DiffMode } from "./DiffView";
import { OpenButton, sidesOf, type OpenSide } from "./OpenFile";
import { Spinner } from "./ui/spinner";

export interface ImageDiffProps {
  path: string;
  status: FileStatus;
  /** Split: versions side by side; unified: stacked. */
  mode: DiffMode;
  /** Bytes of one version (see `Backend.getFileContent`). */
  load: (side: Side) => Promise<Uint8Array<ArrayBuffer>>;
  /** Adds an "open with default app" button to each caption. */
  onOpen?: OpenSide;
}

export default function ImageDiff(props: ImageDiffProps) {
  const sides = () => sidesOf(props.status);
  return (
    <div class="h-full min-h-0 overflow-auto p-4" data-testid="image-diff" data-path={props.path}>
      <div
        class="grid h-full min-h-72 auto-rows-fr gap-4"
        classList={{ "grid-cols-2": props.mode === "split" && sides().length === 2 }}
      >
        <For each={sides()}>
          {(side) => <ImagePanel side={side} path={props.path} load={props.load} onOpen={props.onOpen} />}
        </For>
      </div>
    </div>
  );
}

type Loaded = { state: "loading" } | { state: "ready"; url: string; size: number } | { state: "error"; error: string };

function ImagePanel(props: { side: Side; path: string; load: ImageDiffProps["load"]; onOpen?: OpenSide }) {
  const [img, setImg] = createSignal<Loaded>({ state: "loading" });
  const [dims, setDims] = createSignal<{ w: number; h: number } | null>(null);

  createEffect(() => {
    const { side, path } = props;
    let live = true;
    let url: string | undefined;
    setImg({ state: "loading" });
    setDims(null);
    props.load(side).then(
      (bytes) => {
        if (!live) return;
        url = URL.createObjectURL(new Blob([bytes], { type: imageMime(path) ?? "" }));
        setImg({ state: "ready", url, size: bytes.byteLength });
      },
      (e) => {
        if (live) setImg({ state: "error", error: errorMessage(e) });
      },
    );
    onCleanup(() => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    });
  });

  const label = () => (props.side === "old" ? "Before" : "After");
  const ready = () => {
    const i = img();
    return i.state === "ready" ? i : null;
  };
  const failed = () => {
    const i = img();
    return i.state === "error" ? i : null;
  };

  return (
    <figure class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border" data-testid="image-side" data-side={props.side}>
      <div class="relative min-h-0 flex-1 bg-muted/30">
        <div class="absolute inset-0 flex items-center justify-center p-4">
          <Switch>
            <Match when={img().state === "loading"}>
              <Spinner class="size-5" />
            </Match>
            <Match when={failed()}>
              {(f) => (
                <div class="flex max-w-xs flex-col items-center gap-2 text-center text-sm text-muted-foreground">
                  <TriangleAlert class="size-5 text-destructive" />
                  {f().error}
                </div>
              )}
            </Match>
            <Match when={ready()}>
              {(r) => (
                <img
                  src={r().url}
                  alt={`${label()}: ${props.path}`}
                  draggable={false}
                  // Never scaled up; SVGs without an intrinsic size fill the panel instead.
                  class="checkerboard max-h-full max-w-full object-contain shadow-sm"
                  classList={{ "size-full": dims()?.w === 0 }}
                  onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                  onError={() => setImg({ state: "error", error: "Can't display this image" })}
                />
              )}
            </Match>
          </Switch>
        </div>
      </div>
      <figcaption class="flex h-10 flex-none items-center gap-2 border-t px-3 text-xs text-muted-foreground">
        <span
          class="font-medium"
          classList={{ "text-deleted": props.side === "old", "text-added": props.side === "new" }}
        >
          {label()}
        </span>
        <span class="flex-1" />
        <span class="tabular-nums" data-testid="image-meta">
          <Show when={dims()?.w}>
            {dims()!.w} × {dims()!.h}
            <span class="mx-1.5 opacity-50">·</span>
          </Show>
          <Show when={ready()}>{(r) => formatBytes(r().size)}</Show>
        </span>
        <Show when={props.onOpen}>
          {(open) => (
            <OpenButton
              side={props.side}
              onOpen={open()}
              variant="ghost"
              size="icon-sm"
              class="-mr-1.5"
              title={`Open ${props.side} version with default app`}
            />
          )}
        </Show>
      </figcaption>
    </figure>
  );
}
