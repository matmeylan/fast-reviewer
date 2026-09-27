import { Match, Show, Switch } from "solid-js";
import type { AppStore } from "../lib/store";
import DiffView from "./DiffView";
import { Counts } from "./FileTree";

export default function MainPane(props: { store: AppStore }) {
  const s = props.store;
  const file = () => {
    const p = s.pr();
    const sel = s.selected();
    return p && sel ? p.files.find((f) => f.path === sel) ?? null : null;
  };
  const viewed = () => {
    const f = file();
    return f ? !!s.viewed[f.path] : false;
  };

  return (
    <main class="main">
      <div class="toolbar">
        <Show when={file()} fallback={<span class="toolbar-path" />}>
          {(f) => (
            <>
              <span class="toolbar-path" title={f().path} data-testid="current-path">
                <Show when={f().previousPath}>
                  <span class="muted">{f().previousPath} → </span>
                </Show>
                {f().path}
              </span>
              <Counts add={f().additions} del={f().deletions} />
              <label class="viewed-toggle" classList={{ on: viewed() }} title="Toggle viewed (u)">
                <input
                  type="checkbox"
                  checked={viewed()}
                  onChange={(e) => s.markViewed(f().path, e.currentTarget.checked)}
                  data-testid="viewed-toggle"
                />
                Viewed
              </label>
            </>
          )}
        </Show>
        <div class="segmented" role="group" aria-label="Diff mode" data-testid="mode-toggle">
          <button classList={{ on: s.mode() === "split" }} onClick={() => s.setMode("split")} title="Split (v)">
            Split
          </button>
          <button classList={{ on: s.mode() === "unified" }} onClick={() => s.setMode("unified")} title="Unified (v)">
            Unified
          </button>
        </div>
      </div>
      <div class="diff-host">
        <Switch>
          <Match when={s.prLoading()}>
            {(ref) => (
              <div class="placeholder">
                <div class="spinner" />
                Loading {ref().owner}/{ref().repo}#{ref().number}…
              </div>
            )}
          </Match>
          <Match when={s.done()}>
            <div class="placeholder done" data-testid="all-reviewed">
              <div class="done-icon">✓</div>
              <div class="done-title">All files reviewed</div>
              <div class="muted">
                {s.viewedCount()}/{s.pr()?.files.length} viewed · <kbd>j</kbd>/<kbd>k</kbd> to keep browsing ·{" "}
                <kbd>⌘K</kbd> for the next PR
              </div>
            </div>
          </Match>
          <Match when={s.diff().error}>
            {(err) => (
              <div class="placeholder error">
                <div>Couldn't load diff: {err()}</div>
                <button class="btn" onClick={() => s.retryDiff()}>
                  Retry
                </button>
              </div>
            )}
          </Match>
          <Match when={s.diff().loading}>
            <div class="placeholder">
              <div class="spinner" />
            </div>
          </Match>
          <Match when={s.diff().diff}>
            {(d) => <DiffView diff={d()} mode={s.mode()} hunkNav={s.hunkNav()} />}
          </Match>
          <Match when={s.pr() && s.pr()!.files.length === 0}>
            <div class="placeholder muted">This pull request has no changed files.</div>
          </Match>
        </Switch>
      </div>
    </main>
  );
}
