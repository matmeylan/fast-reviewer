# Fast Reviewer — architecture

A native desktop app (macOS first, Linux later) for reviewing GitHub pull requests fast.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** | Native webview (WKWebView on macOS, WebKitGTK on Linux), ~10 MB binary, instant startup. Cross-platform. |
| Core | **Rust** crate `crates/core` (`fast_reviewer_core`) | GitHub API, auth, diffing, caching. No Tauri dependency so it can be unit-tested and reused (CLI, Linux). |
| Tauri glue | `src-tauri` | Thin `#[tauri::command]` wrappers over the core. |
| UI | **SolidJS + TypeScript + Vite** | Fine-grained reactivity, no VDOM, tiny runtime. |
| Styling | **Tailwind CSS v4** with the shadcn/ui preset `b1YocDISu` (Nova style, Mist base, Cyan theme, Geist, Lucide icons); code in JetBrains Mono | shadcn/ui is React-only, so `src/components/ui/` holds Solid ports of the Nova components we use. Theme tokens live in `src/styles.css`; the diff view keeps its own stylesheet (`src/components/diff.css`) and reads the theme tokens for its chrome. |
| Highlighting | **Shiki** (TextMate grammars, JS regex engine) running in a **Web Worker** | VS Code-quality highlighting for 200+ languages without blocking the UI thread. Languages load lazily. |

## Data flow

