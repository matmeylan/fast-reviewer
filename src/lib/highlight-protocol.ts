// Types shared by the highlight worker, its core and the main-thread client.
// Keep this file free of runtime imports so the UI bundle never pulls in Shiki.

export type ThemeName = "light" | "dark";

/**
 * Compact syntax tokens for a whole text.
 * `data` holds flat `[length, style]` pairs; line `i` (0-based) owns
 * `data.subarray(lineStarts[i], lineStarts[i + 1])`.
 * `style = paletteIndex | (fontStyle << STYLE_FONT_SHIFT)`.
 */
export interface SideTokens {
  palette: string[];
  data: Uint32Array;
  lineStarts: Uint32Array;
  /** Set on progressive (partial) results: only lines `< ready` are tokenized. */
  ready?: number;
}

export const STYLE_FONT_SHIFT = 16;
export const STYLE_COLOR_MASK = (1 << STYLE_FONT_SHIFT) - 1;
export const FONT_ITALIC = 1;
export const FONT_BOLD = 2;
export const FONT_UNDERLINE = 4;

export type WorkerRequest =
  | { type: "highlight"; id: number; text: string; lang: string; theme: ThemeName; low?: boolean }
  | { type: "cancel"; id: number }
  /** Promote a queued low-priority request to high priority. */
  | { type: "bump"; id: number };

export type WorkerResponse =
  /** `done: false` marks a progressive partial result; more messages follow. */
  | { id: number; ok: true; done: boolean; tokens: SideTokens | null }
  | { id: number; ok: false; error: string; cancelled?: boolean };

/** Number of lines in a token set. */
export function tokenLineCount(t: SideTokens): number {
  return t.lineStarts.length - 1;
}

/** Flat `[length, style]` pairs for a 0-based line, or null when out of range or not tokenized yet. */
export function lineTokens(t: SideTokens, line: number): Uint32Array | null {
  if (line < 0 || line + 1 >= t.lineStarts.length || (t.ready !== undefined && line >= t.ready)) return null;
  return t.data.subarray(t.lineStarts[line], t.lineStarts[line + 1]);
}
