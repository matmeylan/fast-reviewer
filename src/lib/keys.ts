// Keyboard handling as pure functions: key -> action, then (state, action) -> update.
// The store applies updates and runs effects; nothing here touches the DOM or backend.

export type Action =
  | "review"
  | "skip"
  | "next"
  | "prev"
  | "toggleViewed"
  | "toggleMode"
  | "nextHunk"
  | "prevHunk"
  | "openBrowser"
  | "picker"
  | "help"
  | "escape"
  | "focusFilter";

export type Mode = "split" | "unified";
export type Overlay = "none" | "picker" | "help";

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

const PLAIN_KEYS: Record<string, Action> = {
  r: "review",
  s: "skip",
  j: "next",
  ArrowDown: "next",
  k: "prev",
  ArrowUp: "prev",
  u: "toggleViewed",
  v: "toggleMode",
  n: "nextHunk",
  p: "prevHunk",
  o: "openBrowser",
  "?": "help",
  "/": "focusFilter",
};

export function keyToAction(e: KeyLike, typing: boolean): Action | null {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey && e.key.toLowerCase() === "k") return "picker";
  if (e.key === "Escape") return "escape";
  if (typing || mod || e.altKey) return null;
  return PLAIN_KEYS[e.key] ?? null;
}

/** Input types that take no text: plain shortcuts keep working while they have focus. */
const NON_TEXT_INPUTS = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "range",
  "color",
  "file",
  "image",
  "hidden",
]);

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
  return tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

export interface NavState {
  /** File paths in visual tree order. */
  order: readonly string[];
  current: string | null;
  isViewed: (path: string) => boolean;
  mode: Mode;
  overlay: Overlay;
  /** "All files reviewed" screen is showing. */
  done: boolean;
}

export type Effect =
  | { type: "setViewed"; path: string; viewed: boolean }
  | { type: "nextHunk" }
  | { type: "prevHunk" }
  | { type: "openBrowser" }
  | { type: "focusFilter" };

export interface Update {
  current?: string | null;
  mode?: Mode;
  overlay?: Overlay;
  done?: boolean;
  effects: Effect[];
}

/** Next file after `from` that is not viewed, wrapping around; `from` itself is excluded. */
export function nextUnviewed(
  order: readonly string[],
  from: string | null,
  isViewed: (path: string) => boolean,
): string | null {
  const n = order.length;
  const start = from === null ? -1 : order.indexOf(from);
  for (let i = 1; i <= n; i++) {
    const p = order[(start + i + n) % n];
    if (p !== from && !isViewed(p)) return p;
  }
  return null;
}

/**
 * The next `n` unviewed files after `from`, wrapping around: exactly the files
 * repeated `r` / `s` presses visit, in that order. `from` itself is excluded.
 */
export function upcomingUnviewed(
  order: readonly string[],
  from: string | null,
  isViewed: (path: string) => boolean,
  n: number,
): string[] {
  const len = order.length;
  const start = from === null ? -1 : order.indexOf(from);
  const out: string[] = [];
  for (let i = 1; i <= len && out.length < n; i++) {
    const p = order[(start + i + len) % len];
    if (p !== from && !isViewed(p)) out.push(p);
  }
  return out;
}

function step(order: readonly string[], from: string | null, dir: 1 | -1): string | null {
  if (order.length === 0) return null;
  if (from === null) return dir === 1 ? order[0] : order[order.length - 1];
  const i = order.indexOf(from);
  if (i < 0) return order[0];
  const j = i + dir;
  return j >= 0 && j < order.length ? order[j] : from;
}

export function reduce(s: NavState, action: Action): Update {
  if (action === "picker") return { overlay: s.overlay === "picker" ? "none" : "picker", effects: [] };
  if (action === "escape") return s.overlay !== "none" ? { overlay: "none", effects: [] } : { effects: [] };
  if (action === "help") return { overlay: s.overlay === "help" ? "none" : "help", effects: [] };
  if (s.overlay !== "none") return { effects: [] };

  switch (action) {
    case "next":
    case "prev":
      return { current: step(s.order, s.current, action === "next" ? 1 : -1), done: false, effects: [] };
    case "review": {
      if (s.current === null) return { current: nextUnviewed(s.order, null, s.isViewed), effects: [] };
      const effects: Effect[] = s.isViewed(s.current)
        ? []
        : [{ type: "setViewed", path: s.current, viewed: true }];
      const target = nextUnviewed(s.order, s.current, s.isViewed);
      return target === null ? { done: true, effects } : { current: target, done: false, effects };
    }
    case "skip": {
      const target = nextUnviewed(s.order, s.current, s.isViewed) ?? step(s.order, s.current, 1);
      return { current: target, done: false, effects: [] };
    }
    case "toggleViewed":
      if (s.current === null) return { effects: [] };
      return {
        done: false,
        effects: [{ type: "setViewed", path: s.current, viewed: !s.isViewed(s.current) }],
      };
    case "toggleMode":
      return { mode: s.mode === "split" ? "unified" : "split", effects: [] };
    case "nextHunk":
      return { effects: [{ type: "nextHunk" }] };
    case "prevHunk":
      return { effects: [{ type: "prevHunk" }] };
    case "openBrowser":
      return { effects: [{ type: "openBrowser" }] };
    case "focusFilter":
      return { effects: [{ type: "focusFilter" }] };
  }
}
