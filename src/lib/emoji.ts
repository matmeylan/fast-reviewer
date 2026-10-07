// Slack-style emoji shortcodes for comment boxes: typing ":thu" suggests 👍, and a
// closing colon (":thumbsup:") turns a known shortcode into its emoji. Names are
// GitHub's (gemoji), so they match what reviewers type on github.com.

export interface Emoji {
  emoji: string;
  names: readonly string[];
  tags: readonly string[];
}

export interface EmojiMatch {
  emoji: string;
  /** The shortcode that matched, shown as ":name:". */
  name: string;
}

/** The ":query" being typed right before the caret; `start` is the colon's index. */
export interface EmojiTrigger {
  start: number;
  query: string;
}

// The colon starts the text, a line or a word ("10:30", "a:b" and URLs don't count), and
// two characters follow, like Slack, so ":D" stays a smiley.
const TRIGGER = /(?:^|[\s([{"'])(:([a-z0-9_+-]{2,32}))$/i;
const CLOSED = /(?:^|[\s([{"'])(:([a-z0-9_+-]{2,32}):)$/i;

export function emojiTrigger(text: string, caret: number): EmojiTrigger | null {
  const m = TRIGGER.exec(text.slice(Math.max(0, caret - 40), caret));
  if (!m) return null;
  return { start: caret - m[1].length, query: m[2].toLowerCase() };
}

/** A just-closed ":name:" before the caret, if any. */
export function closedShortcode(text: string, caret: number): { start: number; name: string } | null {
  const m = CLOSED.exec(text.slice(Math.max(0, caret - 40), caret));
  return m ? { start: caret - m[1].length, name: m[2].toLowerCase() } : null;
}

/** Common in reviews: listed before other matches as good, so ":th" offers 👍 before 3️⃣. */
const POPULAR = [
  "+1", "-1", "tada", "rocket", "eyes", "heart", "fire", "100", "pray", "clap", "raised_hands",
  "sparkles", "thinking", "smile", "joy", "sweat_smile", "white_check_mark", "warning", "bug",
  "wave", "ok_hand", "bulb", "heart_eyes", "laughing", "star", "muscle", "see_no_evil",
  "facepalm", "shrug", "wink", "slightly_smiling_face", "upside_down_face", "exploding_head",
];

export class EmojiIndex {
  private byName = new Map<string, string>();
  private popular: Set<string>;

  constructor(private readonly all: readonly Emoji[]) {
    for (const e of all) for (const n of e.names) if (!this.byName.has(n)) this.byName.set(n, e.emoji);
    this.popular = new Set(POPULAR.map((n) => this.byName.get(n)).filter((e) => e !== undefined));
  }

  get(name: string): string | undefined {
    return this.byName.get(name.toLowerCase());
  }

  /**
   * Best matches first: an exact name, a name prefix, a word in a name ("_up" for
   * "thumbs_up"), a tag prefix, then anywhere in a name. Popular emoji, then shorter
   * names, win ties.
   */
  search(query: string, limit = 8): EmojiMatch[] {
    const q = query.toLowerCase();
    const scored: { m: EmojiMatch; rank: number; i: number; common: boolean }[] = [];
    this.all.forEach((e, i) => {
      let best: { rank: number; name: string } | null = null;
      for (const n of e.names) {
        const rank =
          n === q ? 0 : n.startsWith(q) ? 1 : n.includes(`_${q}`) ? 2 : n.includes(q) ? 4 : -1;
        if (rank >= 0 && (!best || rank < best.rank || (rank === best.rank && n.length < best.name.length)))
          best = { rank, name: n };
      }
      if ((!best || best.rank > 3) && e.tags.some((t) => t.startsWith(q))) best = { rank: 3, name: e.names[0] };
      if (best) scored.push({ m: { emoji: e.emoji, name: best.name }, rank: best.rank, i, common: this.popular.has(e.emoji) });
    });
    scored.sort(
      (a, b) =>
        a.rank - b.rank || +b.common - +a.common || a.m.name.length - b.m.name.length || a.i - b.i,
    );
    return scored.slice(0, limit).map((s) => s.m);
  }
}

let loading: Promise<EmojiIndex> | undefined;

/** The emoji list is ~270 kB: loaded the first time a shortcode is typed. */
export function loadEmoji(): Promise<EmojiIndex> {
  loading ??= import("gemoji").then((m) => new EmojiIndex(m.gemoji));
  return loading;
}
