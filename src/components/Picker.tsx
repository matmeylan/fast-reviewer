// Cmd+K palette: inbox, pasted PR URLs / refs, repo search -> repo PRs. Keyboard-first.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { errorMessage, type AppStore, type PrRef } from "../lib/store";
import type { PrSummary, RepoSummary } from "../lib/types";
import { parsePrRef, rankPrs, REASON_LABEL } from "./pickerLogic";
import ArrowUpRight from "lucide-solid/icons/arrow-up-right";
import FolderGit2 from "lucide-solid/icons/folder-git-2";
import ChevronLeft from "lucide-solid/icons/chevron-left";
import GitPullRequest from "lucide-solid/icons/git-pull-request";
import GitPullRequestDraft from "lucide-solid/icons/git-pull-request-draft";
import Search from "lucide-solid/icons/search";
import { Badge } from "./ui/badge";
import { DialogContent, DialogOverlay } from "./ui/dialog";
import { Kbd, KbdGroup } from "./ui/kbd";
import { Spinner } from "./ui/spinner";

type Item =
  | { kind: "ref"; ref: PrRef }
  | { kind: "pr"; pr: PrSummary }
  | { kind: "repo"; repo: RepoSummary };

function itemKey(item: Item): string {
  if (item.kind === "ref") return `ref:${item.ref.owner}/${item.ref.repo}#${item.ref.number}`;
  if (item.kind === "pr") return `pr:${item.pr.owner}/${item.pr.repo}#${item.pr.number}`;
  return `repo:${item.repo.owner}/${item.repo.name}`;
}

type Stage = { kind: "main" } | { kind: "repo"; owner: string; repo: string };

