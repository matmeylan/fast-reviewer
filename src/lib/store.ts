// App state: Solid signals for coarse values (raw objects, never proxied), a store only
// for per-file maps that need fine-grained updates (viewed, collapsed).
import { batch, createMemo, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { Backend } from "./api";
import type { AuthStatus, FileDiff, PrDetail, PrSummary, ReviewEvent, SubmittedReview } from "./types";
import { buildTree, filterFiles, flattenFiles, isAncestor, type DirNode } from "./tree";
import { nextUnviewed, reduce, upcomingUnviewed, type Action, type Mode, type Overlay } from "./keys";
import { prefetchHighlight, warmHighlighter } from "./highlight-client";
import type { FindStatus } from "../components/diff-find";
import { languageForPath, languagesOf } from "./language";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface DiffState {
  /** Path whose diff is shown; may lag `selected` for up to SWAP_DELAY_MS. */
  path: string | null;
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
}

/** The last review submitted on the open PR. */
export interface ReviewResult extends SubmittedReview {
  event: ReviewEvent;
}

export interface Toast {
  id: number;
  text: string;
  /** Errors are the default; "info" is for plain news ("You're up to date"). */
  kind: "error" | "info";
}

export const SWAP_DELAY_MS = 80;
/** Unviewed files to prefetch ahead of the current one (the next `r` / `s` targets). */
export const PREFETCH = 3;
/**
 * Diffs kept in memory per PR (LRU): the current file, the prefetch window and
 * recently visited files. Bounds memory on PRs with thousands of files.
 */
export const DIFF_CACHE_MAX = 48;
/** Grammars preloaded when a PR opens (most common languages in it first). */
const WARM_LANGS = 12;
const TOAST_MS = 4000;

const KEY_MODE = "fr.mode";
const KEY_LAST_PR = "fr.lastPr";

export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // storage unavailable (private mode, sandbox); settings just won't persist
    }
  },
};

export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const prKey = (r: PrRef) => `${r.owner}/${r.repo}#${r.number}`;

export type AppStore = ReturnType<typeof createAppStore>;

