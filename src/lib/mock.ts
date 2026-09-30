// In-memory mock backend used outside Tauri (browser dev, Playwright).
// Query flags: ?mock=unauth (start signed out), ?mock=failviewed (setFileViewed rejects),
// ?mock=failreview (submitReview rejects), ?mockViewedDelay=<ms> (setFileViewed takes
// that long; other calls are unaffected). Submitted reviews are recorded in `reviews`
// and, in a browser, `window.__mockReviews` (for e2e).
import type { Backend } from "./api";
import type {
  AuthStatus,
  ChangedFile,
  DiffLine,
  FileDiff,
  FileStatus,
  Hunk,
  PrDetail,
  PrSummary,
  RepoSummary,
  ReviewEvent,
  Side,
  SubmittedReview,
} from "./types";

const LATENCY_MS = 30;
/** submitReview is slower, so the UI's submitting state is visible. */
const REVIEW_LATENCY_MS = 250;
const CONTEXT = 3;

// ---------------------------------------------------------------------------
// Tiny Myers diff (O(ND)); good enough for fixtures, including the 3000-line file.

type Edit = 0 | 1 | 2; // equal, delete, insert

export function myers<T>(a: readonly T[], b: readonly T[]): Edit[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  const pickDown = (k: number, d: number, vv: Int32Array) =>
    k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]);

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = pickDown(k, d, v) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = pickDown(k, d, vv) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : vv[off + prevK];
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push(0);
      x--;
      y--;
    }
    if (d > 0) edits.push(x === prevX ? 2 : 1);
    x = prevX;
    y = prevY;
  }
  return edits.reverse();
}

const TOKEN_RE = /\w+|\s+|[^\w\s]/g;

/** Changed [start, end) ranges on each side of a paired del/add line. */
export function intraLine(oldText: string, newText: string): [[number, number][], [number, number][]] {
  const a = oldText.match(TOKEN_RE) ?? [];
  const b = newText.match(TOKEN_RE) ?? [];
  const oldSeg: [number, number][] = [];
  const newSeg: [number, number][] = [];
  const push = (segs: [number, number][], s: number, e: number) => {
    const last = segs[segs.length - 1];
    if (last && last[1] === s) last[1] = e;
    else segs.push([s, e]);
  };
  let i = 0;
  let j = 0;
  let po = 0;
  let pn = 0;
  for (const e of myers(a, b)) {
    if (e === 0) {
      po += a[i++].length;
      pn += b[j++].length;
    } else if (e === 1) {
      push(oldSeg, po, (po += a[i++].length));
    } else {
      push(newSeg, pn, (pn += b[j++].length));
    }
  }
  return [oldSeg, newSeg];
}

export function computeHunks(oldText: string, newText: string): Hunk[] {
  const split = (t: string) => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
  const a = split(oldText);
  const b = split(newText);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const e of myers(a, b)) {
    if (e === 0) lines.push({ kind: "context", oldNo: ++i, newNo: ++j, text: a[i - 1], segments: null });
    else if (e === 1) lines.push({ kind: "del", oldNo: ++i, newNo: null, text: a[i - 1], segments: null });
    else lines.push({ kind: "add", oldNo: null, newNo: ++j, text: b[j - 1], segments: null });
  }

  // Pair dels with adds inside each change block for intra-line highlights.
  for (let s = 0; s < lines.length; ) {
    if (lines[s].kind === "context") {
      s++;
      continue;
    }
    let e = s;
    while (e < lines.length && lines[e].kind !== "context") e++;
    const dels = lines.slice(s, e).filter((l) => l.kind === "del");
    const adds = lines.slice(s, e).filter((l) => l.kind === "add");
    for (let p = 0; p < Math.min(dels.length, adds.length); p++) {
      [dels[p].segments, adds[p].segments] = intraLine(dels[p].text, adds[p].text);
    }
    s = e;
  }

  const hunks: Hunk[] = [];
  let prevStop = 0;
  let k = 0;
  while (k < lines.length) {
    if (lines[k].kind === "context") {
      k++;
      continue;
    }
    const start = Math.max(k - CONTEXT, prevStop);
    // Merge changes separated by at most 2*CONTEXT context lines.
    let end = k;
    let c = k;
    while (c < lines.length) {
      if (lines[c].kind !== "context") {
        end = ++c;
        continue;
      }
      let r = c;
      while (r < lines.length && lines[r].kind === "context") r++;
      if (r < lines.length && r - c <= 2 * CONTEXT) c = r;
      else break;
    }
    const stop = Math.min(lines.length, end + CONTEXT);
    const hl = lines.slice(start, stop);
    hunks.push({
      oldStart: hl.find((l) => l.oldNo !== null)?.oldNo ?? 0,
      oldLines: hl.filter((l) => l.kind !== "add").length,
      newStart: hl.find((l) => l.newNo !== null)?.newNo ?? 0,
      newLines: hl.filter((l) => l.kind !== "del").length,
      lines: hl,
    });
    prevStop = k = stop;
  }
  return hunks;
}