const SEARCH_DEBOUNCE_MS = 200;

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function Picker(props: { store: AppStore; dismissable: boolean }) {
  const s = props.store;
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  const [query, setQuery] = createSignal("");
  const [stage, setStage] = createSignal<Stage>({ kind: "main" });
  const [active, setActive] = createSignal(0);
  const [repos, setRepos] = createSignal<{ q: string; items: RepoSummary[] } | null>(null);
  const [searching, setSearching] = createSignal(false);
  const [repoPrs, setRepoPrs] = createSignal<PrSummary[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => input.focus());

  // Debounced repo search on the main stage.
  let searchSeq = 0;
  createEffect(
    on([query, stage], ([q, st]) => {
      const seq = ++searchSeq;
      const term = q.trim();
      // A search error belongs to the query that caused it.
      if (st.kind === "main") setError(null);
      if (st.kind !== "main" || term.length < 2 || parsePrRef(term)) {
        setSearching(false);
        setRepos(null);
        return;
      }
      setSearching(true);
      const timer = setTimeout(() => {
        s.searchRepos(term).then(
          (items) => {
            if (seq !== searchSeq) return;
            setRepos({ q: term, items });
            setSearching(false);
          },
          (e) => {
            if (seq !== searchSeq) return;
            setError(errorMessage(e));
            setSearching(false);
          },
        );
      }, SEARCH_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(timer));
    }),
  );

  const items = createMemo<Item[]>(() => {
    const q = query();
    const st = stage();
    if (st.kind === "repo") return rankPrs(repoPrs() ?? [], q).map((pr) => ({ kind: "pr", pr }));
    const out: Item[] = [];
    const ref = parsePrRef(q);
    if (ref) out.push({ kind: "ref", ref });
    for (const pr of rankPrs(s.inbox() ?? [], ref ? "" : q)) out.push({ kind: "pr", pr });
    for (const repo of repos()?.items ?? []) out.push({ kind: "repo", repo });
    return out;
  });

  // A new query or stage starts at the top. Items that change underneath the user
  // (inbox refresh, repo search results) keep the highlighted item by identity, so
  // an Enter already on its way opens what the user chose.
  let lastQuery = query();
  let lastStage = stage();
  createEffect(
    on(items, (list, prev) => {
      const q = query();
      const st = stage();
      const reset = !prev || q !== lastQuery || st !== lastStage;
      lastQuery = q;
      lastStage = st;
      if (reset) return setActive(0);
      const i = active();
      const was = prev[i];
      const key = was ? itemKey(was) : null;
      const found = key === null ? -1 : list.findIndex((it) => itemKey(it) === key);
      setActive(found >= 0 ? found : Math.max(0, Math.min(i, list.length - 1)));
    }),
  );
  createEffect(
    on(active, (i) => {
      list?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" });
    }),
  );

  const section = (item: Item): string => {
    if (item.kind === "ref") return "Open";
    if (item.kind === "repo") return "Repositories";
    const st = stage();
    return st.kind === "repo" ? `${st.owner}/${st.repo}` : REASON_LABEL[item.pr.reason];
  };

  async function enterRepo(owner: string, repo: string) {
    setStage({ kind: "repo", owner, repo });
    setQuery("");
    setRepoPrs(null);
    setError(null);
    const stageRef = stage();
    try {
      const prs = await s.listRepoPrs(owner, repo);
      if (stage() === stageRef) setRepoPrs(prs);
    } catch (e) {
      // A late failure for a repo the user already left must not land on another one.
      if (stage() !== stageRef) return;
      setError(errorMessage(e));
      setRepoPrs([]);
    }
  }

  function back() {
    setStage({ kind: "main" });
    setQuery("");
    setError(null);
  }

  function choose(item: Item | undefined) {
    if (!item) return;
    if (item.kind === "ref") void s.openPr(item.ref);
    else if (item.kind === "pr") void s.openPr({ owner: item.pr.owner, repo: item.pr.repo, number: item.pr.number });
    else void enterRepo(item.repo.owner, item.repo.name);
  }

  function onKeyDown(e: KeyboardEvent) {
    const n = items().length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (n) setActive((i) => (i + 1) % n);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (n) setActive((i) => (i - 1 + n) % n);
        break;
      case "Enter":
        e.preventDefault();
        choose(items()[active()]);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (stage().kind === "repo") back();
        else if (query()) setQuery("");
        else if (props.dismissable) s.setOverlay("none");
        break;
      case "Backspace":
        if (!query() && stage().kind === "repo") {
          e.preventDefault();
          back();
        }
        break;
    }
  }

  const repoStage = () => {
    const st = stage();
    return st.kind === "repo" ? st : null;
  };

  const placeholder = () =>
    stage().kind === "repo"
      ? "Filter pull requests…"
      : "Search your PRs, paste a PR URL or owner/repo#123, or type a repo name…";

  return (
    <DialogOverlay
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && props.dismissable) s.setOverlay("none");
      }}
    >
      <DialogContent
        class="flex max-h-[70vh] w-[min(720px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0"
        aria-label="Open pull request"
        data-testid="picker"
      >
        <div class="p-2 pb-0">
          <div class="flex h-10 items-center gap-2 rounded-lg border border-input/30 bg-input/30 px-3">
            <Show when={repoStage()} fallback={<Search class="size-4 flex-none opacity-50" />}>
              {(r) => (
                <button
                  class="crumb inline-flex h-6 flex-none items-center gap-0.5 rounded-md bg-primary/10 pr-2 pl-1 text-xs font-medium text-primary hover:bg-primary/15 dark:bg-primary/25 dark:text-foreground"
                  onClick={back}
                  title="Back (Esc)"
                >
                  <ChevronLeft class="size-3.5" />
                  {r().owner}/{r().repo}
                </button>
              )}
            </Show>
            <input
              ref={input}
              class="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              value={query()}
              placeholder={placeholder()}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              data-testid="picker-input"
            />
            <Show when={searching() || s.inbox() === null || (stage().kind === "repo" && repoPrs() === null)}>
              <Spinner />
            </Show>
          </div>
        </div>
        <div class="no-scrollbar min-h-0 overflow-y-auto scroll-py-2 p-2" ref={list}>
          <For each={items()}>
            {(item, i) => (
              <>
                <Show when={i() === 0 || section(items()[i() - 1]) !== section(item)}>
                  <div class="picker-section px-2 pt-2.5 pb-1.5 text-xs font-medium text-muted-foreground first:pt-1">
                    {section(item)}
                  </div>
                </Show>
                <div
                  class="picker-item group/command-item relative flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm whitespace-nowrap outline-hidden select-none data-selected:bg-muted data-selected:text-foreground [&_svg:not([class*='size-'])]:size-4"
                  classList={{ active: active() === i() }}
                  data-selected={active() === i()}
                  data-index={i()}
                  data-testid="picker-item"
                  onMouseMove={() => setActive(i())}
                  onClick={() => choose(item)}
                >
                  <PickerRow item={item} />
                </div>
              </>
            )}
          </For>
          <Show when={items().length === 0 && s.inbox() !== null && !searching()}>
            <div class="picker-empty py-8 text-center text-sm text-muted-foreground">
              {error() ??
                (stage().kind === "repo"
                  ? repoPrs() === null
                    ? "Loading…"
                    : "No open pull requests"
                  : query().trim().length < 2
                    ? "Nothing in your inbox. Type a repository name to browse its PRs."
                    : "No matches")}
            </div>
          </Show>
        </div>
        <div class="flex items-center gap-4 border-t bg-muted/50 px-4 py-2.5 text-xs text-muted-foreground">
          <span class="flex items-center gap-1.5">
            <KbdGroup>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
            </KbdGroup>
            navigate
          </span>
          <span class="flex items-center gap-1.5">
            <Kbd>↵</Kbd> open
          </span>
          <Show when={props.dismissable || stage().kind === "repo"}>
            <span class="flex items-center gap-1.5">
              <Kbd>esc</Kbd> {stage().kind === "repo" ? "back" : "close"}
            </span>
          </Show>
        </div>
      </DialogContent>
    </DialogOverlay>
  );
}

const META = "min-w-0 flex-[1_1_0] truncate text-xs text-muted-foreground";

function PickerRow(props: { item: Item }) {
  const it = props.item;
  if (it.kind === "ref") {
    return (
      <>
        <ArrowUpRight class="flex-none text-muted-foreground" />
        <span class="pi-title min-w-0 truncate">
          Open {it.ref.owner}/{it.ref.repo}#{it.ref.number}
        </span>
      </>
    );
  }
  if (it.kind === "repo") {
    return (
      <>
        <FolderGit2 class="flex-none text-muted-foreground" />
        <span class="pi-title min-w-0 flex-[0_1_auto] truncate">
          <span class="text-muted-foreground">{it.repo.owner}/</span>
          <span class="font-medium">{it.repo.name}</span>
        </span>
        <span class={META}>{it.repo.description}</span>
        <Show when={it.repo.private}>
          <Badge variant="outline" class="text-muted-foreground">
            private
          </Badge>
        </Show>
      </>
    );
  }
  const pr = it.pr;
  return (
    <>
      {pr.isDraft ? (
        <GitPullRequestDraft class="flex-none text-muted-foreground" />
      ) : (
        <GitPullRequest class="flex-none text-success" />
      )}
      <span class="pi-title min-w-0 flex-[0_1_auto] truncate">{pr.title}</span>
      <span class={META}>
        {pr.owner}/{pr.repo}#{pr.number} · {pr.author} · {timeAgo(pr.updatedAt)}
      </span>
      <Show when={pr.isDraft}>
        <Badge variant="secondary">draft</Badge>
      </Show>
    </>
  );
}