1. `auth_status` resolves a token in order: `GH_TOKEN`/`GITHUB_TOKEN` env → `gh auth token` → OS keychain (`keyring` crate, service `fast-reviewer`). `set_token` stores a PAT in the keychain.
2. `list_inbox` → PRs where review is requested from the viewer + PRs authored by the viewer (GitHub search API).
3. `get_pr(owner, repo, number)` → one GraphQL query: PR metadata + all `files { path additions deletions changeType viewerViewedState }` (paginated). Only when the PR has renamed/copied files, REST `pulls/{n}/files` (pages fetched concurrently, sized by `changedFiles`) supplies `previous_filename`. `totalFiles` / `filesTruncated` tell the UI when GitHub listed fewer files than the PR has (3000-file cap); the sidebar then shows "Showing N of M files". If GraphQL is rejected (other than auth / not-found errors), `get_pr` falls back to REST `pulls/{n}` + `pulls/{n}/files`; REST has no viewed state, so all files come back unviewed (a warning is logged once).
4. `get_file_diff(owner, repo, number, path)` → fetch base + head blobs (by SHA, cached on disk under the OS cache dir keyed by blob SHA; blobs are immutable so cache never invalidates), compute the diff in Rust with `similar` (Patience/Myers), 3 lines of context, pair del/add lines inside a change block and compute intra-line word-level segments (UTF-16 offsets).
5. `get_file_content(owner, repo, number, path, side)` → the raw bytes of one side of a file: `new` is `path` at the head, `old` is the old path (`previousPath` for renames) at the merge base, the two versions `get_file_diff` compares. Same blob cache, but up to 50 MB (`MAX_CONTENT_BYTES`); only files small enough to diff are cached on disk. Returned as a raw IPC response, so the UI gets an `ArrayBuffer`. The UI shows images from it through blob URLs in `<img>` (never inline SVG markup, so SVG scripts don't run).
6. `open_file(owner, repo, number, path, side)` → the same bytes written to `<temp>/fast-reviewer/<owner>/<repo>/<number>/<side>-<short sha>/<file name>` (`temp_copy::path_for` keeps only the base name), then opened with the OS default app through the opener plugin. Types the OS might run instead of view (scripts, installers, `.command`, `.terminal`, `.jar`, link files…) are refused before anything is downloaded (`temp_copy::check_openable`). The call is made in Rust, so the webview has no opener permission.
7. `set_file_viewed(prId, path, viewed)` → GraphQL `markFileAsViewed` / `unmarkFileAsViewed`. The UI updates optimistically and rolls back on failure.
8. `list_review_threads(owner, repo, number)` → GraphQL `reviewThreads` (paginated, first 100 comments per thread): path, `line` (null when outdated or on the whole file), side (`LEFT` → `old`, `RIGHT` → `new`), resolved/outdated, comments. Loaded in the background when a PR opens, and again after a review with line comments.
9. `submit_review(owner, repo, number, event, body, comments)` → REST `POST pulls/{n}/reviews` with `event` `COMMENT` or `APPROVE`, `commit_id` set to the head SHA `get_pr` returned, so the review is pinned to the commit that was reviewed, and the draft line comments as `comments: [{ path, line, side, body }]`. A `COMMENT` with neither body nor line comments is refused without a request (GitHub would answer 422), as is an empty line comment; for other 422s the reason in GitHub's `errors` (e.g. "Can not approve your own pull request") becomes the message.

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
| `⌘F` / `Ctrl+F` | Find in file |
| `⌘G` / `⇧⌘G` | Next / previous find match |
| `a` | Review dialog: comment or approve (`⌘Enter` comments) |
| `o` | Open the PR in the browser |
| `?` | Shortcut help |

## Layout

- Left: file tree. Folders sorted alphabetically before files, both alphabetical; single-child folder chains are compacted (`src/lib/utils`). Each file shows its IntelliJ file-type icon, its name colored by change status, `+N −M` and a viewed check mark; folders show how many files are left to review. A flat list (file name plus folder path, same order) is one click away. Header shows progress (viewed/total).
- Right: selected file diff, split (side by side) or unified. Added/removed lines are tinted; the exact changed characters within a modified line get a stronger highlight.
- Find in file: rows are virtualized, so the browser's own find cannot see off-screen lines. `src/components/diff-find.ts` matches the query against the row model; `DiffView` renders the matches into the line HTML and scrolls the current one into view; `FindBar` edits the query, which lives in the store and persists across files.
- Review: `src/components/ReviewForm.tsx` is shown on the "All files reviewed" screen and in a dialog (the `review` overlay: `a` or the header's Review button). Both read the same draft, result and error from the store, which resets them when another PR opens. The textarea only takes the keyboard once clicked (the dialog focuses it), so single-key shortcuts keep working on the done screen.
- Line comments: clicking a line number opens a popover under that line (`src/components/CommentPopover.tsx`, placed by `DiffView` in the scrolled content so it moves with the line) with the line's threads, its drafts and a box to write one. Only lines in the diff's hunks take new comments (GitHub rejects others); lines outside them open only when they already have comments. A gutter marker shows each line's thread + draft count. Drafts live in the store, are saved per PR in `localStorage` (`fr.drafts.<owner>/<repo>#<n>`, with the head SHA so a restart after a push warns that lines may have moved) and go out with the next review; closing the box (Esc, a click elsewhere) keeps typed text as a draft, Cancel discards it. Replies and resolving happen on GitHub (each thread links there).
- Selection: the shell disables text selection; code cells re-enable it. While a selection lives, its anchor row stays rendered even when scrolled out of the virtualized window. In split view the side the drag started on is the only selectable one, and a `copy` handler writes just the selected code, one line per row.

## Testing

- `cargo test -p fast_reviewer_core` — diff engine, tree/sort, GitHub client against a mock HTTP server (PR loading, REST fallback, auth re-resolution, IPC contract).
- `pnpm test` — Vitest unit tests (tree building, keyboard reducer, highlighting helpers).
- Diff correctness, end to end, against `git diff` output of a real PR (`crates/core/tests/fixtures/git_compare`):
  - `crates/core/tests/git_compare.rs` — the diff engine produces git's hunks.
  - `crates/core/tests/diff_fetch.rs` — through `Service` and a fake GitHub whose base branch moved on after the PR branched: each file is diffed from the merge base (not the base tip) to the head, renames use the old path, and a new push is not served from the diff cache.
  - `src/components/DiffView.integrity.test.tsx` — reads back what `DiffView` renders in split and unified mode: the old and new sides are exactly the diff's lines with the right numbers, and with every gap expanded they are the whole old and new files (fixtures plus pseudo-random edits).
- `pnpm e2e` — Playwright against the production bundle (`vite build` + `vite preview` on port 1421; the dev server force-reloads pages on a cold dependency cache). Outside Tauri, `src/lib/api.ts` uses an in-memory mock backend (`src/lib/mock.ts`), so the full UI can be exercised in a browser. Mock flags: `?mock=unauth`, `?mock=failviewed`, `?mock=failreview`, `?mockViewedDelay=<ms>`; submitted reviews are recorded in `window.__mockReviews`. The mock's `openFile` opens nothing; it records each call in `window.__mockOpenedFiles`.
- `crates/core/examples/smoke.rs` — read-only timing run against real GitHub. `crates/core/examples/compare_git.rs` — diffs every file of a real PR and compares with `git diff` in a local clone (exits 1 on mismatch). Neither writes to GitHub.