// ---------------------------------------------------------------------------
// Fixtures

interface FileSpec {
  path: string;
  previousPath?: string;
  status: FileStatus;
  oldText: string | null;
  newText: string | null;
  binary?: boolean;
  /** Contents of binary files (text files are served as their UTF-8 text). */
  oldBytes?: Uint8Array<ArrayBuffer>;
  newBytes?: Uint8Array<ArrayBuffer>;
}

const LANGS: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  py: "python",
  html: "html",
  css: "css",
  md: "markdown",
  json: "json",
  sql: "sql",
  svg: "xml",
};

function languageOf(path: string): string | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return LANGS[ext] ?? null;
}

/** Deterministic PRNG so fixtures are stable across reloads. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Plausible edits: tweak some lines, insert a few, drop a few. */
function mutate(text: string, seed: number, intensity = 0.12): string {
  const r = rng(seed);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const x = r();
    if (line.trim() === "" || x > intensity) {
      out.push(line);
    } else if (x < intensity * 0.2) {
      // dropped
    } else if (x < intensity * 0.55) {
      out.push(line);
      out.push(line.replace(/\S.*/, "") + insertionFor(line, r));
    } else {
      out.push(tweak(line, r));
    }
  }
  return out.join("\n");
}

function insertionFor(line: string, r: () => number): string {
  const py = /^\s*(def |return |if |for |import |from )/.test(line) || line.includes("self");
  const opts = py
    ? ["logger.debug(\"checkpoint\")", "assert result is not None", "# TODO: handle retries"]
    : ["console.debug(\"render\", props);", "// TODO: memoize", "if (!value) return null;"];
  return opts[Math.floor(r() * opts.length)];
}

function tweak(line: string, r: () => number): string {
  const swaps: [RegExp, string][] = [
    [/\bconst\b/, "let"],
    [/\bdata\b/, "payload"],
    [/\bitems\b/, "rows"],
    [/\bvalue\b/, "nextValue"],
    [/\d+/, String(Math.floor(r() * 500))],
    [/"([^"]*)"/, "\"$1-v2\""],
    [/'([^']*)'/, "'$1_v2'"],
    [/\buser\b/, "account"],
  ];
  for (let t = 0; t < swaps.length; t++) {
    const [re, rep] = swaps[Math.floor(r() * swaps.length)];
    if (re.test(line)) return line.replace(re, rep);
  }
  return line.replace(/\s*$/, "") + " // updated";
}

function tsxComponent(name: string): string {
  return `import { createSignal, Show, type JSX } from "solid-js";
import { cx } from "../lib/utils/strings";

export interface ${name}Props {
  title: string;
  disabled?: boolean;
  items?: string[];
  onSelect?: (value: string) => void;
  children?: JSX.Element;
}

export function ${name}(props: ${name}Props) {
  const [open, setOpen] = createSignal(false);
  const [value, setValue] = createSignal("");
  const count = () => props.items?.length ?? 0;

  function handleClick(item: string) {
    if (props.disabled) return;
    setValue(item);
    props.onSelect?.(item);
    setOpen(false);
  }

  return (
    <div class={cx("${name.toLowerCase()}", open() && "is-open")}>
      <header class="${name.toLowerCase()}__header" onClick={() => setOpen(!open())}>
        <h3>{props.title}</h3>
        <span class="badge">{count()}</span>
      </header>
      <Show when={open()}>
        <ul class="${name.toLowerCase()}__list" role="listbox">
          {props.items?.map((item) => (
            <li
              role="option"
              aria-selected={item === value()}
              onClick={() => handleClick(item)}
            >
              {item}
            </li>
          ))}
        </ul>
      </Show>
      {props.children}
    </div>
  );
}

export default ${name};
`;
}

