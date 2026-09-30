<p align="center"><img src="assets/logo.svg" width="128" height="128" alt="Fast Reviewer logo"></p>

# Fast Reviewer

A fast desktop app for reviewing GitHub pull requests: a file tree on the left, a syntax-highlighted diff on the right, and one-key review (`r` marks the file viewed on GitHub and moves to the next one). It targets macOS first and is built on Tauri 2, so Linux is supported too.

![Split view](docs/screenshots/split-light.png)

## Features

- **PR picker** (`⌘K`): PRs waiting for your review and your own PRs. You can also fuzzy-search your repos and browse their open PRs, or paste a PR URL or `owner/repo#123`.
- **File tree**: folders first, then files, both alphabetical. Single-child folder chains are compacted (`src/lib/utils`). Styled after JetBrains IDEs: each file has its file-type icon (IntelliJ's icon set) and its name is colored by change status (green added, blue modified or renamed, gray struck-through deleted). Viewed files are dimmed with a check mark; hover a row to toggle it. Folders show how many files are left to review, with indent guides. Switch to a flat list with folder paths from the button next to the filter. The header shows progress. Filter with `/`; matches are highlighted. GitHub lists at most 3,000 files per PR; for larger PRs the sidebar shows a "Showing N of M files" warning.
- **Diff**: split (side by side) or unified view. Changed lines are tinted, and the exact characters that changed inside a modified line get a stronger highlight. You can expand hidden context around hunks. Code is selectable; copying gives just the code (no line numbers), and in split view only the side you started selecting on.
- **Images**: changed PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG files show the before and after images (side by side in split view, stacked in unified), over a checkerboard so transparency shows, with their dimensions and file size. SVGs open as images (in an `<img>`, so scripts in them never run); switch to **Source** for their text diff.
- **Open with default app**: files the diff can't show (PDFs, archives, fonts, files too large to diff) have buttons to open the new or old version in the app your OS uses for that file type. The file is written to a temp folder first.
- **Find in file** (`⌘F`): highlights every match in the current diff, including lines scrolled out of view; `Enter` / `⇧Enter` (or `⌘G` / `⇧⌘G`) step through them. With text selected in the diff, `⌘F` searches for it, starting at that occurrence. The query stays when you move to another file.
- **Syntax highlighting**: VS Code-quality highlighting (Shiki / TextMate grammars) for TypeScript, TSX, JavaScript, HTML, CSS, Python, JSON, Markdown, Rust, Go and more than 200 other languages. Highlighting runs in a Web Worker, so it never blocks scrolling. Grammars load on demand; when a PR opens, the grammars for its languages are loaded and warmed while the first diff is fetched.
- **GitHub sync**: "viewed" state is read from GitHub and written back in the background. It is the same checkbox as on github.com. If the write fails, the change is undone and a message is shown. If GitHub's GraphQL API is unavailable (some proxies and GHE setups), PRs load over REST instead; REST has no viewed state, so every file starts unviewed.
- **Speed**: the diffs of the next 3 unviewed files are fetched ahead of time, so `r` and `s` switch files in under 20 ms. Only visible rows are rendered, which keeps 5,000-line diffs smooth. Diffs are computed in Rust and cached in memory, and file contents are cached on disk by commit SHA.
- Light and dark mode follow the system setting.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `r` | Mark file viewed (synced to GitHub in the background) and go to the next unviewed file |
| `s` | Skip to the next unviewed file without marking |
| `j` / `↓` | Next file |
| `k` / `↑` | Previous file |
| `u` | Toggle viewed on the current file |
| `v` | Toggle split / unified (remembered) |
| `n` / `p` | Next / previous hunk |
| `/` | Filter files |
| `⌘F` / `Ctrl+F` | Find in file (searches for the selected text, if any) |
| `⌘G` / `⇧⌘G` | Next / previous match (also `Enter` / `⇧Enter` in the find bar) |
| `o` | Open the PR in the browser |
| `⌘K` / `Ctrl+K` | Open a pull request |
| `?` | Show shortcuts |
| `Esc` | Close overlay / find bar / clear filter |

## Authentication

The app looks for a GitHub token in this order:

1. The `GH_TOKEN` or `GITHUB_TOKEN` environment variable
2. The GitHub CLI (`gh auth token`). If `gh` is installed and logged in, nothing else is needed.
3. A token pasted into the sign-in screen. It is checked against GitHub, then stored in the OS keychain under the service `fast-reviewer`.

If you paste a token, use either:
- a classic PAT with the `repo` scope, or
- a fine-grained PAT with **Pull requests: read & write** and **Contents: read**.

For GitHub Enterprise, set `GITHUB_API_URL` (for example `https://ghe.example.com/api/v3`).

## Download (CI builds)

Every push runs `.github/workflows/ci.yml`: lint and all tests on Linux, plus a universal macOS build (Apple Silicon + Intel).

- **Latest build:** open the repo's *Actions* tab → the latest *CI* run → download the `fast-reviewer-macos` artifact (`.dmg` and a zipped `.app`).
- **Releases:** every push to `main` publishes a GitHub Release (`v<major>.<minor>.<run>`, marked *Latest*) with the notarized `.dmg`; pushing a tag like `v0.2.0` publishes one under that name. Releases are only created when the build was signed and notarized.

CI stamps each build with its own version: `<major>.<minor>` from `src-tauri/tauri.conf.json` plus the CI run number (for example `0.1.57`), or the tag's version for a `v*` tag. To start a new line, bump `version` in `tauri.conf.json` (say to `0.2.0`) before tagging. A tag must be higher than the builds already released, or installed apps won't be offered it.

When the Apple signing secrets below are set, CI signs the app with your Developer ID and notarizes it with Apple, so it opens normally. Without them, the build is only ad-hoc signed and macOS refuses to open the downloaded app.

### Code signing and notarization (one-time setup)

You need a paid Apple Developer Program membership.

1. **Create a Developer ID certificate.** On your Mac: Xcode → Settings → Accounts → select your team → *Manage Certificates…* → **+** → **Developer ID Application**. (Or create it at developer.apple.com → Certificates, using a CSR from Keychain Access.)
2. **Export it as .p12.** Keychain Access → *login* → *My Certificates* → right-click **Developer ID Application: Your Name (TEAMID)** → *Export…* → save as `cert.p12` with a strong password. Then copy it as base64:
   ```sh
   base64 -i cert.p12 | pbcopy
   ```
3. **Find the exact identity name:**
   ```sh
   security find-identity -v -p codesigning
   # → "Developer ID Application: Your Name (TEAMID1234)"
   ```
4. **Create an App Store Connect API key for notarization** (recommended): appstoreconnect.apple.com → *Users and Access* → *Integrations* → *App Store Connect API* → *Team Keys* → **+**, role **Developer**. Download `AuthKey_<KEYID>.p8` (only downloadable once) and note the **Key ID** and **Issuer ID**.
5. **Add repository secrets** (GitHub → repo → *Settings* → *Secrets and variables* → *Actions* → *New repository secret*):

   | Secret | Value |
   |---|---|
   | `APPLE_CERTIFICATE` | base64 of `cert.p12` (step 2) |
   | `APPLE_CERTIFICATE_PASSWORD` | the .p12 export password |
   | `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID1234)` (step 3) |
   | `APPLE_API_ISSUER` | Issuer ID (step 4) |
   | `APPLE_API_KEY` | Key ID (step 4) |
   | `APPLE_API_KEY_P8` | full contents of `AuthKey_<KEYID>.p8`, including the BEGIN/END lines |

   Alternative to the API key: `APPLE_ID` (your Apple ID email), `APPLE_PASSWORD` (an [app-specific password](https://account.apple.com) → Sign-In and Security → App-Specific Passwords) and `APPLE_TEAM_ID`.
6. **Re-run CI** (Actions → CI → *Run workflow*, or push). The macOS job signs, notarizes and staples both the `.app` and the `.dmg`, then fails the build if Gatekeeper (`spctl`) would reject them.

Delete `cert.p12` and the `.p8` from your disk once the secrets are saved.

### In-app updates (one-time setup)

The app checks `latest.json` in the latest GitHub release at startup and every 6 hours; on macOS, **Fast Reviewer → Check for Updates…** checks right away and says whether you are up to date. When a newer version is out, an **Update to x.y.z** button shows in the title bar. One click downloads the update, checks its signature, replaces the app and restarts it.

Updates are signed with a key of their own, separate from the Apple certificate:

1. **Generate the key pair** (choose a password when asked):
   ```sh
   pnpm tauri signer generate -w ~/.tauri/fast-reviewer.key
   ```
2. **Commit the public key:** paste the contents of `~/.tauri/fast-reviewer.key.pub` into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
3. **Add repository secrets:**

   | Secret | Value |
   |---|---|
   | `TAURI_SIGNING_PRIVATE_KEY` | full contents of `~/.tauri/fast-reviewer.key` |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password from step 1 |

Every release after that includes `Fast-Reviewer-macOS-universal.app.tar.gz`, its `.sig`, and `latest.json`. CI fails if the private key is set but the public key isn't committed.

Keep a backup of the private key. Installed apps only accept updates signed with it, so losing it means everyone has to reinstall by hand. Apps from before this setup can't update themselves, so install the first release that has `latest.json` by hand. Development builds (`pnpm tauri dev`) never check for updates.

## Development

Prerequisites: Rust (stable), Node 22+ and pnpm. On macOS you also need the Xcode command-line tools. On Linux you need the WebKitGTK 4.1 dev packages (see the [Tauri prerequisites](https://tauri.app/start/prerequisites/)).

```sh
pnpm install
pnpm tauri dev          # run the desktop app with hot reload
pnpm dev                # UI only in a browser at http://localhost:1420, using the mock backend
```

Build a release:

```sh
pnpm tauri build                 # macOS: target/release/bundle/macos/Fast Reviewer.app and bundle/dmg/*.dmg
pnpm tauri build --no-bundle     # just the binary: target/release/fast-reviewer
```

The mock backend is used automatically outside Tauri. It serves a 30-file fixture PR (with PNG, SVG and PDF files), a 2,400-file PR and a 3,000-line generated file. Flags: `?mock=unauth` starts signed out, `?mock=failviewed` makes viewed-sync fail, and `?mockViewedDelay=<ms>` makes viewed-sync take that long.

## Tests

```sh
cargo test --workspace                          # diff engine, GitHub client against a mock server, IPC contract
cargo clippy --workspace --all-targets -- -D warnings
pnpm typecheck
pnpm test                                       # Vitest unit tests
pnpm e2e                                        # Playwright end-to-end tests (mock backend)
cargo test --release -p fast_reviewer_core --test diff_perf -- --ignored --nocapture   # diff timings
GH_TOKEN=... cargo run -p fast_reviewer_core --example smoke -- <owner> <repo> <number> # read-only timing check against real GitHub
GH_TOKEN=... cargo run -p fast_reviewer_core --example compare_git -- <owner> <repo> <number> [<clone>]  # compare our diffs with `git diff`
```

`src/lib/contract.fixture.json` is shared by `crates/core/tests/contract.rs` and `src/lib/contract.test.ts`. This keeps the Rust serde output and the TypeScript types in `src/lib/types.ts` in sync.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The main pieces:
- `crates/core`: a Rust crate with no Tauri dependency. It handles GitHub, auth, diffing and caching.
- `src-tauri`: thin command wrappers around `crates/core`.
- `src/`: the UI, written in SolidJS + TypeScript. Shiki highlighting runs in `src/workers/`.
