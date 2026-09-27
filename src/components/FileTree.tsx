// Virtualized file tree: only rows in (or near) the viewport are in the DOM.
import { createEffect, createMemo, createSelector, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { AppStore } from "../lib/store";
import { visibleRows, type DirNode, type FileNode } from "../lib/tree";
import type { FileStatus } from "../lib/types";

export const ROW_H = 24;
const OVERSCAN = 12;
const INDENT = 12;

const STATUS: Record<FileStatus, [string, string]> = {
  added: ["A", "Added"],
  removed: ["D", "Deleted"],
  modified: ["M", "Modified"],
  renamed: ["R", "Renamed"],
  copied: ["C", "Copied"],
  changed: ["M", "Changed"],
};

export function Counts(props: { add: number; del: number }) {
  return (
    <span class="counts">
      <Show when={props.add > 0}>
        <span class="add">+{props.add}</span>
      </Show>
      <Show when={props.del > 0}>
        <span class="del">−{props.del}</span>
      </Show>
    </span>
  );
}

export default function FileTree(props: { store: AppStore }) {
  const s = props.store;
  let el!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(800);
  const isSelected = createSelector(s.selected);

  const rows = createMemo(() => {
    const t = s.tree();
    if (!t) return [];
    const filtering = s.filter().trim() !== "";
    return visibleRows(t, filtering ? () => false : (d) => !!s.collapsed[d]);
  });
  const start = createMemo(() => Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN));
  const slice = createMemo(() => {
    const end = Math.ceil((scrollTop() + height()) / ROW_H) + OVERSCAN;
    return rows().slice(start(), end);
  });

  onMount(() => {
    setHeight(el.clientHeight || 800);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  // Keep the selected file in view.
  createEffect(
    on([s.selected, rows], ([sel, rs]) => {
      if (!sel) return;
      const i = rs.findIndex((r) => r.node.path === sel && r.node.kind === "file");
      if (i < 0) return;
      const top = i * ROW_H;
      const pad = ROW_H * 2;
      if (top < el.scrollTop + pad) el.scrollTop = Math.max(0, top - pad);
      else if (top + ROW_H > el.scrollTop + el.clientHeight - pad) el.scrollTop = top + ROW_H - el.clientHeight + pad;
    }),
  );

  const Dir = (p: { node: DirNode; depth: number }) => {
    const open = () => s.filter().trim() !== "" || !s.collapsed[p.node.path];
    return (
      <div
        class="row dir"
        style={{ "padding-left": `${6 + p.depth * INDENT}px` }}
        title={p.node.path}
        onClick={() => s.toggleCollapsed(p.node.path)}
        data-path={p.node.path}
      >
        <span class="chevron" classList={{ open: open() }} />
        <span class="name">{p.node.name}</span>
        <Counts add={p.node.additions} del={p.node.deletions} />
      </div>
    );
  };

  const File = (p: { node: FileNode; depth: number }) => {
    const f = p.node.file;
    const [letter, label] = STATUS[f.status];
    const viewed = () => !!s.viewed[f.path];
    return (
      <div
        class="row file"
        classList={{ selected: isSelected(f.path), viewed: viewed() }}
        style={{ "padding-left": `${6 + p.depth * INDENT + 14}px` }}
        title={f.previousPath ? `${f.previousPath} → ${f.path}` : f.path}
        onClick={() => s.select(f.path)}
        data-path={f.path}
        data-testid="tree-file"
      >
        <span class={`status status-${f.status}`} title={label}>
          {letter}
        </span>
        <span class="name">{p.node.name}</span>
        <Counts add={f.additions} del={f.deletions} />
        <button
          class="check"
          classList={{ on: viewed() }}
          title={viewed() ? "Viewed (u to unmark)" : "Mark viewed (u)"}
          aria-label="Viewed"
          aria-pressed={viewed()}
          onClick={(e) => {
            e.stopPropagation();
            s.markViewed(f.path, !viewed());
          }}
        />
      </div>
    );
  };

  return (
    <div class="tree" ref={el} onScroll={() => setScrollTop(el.scrollTop)} role="tree">
      <div class="tree-spacer" style={{ height: `${rows().length * ROW_H}px` }}>
        <div class="tree-window" style={{ transform: `translateY(${start() * ROW_H}px)` }}>
          <For each={slice()}>
            {(row) =>
              row.node.kind === "dir" ? (
                <Dir node={row.node} depth={row.depth} />
              ) : (
                <File node={row.node} depth={row.depth} />
              )
            }
          </For>
        </div>
      </div>
      <Show when={s.tree() && rows().length === 0}>
        <div class="tree-empty">No files match “{s.filter()}”</div>
      </Show>
    </div>
  );
}
