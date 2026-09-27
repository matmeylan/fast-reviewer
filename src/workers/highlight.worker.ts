/// <reference lib="webworker" />
// Highlight worker: tokenizes whole texts with Shiki off the main thread.
// High-priority requests (the visible file) run before low ones (prefetch), and
// preempt a running low one between chunks. Requests can be cancelled.
import { createHighlightCore, HighlightCancelled } from "../lib/highlight-core";
import type { SideTokens, WorkerRequest, WorkerResponse } from "../lib/highlight-protocol";

declare const self: DedicatedWorkerGlobalScope;

type Job = Extract<WorkerRequest, { type: "highlight" }>;

const core = createHighlightCore();
const high: Job[] = [];
const low: Job[] = [];
const inflight = new Set<number>();
const cancelled = new Set<number>();
let running = false;

// Small LRU keyed by content so identical texts (re-fetched diffs) are free.
const CACHE_MAX = 32;
const cache = new Map<string, SideTokens | null>();

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36) + ":" + s.length;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function run(req: Job, isLow: boolean) {
  const key = `${req.theme}\0${req.lang}\0${hash(req.text)}`;
  inflight.add(req.id);
  try {
    let tokens = cache.get(key);
    if (tokens === undefined) {
      tokens = await core.tokenize(req.text, req.lang, req.theme, {
        yieldFn: async () => {
          await tick();
          if (isLow) while (high.length > 0) await run(high.shift()!, false);
        },
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
    post({ id: req.id, ok: false, error: String(e), cancelled: e instanceof HighlightCancelled });
  } finally {
    inflight.delete(req.id);
    cancelled.delete(req.id);
  }
}

async function pump() {
  if (running) return;
  running = true;
  // Let messages posted together arrive before choosing what to run.
  await tick();
  while (high.length > 0 || low.length > 0) {
    const isLow = high.length === 0;
    await run(isLow ? low.shift()! : high.shift()!, isLow);
  }
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
    if (take(msg.id)) post({ id: msg.id, ok: false, error: "cancelled", cancelled: true });
    else if (inflight.has(msg.id)) cancelled.add(msg.id);
    return;
  }
  (msg.low ? low : high).push(msg);
  void pump();
};
