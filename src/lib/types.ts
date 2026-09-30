// IPC contract between the Rust core and the UI.
// Mirrors crates/core/src/model.rs (serde camelCase). Keep both in sync.

export type AuthSource = "env" | "ghCli" | "keychain";

export interface AuthStatus {
  authenticated: boolean;
  login: string | null;
  source: AuthSource | null;
}

export interface RepoSummary {
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  updatedAt: string;
}

export interface PrSummary {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  /** Why this PR is listed in the inbox. */
  reason: "reviewRequested" | "authored" | "other";
}

export type FileStatus = "added" | "removed" | "modified" | "renamed" | "copied" | "changed";
export type ViewedState = "VIEWED" | "UNVIEWED" | "DISMISSED";

export interface ChangedFile {
  path: string;
  previousPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  viewed: ViewedState;
}

export interface PrDetail {
  /** GraphQL node id, required for markFileAsViewed. */
  id: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  /** Sorted by path. At most 3000 files (GitHub's listing cap); see `filesTruncated`. */
  files: ChangedFile[];
  /** Number of changed files GitHub reports for the PR (may exceed `files.length`). */
  totalFiles: number;
  /** True when `files` is not the full list (the PR has more files than GitHub will list). */
  filesTruncated: boolean;
}

export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  /** Line content without trailing newline. */
  text: string;
  /**
   * Intra-line changed ranges as [start, end) offsets in UTF-16 code units
   * into `text`. Only set on add/del lines that pair with a counterpart line.
   */
  segments: [number, number][] | null;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  /** Shiki language id guessed from the path (e.g. "typescript", "tsx", "python"), or null for plain text. */
  language: string | null;
  binary: boolean;
  /** True when the file was too large to diff; hunks are empty. */
  tooLarge: boolean;
  hunks: Hunk[];
  /** Full old/new file text so the UI can expand context. Null when absent (added/removed/binary). */
  oldText: string | null;
  newText: string | null;
}

/** What a submitted review does. Same values as GitHub's `event` field. */
export type ReviewEvent = "COMMENT" | "APPROVE";

export interface SubmittedReview {
  id: number;
  /** The review on github.com. */
  url: string;
  /** GitHub's review state, e.g. "COMMENTED" or "APPROVED". */
  state: string;
}
