// Main-thread side of syntax highlighting: owns the worker, caches results per
// FileDiff object and exposes the current color scheme as a signal.
import { createRoot, createSignal, type Accessor } from "solid-js";
import type { FileDiff } from "./types";
import { lineTokens, type SideTokens, type ThemeName, type WorkerRequest, type WorkerResponse } from "./highlight-protocol";

export type Side = "old" | "new";

interface Pending {
  update: (t: SideTokens | null, done: boolean) => void;
  fail: (cancelled: boolean) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  worker = new Worker(new URL("../workers/highlight.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.ok) {
      if (msg.done) pending.delete(msg.id);
      p.update(msg.tokens, msg.done);
    } else {
      pending.delete(msg.id);
      p.fail(!!msg.cancelled);
    }
  };
  return worker;
}

export interface HighlightJob {
  cancel(): void;
  /** Raise a low-priority job to high priority. */
  bump(): void;
}

/**
 * Tokenize a whole text in the worker. `update` receives progressive partial
 * results and finally the complete one (`done`); it gets null when the
 * language is unsupported.
 */
export function highlightText(
  text: string,
  lang: string,
  theme: ThemeName,
  low: boolean,
  update: Pending["update"],
  fail: Pending["fail"],
): HighlightJob {
  const w = getWorker();
  if (!w) {
    queueMicrotask(() => update(null, true));
    return { cancel() {}, bump() {} };
  }
  const id = nextId++;
  pending.set(id, { update, fail });
  w.postMessage({ type: "highlight", id, text, lang, theme, low } satisfies WorkerRequest);
  const send = (msg: WorkerRequest) => pending.has(id) && w.postMessage(msg);
  return {
    cancel: () => send({ type: "cancel", id }),
    bump: () => send({ type: "bump", id }),
  };
}

/**
 * The hunk lines of one side placed at their line numbers (other lines empty),
 * so token line `n - 1` always belongs to line number `n`. Cheap to tokenize
 * even for huge files; lacks multi-line state from outside the hunks.
 */
export function hunkSource(diff: FileDiff, side: Side): { text: string; lines: number } | null {
  const lines: string[] = [];
  let count = 0;
  for (const h of diff.hunks) {
    for (const l of h.lines) {
      const no = side === "old" ? l.oldNo : l.newNo;
      if (no == null) continue;
      while (lines.length < no - 1) lines.push("");
      lines[no - 1] = l.text;
      count++;
    }
  }
  return count > 0 ? { text: lines.join("\n"), lines: count } : null;
}

/** Tokens for one side: exact whole-file tokens (maybe partial) and a quick hunk-only sketch. */
export interface SideHighlight {
  full: SideTokens | null;
  sketch: SideTokens | null;
}

export interface DiffTokens {
  old: SideHighlight;
  new: SideHighlight;
}

const EMPTY: DiffTokens = { old: { full: null, sketch: null }, new: { full: null, sketch: null } };

/** Best available tokens for a line number on a side: whole-file tokens first, then the sketch. */
export function tokensFor(t: DiffTokens | null, side: Side, lineNo: number | null): Uint32Array | null {
  if (!t || lineNo == null) return null;
  const s = t[side];
  return (s.full && lineTokens(s.full, lineNo - 1)) ?? (s.sketch && lineTokens(s.sketch, lineNo - 1)) ?? null;
}

/** Palette of the most complete token set (all share the worker's per-theme palette). */
export function paletteOf(t: DiffTokens | null): string[] {
  let best: string[] = [];
  if (!t) return best;
  for (const s of [t.old.full, t.old.sketch, t.new.full, t.new.sketch]) {
    if (s && s.palette.length > best.length) best = s.palette;
  }
  return best;
}

interface Entry {
  tokens: Accessor<DiffTokens>;
  jobs: HighlightJob[];
  done: boolean;
}

export interface DiffHighlight {
  /** Reactive; grows as results stream in. */
  tokens: Accessor<DiffTokens>;
  /** Stop unfinished work and forget it (a later call starts over). */
  cancel(): void;
}

const cache = new WeakMap<FileDiff, Map<ThemeName, Entry>>();

/**
 * Highlight both sides of a diff. Service order: hunk sketches (new, old), then
 * whole files (new, old). The sketch is skipped when the hunks are most of the
 * file. Results are cached per FileDiff object and theme. `low` queues behind
 * the visible file (prefetch); a later high-priority call bumps it.
 */
export function highlightDiff(diff: FileDiff, theme: ThemeName, low = false): DiffHighlight {
  let byTheme = cache.get(diff);
  if (!byTheme) cache.set(diff, (byTheme = new Map()));
  let entry = byTheme.get(theme);
  if (entry && !low && !entry.done) for (const j of entry.jobs) j.bump();
  if (!entry) entry = startEntry(diff, theme, low, byTheme);
  const e = entry;
  return {
    tokens: e.tokens,
    cancel() {
      if (e.done) return;
      for (const j of e.jobs) j.cancel();
      if (byTheme!.get(theme) === e) byTheme!.delete(theme);
    },
  };
}

function startEntry(diff: FileDiff, theme: ThemeName, low: boolean, byTheme: Map<ThemeName, Entry>): Entry {
  const [tokens, setTokens] = createSignal<DiffTokens>(EMPTY);
  const entry: Entry = { tokens, jobs: [], done: false };
  const lang = diff.language;
  if (!lang || diff.binary || diff.tooLarge) {
    entry.done = true;
    byTheme.set(theme, entry);
    return entry;
  }

  type Spec = { side: Side; kind: keyof SideHighlight; text: string };
  const specs: Spec[] = [];
  for (const side of ["new", "old"] as const) {
    const full = side === "old" ? diff.oldText : diff.newText;
    const hunks = hunkSource(diff, side);
    if (hunks && (full == null || lineCount(full) > 2 * hunks.lines + 200)) {
      specs.push({ side, kind: "sketch", text: hunks.text });
    }
    if (full != null) specs.push({ side, kind: "full", text: full });
  }
  // Service order: sketches (new, old), then whole files (new, old).
  specs.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "sketch" ? -1 : 1));
  // The high queue is served newest-first, the low queue oldest-first.
  const postOrder = low ? specs : specs.slice().reverse();

  let remaining = postOrder.length;
  const finish = () => {
    if (--remaining === 0) entry.done = true;
  };
  for (const spec of postOrder) {
    const job = highlightText(
      spec.text,
      lang,
      theme,
      low,
      (t, done) => {
        setTokens((prev) => ({ ...prev, [spec.side]: { ...prev[spec.side], [spec.kind]: t } }));
        if (done) finish();
      },
      (cancelled) => {
        if (cancelled && byTheme.get(theme) === entry) byTheme.delete(theme);
        finish();
      },
    );
    entry.jobs.push(job);
  }
  if (remaining === 0) entry.done = true;
  byTheme.set(theme, entry);
  return entry;
}

function lineCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** Warm the highlight cache for a diff the user is likely to open next. */
export function prefetchHighlight(diff: FileDiff, theme: ThemeName = colorScheme()): void {
  highlightDiff(diff, theme, true);
}

let scheme: Accessor<ThemeName> | null = null;

/** Current OS color scheme, reactive to changes. */
export function colorScheme(): ThemeName {
  if (!scheme) {
    scheme = createRoot(() => {
      const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
      const [get, set] = createSignal<ThemeName>(mq?.matches ? "dark" : "light");
      mq?.addEventListener?.("change", (e) => set(e.matches ? "dark" : "light"));
      return get;
    });
  }
  return scheme();
}