function tsModule(name: string): string {
  return `// ${name} helpers shared by the dashboard.
import type { Order, User } from "../generated/schema";

export const DEFAULT_PAGE_SIZE = 50;
const cache = new Map<string, unknown>();

export interface ${name}Options {
  pageSize?: number;
  signal?: AbortSignal;
}

export async function fetchJson<T>(url: string, opts: ${name}Options = {}): Promise<T> {
  const key = \`\${url}?size=\${opts.pageSize ?? DEFAULT_PAGE_SIZE}\`;
  if (cache.has(key)) return cache.get(key) as T;
  const res = await fetch(key, { signal: opts.signal });
  if (!res.ok) throw new Error(\`Request failed: \${res.status}\`);
  const data = (await res.json()) as T;
  cache.set(key, data);
  return data;
}

export function totalFor(items: Order[]): number {
  let total = 0;
  for (const item of items) total += item.quantity * item.unitPrice;
  return Math.round(total * 100) / 100;
}

export function displayName(user: User): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return name || user.email;
}

export function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}
`;
}

function pyModule(name: string): string {
  return `"""${name} endpoints."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterable

from fastapi import APIRouter, Depends, HTTPException

from api.models import Order, User
from api.server import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/${name}", tags=["${name}"])

PAGE_SIZE = 50


@dataclass
class Page:
    items: list
    total: int
    page: int


def paginate(items: Iterable, page: int, size: int = PAGE_SIZE) -> Page:
    items = list(items)
    start = (page - 1) * size
    return Page(items=items[start : start + size], total=len(items), page=page)


@router.get("/")
def list_${name}(page: int = 1, db=Depends(get_db)) -> Page:
    rows = db.query(Order).order_by(Order.created_at.desc())
    return paginate(rows, page)


@router.get("/{item_id}")
def get_${name.replace(/s$/, "")}(item_id: int, db=Depends(get_db)):
    row = db.get(Order, item_id)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    logger.info("fetched %s", item_id)
    return row
`;
}

function cssFile(): string {
  return `:root {
  --color-bg: #ffffff;
  --color-fg: #1f2328;
  --color-accent: #0969da;
  --radius: 6px;
  --space-1: 4px;
  --space-2: 8px;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--color-bg);
  color: var(--color-fg);
}

.button {
  display: inline-flex;
  align-items: center;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius);
  background: var(--color-accent);
  color: white;
}

.button:hover {
  filter: brightness(1.1);
}

.table {
  width: 100%;
  border-collapse: collapse;
}

.table td,
.table th {
  padding: 6px 12px;
  border-bottom: 1px solid #d0d7de;
}
`;
}

const CSS_NEW = `:root {
  --color-bg: #ffffff;
  --color-fg: #1f2328;
  --color-accent: #0969da;
  --color-border: #d0d7de;
  --radius: 8px;
  --space-1: 4px;
  --space-2: 8px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #0d1117;
    --color-fg: #e6edf3;
    --color-border: #30363d;
  }
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--color-bg);
  color: var(--color-fg);
}

.button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius);
  background: var(--color-accent);
  color: white;
}

.button:hover {
  filter: brightness(1.1);
}

.table {
  width: 100%;
  border-collapse: collapse;
}

.table td,
.table th {
  padding: 6px 12px;
  border-bottom: 1px solid var(--color-border);
}
`;

const HTML_OLD = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Acme Dashboard</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header class="topbar">
      <img src="assets/logo.png" alt="Acme" width="32" />
      <nav>
        <a href="/orders">Orders</a>
        <a href="/users">Users</a>
      </nav>
    </header>
    <main id="app"></main>
    <script src="/src/main.tsx" type="module"></script>
  </body>
</html>
`;

const HTML_NEW = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Acme Dashboard</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header class="topbar">
      <img src="assets/logo.png" alt="Acme logo" width="32" height="32" />
      <nav aria-label="Primary">
        <a href="/orders">Orders</a>
        <a href="/customers">Customers</a>
        <a href="/reports">Reports</a>
      </nav>
    </header>
    <main id="app"></main>
    <script src="/src/main.tsx" type="module"></script>
  </body>
</html>
`;

const README_OLD = `# Acme Web

Dashboard for managing orders and users.

## Development

\`\`\`sh
npm install
npm run dev
\`\`\`

## Testing

Run \`npm test\` before pushing.
`;

