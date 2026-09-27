# Fast Reviewer — architecture

A native desktop app (macOS first, Linux later) for reviewing GitHub pull requests fast.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** | Native webview (WKWebView on macOS, WebKitGTK on Linux), ~10 MB binary, instant startup. Cross-platform. |
| Core | **Rust** crate `crates/core` (`fast_reviewer_core`) | GitHub API, auth, diffing, caching. No Tauri dependency so it can be unit-tested and reused (CLI, Linux). |
| Tauri glue | `src-tauri` | Thin `#[tauri::command]` wrappers over the core. |
| UI | **SolidJS + TypeScript + Vite** | Fine-grained reactivity, no VDOM, tiny runtime. |
| Styling | **Tailwind CSS v4** with the shadcn/ui preset `b1YocDISu` (Nova style, Mist base, Cyan theme, Geist, Lucide icons) | shadcn/ui is React-only, so `src/components/ui/` holds Solid ports of the Nova components we use. Theme tokens live in `src/styles.css`; the diff view keeps its own stylesheet (`src/components/diff.css`) and reads the theme tokens for its chrome. |
| Highlighting | **Shiki** (TextMate grammars, JS regex engine) running in a **Web Worker** | VS Code-quality highlighting for 200+ languages without blocking the UI thread. Languages load lazily. |

## Data flow

1. `auth_status` resolves a token in order: `GH_TOKEN`/`GITHUB_TOKEN` env → `gh auth token` → OS keychain (`keyring` crate, service `fast-reviewer`). `set_token` stores a PAT in the keychain.
2. `list_inbox` → PRs where review is requested from the viewer + PRs authored by the viewer (GitHub search API).
3. `get_pr(owner, repo, number)` → one GraphQL query: PR metadata + all `files { path additions deletions changeType viewerViewedState }` (paginated). Only when the PR has renamed/copied files, REST `pulls/{n}/files` (pages fetched concurrently, sized by `changedFiles`) supplies `previous_filename`. `totalFiles` / `filesTruncated` tell the UI when GitHub listed fewer files than the PR has (3000-file cap); the sidebar then shows "Showing N of M files". If GraphQL is rejected (other than auth / not-found errors), `get_pr` falls back to REST `pulls/{n}` + `pulls/{n}/files`; REST has no viewed state, so all files come back unviewed (a warning is logged once).
4. `get_file_diff(owner, repo, number, path)` → fetch base + head blobs (by SHA, cached on disk under the OS cache dir keyed by blob SHA; blobs are immutable so cache never invalidates), compute the diff in Rust with `similar` (Patience/Myers), 3 lines of context, pair del/add lines inside a change block and compute intra-line word-level segments (UTF-16 offsets).
5. `set_file_viewed(prId, path, viewed)` → GraphQL `markFileAsViewed` / `unmarkFileAsViewed`. The UI updates optimistically and rolls back on failure.

## Speed rules

- The UI prefetches diffs for the next 3 **unviewed** files in tree order (exactly what `r` / `s` open next), so they move to an already-loaded diff. The UI keeps an LRU of at most 48 diffs.
- Rust keeps an in-memory LRU of computed `FileDiff`s; blobs are also cached on disk.
- Diff rows are virtualized (only visible rows are in the DOM).
- Highlighting runs off the main thread. Plain text renders first, then tokens swap in.
- On PR open, the highlighter worker loads and warms (tokenizes a small sample with) the grammars of up to 12 languages in the PR, the first file's language first, so the first highlight of each language is fast.
- One shared `reqwest::Client` (HTTP/2, rustls, keep-alive).

## Keyboard

| Key | Action |
|---|---|
| `r` | Mark file viewed on GitHub (in the background) and go to next file |
| `s` | Skip: go to next unviewed file |
| `j` / `k` (or ↓/↑ in tree) | Next / previous file |
| `u` | Toggle viewed on the current file |
| `v` | Toggle split / unified view |
| `n` / `p` | Next / previous hunk |
| `⌘K` / `Ctrl+K` | Open PR picker |
| `o` | Open the PR in the browser |
| `?` | Shortcut help |

## Layout

- Left: file tree. Folders sorted alphabetically before files, both alphabetical; single-child folder chains are compacted (`src/lib/utils`). Each file shows `+N −M` and a viewed checkmark. Header shows progress (viewed/total).
- Right: selected file diff, split (side by side) or unified. Added/removed lines are tinted; the exact changed characters within a modified line get a stronger highlight.

## Testing

- `cargo test -p fast_reviewer_core` — diff engine, tree/sort, GitHub client against a mock HTTP server (PR loading, REST fallback, auth re-resolution, IPC contract).
- `pnpm test` — Vitest unit tests (tree building, keyboard reducer, highlighting helpers).
- `pnpm e2e` — Playwright against the production bundle (`vite build` + `vite preview` on port 1421; the dev server force-reloads pages on a cold dependency cache). Outside Tauri, `src/lib/api.ts` uses an in-memory mock backend (`src/lib/mock.ts`), so the full UI can be exercised in a browser. Mock flags: `?mock=unauth`, `?mock=failviewed`, `?mockViewedDelay=<ms>`.
- `crates/core/examples/smoke.rs` — read-only timing run against real GitHub. `crates/core/examples/compare_git.rs` — diffs every file of a real PR and compares with `git diff` in a local clone (exits 1 on mismatch). Neither writes to GitHub.
