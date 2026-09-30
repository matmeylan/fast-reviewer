import { createSignal, Match, Show, Switch } from "solid-js";
import logoUrl from "../../assets/logo.svg";
import type { AppStore } from "../lib/store";
import { isImage, isSvg } from "../lib/media";
import type { FileDiff, Side } from "../lib/types";
import DiffView from "./DiffView";
import FindBar from "./FindBar";
import ImageDiff from "./ImageDiff";
import { OpenFileActions } from "./OpenFile";
import { Counts } from "./FileTree";
import ReviewForm from "./ReviewForm";
import CircleCheckBig from "lucide-solid/icons/circle-check-big";
import CodeXml from "lucide-solid/icons/code-xml";
import Columns2 from "lucide-solid/icons/columns-2";
import FileCode from "lucide-solid/icons/file-code";
import ImageIcon from "lucide-solid/icons/image";
import MessageSquare from "lucide-solid/icons/message-square";
import Rows2 from "lucide-solid/icons/rows-2";
import TriangleAlert from "lucide-solid/icons/triangle-alert";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Kbd } from "./ui/kbd";
import { Spinner } from "./ui/spinner";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** Tabs-list styling, applied from the group so each button's class is just its state ("on"). */
const SEGMENTS =
  "inline-flex h-8 flex-none items-center rounded-lg bg-muted p-[3px] text-muted-foreground *:inline-flex *:h-full *:items-center *:gap-1.5 *:rounded-md *:border *:border-transparent *:px-2 *:text-[0.8rem] *:font-medium *:text-foreground/60 *:transition-all *:hover:text-foreground dark:*:text-muted-foreground dark:*:hover:text-foreground [&_svg]:size-3.5 [&>.on]:bg-background [&>.on]:text-foreground [&>.on]:shadow-sm dark:[&>.on]:border-input dark:[&>.on]:bg-input/30 dark:[&>.on]:text-foreground";

