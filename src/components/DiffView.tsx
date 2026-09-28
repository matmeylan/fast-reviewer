// OWNER: diff-view agent. Contract used by the app shell:
// <DiffView diff mode hunkNav find findNav onFindStatus /> renders one file's
// diff, virtualized, with syntax highlighting swapped in from the highlight
// worker when ready, find-in-file matches highlighted, and selectable code.
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import type { DiffLine, FileDiff } from "../lib/types";
import type { ThemeName } from "../lib/highlight-protocol";
import { renderLineHtml, paletteCss, type LineHits } from "../lib/highlight-merge";
import { colorScheme, highlightDiff, paletteOf, tokensFor, type Side } from "../lib/highlight-client";
import {
  anchorRow,
  buildRows,
  cols,
  computeGaps,
  emptyExpansion,
  expandGap,
  EXPAND_STEP,
  splitTextLines,
  type Expansion,
  type Row,
  type RowModel,
} from "./diff-rows";
import { findMatches, matchFrom, sameMatch, stepMatch, type FindMatch, type FindOptions, type FindStatus } from "./diff-find";
import "./diff.css";

export type DiffMode = "split" | "unified";

export interface DiffViewProps {
  diff: FileDiff;
  mode: DiffMode;
  /** Incremented by the shell to request scrolling to next (+1) / previous (-1) hunk. */
  hunkNav?: { dir: 1 | -1; seq: number };
  /** Force a theme; defaults to the OS color scheme. */
  theme?: ThemeName;
  /** Line stats, shown for files too large to display. */
  stats?: { additions: number; deletions: number };
  /** Text to find in the file; matches are highlighted. Omit while the find bar is closed. */
  find?: FindOptions;
  /** Incremented by the shell to step to the next (+1) / previous (-1) find match. */
  findNav?: { dir: 1 | -1; seq: number };
  /** Reports the number of find matches and the current one (-1: none yet). */
  onFindStatus?: (status: FindStatus) => void;
}

export const ROW_HEIGHT = 20;
const OVERSCAN = 20;
const CODE_PAD = 32;
/** Farthest (in rows) a selection's anchor row is kept rendered while scrolled away. */
const PIN_MAX = 2000;

const linesCache = new WeakMap<FileDiff, string[] | null>();
function newTextLines(diff: FileDiff): string[] | null {
  let lines = linesCache.get(diff);
  if (lines === undefined) {
    lines = diff.newText == null ? null : splitTextLines(diff.newText);
    linesCache.set(diff, lines);
  }
  return lines;
}

export default function DiffView(props: DiffViewProps) {
  return (
    <Switch fallback={<DiffBody {...props} />}>
      <Match when={props.diff.binary}>
        <div class="diff-view diff-empty" data-theme={props.theme ?? colorScheme()} data-path={props.diff.path}>Binary file not shown</div>
      </Match>
      <Match when={props.diff.tooLarge}>
        <div class="diff-view diff-empty" data-theme={props.theme ?? colorScheme()} data-path={props.diff.path}>
          File too large to display
          <Show when={props.stats}>
            {(s) => (
              <span class="diff-stats">
                <span class="add">+{s().additions}</span> <span class="del">−{s().deletions}</span>
              </span>
            )}
          </Show>
        </div>
      </Match>
      <Match when={props.diff.hunks.length === 0}>
        <div class="diff-view diff-empty" data-theme={props.theme ?? colorScheme()} data-path={props.diff.path}>
          {props.diff.oldPath && props.diff.oldPath !== props.diff.path
            ? "File renamed without changes"
            : "No changes"}
        </div>
      </Match>
    </Switch>
  );
}