const README_NEW = `# Acme Web

Dashboard for managing orders, customers and reports.

## Development

\`\`\`sh
pnpm install
pnpm dev
\`\`\`

The API lives in \`api/\` and runs with \`uvicorn api.server:app --reload\`.

## Testing

Run \`pnpm test\` and \`pytest\` before pushing.
`;

const fromBase64 = (b64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// A blue 64×64 badge replaced by an orange 96×64 one, both with transparent corners.
const LOGO_OLD_PNG = fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAy0lEQVR42u3b0Q2DMAwFwCzTyTp+h2hXoMV2nPqexD/vQCCIs5aISFEez9f7yjGu8F+BRJU+DiO7eGuI6vJtEHYVbwHRpfwWhG7lSxG6li9B6F4+FeGU8ikIp5UPR4g6oatpBRB5RaoBbiNE35I7AG4hjAbIeCjtAvgJAcBkgKz38k6ArxAAABgMkFUqK+EIAAAAAAAAAAAAYwF8CwAAAMA/QQAALIwAsDhqedyAhBEZQ1LG5AxKGpU1LG1c3oYJW2ZsmqoFWSIiRfkAqS3dbwuFRSsAAAAASUVORK5CYII=",
);
const LOGO_NEW_PNG = fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAYAAADlNHIOAAAA60lEQVR42u3cwQ3CMBREwRRAgfR/pAk4cgWEtevvsbQNvAkSCQrX9eN53G9Pe+9aeQQOoYgYhBAuiCBYEEGoIIJAQQRhwgiiBAEECSOIAQCAATgTQIgwgggAABgAAAbgq316AIg/C2BK+O0AJl312wFMjb8FwOT49QDT41cDTA9fC3DCVV8LcFr8KoAT49cAnBq/AuDU8D4BACD4FgQAgjthAJ4FeRoK4H8IK45fxBaFBbAJBIAwAoAwAgAP4wwAAAPgPTHzliQAAwDA/GPKpPgACgAghONDKIgPoSA+hIL4EArigygID2V97Be5GG5wKcNHcQAAAABJRU5ErkJggg==",
);

const ICON_SVG_OLD = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="28" fill="#2563eb"/>
  <path d="M32 18v28M18 32h28" stroke="#fff" stroke-width="8" stroke-linecap="round"/>
</svg>
`;

const ICON_SVG_NEW = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect x="4" y="4" width="56" height="56" rx="14" fill="#ea580c"/>
  <path d="M24 20l14 12-14 12" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

/** A one-page PDF showing `text`. */
function pdfFile(text: string): Uint8Array<ArrayBuffer> {
  const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const BUTTON_OLD = `import type { JSX } from "solid-js";

export interface ButtonProps {
  variant?: "primary" | "secondary";
  disabled?: boolean;
  onClick?: () => void;
  children: JSX.Element;
}

