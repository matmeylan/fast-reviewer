// Merges syntax tokens (foreground) with intra-line change segments (background)
// into flat spans, and renders them to an HTML string for one diff row.
import { FONT_BOLD, FONT_ITALIC, FONT_UNDERLINE, STYLE_COLOR_MASK, STYLE_FONT_SHIFT } from "./highlight-protocol";

export interface Span {
  start: number;
  end: number;
  /** Token style (see SideTokens), or -1 for unstyled text. */
  style: number;
  /** Inside an intra-line changed segment. */
  mark: boolean;
}

/**
 * Split `[0, textLength)` at every token and segment boundary.
 * `tokens` are flat `[length, style]` pairs (UTF-16 lengths); text beyond the
 * tokens is unstyled. Segments are `[start, end)` UTF-16 offsets; they are
 * clamped, and empty or overlapping ones are ignored. Adjacent spans with the
 * same style and mark are coalesced.
 */
export function mergeSpans(
  textLength: number,
  tokens: ArrayLike<number> | null,
  segments: readonly (readonly [number, number])[] | null,
): Span[] {
  const out: Span[] = [];
  if (textLength <= 0) return out;
  const tokLen = tokens ? tokens.length - (tokens.length & 1) : 0;
  let ti = 0;
  let tokEnd = tokLen > 0 ? tokens![0] : textLength;
  let style = tokLen > 0 ? tokens![1] : -1;
  let si = 0;
  const segCount = segments ? segments.length : 0;
  let pos = 0;

  while (pos < textLength) {
    // Advance past tokens that end at or before pos (zero-length ones included).
    while (tokEnd <= pos) {
      ti += 2;
      if (ti < tokLen) {
        tokEnd += tokens![ti];
        style = tokens![ti + 1];
      } else {
        tokEnd = textLength;
        style = -1;
      }
    }
    // Skip segments that are empty, out of order or already behind pos.
    while (si < segCount && Math.min(segments![si][1], textLength) <= pos) si++;

    let mark = false;
    let segBoundary = textLength;
    if (si < segCount) {
      const [s, e] = segments![si];
      if (pos >= s) {
        mark = true;
        segBoundary = Math.min(e, textLength);
      } else {
        segBoundary = Math.min(s, textLength);
      }
    }
    const end = Math.min(tokEnd, segBoundary, textLength);
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (last && last.end === pos && last.style === style && last.mark === mark) last.end = end;
    else out.push({ start: pos, end, style, mark });
    pos = end;
  }
  return out;
}

const ESCAPE_RE = /[&<>]/;
const ESCAPE_ALL = /[&<>]/g;
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

export function escapeHtml(s: string): string {
  return ESCAPE_RE.test(s) ? s.replace(ESCAPE_ALL, (c) => ESCAPES[c]) : s;
}

/** CSS class for a token style: `k<color>` plus font classes. */
export function styleClass(style: number): string {
  const font = style >>> STYLE_FONT_SHIFT;
  let cls = "k" + (style & STYLE_COLOR_MASK);
  if (font & FONT_ITALIC) cls += " fi";
  if (font & FONT_BOLD) cls += " fb";
  if (font & FONT_UNDERLINE) cls += " fu";
  return cls;
}

/** Find matches on one line: sorted, non-overlapping [start, end) ranges, and which one is current (-1: none). */
export interface LineHits {
  ranges: readonly (readonly [number, number])[];
  current: number;
}

/** 0: no match, 1: a find match, 2: the current find match. */
type Hit = 0 | 1 | 2;

/** Split spans at find match boundaries and tag each piece with its match state. */
export function splitAtHits(spans: readonly Span[], hits: LineHits): (Span & { hit: Hit })[] {
  const out: (Span & { hit: Hit })[] = [];
  const { ranges, current } = hits;
  let h = 0;
  for (const sp of spans) {
    let pos = sp.start;
    while (pos < sp.end) {
      while (h < ranges.length && ranges[h][1] <= pos) h++;
      let end = sp.end;
      let hit: Hit = 0;
      if (h < ranges.length) {
        const [s, e] = ranges[h];
        if (s <= pos) {
          hit = h === current ? 2 : 1;
          end = Math.min(end, e);
        } else end = Math.min(end, s);
      }
      out.push({ ...sp, start: pos, end, hit });
      pos = end;
    }
  }
  return out;
}

const HIT_CLASS = ["", "fm", "fm fc"];

/**
 * Render one line to HTML. Styled spans get `k<n>`; marked spans get `x`, plus
 * `xl` / `xr` on the left / right edge of each contiguous marked run. Find
 * matches get `fm`, and the current one also `fc`.
 */
export function renderLineHtml(
  text: string,
  tokens: ArrayLike<number> | null,
  segments: readonly (readonly [number, number])[] | null,
  hits: LineHits | null = null,
): string {
  if (hits && hits.ranges.length === 0) hits = null;
  if (!tokens && !segments && !hits) return escapeHtml(text);
  const merged = mergeSpans(text.length, tokens, segments);
  const spans = hits ? splitAtHits(merged, hits) : merged;
  let html = "";
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    const hit = hits ? (sp as Span & { hit: Hit }).hit : 0;
    const body = escapeHtml(text.slice(sp.start, sp.end));
    if (sp.style < 0 && !sp.mark && !hit) {
      html += body;
      continue;
    }
    let cls = sp.style >= 0 ? styleClass(sp.style) : "";
    if (sp.mark) {
      cls = cls ? cls + " x" : "x";
      if (i === 0 || !spans[i - 1].mark) cls += " xl";
      if (i === spans.length - 1 || !spans[i + 1].mark) cls += " xr";
    }
    if (hit) cls = cls ? cls + " " + HIT_CLASS[hit] : HIT_CLASS[hit];
    html += `<span class="${cls}">${body}</span>`;
  }
  return html;
}

/** Stylesheet rules mapping palette indices to colors, scoped under `scope`. */
export function paletteCss(palette: readonly string[], scope: string): string {
  let css = "";
  for (let i = 0; i < palette.length; i++) css += `${scope} .k${i}{color:${palette[i]}}`;
  return css;
}