function DiffBody(props: DiffViewProps) {
  let scroller!: HTMLDivElement;
  let rowsEl!: HTMLDivElement;
  let hbar!: HTMLDivElement;
  let measure!: HTMLSpanElement;

  const theme = () => props.theme ?? colorScheme();
  const newLines = createMemo(() => newTextLines(props.diff));
  const gaps = createMemo(() => computeGaps(props.diff.hunks, newLines()?.length ?? null));

  // Expansion state is tied to the diff it was made for, so a new diff starts collapsed.
  const [expState, setExpState] = createSignal<{ diff: FileDiff; exp: Expansion } | null>(null);
  const expansion = () => {
    const s = expState();
    return s && s.diff === props.diff ? s.exp : emptyExpansion(gaps().length);
  };
  const expand = (gap: number, dir: "up" | "down" | "all") =>
    setExpState({ diff: props.diff, exp: expandGap(gaps(), expansion(), gap, dir) });

  const model = createMemo(() => buildRows(props.diff, props.mode, expansion(), newLines()));

  // --- Syntax tokens ------------------------------------------------------
  // Plain text renders first; tokens stream in from the worker and swap in.
  const highlight = createMemo(() => {
    const h = highlightDiff(props.diff, theme());
    onCleanup(() => h.cancel());
    return h;
  });
  const tokens = () => highlight().tokens();
  const palette = createMemo(() => paletteCss(paletteOf(tokens()), ".diff-view"));

  // --- Find -------------------------------------------------------------------
  const matches = createMemo(() => (props.find ? findMatches(model().rows, props.find) : []));
  /** Index into matches(), or -1 before the user has stepped to one. */
  const [current, setCurrent] = createSignal(-1);
  const matchesByLine = createMemo(() => {
    const map = new Map<DiffLine, number[]>();
    matches().forEach((m, i) => {
      const list = map.get(m.line);
      if (list) list.push(i);
      else map.set(m.line, [i]);
    });
    return map;
  });

  // Rendered HTML per line, invalidated when tokens change.
  const htmlCache = createMemo(() => {
    tokens();
    return { old: new WeakMap<DiffLine, string>(), new: new WeakMap<DiffLine, string>() };
  });
  const lineTokens = (line: DiffLine, side: Side) => {
    const t = tokens();
    // Context lines take new-side tokens on both sides so they color identically.
    return line.kind === "context"
      ? tokensFor(t, "new", line.newNo) ?? tokensFor(t, "old", line.oldNo)
      : tokensFor(t, side, side === "old" ? line.oldNo : line.newNo);
  };
  const lineHtml = (line: DiffLine, side: Side): string => {
    const found = matchesByLine().get(line);
    if (found) {
      // Few lines match, and the current match moves: render these fresh.
      const ms = matches();
      const hits: LineHits = { ranges: found.map((i) => [ms[i].start, ms[i].end]), current: found.indexOf(current()) };
      return renderLineHtml(line.text, lineTokens(line, side), line.segments, hits);
    }
    const cache = htmlCache()[side];
    let html = cache.get(line);
    if (html === undefined) {
      html = renderLineHtml(line.text, lineTokens(line, side), line.segments);
      cache.set(line, html);
    }
    return html;
  };

  // --- Text selection -----------------------------------------------------------
  // Rows scrolled out of view leave the DOM, which would drop a selection anchored
  // in them, so the anchor row stays rendered while the selection lives.
  const [pin, setPin] = createSignal<number | null>(null);
  // In split view a selection stays on the side it started on.
  const [selSide, setSelSide] = createSignal<Side | null>(null);

  // --- Virtualization -----------------------------------------------------
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewHeight, setViewHeight] = createSignal(typeof window !== "undefined" ? window.innerHeight : 800);
  const range = createMemo(
    () => {
      const n = model().rows.length;
      const first = Math.floor(scrollTop() / ROW_HEIGHT);
      let start = Math.max(0, first - OVERSCAN);
      let end = Math.min(n, first + Math.ceil(viewHeight() / ROW_HEIGHT) + 1 + OVERSCAN);
      const p = pin();
      if (p !== null && p < n && Math.abs(p - first) <= PIN_MAX) {
        start = Math.min(start, p);
        end = Math.max(end, p + 1);
      }
      return { start, end };
    },
    undefined,
    { equals: (a, b) => a.start === b.start && a.end === b.end },
  );
  const visible = createMemo(() => {
    const { start, end } = range();
    return model().rows.slice(start, end);
  });

  // --- Horizontal scroll (shared by both panes; gutters stay put) ---------
  const [scrollX, setScrollX] = createSignal(0);
  const [charWidth, setCharWidth] = createSignal(7.2);
  const [codeWidth, setCodeWidth] = createSignal(0);
  const maxScrollX = () => Math.max(0, Math.ceil(model().maxCols * charWidth() + CODE_PAD - codeWidth()));

  const measureCode = () => {
    const dc = scroller.querySelector<HTMLElement>(".dc");
    if (dc) setCodeWidth(dc.clientWidth);
  };

  const measureChar = () => {
    const w = measure.getBoundingClientRect().width / 64;
    if (w > 0) setCharWidth(w);
  };

  onMount(() => {
    measureChar();
    // The code font is a web font: measure again once it has loaded.
    let live = true;
    onCleanup(() => (live = false));
    document.fonts?.ready.then(() => {
      if (!live) return;
      measureChar();
      measureCode();
    });
    setViewHeight(scroller.clientHeight || viewHeight());
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        setViewHeight(scroller.clientHeight);
        measureCode();
      });
      ro.observe(scroller);
      onCleanup(() => ro.disconnect());
    }
    const onWheel = (e: WheelEvent) => {
      // Shift+wheel on mice without native horizontal scrolling.
      const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
      if (dx === 0) return;
      if (!e.deltaX) e.preventDefault();
      hbar.scrollLeft += dx;
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    onCleanup(() => scroller.removeEventListener("wheel", onWheel));
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("copy", onCopy);
    onCleanup(() => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("copy", onCopy);
    });
    measureCode();
  });

  /** The selection's range when it is a non-empty one inside this diff. */
  const diffSelection = (): Range | null => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    return scroller.contains(r.commonAncestorContainer) ? r : null;
  };

  /** Model row index of the rendered row containing `node`, or -1. */
  const rowOf = (node: Node | null): number => {
    const el = node && scroller.contains(node) ? (node instanceof Element ? node : node.parentElement) : null;
    const dr = el?.closest(".dr");
    return dr && dr.parentElement === rowsEl ? untrack(range).start + Array.prototype.indexOf.call(rowsEl.children, dr) : -1;
  };

  /**
   * Where the last selection in the diff starts. A new find query starts there,
   * so Cmd+F on a selected word makes that occurrence the current match. It
   * outlives the selection moving into the find input; a click in the diff or
   * a find step clears it.
   */
  let selOrigin: { model: RowModel; row: number; line: DiffLine | null; offset: number } | null = null;

  const onSelectionChange = () => {
    const sel = document.getSelection();
    const anchor = sel && !sel.isCollapsed ? rowOf(sel.anchorNode) : -1;
    setPin(anchor >= 0 ? anchor : null);

    const r = diffSelection();
    if (!r) {
      if (sel?.anchorNode && scroller.contains(sel.anchorNode)) selOrigin = null;
      return;
    }
    const row = rowOf(r.startContainer);
    if (row < 0) return;
    const start = r.startContainer;
    const dt = (start instanceof Element ? start : start.parentElement)?.closest(".dt");
    const m = untrack(model);
    const shown = m.rows[row];
    const side = dt?.parentElement?.getAttribute("data-side");
    const line =
      !dt || !shown ? null : shown.t === "line" ? shown.line : shown.t === "pair" ? (side === "old" ? shown.left : shown.right) : null;
    let offset = 0;
    if (dt) {
      const before = document.createRange();
      before.setStart(dt, 0);
      before.setEnd(start, r.startOffset);
      offset = before.toString().length;
    }
    selOrigin = { model: m, row, line, offset };
  };

  // Copy the selected code only: one line per row, no line numbers, and in split
  // view only the side the selection started on.
  const onCopy = (e: ClipboardEvent) => {
    const sel = diffSelection();
    if (!sel || !e.clipboardData) return;
    const side = props.mode === "split" ? selSide() : null;
    const parts: string[] = [];
    for (const dt of rowsEl.querySelectorAll<HTMLElement>(".dt")) {
      if (!sel.intersectsNode(dt)) continue;
      if (side && dt.parentElement?.getAttribute("data-side") !== side) continue;
      const r = document.createRange();
      r.selectNodeContents(dt);
      if (sel.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(sel.startContainer, sel.startOffset);
      if (sel.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(sel.endContainer, sel.endOffset);
      parts.push(r.toString());
    }
    if (parts.length === 0) return;
    e.clipboardData.setData("text/plain", parts.join("\n"));
    e.preventDefault();
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.shiftKey || e.button !== 0) return;
    const dc = (e.target as Element | null)?.closest?.(".dc");
    setSelSide((dc?.getAttribute("data-side") as Side | null) ?? null);
  };

  createEffect(on(() => props.mode, () => requestAnimationFrame(measureCode), { defer: true }));

  // Split and unified give the same line different row indexes. On a mode switch,
  // keep the first visible source line at the top instead of the pixel offset.
  let shown: { model: RowModel; mode: DiffMode; diff: FileDiff } | null = null;
  createEffect(
    on(model, (m) => {
      const prev = shown;
      shown = { model: m, mode: props.mode, diff: props.diff };
      if (!prev || prev.diff !== props.diff || prev.mode === props.mode) return;
      // The signal, not scroller.scrollTop: the DOM may already be clamped to the new height.
      const top = untrack(scrollTop);
      const first = Math.floor(top / ROW_HEIGHT);
      const target = anchorRow(prev.model.rows, first, m.rows);
      if (target === undefined) return;
      scroller.scrollTop = target * ROW_HEIGHT + (top - first * ROW_HEIGHT);
      setScrollTop(scroller.scrollTop);
    }),
  );

  createEffect(
    on(
      () => props.diff.path,
      () => {
        scroller.scrollTop = 0;
        hbar.scrollLeft = 0;
        setScrollTop(0);
        setScrollX(0);
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => props.hunkNav?.seq,
      () => {
        const nav = props.hunkNav;
        if (!nav) return;
        const cur = scroller.scrollTop;
        const hr = model().hunkRows;
        let target: number | undefined;
        if (nav.dir > 0) target = hr.find((i) => i * ROW_HEIGHT > cur + 1);
        else for (let k = hr.length - 1; k >= 0 && target === undefined; k--) if (hr[k] * ROW_HEIGHT < cur - 1) target = hr[k];
        if (target !== undefined) {
          scroller.scrollTop = target * ROW_HEIGHT;
          setScrollTop(scroller.scrollTop);
        }
      },
      { defer: true },
    ),
  );

  const topRow = () => Math.floor(untrack(scrollTop) / ROW_HEIGHT);
  const bottomRow = () => Math.floor((untrack(scrollTop) + untrack(viewHeight)) / ROW_HEIGHT);

  /** Scroll a match into view: vertically centered if off screen, horizontally if clipped. */
  const revealMatch = (m: FindMatch) => {
    const top = m.row * ROW_HEIGHT;
    const h = scroller.clientHeight || untrack(viewHeight);
    if (top < scroller.scrollTop || top + ROW_HEIGHT > scroller.scrollTop + h) {
      scroller.scrollTop = Math.max(0, top - Math.floor((h - ROW_HEIGHT) / 2));
      setScrollTop(scroller.scrollTop);
    }
    const cw = untrack(charWidth);
    const x0 = cols(m.line.text.slice(0, m.start)) * cw;
    const x1 = cols(m.line.text.slice(0, m.end)) * cw;
    const w = untrack(codeWidth);
    const sx = untrack(scrollX);
    if (x0 < sx || x1 > sx + w) {
      hbar.scrollLeft = Math.min(untrack(maxScrollX), Math.max(0, Math.round(x0 - w / 3)));
      setScrollX(hbar.scrollLeft);
    }
  };

  // Keep the current match across rebuilt rows; a new query moves to its first
  // match from where the last one was (or the top of the view) and shows it.
  let lastFind: { diff: FileDiff | null; matches: FindMatch[]; opts?: FindOptions } = { diff: null, matches: [] };
  createEffect(
    on(matches, (ms) => {
      const prev = lastFind;
      const opts = props.find;
      lastFind = { diff: props.diff, matches: ms, opts };
      const was = prev.matches[untrack(current)] as FindMatch | undefined;
      let next = -1;
      if (ms.length === 0 || prev.diff !== props.diff) {
        // A new file starts unpositioned: the next step goes to the first match in view.
      } else if (opts?.query === prev.opts?.query && opts?.caseSensitive === prev.opts?.caseSensitive) {
        next = was ? ms.findIndex((m) => sameMatch(m, was)) : -1;
      } else {
        const o = selOrigin && selOrigin.model === untrack(model) ? selOrigin : null;
        if (o) {
          const exact = o.line ? ms.findIndex((m) => m.line === o.line && m.start === o.offset) : -1;
          next = exact >= 0 ? exact : matchFrom(ms, o.row, o.offset);
        } else next = was ? matchFrom(ms, was.row, was.start) : stepMatch(ms, -1, 1, topRow(), bottomRow());
        revealMatch(ms[next]);
      }
      setCurrent(next);
    }),
  );

  createEffect(
    on(
      () => props.findNav?.seq,
      () => {
        const nav = props.findNav;
        const ms = matches();
        if (!nav || ms.length === 0) return;
        selOrigin = null;
        const i = stepMatch(ms, current(), nav.dir, topRow(), bottomRow());
        setCurrent(i);
        revealMatch(ms[i]);
      },
      { defer: true },
    ),
  );

  createEffect(() => props.onFindStatus?.({ count: matches().length, index: current() }));
  onCleanup(() => props.onFindStatus?.({ count: 0, index: -1 }));

  const gutterCh = () => Math.max(3, String(model().maxLineNo).length) + 2;

  const LineCell = (p: { line: DiffLine | null; side: Side }) => {
    const line = p.line;
    if (!line) return <><span class="ln fill" /><div class="dc fill" /></>;
    const no = p.side === "old" ? line.oldNo : line.newNo;
    return (
      <>
        <span class={`ln ${line.kind}`}>{no ?? ""}</span>
        <div class={`dc ${line.kind}`} data-side={p.side}>
          <div class="dt" innerHTML={lineHtml(line, p.side)} />
        </div>
      </>
    );
  };

  const RowView = (p: { row: Row }) => {
    const row = p.row;
    switch (row.t) {
      case "pair":
        return (
          <div class="dr">
            <LineCell line={row.left} side="old" />
            <LineCell line={row.right} side="new" />
          </div>
        );
      case "line": {
        const l = row.line;
        return (
          <div class={`dr ${l.kind}`}>
            <span class={`ln ${l.kind}`}>{l.oldNo ?? ""}</span>
            <span class={`ln ${l.kind}`}>{l.newNo ?? ""}</span>
            <div class={`dc ${l.kind}`}>
              <div class="dt" innerHTML={lineHtml(l, l.kind === "del" ? "old" : "new")} />
            </div>
          </div>
        );
      }
      case "hunk":
        return (
          <div class="dr dh">
            <div class="dhx">
              <Show
                when={row.remaining > EXPAND_STEP}
                fallback={
                  <Show when={row.up || row.down}>
                    <button class="dhb" title={`Expand all ${row.remaining} lines`} onClick={() => expand(row.gap, "all")}>
                      <Icon d="M4 6l4-4 4 4M4 10l4 4 4-4" />
                    </button>
                  </Show>
                }
              >
                <Show when={row.down}>
                  <button class="dhb" title="Expand down" onClick={() => expand(row.gap, "down")}>
                    <Icon d="M4 6l4 4 4-4" />
                  </button>
                </Show>
                <Show when={row.up}>
                  <button class="dhb" title="Expand up" onClick={() => expand(row.gap, "up")}>
                    <Icon d="M4 10l4-4 4 4" />
                  </button>
                </Show>
              </Show>
            </div>
            <div class="dhh">
              {row.header}
              <Show when={row.up && row.down && row.remaining > EXPAND_STEP}>
                <button class="dha" onClick={() => expand(row.gap, "all")}>
                  Expand all {row.remaining} lines
                </button>
              </Show>
            </div>
          </div>
        );
    }
  };

  return (
    <div
      class="diff-view"
      classList={{ split: props.mode === "split", unified: props.mode !== "split" }}
      data-theme={theme()}
      data-path={props.diff.path}
      data-sel={selSide() ?? undefined}
      style={{ "--gw": `${gutterCh()}ch`, "--sx": `${scrollX()}px` }}
    >
      <style>{palette()}</style>
      <span class="dv-measure" ref={measure} aria-hidden="true">
        {"0".repeat(64)}
      </span>
      <div
        class="dv-scroll"
        ref={scroller}
        onScroll={() => setScrollTop(scroller.scrollTop)}
        onMouseDown={onMouseDown}
      >
        <div class="dv-spacer" style={{ height: `${model().rows.length * ROW_HEIGHT}px` }}>
          <div class="dv-rows" ref={rowsEl} style={{ transform: `translateY(${range().start * ROW_HEIGHT}px)` }}>
            <For each={visible()}>{(row) => <RowView row={row} />}</For>
          </div>
        </div>
      </div>
      <div class="dv-hbar" ref={hbar} hidden={maxScrollX() === 0} onScroll={() => setScrollX(hbar.scrollLeft)}>
        <div style={{ width: `calc(100% + ${maxScrollX()}px)` }} />
      </div>
    </div>
  );
}

function Icon(p: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d={p.d} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
