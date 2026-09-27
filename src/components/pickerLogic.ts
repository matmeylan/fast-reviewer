// Pure helpers for the PR picker: reference parsing and fuzzy matching.
import type { PrRef } from "../lib/store";
import type { PrSummary } from "../lib/types";

const URL_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const SHORT_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** Parses "https://github.com/o/r/pull/123" or "o/r#123". */
export function parsePrRef(input: string): PrRef | null {
  const s = input.trim();
  const m = URL_RE.exec(s) ?? SHORT_RE.exec(s);
  if (!m) return null;
  const number = Number(m[3]);
  return number > 0 ? { owner: m[1], repo: m[2], number } : null;
}

export const prKey = (r: PrRef): string => `${r.owner}/${r.repo}#${r.number}`;

/**
 * Fuzzy score (higher is better), -1 when `query` doesn't match. Each whitespace-separated
 * token must be a substring, or an "acronym" match where every character either continues
 * the previous match or starts a word ("fpo" -> "Fix pagination off-by-one").
 */
export function fuzzyScore(query: string, text: string): number {
  const t = text.toLowerCase();
  let total = 0;
  for (const token of query.toLowerCase().split(/\s+/)) {
    if (!token) continue;
    const s = tokenScore(token, t);
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

function tokenScore(q: string, t: string): number {
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - Math.min(direct, 500) + (isWordStart(t, direct) ? 100 : 0);
  let score = 0;
  let ti = 0;
  for (const ch of q) {
    let found = t[ti] === ch && ti > 0 ? ti : -1;
    if (found < 0) {
      for (let j = t.indexOf(ch, ti); j >= 0; j = t.indexOf(ch, j + 1)) {
        if (isWordStart(t, j)) {
          found = j;
          break;
        }
      }
    }
    if (found < 0) return -1;
    score += found === ti ? 3 : 1;
    ti = found + 1;
  }
  return score;
}

function isWordStart(t: string, i: number): boolean {
  return i === 0 || /[\s/#_.-]/.test(t[i - 1]);
}

const REASON_ORDER: Record<PrSummary["reason"], number> = { reviewRequested: 0, authored: 1, other: 2 };

export const REASON_LABEL: Record<PrSummary["reason"], string> = {
  reviewRequested: "Review requested",
  authored: "Your pull requests",
  other: "Pull requests",
};

export const prSearchText = (p: PrSummary): string =>
  `${p.owner}/${p.repo}#${p.number} ${p.title} ${p.author}`;

/** Inbox order: review requested, then authored, then other; best match then most recent within a group. */
export function rankPrs(prs: readonly PrSummary[], query: string): PrSummary[] {
  const scored: { p: PrSummary; s: number }[] = [];
  for (const p of prs) {
    const s = fuzzyScore(query, prSearchText(p));
    if (s >= 0) scored.push({ p, s });
  }
  scored.sort(
    (a, b) =>
      REASON_ORDER[a.p.reason] - REASON_ORDER[b.p.reason] ||
      b.s - a.s ||
      (a.p.updatedAt < b.p.updatedAt ? 1 : a.p.updatedAt > b.p.updatedAt ? -1 : 0),
  );
  return scored.map((x) => x.p);
}
