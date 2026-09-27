// Virtualized file tree: only rows in (or near) the viewport are in the DOM.
// Styled after the changed-files trees of JetBrains IDEs: file-type icons, change
// status as the name's color, and little else on a row.
import {
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  type JSX,
} from "solid-js";
import Check from "lucide-solid/icons/check";
import ChevronRight from "lucide-solid/icons/chevron-right";
import type { AppStore } from "../lib/store";
import { visibleRows, type DirNode, type FileNode, type Row } from "../lib/tree";
import type { ChangedFile, FileStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { fileIcon, folderIcon, type IconUrls } from "./file-icons";
import { Checkbox } from "./ui/checkbox";

export const ROW_H = 28;
const OVERSCAN = 12;
const INDENT = 16;
/** Left padding of a depth-0 row. */
const PAD_X = 8;
/** Room above the first and below the last row. */
const PAD_Y = 4;
/** Chevron (14px) plus the gap after it: files sit where a folder's chevron would. */
const CHEVRON_SLOT = 20;

export type TreeView = "tree" | "flat";

/** Change status as the name's color, as in IntelliJ; the label is for tooltips and tests. */
const STATUS: Record<FileStatus, { label: string; class: string }> = {
  added: { label: "Added", class: "text-status-added" },
  removed: { label: "Deleted", class: "text-status-deleted line-through decoration-status-deleted/60" },
  modified: { label: "Modified", class: "text-status-modified" },
  changed: { label: "Changed", class: "text-status-modified" },
  renamed: { label: "Renamed", class: "text-status-modified" },
  copied: { label: "Copied", class: "text-status-modified" },
};

export function Counts(props: { add: number; del: number; class?: string; quiet?: boolean }) {
  // Quiet counts stay gray until their row is hovered or selected.
  const add = () => (props.quiet ? "text-muted-foreground group-hover/row:text-added group-[.selected]/row:text-added" : "text-added");
  const del = () =>
    props.quiet ? "text-muted-foreground group-hover/row:text-deleted group-[.selected]/row:text-deleted" : "text-deleted";
  return (
    <span class={cn("counts inline-flex flex-none gap-1.5 font-mono text-[0.6875rem] tabular-nums", props.class)}>
      <Show when={props.add > 0}>
        <span class={`add ${add()}`}>+{props.add}</span>
      </Show>
      <Show when={props.del > 0}>
        <span class={`del ${del()}`}>−{props.del}</span>
      </Show>
    </span>
  );
}

function Icon(props: { urls: IconUrls; class?: string }) {
  return (
    <picture class={cn("flex size-4 flex-none", props.class)}>
      <source srcset={props.urls.dark} media="(prefers-color-scheme: dark)" />
      <img src={props.urls.light} alt="" width="16" height="16" draggable={false} />
    </picture>
  );
}

/** Wraps the parts of `text` that match a filter token in <mark>. */
function Highlight(props: { text: string; tokens: string[] }): JSX.Element {
  const parts = createMemo(() => {
    const { text, tokens } = props;
    if (tokens.length === 0) return [{ text, hit: false }];
    const lower = text.toLowerCase();
    const hit = new Uint8Array(text.length);
    for (const t of tokens) {
      for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + 1)) hit.fill(1, i, i + t.length);
    }
    const out: { text: string; hit: boolean }[] = [];
    let i = 0;
    while (i < text.length) {
      let j = i + 1;
      while (j < text.length && hit[j] === hit[i]) j++;
      out.push({ text: text.slice(i, j), hit: hit[i] === 1 });
      i = j;
    }
    return out;
  });
  return (
    <Index each={parts()}>
      {(p) =>
        p().hit ? (
          <mark class="rounded-[2px] bg-amber-300/60 text-inherit dark:bg-amber-400/35">{p().text}</mark>
        ) : (
          p().text
        )
      }
    </Index>
  );
}

const ROW =
  "group/row relative flex h-7 items-center gap-1.5 rounded-md pr-1.5 text-[0.8125rem] whitespace-nowrap hover:bg-sidebar-accent";
const SELECTED_ACTIVE = "bg-primary/12! dark:bg-primary/30!";
const SELECTED_INACTIVE = "bg-foreground/[0.07]!";