export function createAppStore(backend: Backend) {
  const [phase, setPhase] = createSignal<"loading" | "auth" | "ready">("loading");
  const [auth, setAuth] = createSignal<AuthStatus | null>(null);
  const [inbox, setInbox] = createSignal<PrSummary[] | null>(null);
  const [pr, setPr] = createSignal<PrDetail | null>(null);
  const [prLoading, setPrLoading] = createSignal<PrRef | null>(null);
  const [viewed, setViewedMap] = createStore<Record<string, boolean>>({});
  const [viewedCount, setViewedCount] = createSignal(0);
  const [collapsed, setCollapsed] = createStore<Record<string, boolean>>({});
  const [selected, setSelected] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);
  const [mode, setModeSignal] = createSignal<Mode>(storage.get(KEY_MODE) === "unified" ? "unified" : "split");
  const [overlay, setOverlay] = createSignal<Overlay>("none");
  const [filter, setFilter] = createSignal("");
  const [diff, setDiff] = createSignal<DiffState>({ path: null, diff: null, loading: false, error: null });
  const [hunkNav, setHunkNav] = createSignal<{ dir: 1 | -1; seq: number } | undefined>();
  const [focusFilterSeq, setFocusFilterSeq] = createSignal(0);
  // Find in file: the query outlives the bar (reopening restores it) and file switches.
  const [findOpen, setFindOpen] = createSignal(false);
  const [findQuery, setFindQuery] = createSignal("");
  const [findCase, setFindCase] = createSignal(false);
  const [findNav, setFindNav] = createSignal<{ dir: 1 | -1; seq: number } | undefined>();
  const [focusFindSeq, setFocusFindSeq] = createSignal(0);
  const [findStatus, setFindStatus] = createSignal<FindStatus>({ count: 0, index: -1 });
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  // Review form, for the open PR only: reset when another PR opens.
  const [reviewDraft, setReviewDraft] = createSignal("");
  const [reviewSubmitting, setReviewSubmitting] = createSignal(false);
  const [reviewResult, setReviewResult] = createSignal<ReviewResult | null>(null);
  const [reviewError, setReviewError] = createSignal<string | null>(null);

  const fullTree = createMemo<DirNode | null>(() => {
    const p = pr();
    return p ? buildTree(p.files) : null;
  });
  const tree = createMemo<DirNode | null>(() => {
    const p = pr();
    const q = filter().trim();
    return p && q ? buildTree(filterFiles(p.files, q)) : fullTree();
  });
  /** Visual order of files; next/prev and prefetch follow it. */
  const order = createMemo<string[]>(() => {
    const t = tree();
    return t ? flattenFiles(t) : [];
  });
  /** GitHub refuses to let authors approve their own PR. */
  const ownPr = () => {
    const login = auth()?.login;
    return !!login && pr()?.author.toLowerCase() === login.toLowerCase();
  };
  const pickerOpen = () => overlay() === "picker" || (phase() === "ready" && !pr() && !prLoading());

  // --- toasts -------------------------------------------------------------
  let toastSeq = 0;
  function toast(text: string, kind: Toast["kind"] = "error") {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => dismissToast(id), TOAST_MS);
  }
  const dismissToast = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  // --- diff cache -----------------------------------------------------------
  // Keyed by path within the current PR; cleared on PR switch. A bounded LRU:
  // `cache` holds insertion/recency order, `ready` mirrors its settled entries.
  // Evicted diffs (and the highlight tokens keyed on them) can be garbage
  // collected and are re-fetched from the Rust / disk cache when revisited.
  let cache = new Map<string, Promise<FileDiff>>();
  let ready = new Map<string, FileDiff>();

  /** Mark `path` most recently used. */
  function touch(path: string) {
    const hit = cache.get(path);
    if (hit) {
      cache.delete(path);
      cache.set(path, hit);
    }
  }

  function fetchDiff(path: string): Promise<FileDiff> {
    const hit = cache.get(path);
    if (hit) {
      touch(path);
      return hit;
    }
    const p = pr()!;
    const mine = cache;
    const promise: Promise<FileDiff> = backend.getFileDiff(p.owner, p.repo, p.number, path).then(
      (d) => {
        if (mine === cache && cache.get(path) === promise) ready.set(path, d);
        return d;
      },
      (e) => {
        if (mine === cache && cache.get(path) === promise) cache.delete(path);
        throw e;
      },
    );
    cache.set(path, promise);
    while (cache.size > DIFF_CACHE_MAX) {
      const oldest = cache.keys().next().value!;
      cache.delete(oldest);
      ready.delete(oldest);
    }
    return promise;
  }

  /**
   * Fetch (and highlight, at low priority) the files the user will most likely
   * open next: the next PREFETCH unviewed files in tree order, which is exactly
   * where `r` / `s` go, plus the next file in order for `j`.
   */
  function prefetchAround(path: string) {
    const o = order();
    const targets = upcomingUnviewed(o, path, (x) => !!viewed[x], PREFETCH);
    const i = o.indexOf(path);
    const following = i >= 0 ? o[i + 1] : undefined;
    if (following && !targets.includes(following)) targets.push(following);
    const mine = cache;
    for (const t of targets) {
      fetchDiff(t).then(
        (d) => {
          if (mine === cache) prefetchHighlight(d);
        },
        () => {},
      );
    }
  }

  let selectSeq = 0;
  function select(path: string) {
    const seq = ++selectSeq;
    batch(() => {
      setSelected(path);
      setDone(false);
      for (const dir of Object.keys(collapsed)) {
        if (collapsed[dir] && isAncestor(dir, path)) setCollapsed(dir, false);
      }
      const hit = ready.get(path);
      if (hit) {
        touch(path);
        setDiff({ path, diff: hit, loading: false, error: null });
      }
    });
    if (!ready.has(path)) {
      // Keep the previous diff on screen briefly so fast loads swap without a flash.
      const timer = setTimeout(() => {
        if (seq === selectSeq) setDiff({ path, diff: null, loading: true, error: null });
      }, SWAP_DELAY_MS);
      fetchDiff(path).then(
        (d) => {
          clearTimeout(timer);
          if (seq === selectSeq) setDiff({ path, diff: d, loading: false, error: null });
        },
        (e) => {
          clearTimeout(timer);
          if (seq === selectSeq) setDiff({ path, diff: null, loading: false, error: errorMessage(e) });
        },
      );
    }
    prefetchAround(path);
  }

  // --- viewed -------------------------------------------------------------
  const viewedVersion = new Map<string, number>();

  function applyViewed(path: string, value: boolean) {
    if (!!viewed[path] === value) return;
    setViewedMap(path, value);
    setViewedCount((c) => c + (value ? 1 : -1));
  }

  /**
   * Optimistic: update now, sync to GitHub in the background, roll back on failure.
   * Never awaited: navigation must not wait for GitHub. Each toggle gets a version,
   * so a late failure of an older toggle cannot undo a newer one.
   */
  function markViewed(path: string, value: boolean) {
    const p = pr();
    if (!p || !!viewed[path] === value) return;
    const version = (viewedVersion.get(path) ?? 0) + 1;
    viewedVersion.set(path, version);
    applyViewed(path, value);
    backend.setFileViewed(p.id, path, value).catch((e) => {
      if (pr() !== p || viewedVersion.get(path) !== version) return;
      applyViewed(path, !value);
      if (value) setDone(false);
      toast(`Couldn't mark ${baseName(path)} as ${value ? "viewed" : "unviewed"}: ${errorMessage(e)}`);
    });
  }

  // --- review -------------------------------------------------------------
  let reviewSeq = 0;

  function resetReview() {
    reviewSeq++;
    batch(() => {
      setReviewDraft("");
      setReviewSubmitting(false);
      setReviewResult(null);
      setReviewError(null);
    });
  }

  /**
   * Submit the draft as a review of the open PR. On failure the error is kept for the
   * form and the draft stays. A result that lands after another PR opened only toasts.
   */
  async function submitReview(event: ReviewEvent): Promise<boolean> {
    const p = pr();
    const body = reviewDraft().trim();
    if (!p || reviewSubmitting() || (event === "COMMENT" && !body)) return false;
    const seq = ++reviewSeq;
    batch(() => {
      setReviewSubmitting(true);
      setReviewError(null);
    });
    const label = event === "APPROVE" ? "Approved" : "Review submitted";
    try {
      const r = await backend.submitReview(p.owner, p.repo, p.number, event, body);
      if (seq !== reviewSeq) {
        toast(`${label} on ${prKey(p)}`);
        return false;
      }
      batch(() => {
        setReviewResult({ ...r, event });
        setReviewDraft("");
        setReviewSubmitting(false);
      });
      toast(label);
      return true;
    } catch (e) {
      if (seq !== reviewSeq) {
        toast(`Couldn't submit review on ${prKey(p)}: ${errorMessage(e)}`);
        return false;
      }
      batch(() => {
        setReviewError(errorMessage(e));
        setReviewSubmitting(false);
      });
      return false;
    }
  }

  function openReview() {
    const r = reviewResult();
    if (r) backend.openUrl(r.url).catch((e) => toast(`Couldn't open browser: ${errorMessage(e)}`));
  }

  // --- PR -----------------------------------------------------------------
  let openSeq = 0;
  async function openPr(ref: PrRef): Promise<boolean> {
    const seq = ++openSeq;
    batch(() => {
      setPrLoading(ref);
      setOverlay("none");
    });
    try {
      const detail = await backend.getPr(ref.owner, ref.repo, ref.number);
      if (seq !== openSeq) return false;
      cache = new Map();
      ready = new Map();
      viewedVersion.clear();
      const map: Record<string, boolean> = {};
      let count = 0;
      for (const f of detail.files) {
        const v = f.viewed === "VIEWED";
        map[f.path] = v;
        if (v) count++;
      }
      // Drop pending select() callbacks and swap timers from the previous PR.
      selectSeq++;
      const prev = pr();
      if (!prev || prKey(prev) !== prKey(detail)) resetReview();
      batch(() => {
        setPr(detail);
        setViewedMap(reconcile(map));
        setViewedCount(count);
        setCollapsed(reconcile({}));
        setFilter("");
        setDone(false);
        setSelected(null);
        setDiff({ path: null, diff: null, loading: false, error: null });
        setPrLoading(null);
      });
      storage.set(KEY_LAST_PR, JSON.stringify(ref));
      const first = nextUnviewed(order(), null, (x) => !!viewed[x]) ?? order()[0];
      // Load the grammars this PR needs while the first diff is on its way (its language first).
      warmHighlighter(
        [first ? languageForPath(first) : null, ...languagesOf(detail.files.map((f) => f.path))].slice(0, WARM_LANGS),
      );
      if (first) select(first);
      return true;
    } catch (e) {
      if (seq !== openSeq) return false;
      batch(() => {
        setPrLoading(null);
        if (pr()) setOverlay("picker");
      });
      toast(`Couldn't open ${ref.owner}/${ref.repo}#${ref.number}: ${errorMessage(e)}`);
      return false;
    }
  }

  async function refreshInbox() {
    try {
      setInbox(await backend.listInbox());
    } catch (e) {
      toast(`Couldn't load inbox: ${errorMessage(e)}`);
      if (inbox() === null) setInbox([]);
    }
  }

  function lastPr(): PrRef | null {
    const raw = storage.get(KEY_LAST_PR);
    if (!raw) return null;
    try {
      const r = JSON.parse(raw) as PrRef;
      return typeof r.owner === "string" && typeof r.repo === "string" && Number.isInteger(r.number) ? r : null;
    } catch {
      return null;
    }
  }

  async function start(status: AuthStatus) {
    batch(() => {
      setAuth(status);
      setPhase(status.authenticated ? "ready" : "auth");
    });
    if (!status.authenticated) return;
    void refreshInbox();
    const last = lastPr();
    if (last && !(await openPr(last))) storage.set(KEY_LAST_PR, null);
  }

  async function init() {
    try {
      await start(await backend.authStatus());
    } catch (e) {
      toast(`Couldn't check authentication: ${errorMessage(e)}`);
      setPhase("auth");
    }
  }

  async function signIn(token: string) {
    await start(await backend.setToken(token));
    if (!auth()?.authenticated) throw new Error("Token was not accepted");
  }

  async function signOut() {
    const status = await backend.signOut();
    selectSeq++;
    openSeq++;
    resetReview();
    batch(() => {
      setPr(null);
      setPrLoading(null);
      setSelected(null);
      setDiff({ path: null, diff: null, loading: false, error: null });
      setInbox(null);
      setAuth(status);
      setPhase("auth");
    });
  }

  // --- actions --------------------------------------------------------------
  function setMode(m: Mode) {
    setModeSignal(m);
    storage.set(KEY_MODE, m);
  }

  /** Actions that stay live while a PR is loading; the rest would act on the hidden previous PR. */
  const LOADING_ACTIONS: ReadonlySet<Action> = new Set<Action>(["picker", "help", "escape"]);

  function dispatch(action: Action) {
    if (prLoading() && !LOADING_ACTIONS.has(action)) return;
    const u = reduce(
      {
        order: order(),
        current: selected(),
        isViewed: (x) => !!viewed[x],
        mode: mode(),
        overlay: pickerOpen() ? "picker" : overlay(),
        done: done(),
        findOpen: findOpen(),
      },
      action,
    );
    batch(() => {
      if (u.overlay !== undefined) {
        setOverlay(u.overlay);
        if (u.overlay === "picker") void refreshInbox();
      }
      if (u.mode) setMode(u.mode);
      if (u.findOpen !== undefined) setFindOpen(u.findOpen);
      for (const e of u.effects) {
        if (e.type === "setViewed") markViewed(e.path, e.viewed);
        else if (e.type === "nextHunk") setHunkNav((h) => ({ dir: 1, seq: (h?.seq ?? 0) + 1 }));
        else if (e.type === "prevHunk") setHunkNav((h) => ({ dir: -1, seq: (h?.seq ?? 0) + 1 }));
        else if (e.type === "openBrowser") {
          const p = pr();
          if (p) backend.openUrl(p.url).catch((err) => toast(`Couldn't open browser: ${errorMessage(err)}`));
        } else if (e.type === "focusFilter") setFocusFilterSeq((n) => n + 1);
        else if (e.type === "focusFind") setFocusFindSeq((n) => n + 1);
        else if (e.type === "findNav") {
          const dir = e.dir;
          setFindNav((f) => ({ dir, seq: (f?.seq ?? 0) + 1 }));
        }
      }
      if (u.done !== undefined) setDone(u.done);
    });
    if (u.current && u.current !== selected()) select(u.current);
  }

  function retryDiff() {
    const path = selected();
    if (path) select(path);
  }

  return {
    // state
    phase,
    auth,
    inbox,
    pr,
    prLoading,
    viewed,
    viewedCount,
    collapsed,
    selected,
    done,
    mode,
    overlay,
    pickerOpen,
    filter,
    diff,
    hunkNav,
    focusFilterSeq,
    findOpen,
    findQuery,
    findCase,
    findNav,
    focusFindSeq,
    findStatus,
    toasts,
    reviewDraft,
    reviewSubmitting,
    reviewResult,
    reviewError,
    ownPr,
    tree,
    order,
    // actions
    init,
    signIn,
    signOut,
    openPr,
    refreshInbox,
    select,
    markViewed,
    dispatch,
    setMode,
    setFilter,
    setOverlay,
    setFindOpen,
    setFindQuery,
    setFindCase,
    setFindStatus,
    toggleCollapsed: (dir: string) => setCollapsed(dir, (c) => !c),
    retryDiff,
    toast,
    dismissToast,
    setReviewDraft,
    submitReview,
    openReview,
    /** Back to an empty form after a submitted review ("write another"). */
    newReview: resetReview,
    listRepoPrs: (owner: string, repo: string) => backend.listRepoPrs(owner, repo),
    searchRepos: (q: string) => backend.searchRepos(q),
  };
}