export function Button(props: ButtonProps) {
  const variant = props.variant ?? "primary";
  return (
    <button
      class={\`button button--\${variant}\`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
`;

const BUTTON_NEW = `import { splitProps, type JSX } from "solid-js";

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
}

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "size", "loading", "class"]);
  const variant = () => local.variant ?? "primary";
  return (
    <button
      class={\`button button--\${variant()} button--\${local.size ?? "md"} \${local.class ?? ""}\`}
      disabled={rest.disabled || local.loading}
      aria-busy={local.loading}
      {...rest}
    >
      {local.loading ? <span class="spinner" /> : props.children}
    </button>
  );
}
`;

function schemaFile(lines: number, variant: 0 | 1): string {
  const out = ["// Code generated by openapi-typescript. DO NOT EDIT.", ""];
  let n = 0;
  while (out.length < lines) {
    const bump = variant === 1 && n % 9 === 5;
    out.push(`export interface Model${n} {`);
    out.push(`  id: string;`);
    out.push(`  createdAt: string;`);
    out.push(bump ? `  updatedAt: string | null;` : `  updatedAt: string;`);
    out.push(`  name${n % 3 === 0 ? "?" : ""}: string;`);
    if (variant === 1 && n % 17 === 7) out.push(`  archived?: boolean;`);
    out.push(`  ref${n}: Model${(n + 1) % 997} | null;`);
    out.push(`}`);
    out.push("");
    n++;
  }
  out.push(
    "export interface Order { id: string; quantity: number; unitPrice: number }",
    "export interface User { id: string; email: string; firstName?: string; lastName?: string }",
    "",
  );
  return out.join("\n");
}

function modified(path: string, oldText: string, newText?: string): FileSpec {
  let next = newText;
  for (let seed = hash(path); next === undefined || next === oldText; seed++) next = mutate(oldText, seed);
  return { path, status: "modified", oldText, newText: next };
}

function mainPrFiles(): FileSpec[] {
  const users = pyModule("users");
  const legacy = pyModule("legacy_auth");
  const table = tsxComponent("DataTable");
  const formatting = tsModule("Formatting");
  return [
    modified("README.md", README_OLD, README_NEW),
    { path: "api/__init__.py", status: "added", oldText: null, newText: `"""Acme API package."""\n\n__version__ = "0.4.0"\n` },
    modified("api/models.py", pyModule("models")),
    modified("api/routes/orders.py", pyModule("orders")),
    modified("api/routes/users.py", users),
    modified("api/server.py", pyModule("server")),
    { path: "api/legacy_auth.py", status: "removed", oldText: legacy, newText: null },
    { path: "docs/step10-deploy.md", status: "added", oldText: null, newText: "# Step 10: Deploy\n\nPush to main.\n" },
    { path: "docs/step2-setup.md", status: "added", oldText: null, newText: "# Step 2: Setup\n\nInstall deps.\n" },
    { path: "docs/guide.pdf", status: "added", oldText: null, newText: null, binary: true, newBytes: pdfFile("Acme deployment guide") },
    modified("package.json", `{\n  "name": "acme-web",\n  "version": "1.3.0",\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest"\n  }\n}\n`, `{\n  "name": "acme-web",\n  "version": "1.4.0",\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest run",\n    "lint": "eslint ."\n  }\n}\n`),
    modified("packages/shared/src/index.ts", tsModule("Shared")),
    modified("src/components/Button.tsx", BUTTON_OLD, BUTTON_NEW),
    modified("src/components/Modal.tsx", tsxComponent("Modal")),
    modified("src/components/Sidebar.tsx", tsxComponent("Sidebar")),
    { path: "src/components/Table/Table.tsx", previousPath: "src/components/DataTable.tsx", status: "renamed", oldText: table, newText: mutate(table.replaceAll("DataTable", "Table"), 7, 0.05) },
    modified("src/components/Table/TableRow.tsx", tsxComponent("TableRow")),
    modified("src/components/forms/Input.tsx", tsxComponent("Input")),
    { path: "src/components/forms/Select.tsx", status: "added", oldText: null, newText: tsxComponent("Select") },
    modified("src/generated/schema.ts", schemaFile(3000, 0), schemaFile(3000, 1)),
    modified("src/lib/api.ts", tsModule("Api")),
    { path: "src/lib/format.ts", previousPath: "src/lib/formatting.ts", status: "renamed", oldText: formatting, newText: mutate(formatting, 3, 0.04) },
    modified("src/lib/hooks/useFetch.ts", tsModule("UseFetch")),
    modified("src/lib/utils/debounce.ts", tsModule("Debounce")),
    modified("src/lib/utils/strings.ts", tsModule("Strings")),
    { path: "tests/test_orders.py", status: "added", oldText: null, newText: pyModule("test_orders") },
    modified("web/assets/icon.svg", ICON_SVG_OLD, ICON_SVG_NEW),
    { path: "web/assets/logo.png", status: "modified", oldText: null, newText: null, binary: true, oldBytes: LOGO_OLD_PNG, newBytes: LOGO_NEW_PNG },
    modified("web/index.html", HTML_OLD, HTML_NEW),
    modified("web/styles.css", cssFile(), CSS_NEW),
  ];
}

function hugePrFiles(count: number): FileSpec[] {
  const out: FileSpec[] = [];
  for (let i = 0; i < count; i++) {
    const path = `packages/pkg-${i % 48}/src/${i % 5 === 0 ? "internal/" : ""}module${i}.ts`;
    const old = `export const version = "1.${i}.0";\nexport const name = "module${i}";\nexport function run() {\n  return name;\n}\n`;
    out.push(modified(path, old, old.replace(`1.${i}.0`, `1.${i}.1`)));
  }
  return out;
}

const HOURS = 3600_000;
const ago = (h: number) => new Date(Date.UTC(2026, 8, 27, 12) - h * HOURS).toISOString();

interface PrFixture {
  summary: PrSummary;
  baseRef: string;
  headRef: string;
  files: () => FileSpec[];
  initiallyViewed?: string[];
}

function pr(
  owner: string,
  repo: string,
  number: number,
  title: string,
  author: string,
  reason: PrSummary["reason"],
  hoursAgo: number,
  isDraft = false,
): PrSummary {
  return {
    owner,
    repo,
    number,
    title,
    author,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    isDraft,
    updatedAt: ago(hoursAgo),
    reason,
  };
}

function fixtures(): PrFixture[] {
  const main = mainPrFiles;
  return [
    {
      summary: pr("acme", "web", 482, "Refactor data table and add order routes", "hubot", "reviewRequested", 2),
      baseRef: "main",
      headRef: "feat/orders-table",
      files: main,
      initiallyViewed: ["README.md", "package.json"],
    },
    {
      summary: pr("acme", "monorepo", 9000, "chore: bump versions across all packages", "renovate-bot", "reviewRequested", 5),
      baseRef: "main",
      headRef: "renovate/all",
      files: () => hugePrFiles(2400),
    },
    {
      summary: pr("acme", "api", 91, "Fix pagination off-by-one in orders endpoint", "mona", "reviewRequested", 26),
      baseRef: "main",
      headRef: "fix/pagination",
      files: () => main().filter((f) => f.path.startsWith("api/") || f.path.startsWith("tests/")),
    },
    {
      summary: pr("acme", "web", 475, "WIP: dark mode tokens", "octocat", "authored", 8, true),
      baseRef: "main",
      headRef: "octocat/dark-mode",
      files: () => main().filter((f) => f.path.startsWith("web/")),
    },
    {
      summary: pr("octocat", "dotfiles", 12, "Add zsh aliases for git worktrees", "octocat", "authored", 50),
      baseRef: "main",
      headRef: "worktrees",
      files: () => [
        modified("README.md", README_OLD, README_OLD.replace("Acme Web", "dotfiles")),
      ],
    },
  ];
}

const REPOS: RepoSummary[] = [
  { owner: "acme", name: "web", description: "Customer dashboard", private: true, updatedAt: ago(2) },
  { owner: "acme", name: "api", description: "Orders and billing API", private: true, updatedAt: ago(26) },
  { owner: "acme", name: "monorepo", description: "Shared packages", private: true, updatedAt: ago(5) },
  { owner: "acme", name: "design-system", description: "UI components and tokens", private: false, updatedAt: ago(80) },
  { owner: "octocat", name: "dotfiles", description: "My shell setup", private: false, updatedAt: ago(50) },
  { owner: "octocat", name: "hello-world", description: "My first repository", private: false, updatedAt: ago(900) },
  { owner: "solidjs", name: "solid", description: "A declarative, efficient, and flexible JavaScript library", private: false, updatedAt: ago(10) },
  { owner: "tauri-apps", name: "tauri", description: "Build smaller, faster, and more secure desktop applications", private: false, updatedAt: ago(4) },
];

// ---------------------------------------------------------------------------

interface LoadedPr {
  detail: PrDetail;
  specs: Map<string, FileSpec>;
  diffs: Map<string, FileDiff>;
}

function toDiff(spec: FileSpec): FileDiff {
  const oldText = spec.oldText;
  const newText = spec.newText;
  return {
    path: spec.path,
    oldPath: spec.previousPath ?? null,
    language: languageOf(spec.path),
    binary: !!spec.binary,
    tooLarge: false,
    hunks: spec.binary ? [] : computeHunks(oldText ?? "", newText ?? ""),
    oldText,
    newText,
  };
}

/** One side of a fixture file, or a NotFound-like error when the file has no such side. */
function sideBytes(spec: FileSpec | undefined, path: string, side: Side): Uint8Array<ArrayBuffer> {
  const text = side === "old" ? spec?.oldText : spec?.newText;
  const bytes = (side === "old" ? spec?.oldBytes : spec?.newBytes) ?? (text == null ? null : new TextEncoder().encode(text));
  if (!bytes) throw new Error(`Not found on GitHub: ${side} version of ${path}`);
  return bytes;
}

export interface OpenedFile {
  owner: string;
  repo: string;
  number: number;
  path: string;
  side: Side;
}

/** Files the mock's `openFile` "opened", oldest first. Also `window.__mockOpenedFiles`, for e2e. */
export function mockOpenedFiles(): OpenedFile[] {
  const g = globalThis as { __mockOpenedFiles?: OpenedFile[] };
  return (g.__mockOpenedFiles ??= []);
}

export interface MockOptions {
  authenticated?: boolean;
  failViewed?: boolean;
  failReview?: boolean;
  /** Latency of every call; also replaces REVIEW_LATENCY_MS when set. */
  latencyMs?: number;
  /** Latency of setFileViewed only (defaults to `latencyMs`), to simulate a slow GitHub write. */
  viewedDelayMs?: number;
}

function optionsFromLocation(): MockOptions {
  if (typeof location === "undefined") return {};
  const params = new URLSearchParams(location.search);
  const flags = params.getAll("mock").flatMap((v) => v.split(","));
  const delay = Number(params.get("mockViewedDelay"));
  return {
    authenticated: !flags.includes("unauth"),
    failViewed: flags.includes("failviewed"),
    failReview: flags.includes("failreview"),
    viewedDelayMs: Number.isFinite(delay) && delay > 0 ? delay : undefined,
  };
}

export interface MockReview extends SubmittedReview {
  owner: string;
  repo: string;
  number: number;
  event: ReviewEvent;
  body: string;
  commitId: string;
}

export interface MockBackend extends Backend {
  /** Reviews submitted so far, oldest first. */
  reviews: MockReview[];
}

export function createMockBackend(opts: MockOptions = optionsFromLocation()): MockBackend {
  const latency = opts.latencyMs ?? LATENCY_MS;
  // Every call gets its own timer: nothing is serialized, like concurrent Tauri commands.
  const wait = <T>(value: () => T, ms = latency): Promise<T> =>
    new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(value());
        } catch (e) {
          reject(e);
        }
      }, ms),
    );

  let auth: AuthStatus = opts.authenticated === false
    ? { authenticated: false, login: null, source: null }
    : { authenticated: true, login: "octocat", source: "ghCli" };
  const all = fixtures();
  const loaded = new Map<string, LoadedPr>();
  const byId = new Map<string, LoadedPr>();
  const viewed = new Map<string, Set<string>>();
  const reviews: MockReview[] = [];
  if (typeof window !== "undefined") (window as { __mockReviews?: MockReview[] }).__mockReviews = reviews;

  const requireAuth = () => {
    if (!auth.authenticated) throw new Error("not authenticated");
  };

  function load(owner: string, repo: string, number: number): LoadedPr {
    const key = `${owner}/${repo}#${number}`;
    const hit = loaded.get(key);
    if (hit) return hit;
    const fx = all.find((f) => f.summary.owner === owner && f.summary.repo === repo && f.summary.number === number)
      ?? synthetic(owner, repo, number);
    const specs = new Map(fx.files().map((s) => [s.path, s]));
    const seen = viewed.get(key) ?? new Set(fx.initiallyViewed ?? []);
    viewed.set(key, seen);
    const diffs = new Map<string, FileDiff>();
    const files: ChangedFile[] = [...specs.values()].map((s) => {
      const d = toDiff(s);
      diffs.set(s.path, d);
      let additions = 0;
      let deletions = 0;
      for (const h of d.hunks) {
        for (const l of h.lines) {
          if (l.kind === "add") additions++;
          else if (l.kind === "del") deletions++;
        }
      }
      return {
        path: s.path,
        previousPath: s.previousPath ?? null,
        status: s.status,
        additions,
        deletions,
        viewed: seen.has(s.path) ? "VIEWED" : "UNVIEWED",
      };
    });
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const detail: PrDetail = {
      id: `PR_mock_${hash(key).toString(36)}`,
      owner,
      repo,
      number,
      title: fx.summary.title,
      author: fx.summary.author,
      url: fx.summary.url,
      baseRef: fx.baseRef,
      headRef: fx.headRef,
      baseSha: hash(key + "base").toString(16).padStart(8, "0"),
      headSha: hash(key + "head").toString(16).padStart(8, "0"),
      files,
      totalFiles: files.length,
      filesTruncated: false,
    };
    const lp = { detail, specs, diffs };
    loaded.set(key, lp);
    byId.set(detail.id, lp);
    return lp;
  }

  function synthetic(owner: string, repo: string, number: number): PrFixture {
    if (!REPOS.some((r) => r.owner === owner && r.name === repo)) {
      throw new Error(`Could not resolve to a PullRequest: ${owner}/${repo}#${number}`);
    }
    return {
      summary: pr(owner, repo, number, `Update ${repo} (#${number})`, "mona", "other", 12),
      baseRef: "main",
      headRef: `topic-${number}`,
      files: () => mainPrFiles().slice(0, 6),
    };
  }

  function prsFor(owner: string, repo: string): PrSummary[] {
    const known = all.map((f) => f.summary).filter((s) => s.owner === owner && s.repo === repo);
    const extra = [1, 2, 3].map((i) =>
      pr(owner, repo, 100 + i * 7, `${["Improve", "Fix", "Refactor"][i - 1]} ${repo} ${["docs", "tests", "build"][i - 1]}`, "mona", "other", i * 30),
    );
    return [...known, ...extra];
  }

  return {
    reviews,
    authStatus: () => wait(() => auth),
    setToken: (token) =>
      wait(() => {
        if (token.trim().length < 4) throw new Error("Bad credentials");
        auth = { authenticated: true, login: "octocat", source: "keychain" };
        return auth;
      }),
    signOut: () =>
      wait(() => {
        auth = { authenticated: false, login: null, source: null };
        return auth;
      }),
    listInbox: () =>
      wait(() => {
        requireAuth();
        return all.map((f) => f.summary);
      }),
    searchRepos: (query) =>
      wait(() => {
        requireAuth();
        const q = query.toLowerCase();
        return REPOS.filter((r) => `${r.owner}/${r.name}`.includes(q) || r.description?.toLowerCase().includes(q));
      }),
    listRepoPrs: (owner, repo) =>
      wait(() => {
        requireAuth();
        return prsFor(owner, repo);
      }),
    getPr: (owner, repo, number) =>
      wait(() => {
        requireAuth();
        const { detail } = load(owner, repo, number);
        const seen = viewed.get(`${owner}/${repo}#${number}`)!;
        return {
          ...detail,
          files: detail.files.map((f) => ({ ...f, viewed: seen.has(f.path) ? "VIEWED" : "UNVIEWED" })),
        };
      }),
    getFileDiff: (owner, repo, number, path) =>
      wait(() => {
        requireAuth();
        const d = load(owner, repo, number).diffs.get(path);
        if (!d) throw new Error(`No such file in PR: ${path}`);
        return d;
      }),
    getFileContent: (owner, repo, number, path, side) =>
      wait(() => {
        requireAuth();
        return sideBytes(load(owner, repo, number).specs.get(path), path, side);
      }),
    openFile: (owner, repo, number, path, side) =>
      wait(() => {
        requireAuth();
        sideBytes(load(owner, repo, number).specs.get(path), path, side);
        mockOpenedFiles().push({ owner, repo, number, path, side });
      }),
    setFileViewed: (prId, path, isViewed) =>
      wait(() => {
        requireAuth();
        if (opts.failViewed) throw new Error("GitHub API error: 502 Bad Gateway");
        const lp = byId.get(prId);
        if (!lp) throw new Error(`Unknown PR id ${prId}`);
        const key = `${lp.detail.owner}/${lp.detail.repo}#${lp.detail.number}`;
        const seen = viewed.get(key)!;
        if (isViewed) seen.add(path);
        else seen.delete(path);
      }, opts.viewedDelayMs ?? latency),
    submitReview: (owner, repo, number, event, body) =>
      wait(() => {
        requireAuth();
        // Same checks and messages as the Rust core / GitHub.
        const text = body.trim();
        if (event === "COMMENT" && !text) throw new Error("Write a comment before submitting");
        if (opts.failReview) throw new Error("GitHub API error 502: Server Error");
        const { detail } = load(owner, repo, number);
        if (event === "APPROVE" && detail.author === auth.login) {
          throw new Error("GitHub API error 422: Can not approve your own pull request");
        }
        const id = 1000 + reviews.length;
        const review: MockReview = {
          id,
          url: `${detail.url}#pullrequestreview-${id}`,
          state: event === "APPROVE" ? "APPROVED" : "COMMENTED",
          owner,
          repo,
          number,
          event,
          body: text,
          commitId: detail.headSha,
        };
        reviews.push(review);
        return { id: review.id, url: review.url, state: review.state };
      }, opts.latencyMs ?? REVIEW_LATENCY_MS),
    openUrl: (url) =>
      wait(() => {
        window.open(url, "_blank", "noopener");
      }),
  };
}