export default function FileTree(props: { store: AppStore; view: TreeView; active: boolean }) {
  const s = props.store;
  let el!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(800);
  const isSelected = createSelector(s.selected);
  const tokens = createMemo(() => s.filter().toLowerCase().split(/\s+/).filter(Boolean));

  const byPath = createMemo(() => new Map((s.pr()?.files ?? []).map((f) => [f.path, f])));

  /** Files left to review under each folder path (every ancestor of every file). */
  const unviewedIn = createMemo(() => {
    const counts = new Map<string, number>();
    for (const f of s.pr()?.files ?? []) {
      if (s.viewed[f.path]) continue;
      for (let i = f.path.indexOf("/"); i >= 0; i = f.path.indexOf("/", i + 1)) {
        const dir = f.path.slice(0, i);
        counts.set(dir, (counts.get(dir) ?? 0) + 1);
      }
    }
    return counts;
  });

  const rows = createMemo<Row[]>(() => {
    if (props.view === "flat") {
      const files = byPath();
      return s.order().map((path) => {
        const file = files.get(path)!;
        return { node: { kind: "file", name: path.slice(path.lastIndexOf("/") + 1), path, file }, depth: 0 };
      });
    }
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

  // Keep the selected file in view. Uses the tracked scroll position and height:
  // reading el.scrollTop here would force a layout on every selection change.
  const scrollTo = (y: number) => {
    const max = Math.max(0, rows().length * ROW_H + PAD_Y * 2 - height());
    const clamped = Math.min(Math.max(0, y), max);
    el.scrollTop = clamped;
    setScrollTop(clamped);
  };
  createEffect(
    on([s.selected, rows], ([sel, rs]) => {
      if (!sel) return;
      const i = rs.findIndex((r) => r.node.path === sel && r.node.kind === "file");
      if (i < 0) return;
      const top = PAD_Y + i * ROW_H;
      const pad = ROW_H * 2;
      const y = untrack(scrollTop);
      const h = untrack(height);
      if (top < y + pad) scrollTo(Math.max(0, top - pad));
      else if (top + ROW_H > y + h - pad) scrollTo(top + ROW_H - h + pad);
    }),
  );

  /** One vertical line per ancestor level, centred under that level's chevron. */
  const Guides = (p: { depth: number }) => (
    <Index each={Array.from({ length: p.depth })}>
      {(_, i) => (
        <span
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 w-px bg-border"
          style={{ left: `${PAD_X + i * INDENT + 6.5}px` }}
        />
      )}
    </Index>
  );

  const Dir = (p: { node: DirNode; depth: number }) => {
    const open = () => s.filter().trim() !== "" || !s.collapsed[p.node.path];
    const left = () => unviewedIn().get(p.node.path) ?? 0;
    return (
      <div
        class={`row dir ${ROW}`}
        style={{ "padding-left": `${PAD_X + p.depth * INDENT}px` }}
        title={`${p.node.path} · ${left()} of ${p.node.fileCount} left to review · +${p.node.additions} −${p.node.deletions}`}
        onClick={() => s.toggleCollapsed(p.node.path)}
        data-path={p.node.path}
      >
        <Guides depth={p.depth} />
        <ChevronRight
          class="size-3.5 flex-none text-muted-foreground transition-transform duration-100"
          classList={{ "rotate-90": open() }}
        />
        <Icon urls={folderIcon()} />
        <span class="name min-w-0 flex-1 truncate">
          <Highlight text={p.node.name} tokens={tokens()} />
        </span>
        <Show
          when={left() > 0}
          fallback={<Check class="size-3.5 flex-none text-success" aria-label="All reviewed" />}
        >
          <span class="left flex-none text-[0.6875rem] text-muted-foreground tabular-nums">{left()} left</span>
        </Show>
      </div>
    );
  };

  const File = (p: { node: FileNode; depth: number }) => {
    const f: ChangedFile = p.node.file;
    const status = STATUS[f.status];
    const viewed = () => !!s.viewed[f.path];
    const dir = () => (props.view === "flat" ? f.path.slice(0, Math.max(0, f.path.lastIndexOf("/"))) : "");
    return (
      <div
        class={`row file ${ROW}`}
        classList={{
          selected: isSelected(f.path),
          [SELECTED_ACTIVE]: isSelected(f.path) && props.active,
          [SELECTED_INACTIVE]: isSelected(f.path) && !props.active,
          viewed: viewed(),
        }}
        style={{
          "padding-left": `${PAD_X + p.depth * INDENT + (props.view === "tree" ? CHEVRON_SLOT : 0)}px`,
        }}
        title={`${f.previousPath ? `${f.previousPath} → ${f.path}` : f.path} · ${status.label}`}
        onClick={() => s.select(f.path)}
        data-path={f.path}
        data-status={f.status}
        data-testid="tree-file"
      >
        <Guides depth={p.depth} />
        <Icon urls={fileIcon(f.path)} class={viewed() ? "opacity-50" : undefined} />
        <span class="flex min-w-0 flex-1 items-baseline gap-2" classList={{ "opacity-50": viewed() }}>
          <span class={`name max-w-full flex-none truncate ${status.class}`}>
            <Highlight text={p.node.name} tokens={tokens()} />
          </span>
          <Show when={dir()}>
            <span class="min-w-0 truncate text-xs text-muted-foreground">
              <Highlight text={dir()} tokens={tokens()} />
            </span>
          </Show>
        </span>
        <Counts add={f.additions} del={f.deletions} quiet class={viewed() ? "opacity-50" : undefined} />
        <span class="relative flex size-4 flex-none items-center justify-center">
          <Show when={viewed()}>
            <Check
              class="size-3.5 text-success group-hover/row:invisible"
              stroke-width={2.5}
              aria-hidden="true"
            />
          </Show>
          {/* Viewed files show a check mark; the checkbox appears on hover (and on the selected row when unviewed). */}
          <Checkbox
            class={cn(
              "absolute inset-0 invisible border-muted-foreground/50 bg-background group-hover/row:visible dark:border-muted-foreground/60",
              !viewed() && "group-[.selected]/row:visible",
            )}
            checked={viewed()}
            title={viewed() ? "Viewed (u to unmark)" : "Mark viewed (u)"}
            aria-label="Viewed"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onChange={(on) => s.markViewed(f.path, on)}
          />
        </span>
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
