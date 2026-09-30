// Typed IPC wrapper. Inside Tauri it invokes Rust commands; in a plain browser
// (dev server, Playwright) it falls back to the in-memory mock backend.
import type { AuthStatus, FileDiff, PrDetail, PrSummary, RepoSummary, Side } from "./types";

export interface Backend {
  authStatus(): Promise<AuthStatus>;
  setToken(token: string): Promise<AuthStatus>;
  signOut(): Promise<AuthStatus>;
  listInbox(): Promise<PrSummary[]>;
  searchRepos(query: string): Promise<RepoSummary[]>;
  listRepoPrs(owner: string, repo: string): Promise<PrSummary[]>;
  getPr(owner: string, repo: string, number: number): Promise<PrDetail>;
  getFileDiff(owner: string, repo: string, number: number, path: string): Promise<FileDiff>;
  /** Raw bytes of one side of a file (a version its diff compares); ArrayBuffer-backed, so Blob-ready. */
  getFileContent(owner: string, repo: string, number: number, path: string, side: Side): Promise<Uint8Array<ArrayBuffer>>;
  /** Write one side of a file to a temp file and open it with the OS default app. */
  openFile(owner: string, repo: string, number: number, path: string, side: Side): Promise<void>;
  setFileViewed(prId: string, path: string, viewed: boolean): Promise<void>;
  openUrl(url: string): Promise<void>;
}

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function tauriBackend(): Backend {
  // Lazy import keeps @tauri-apps/api out of the browser/mock path.
  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  };
  return {
    authStatus: () => call("auth_status"),
    setToken: (token) => call("set_token", { token }),
    signOut: () => call("sign_out"),
    listInbox: () => call("list_inbox"),
    searchRepos: (query) => call("search_repos", { query }),
    listRepoPrs: (owner, repo) => call("list_repo_prs", { owner, repo }),
    getPr: (owner, repo, number) => call("get_pr", { owner, repo, number }),
    getFileDiff: (owner, repo, number, path) => call("get_file_diff", { owner, repo, number, path }),
    // Raw responses arrive as an ArrayBuffer; the IPC fallback (postMessage) sends a number array.
    getFileContent: (owner, repo, number, path, side) =>
      call<ArrayBuffer | number[]>("get_file_content", { owner, repo, number, path, side }).then((b) =>
        b instanceof ArrayBuffer ? new Uint8Array(b) : Uint8Array.from(b),
      ),
    openFile: (owner, repo, number, path, side) => call("open_file", { owner, repo, number, path, side }),
    setFileViewed: (prId, path, viewed) => call("set_file_viewed", { prId, path, viewed }),
    openUrl: (url) => call("open_url", { url }),
  };
}

let backend: Backend | null = null;

export async function getBackend(): Promise<Backend> {
  if (backend) return backend;
  if (isTauri()) {
    backend = tauriBackend();
  } else {
    const { createMockBackend } = await import("./mock");
    backend = createMockBackend();
  }
  return backend;
}

/** Test hook: inject a backend. */
export function setBackend(b: Backend | null): void {
  backend = b;
}
