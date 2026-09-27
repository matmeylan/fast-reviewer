// Virtualized file tree: only rows in (or near) the viewport are in the DOM.
import { createEffect, createMemo, createSelector, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { AppStore } from "../lib/store";
import { visibleRows, type DirNode, type FileNode } from "../lib/tree";
import type { FileStatus } from "../lib/types";
import ChevronRight from "lucide-solid/icons/chevron-right";
import Folder from "lucide-solid/icons/folder";
import FolderOpen from "lucide-solid/icons/folder-open";
import { cn } from "../lib/utils";
import { Checkbox } from "./ui/checkbox";

export const ROW_H = 28;
const OVERSCAN = 12;
const INDENT = 14;
/** Room above the first and below the last row. */
const PAD_Y = 4;

const STATUS_COLOR: Record<FileStatus, string> = {
  added: "text-added",
  removed: "text-deleted",
  modified: "text-modified",
  renamed: "text-renamed",
  copied: "text-renamed",
  changed: "text-modified",
};

const STATUS: Record<FileStatus, [string, string]> = {
  added: ["A", "Added"],
  removed: ["D", "Deleted"],
  modified: ["M", "Modified"],
  renamed: ["R", "Renamed"],
  copied: ["C", "Copied"],
  changed: ["M", "Changed"],
};

export function Counts(props: { add: number; del: number; class?: string }) {
  return (
    <span class={cn("counts inline-flex flex-none gap-1.5 font-mono text-[0.6875rem] tabular-nums", props.class)}>
      <Show when={props.add > 0}>
        <span class="add text-added">+{props.add}</span>
      </Show>
      <Show when={props.del > 0}>
        <span class="del text-deleted">−{props.del}</span>
      </Show>
    </span>
  );
}

const ROW =
  "flex h-7 items-center gap-1.5 rounded-md pr-1.5 text-[0.8125rem] whitespace-nowrap hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

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
  const start = createMemo(() => Math.max(0, Math.floor((scrollTop() - PAD_Y) / ROW_H) - OVERSCAN));
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
      const top = PAD_Y + i * ROW_H;
      const pad = ROW_H * 2;
      if (top < el.scrollTop + pad) el.scrollTop = Math.max(0, top - pad);
      else if (top + ROW_H > el.scrollTop + el.clientHeight - pad) el.scrollTop = top + ROW_H - el.clientHeight + pad;
    }),
  );

  const Dir = (p: { node: DirNode; depth: number }) => {
    const open = () => s.filter().trim() !== "" || !s.collapsed[p.node.path];
    return (
      <div
        class={`row dir ${ROW}`}
        style={{ "padding-left": `${8 + p.depth * INDENT}px` }}
        title={p.node.path}
        onClick={() => s.toggleCollapsed(p.node.path)}
        data-path={p.node.path}
      >
        <ChevronRight
          class="size-3.5 flex-none text-muted-foreground transition-transform duration-100"
          classList={{ "rotate-90": open() }}
        />
        {open() ? (
          <FolderOpen class="size-4 flex-none text-muted-foreground" />
        ) : (
          <Folder class="size-4 flex-none text-muted-foreground" />
        )}
        <span class="name min-w-0 flex-1 truncate text-muted-foreground">{p.node.name}</span>
        <Counts add={p.node.additions} del={p.node.deletions} class="opacity-70" />
      </div>
    );
  };

  const File = (p: { node: FileNode; depth: number }) => {
    const f = p.node.file;
    const [letter, label] = STATUS[f.status];
    const viewed = () => !!s.viewed[f.path];
    return (
      <div
        class={`row file ${ROW}`}
        classList={{
          selected: isSelected(f.path),
          "bg-primary/10! dark:bg-primary/25! text-foreground font-medium": isSelected(f.path),
          viewed: viewed(),
        }}
        style={{ "padding-left": `${8 + p.depth * INDENT + 20}px` }}
        title={f.previousPath ? `${f.previousPath} → ${f.path}` : f.path}
        onClick={() => s.select(f.path)}
        data-path={f.path}
        data-testid="tree-file"
      >
        <span
          class={`status status-${f.status} w-4 flex-none text-center font-mono text-[0.625rem] font-bold ${STATUS_COLOR[f.status]}`}
          title={label}
        >
          {letter}
        </span>
        <span class="name min-w-0 flex-1 truncate" classList={{ "text-muted-foreground": viewed() }}>
          {p.node.name}
        </span>
        <Counts add={f.additions} del={f.deletions} />
        <Checkbox
          class="ml-1"
          checked={viewed()}
          title={viewed() ? "Viewed (u to unmark)" : "Mark viewed (u)"}
          aria-label="Viewed"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          onChange={(on) => s.markViewed(f.path, on)}
        />
      </div>
    );
  };

  return (
    <div
      class="tree relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 contain-strict"
      ref={el}
      onScroll={() => setScrollTop(el.scrollTop)}
      role="tree"
    >
      <div class="relative" style={{ height: `${rows().length * ROW_H + PAD_Y * 2}px` }}>
        <div class="will-change-transform" style={{ transform: `translateY(${PAD_Y + start() * ROW_H}px)` }}>
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
        <div class="px-4 py-6 text-center text-sm text-muted-foreground">No files match “{s.filter()}”</div>
      </Show>
    </div>
  );
}
