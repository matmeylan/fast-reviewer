/// <reference lib="webworker" />
// Highlight worker: tokenizes whole texts with Shiki off the main thread.
// High-priority requests (the visible file) are served newest-first, before low
// ones (prefetch, oldest-first). Queued or in-flight requests can be cancelled.
import { createHighlightCore, HighlightCancelled } from "../lib/highlight-core";
import type { SideTokens, ThemeName, WorkerRequest, WorkerResponse } from "../lib/highlight-protocol";

declare const self: DedicatedWorkerGlobalScope;

const core = createHighlightCore();
type Job = Extract<WorkerRequest, { type: "highlight" }>;
const high: Job[] = [];
const low: Job[] = [];
const cancelled = new Set<number>();
let running = false;
let currentId = -1;

// Small LRU keyed by content so identical texts (re-fetched diffs) are free.
const CACHE_MAX = 32;
const cache = new Map<string, SideTokens | null>();

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36) + ":" + s.length;
}

const yieldFn = () => new Promise<void>((r) => setTimeout(r, 0));

async function pump() {
  if (running) return;
  running = true;
  while (high.length > 0 || low.length > 0) {
    const req = high.length > 0 ? high.pop()! : low.shift()!;
    currentId = req.id;
    const key = `${req.theme}\0${req.lang}\0${hash(req.text)}`;
    try {
      let tokens = cache.get(key);
      if (tokens === undefined) {
        tokens = await core.tokenize(req.text, req.lang, req.theme as ThemeName, {
          yieldFn,
          isCancelled: () => cancelled.has(req.id),
          onProgress: (partial) => post({ id: req.id, ok: true, done: false, tokens: partial }),
        });
        cache.set(key, tokens);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      } else {
        cache.delete(key);
        cache.set(key, tokens);
      }
      post({ id: req.id, ok: true, done: true, tokens });
    } catch (e) {
      const isCancel = e instanceof HighlightCancelled;
      post({ id: req.id, ok: false, error: String(e), cancelled: isCancel });
    }
    cancelled.delete(req.id);
  }
  currentId = -1;
  running = false;
}

function take(id: number): Job | undefined {
  for (const q of [high, low]) {
    const i = q.findIndex((j) => j.id === id);
    if (i >= 0) return q.splice(i, 1)[0];
  }
  return undefined;
}

function post(msg: WorkerResponse) {
  self.postMessage(msg);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "bump") {
    const job = take(msg.id);
    if (job) high.push(job);
    return;
  }
  if (msg.type === "cancel") {
    if (take(msg.id)) {
      post({ id: msg.id, ok: false, error: "cancelled", cancelled: true });
    } else if (msg.id === currentId) {
      cancelled.add(msg.id);
    }
    return;
  }
  (msg.low ? low : high).push(msg);
  void pump();
};