export default function MainPane(props: { store: AppStore }) {
  const s = props.store;
  const file = () => {
    const p = s.pr();
    const sel = s.selected();
    return p && sel ? p.files.find((f) => f.path === sel) ?? null : null;
  };
  /** Line counts for the file whose diff is on screen (it may lag the selection briefly). */
  const statsFor = (path: string) => {
    const f = s.pr()?.files.find((x) => x.path === path);
    return f ? { additions: f.additions, deletions: f.deletions } : undefined;
  };
  const viewed = () => {
    const f = file();
    return f ? !!s.viewed[f.path] : false;
  };
  const statusOf = (path: string) => s.pr()?.files.find((x) => x.path === path)?.status ?? "modified";
  /** SVG whose source diff is shown instead of the image (SVGs open as images). */
  const [svgSource, setSvgSource] = createSignal<string | null>(null);
  const showImage = (d: FileDiff) => isImage(d.path) && svgSource() !== d.path;

  return (
    <main class="main flex min-w-0 flex-1 flex-col">
      <div class="flex h-12 flex-none items-center gap-3 border-b px-4">
        <Show when={file()} fallback={<span class="flex-1" />}>
          {(f) => (
            <>
              <FileCode class="size-4 flex-none text-muted-foreground" />
              <span
                class="min-w-0 flex-[0_1_auto] truncate font-mono text-[0.8125rem] select-text"
                title={f().path}
                data-testid="current-path"
              >
                <Show when={f().previousPath}>
                  <span class="text-muted-foreground">{f().previousPath} → </span>
                </Show>
                {f().path}
              </span>
              <Counts add={f().additions} del={f().deletions} class="text-xs" />
              <label
                class="ml-1 inline-flex h-7 flex-none cursor-pointer items-center gap-2 rounded-[min(var(--radius-md),12px)] border px-2.5 text-[0.8rem] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:border-input dark:bg-input/30"
                classList={{ "text-foreground! border-primary/40 dark:border-primary/60": viewed() }}
                title="Toggle viewed (u)"
              >
                <Checkbox
                  checked={viewed()}
                  onChange={(on) => s.markViewed(f().path, on)}
                  data-testid="viewed-toggle"
                />
                Viewed
              </label>
              <span class="flex-1" />
              <Show when={isSvg(f().path)}>
                <div class={SEGMENTS} role="group" aria-label="SVG view" data-testid="svg-toggle">
                  <button classList={{ on: svgSource() !== f().path }} onClick={() => setSvgSource(null)}>
                    <ImageIcon />
                    Image
                  </button>
                  <button classList={{ on: svgSource() === f().path }} onClick={() => setSvgSource(f().path)}>
                    <CodeXml />
                    Source
                  </button>
                </div>
              </Show>
            </>
          )}
        </Show>
        <Show when={s.pr()}>
          <Button
            variant="outline"
            size="sm"
            class="flex-none"
            onClick={() => s.dispatch("writeReview")}
            title="Comment or approve (a)"
            data-testid="review-button"
          >
            <Show when={s.reviewResult()} fallback={<MessageSquare />}>
              <CircleCheckBig class="text-success" />
            </Show>
            Review
          </Button>
        </Show>
        <div
          class={SEGMENTS}
          role="group"
          aria-label="Diff mode"
          data-testid="mode-toggle"
        >
          <button classList={{ on: s.viewMode() === "split" }} onClick={() => s.setMode("split")} title="Split (v)">
            <Columns2 />
            Split
          </button>
          <button
            classList={{ on: s.viewMode() === "unified" }}
            onClick={() => s.setMode("unified")}
            title="Unified (v)"
          >
            <Rows2 />
            Unified
          </button>
        </div>
      </div>
      <div class="diff-host relative flex min-h-0 flex-1 flex-col *:min-h-0 *:flex-1">
        <Switch>
          <Match when={s.prLoading()}>
            {(ref) => (
              <div class="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
                <Spinner class="size-5" />
                Loading {ref().owner}/{ref().repo}#{ref().number}…
              </div>
            )}
          </Match>
          <Match when={!s.pr()}>
            {/* Shown under the picker, which stays open while no PR is loaded. */}
            <Empty class="h-full justify-end pb-[12vh]" data-testid="welcome">
              <EmptyHeader>
                <img src={logoUrl} alt="" width="96" height="96" class="mb-2" draggable={false} />
                <EmptyTitle class="text-lg">Fast Reviewer</EmptyTitle>
                <EmptyDescription>
                  <Kbd>{isMac ? "⌘K" : "Ctrl K"}</Kbd> to open a pull request
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </Match>
          <Match when={s.done()}>
            <Empty class="h-full" data-testid="all-reviewed">
              <EmptyHeader>
                <EmptyMedia class="size-12 rounded-full bg-success/15 text-success [&_svg:not([class*='size-'])]:size-6">
                  <CircleCheckBig />
                </EmptyMedia>
                <EmptyTitle class="text-lg">All files reviewed</EmptyTitle>
                <EmptyDescription>
                  {s.viewedCount()}/{s.pr()?.files.length} viewed. Press <Kbd>j</Kbd> / <Kbd>k</Kbd> to keep browsing or{" "}
                  <Kbd>{isMac ? "⌘K" : "Ctrl K"}</Kbd> to open the next PR.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent class="mt-2 max-w-md">
                <ReviewForm store={s} />
              </EmptyContent>
            </Empty>
          </Match>
          <Match when={s.diff().error}>
            {(err) => (
              <Empty class="h-full">
                <EmptyHeader>
                  <EmptyMedia class="bg-destructive/10 text-destructive">
                    <TriangleAlert />
                  </EmptyMedia>
                  <EmptyTitle>Couldn't load diff</EmptyTitle>
                  <EmptyDescription>{err()}</EmptyDescription>
                </EmptyHeader>
                <Button variant="outline" onClick={() => s.retryDiff()}>
                  Retry
                </Button>
              </Empty>
            )}
          </Match>
          <Match when={s.diff().loading}>
            <div class="flex h-full items-center justify-center">
              <Spinner class="size-5" />
            </div>
          </Match>
          <Match when={s.diff().diff}>
            {(d) => {
              const open = (side: Side) => s.openFile(d().path, side);
              return (
                <Show
                  when={showImage(d())}
                  fallback={
                    <DiffView
                      diff={d()}
                      mode={s.viewMode()}
                      hunkNav={s.hunkNav()}
                      stats={d().tooLarge ? statsFor(d().path) : undefined}
                      actions={<OpenFileActions status={statusOf(d().path)} onOpen={open} />}
                      find={s.findOpen() ? { query: s.findQuery(), caseSensitive: s.findCase() } : undefined}
                      findNav={s.findNav()}
                      onFindStatus={s.setFindStatus}
                    />
                  }
                >
                  <ImageDiff
                    path={d().path}
                    status={statusOf(d().path)}
                    mode={s.viewMode()}
                    load={(side) => s.fileContent(d().path, side)}
                    onOpen={open}
                  />
                </Show>
              );
            }}
          </Match>
          <Match when={s.pr() && s.pr()!.files.length === 0}>
            <Empty class="h-full">
              <EmptyHeader>
                <EmptyTitle>No changed files</EmptyTitle>
                <EmptyDescription>This pull request has no changed files.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </Match>
        </Switch>
        <Show when={s.findOpen() && s.pr()}>
          <FindBar store={s} />
        </Show>
      </div>
    </main>
  );
}
