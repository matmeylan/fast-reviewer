// Cmd+K palette: inbox, pasted PR URLs / refs, repo search -> repo PRs. Keyboard-first.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { errorMessage, type AppStore, type PrRef } from "../lib/store";
import type { PrSummary, RepoSummary } from "../lib/types";
import { parsePrRef, rankPrs, REASON_LABEL } from "./pickerLogic";

type Item =
  | { kind: "ref"; ref: PrRef }
  | { kind: "pr"; pr: PrSummary }
  | { kind: "repo"; repo: RepoSummary };

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

  createEffect(on(items, () => setActive(0)));
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
    try {
      const prs = await s.listRepoPrs(owner, repo);
      const st = stage();
      if (st.kind === "repo" && st.owner === owner && st.repo === repo) setRepoPrs(prs);
    } catch (e) {
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
    <div
      class="overlay picker-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && props.dismissable) s.setOverlay("none");
      }}
    >
      <div class="picker" role="dialog" aria-label="Open pull request" data-testid="picker">
        <div class="picker-input">
          <Show when={repoStage()}>
            {(r) => (
              <button class="crumb" onClick={back} title="Back (Esc)">
                {r().owner}/{r().repo}
              </button>
            )}
          </Show>
          <input
            ref={input}
            value={query()}
            placeholder={placeholder()}
            spellcheck={false}
            autocomplete="off"
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            data-testid="picker-input"
          />
          <Show when={searching() || s.inbox() === null || (stage().kind === "repo" && repoPrs() === null)}>
            <div class="spinner small" />
          </Show>
        </div>
        <div class="picker-list" ref={list}>
          <For each={items()}>
            {(item, i) => (
              <>
                <Show when={i() === 0 || section(items()[i() - 1]) !== section(item)}>
                  <div class="picker-section">{section(item)}</div>
                </Show>
                <div
                  class="picker-item"
                  classList={{ active: active() === i() }}
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
            <div class="picker-empty">
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
        <div class="picker-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <Show when={props.dismissable || stage().kind === "repo"}>
            <span>
              <kbd>esc</kbd> {stage().kind === "repo" ? "back" : "close"}
            </span>
          </Show>
        </div>
      </div>
    </div>
  );
}

function PickerRow(props: { item: Item }) {
  const it = props.item;
  if (it.kind === "ref") {
    return (
      <>
        <span class="pi-icon">↗</span>
        <span class="pi-title">
          Open {it.ref.owner}/{it.ref.repo}#{it.ref.number}
        </span>
      </>
    );
  }
  if (it.kind === "repo") {
    return (
      <>
        <span class="pi-icon">▤</span>
        <span class="pi-title">
          {it.repo.owner}/<b>{it.repo.name}</b>
        </span>
        <span class="pi-meta">{it.repo.description}</span>
        <Show when={it.repo.private}>
          <span class="badge">private</span>
        </Show>
      </>
    );
  }
  const pr = it.pr;
  return (
    <>
      <span class="pi-icon pr-icon" classList={{ draft: pr.isDraft }}>
        ⑂
      </span>
      <span class="pi-title">{pr.title}</span>
      <span class="pi-meta">
        {pr.owner}/{pr.repo}#{pr.number} · {pr.author} · {timeAgo(pr.updatedAt)}
      </span>
      <Show when={pr.isDraft}>
        <span class="badge">draft</span>
      </Show>
    </>
  );
}
