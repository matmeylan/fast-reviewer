// Shiki-based tokenizer. Runs inside the highlight worker (and in Node tests).
// Fine-grained core + JavaScript regex engine (no WASM); grammars load lazily.
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";
import { STYLE_FONT_SHIFT, type SideTokens, type ThemeName } from "./highlight-protocol";

const THEME_IDS: Record<ThemeName, string> = { light: "github-light", dark: "github-dark" };
const THEME_LOADERS: Record<ThemeName, () => Promise<{ default: unknown }>> = {
  light: () => import("shiki/themes/github-light.mjs"),
  dark: () => import("shiki/themes/github-dark.mjs"),
};

/** Lines per tokenization chunk; the grammar state is carried across chunks. The first is small for a fast first result. */
const FIRST_CHUNK_LINES = 200;
const CHUNK_LINES = 1000;
/** Skip highlighting for texts larger than this (UTF-16 units). */
export const MAX_HIGHLIGHT_CHARS = 4_000_000;

const PLAIN = new Set(["text", "plaintext", "txt", "plain"]);

export class HighlightCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export interface TokenizeOptions {
  /** Called between chunks; return true to abort with HighlightCancelled. */
  isCancelled?: () => boolean;
  /** Awaited between chunks so other messages (e.g. cancel) can be processed. */
  yieldFn?: () => Promise<void>;
  /** Receives a partial result (with `ready` set) after every chunk but the last. */
  onProgress?: (partial: SideTokens) => void;
}

export interface HighlightCore {
  /** Canonical Shiki language id for `lang`, or null when unsupported. */
  resolveLanguage(lang: string | null): string | null;
  tokenize(text: string, lang: string | null, theme: ThemeName, opts?: TokenizeOptions): Promise<SideTokens | null>;
}

interface Palette {
  colors: string[];
  index: Map<string, number>;
}

export function createHighlightCore(): HighlightCore {
  let hl: Promise<HighlighterCore> | null = null;
  const loadedThemes = new Map<ThemeName, Promise<void>>();
  const loadedLangs = new Map<string, Promise<void>>();
  const palettes = new Map<ThemeName, Palette>();

  const highlighter = () =>
    (hl ??= createHighlighterCore({
      themes: [],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    }));

  const ensureTheme = (theme: ThemeName) => {
    let p = loadedThemes.get(theme);
    if (!p) {
      p = highlighter().then(async (h) => h.loadTheme((await THEME_LOADERS[theme]()).default as never));
      loadedThemes.set(theme, p);
    }
    return p;
  };

  const ensureLang = (id: string) => {
    let p = loadedLangs.get(id);
    if (!p) {
      const loader = bundledLanguages[id as keyof typeof bundledLanguages];
      p = highlighter().then(async (h) => h.loadLanguage((await loader()).default));
      p.catch(() => loadedLangs.delete(id));
      loadedLangs.set(id, p);
    }
    return p;
  };

  const paletteFor = (theme: ThemeName) => {
    let p = palettes.get(theme);
    if (!p) palettes.set(theme, (p = { colors: [], index: new Map() }));
    return p;
  };

  const resolveLanguage = (lang: string | null): string | null => {
    if (!lang) return null;
    const id = lang.toLowerCase();
    if (PLAIN.has(id)) return null;
    return id in bundledLanguages ? id : null;
  };

  return {
    resolveLanguage,
    async tokenize(text, lang, theme, opts = {}) {
      const id = resolveLanguage(lang);
      if (!id || text.length > MAX_HIGHLIGHT_CHARS) return null;
      const [h] = await Promise.all([highlighter(), ensureTheme(theme), ensureLang(id)]);
      const themeId = THEME_IDS[theme];
      const fg = h.getTheme(themeId).fg;
      const pal = paletteFor(theme);
      const colorIndex = (c: string | undefined) => {
        const key = (c ?? fg).toLowerCase();
        let i = pal.index.get(key);
        if (i === undefined) {
          i = pal.colors.length;
          pal.colors.push(key);
          pal.index.set(key, i);
        }
        return i;
      };

      const lines = text.split(/\r?\n/);
      const data: number[] = [];
      const lineStarts = new Uint32Array(lines.length + 1);
      let lineNo = 0;
      let state: ReturnType<HighlighterCore["getLastGrammarState"]> | undefined;

      for (let start = 0; start < lines.length; ) {
        if (start > 0) {
          opts.onProgress?.({
            palette: pal.colors.slice(),
            data: Uint32Array.from(data),
            lineStarts: lineStarts.slice(0, lineNo + 1).fill(data.length, lineNo),
            ready: lineNo,
          });
          if (opts.yieldFn) await opts.yieldFn();
          if (opts.isCancelled?.()) throw new HighlightCancelled();
        }
        const end = start + (start === 0 ? FIRST_CHUNK_LINES : CHUNK_LINES);
        const chunk = lines.slice(start, end).join("\n");
        start = end;
        const tokens = h.codeToTokensBase(chunk, {
          lang: id,
          theme: themeId,
          grammarState: state,
          tokenizeMaxLineLength: 5000,
          tokenizeTimeLimit: 500,
        });
        state = h.getLastGrammarState(tokens);
        for (const line of tokens) {
          lineStarts[lineNo] = data.length;
          let prevStyle = -1;
          for (const t of line) {
            const len = t.content.length;
            if (len === 0) continue;
            const font = t.fontStyle && t.fontStyle > 0 ? t.fontStyle : 0;
            const style = colorIndex(t.color) | (font << STYLE_FONT_SHIFT);
            // Coalesce neighbours with identical style to keep payloads small.
            if (style === prevStyle) data[data.length - 2] += len;
            else data.push(len, style);
            prevStyle = style;
          }
          lineNo++;
        }
      }
      // Shiki may drop a trailing empty line; pad so every source line has an entry.
      for (; lineNo < lines.length; lineNo++) lineStarts[lineNo] = data.length;
      lineStarts[lines.length] = data.length;
      return { palette: pal.colors.slice(), data: Uint32Array.from(data), lineStarts };
    },
  };
}
