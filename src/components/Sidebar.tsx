import { createEffect, createSignal, on, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import GitBranch from "lucide-solid/icons/git-branch";
import GitMerge from "lucide-solid/icons/git-merge";
import GitPullRequest from "lucide-solid/icons/git-pull-request";
import GitPullRequestClosed from "lucide-solid/icons/git-pull-request-closed";
import GitPullRequestDraft from "lucide-solid/icons/git-pull-request-draft";
import Search from "lucide-solid/icons/search";
import TriangleAlert from "lucide-solid/icons/triangle-alert";
import { storage, type AppStore } from "../lib/store";
import type { PrState } from "../lib/types";
import ListIcon from "lucide-solid/icons/list";
import ListTree from "lucide-solid/icons/list-tree";
import FileTree, { type TreeView } from "./FileTree";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { InputGroup, InputGroupAddon, inputGroupControlClass } from "./ui/input";
import { Kbd } from "./ui/kbd";
import { Progress } from "./ui/progress";

const KEY_VIEW = "fr.treeView";

/** GitHub's state colors: green open, gray draft, purple merged, red closed. */
const PR_STATE: Record<PrState, { label: string; icon: Component<{ class?: string }>; class: string }> = {
  open: { label: "Open", icon: GitPullRequest, class: "bg-success/10 text-success" },
  draft: { label: "Draft", icon: GitPullRequestDraft, class: "bg-muted text-muted-foreground" },
  merged: {
    label: "Merged",
    icon: GitMerge,
    class: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  },
  closed: { label: "Closed", icon: GitPullRequestClosed, class: "bg-destructive/10 text-destructive" },
};

function PrStateBadge(props: { state: PrState }) {
  const st = () => PR_STATE[props.state];
  return (
    <Badge class={st().class} data-testid="pr-state" data-state={props.state}>
      <Dynamic component={st().icon} />
      {st().label}
    </Badge>
  );
}

export default function Sidebar(props: { store: AppStore; treeActive?: boolean }) {
  const s = props.store;
  let input!: HTMLInputElement;
  const [view, setViewSignal] = createSignal<TreeView>(storage.get(KEY_VIEW) === "flat" ? "flat" : "tree");
  const setView = (v: TreeView) => {
    setViewSignal(v);
    storage.set(KEY_VIEW, v);
  };

  createEffect(
    on(
      s.focusFilterSeq,
      () => {
        input.focus();
        input.select();
      },
      { defer: true },
    ),
  );

  const total = () => s.pr()?.files.length ?? 0;
  const pct = () => (total() ? (s.viewedCount() / total()) * 100 : 0);

  return (
    <aside class="sidebar flex w-(--sidebar-w,320px) flex-none flex-col border-r bg-sidebar text-sidebar-foreground min-h-0">
      <Show when={s.pr()}>
        {(pr) => (
          <header class="flex flex-col gap-3 border-b px-4 pt-4 pb-4">
            <div class="flex flex-col gap-1.5">
              <div class="pr-title line-clamp-2 font-heading text-[0.9375rem] leading-snug font-medium" title={pr().title}>
                {pr().title}
              </div>
              <div class="flex min-w-0 items-center gap-2 text-xs whitespace-nowrap text-muted-foreground">
                <PrStateBadge state={pr().state} />
                <span class="pr-ref">
                  {pr().owner}/{pr().repo} <span class="font-medium text-foreground">#{pr().number}</span>
                </span>
                <span
                  class="flex min-w-0 items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem]"
                  title={`${pr().headRef} → ${pr().baseRef}`}
                >
                  <GitBranch class="size-3 flex-none" />
                  <span class="truncate">{pr().headRef}</span>
                </span>
              </div>
            </div>
            <div class="flex flex-col gap-1.5" data-testid="progress">
              <div class="flex items-center justify-between text-xs">
                <span class="font-medium">Review progress</span>
                <span class="text-muted-foreground tabular-nums">
                  {s.viewedCount()}/{total()} viewed
                </span>
              </div>
              <Progress value={pct()} indicatorClass={pct() === 100 ? "bg-success" : undefined} />
            </div>
            <Show when={pr().filesTruncated}>
              <div
                class="grid grid-cols-[auto_1fr] gap-x-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs leading-snug text-amber-700 dark:text-amber-400"
                role="alert"
                data-testid="files-truncated"
              >
                <TriangleAlert class="mt-px size-3.5" aria-hidden="true" />
                <span>
                  Showing {pr().files.length.toLocaleString()} of {pr().totalFiles.toLocaleString()} files — GitHub
                  limits the file list
                </span>
              </div>
            </Show>
          </header>
        )}
      </Show>
      <div class="flex items-center gap-1.5 px-3 pt-3 pb-2">
        <InputGroup class="bg-background">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <input
            ref={input}
            type="search"
            data-slot="input-group-control"
            class={inputGroupControlClass}
            placeholder="Filter files"
            spellcheck={false}
            autocomplete="off"
            value={s.filter()}
            onInput={(e) => s.setFilter(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (s.filter()) s.setFilter("");
                else input.blur();
              } else if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                const first = s.order()[0];
                if (first) s.select(first);
                input.blur();
              }
            }}
            data-testid="file-filter"
          />
          <InputGroupAddon align="inline-end">
            <Kbd>/</Kbd>
          </InputGroupAddon>
        </InputGroup>
        <Button
          variant="ghost"
          size="icon"
          class="flex-none text-muted-foreground"
          onClick={() => setView(view() === "tree" ? "flat" : "tree")}
          title={view() === "tree" ? "Show as flat list" : "Group by folder"}
          aria-label={view() === "tree" ? "Show as flat list" : "Group by folder"}
          data-testid="tree-view-toggle"
        >
          {view() === "tree" ? <ListIcon /> : <ListTree />}
        </Button>
      </div>
      <FileTree store={s} view={view()} active={props.treeActive ?? true} />
    </aside>
  );
}
