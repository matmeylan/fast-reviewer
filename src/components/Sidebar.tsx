import { createEffect, on, Show } from "solid-js";
import type { AppStore } from "../lib/store";
import FileTree from "./FileTree";

export default function Sidebar(props: { store: AppStore }) {
  const s = props.store;
  let input!: HTMLInputElement;

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
    <aside class="sidebar">
      <Show when={s.pr()}>
        {(pr) => (
          <header class="pr-header">
            <div class="pr-title" title={pr().title}>
              {pr().title}
            </div>
            <div class="pr-meta">
              <span class="pr-ref">
                {pr().owner}/{pr().repo} <b>#{pr().number}</b>
              </span>
              <span class="pr-branch" title={`${pr().headRef} → ${pr().baseRef}`}>
                {pr().headRef}
              </span>
            </div>
            <div class="progress" data-testid="progress">
              <div class="progress-bar">
                <div class="progress-fill" style={{ width: `${pct()}%` }} />
              </div>
              <span class="progress-label">
                {s.viewedCount()}/{total()} viewed
              </span>
            </div>
          </header>
        )}
      </Show>
      <div class="filter">
        <input
          ref={input}
          type="search"
          placeholder="Filter files  /"
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
      </div>
      <FileTree store={s} />
    </aside>
  );
}
