import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { AppStore, CommentTarget, DraftComment } from "../lib/store";
import type { ReviewThread } from "../lib/types";
import ExternalLink from "lucide-solid/icons/external-link";
import Pencil from "lucide-solid/icons/pencil";
import Trash from "lucide-solid/icons/trash";
import X from "lucide-solid/icons/x";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";
import { Textarea } from "./ui/textarea";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** "now", "5m", "3h", "2d", or a date for older comments. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const m = Math.floor((now - t) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h`;
  if (m < 30 * 24 * 60) return `${Math.floor(m / (24 * 60))}d`;
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The comments on one diff line: GitHub's threads, the drafts that go with the next
 * review, and a box to write another draft. Closing it (Esc, a click elsewhere) keeps
 * what was typed as a draft; Cancel discards it. Rendered keyed by target, so each line
 * gets a fresh one.
 */
export default function CommentPopover(props: { store: AppStore; target: CommentTarget }) {
  const s = props.store;
  const t = props.target;
  let root!: HTMLDivElement;
  let composer: HTMLTextAreaElement | undefined;

  const threads = () => s.threadsAt(t.path, t.side, t.line);
  const drafts = () => s.draftsAt(t.path, t.side, t.line);
  const [composing, setComposing] = createSignal(t.canComment && threads().length === 0 && drafts().length === 0);
  const [text, setText] = createSignal("");
  const [editing, setEditing] = createSignal<{ id: number; text: string } | null>(null);

  const close = () => s.setCommentAt(null);

  function add() {
    if (!text().trim()) return;
    s.addDraft(t, text());
    setText("");
    setComposing(false);
  }

  function saveEdit() {
    const e = editing();
    if (e) s.updateDraft(e.id, e.text);
    setEditing(null);
  }

  // Unsaved text is kept, not lost: a new comment becomes a draft, an edit is applied.
  // Not when the popover goes away because another PR opened (or the user signed out).
  const pr = s.pr();
  onCleanup(() => {
    if (s.pr() !== pr) return;
    if (text().trim()) s.addDraft(t, text());
    const e = editing();
    if (e) s.updateDraft(e.id, e.text);
  });

  onMount(() => {
    if (composing()) composer?.focus();
    // A click outside closes the popover; line numbers are left to the diff, which
    // moves the popover to (or closes it on) the clicked line.
    const onPointerDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (!el || root.contains(el) || el.closest?.(".ln.cm")) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown, true));
  });

  /** ⌘/Ctrl+Enter submits, Esc closes; keys never reach the review shortcuts. */
  const keys = (submit: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div
      ref={root}
      class="flex max-h-[min(70vh,560px)] flex-col overflow-hidden rounded-lg border bg-popover font-sans text-sm text-popover-foreground shadow-lg dark:border-input"
      role="dialog"
      aria-label={`Comments on line ${t.line}`}
      data-testid="comment-popover"
    >
      <div class="flex h-9 flex-none items-center gap-2 border-b pr-1 pl-3 dark:border-input">
        <span class="font-medium">Line {t.line}</span>
        <Show when={t.side === "old"}>
          <span class="text-xs text-muted-foreground">(before the change)</span>
        </Show>
        <span class="flex-1" />
        <Button variant="ghost" size="icon-xs" onClick={close} title="Close (Esc)" aria-label="Close">
          <X />
        </Button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <For each={threads()}>{(thread) => <Thread thread={thread} store={s} />}</For>
        <For each={drafts()}>
          {(d) => (
            <Show
              when={editing()?.id === d.id}
              fallback={<Draft draft={d} onEdit={() => setEditing({ id: d.id, text: d.body })} onDelete={() => s.deleteDraft(d.id)} />}
            >
              <div class="flex flex-col gap-2 border-b p-3 dark:border-input">
                <Textarea
                  ref={(el) => queueMicrotask(() => el.focus())}
                  class="max-h-48 min-h-16 resize-none select-text"
                  aria-label="Edit draft comment"
                  value={editing()?.text ?? ""}
                  onInput={(e) => setEditing({ id: d.id, text: e.currentTarget.value })}
                  onKeyDown={keys(saveEdit)}
                  data-testid="draft-edit"
                />
                <div class="flex justify-end gap-2">
                  <Button variant="ghost" size="xs" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                  <Button size="xs" onClick={saveEdit} data-testid="draft-save">
                    Save
                  </Button>
                </div>
              </div>
            </Show>
          )}
        </For>
      </div>
      <Show when={t.canComment}>
        <Show
          when={composing()}
          fallback={
            <div class="flex-none p-2">
              <Button
                variant="ghost"
                size="sm"
                class="w-full justify-start text-muted-foreground"
                onClick={() => {
                  setComposing(true);
                  composer?.focus();
                }}
                data-testid="comment-new"
              >
                Add a comment…
              </Button>
            </div>
          }
        >
          <div class="flex flex-none flex-col gap-2 p-3">
            <Textarea
              ref={composer}
              class="max-h-48 min-h-16 resize-none select-text"
              placeholder="Leave a comment"
              aria-label="Line comment"
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
              onKeyDown={keys(add)}
              data-testid="comment-body"
            />
            <div class="flex items-center gap-2">
              <span class="mr-auto text-xs text-muted-foreground">Sent with your review</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setText("");
                  if (threads().length || drafts().length) setComposing(false);
                  else close();
                }}
              >
                Cancel
              </Button>
              <Button size="xs" disabled={!text().trim()} onClick={add} data-testid="comment-add">
                Add to review
                <Kbd class="ml-0.5 bg-primary-foreground/20 text-primary-foreground">{isMac ? "⌘↵" : "Ctrl ↵"}</Kbd>
              </Button>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}

function Thread(props: { thread: ReviewThread; store: AppStore }) {
  const first = () => props.thread.comments[0];
  return (
    <div class="border-b p-3 dark:border-input" classList={{ "opacity-70": props.thread.resolved }} data-testid="comment-thread">
      <For each={props.thread.comments}>
        {(c, i) => (
          <div classList={{ "mt-3": i() > 0 }}>
            <div class="flex items-center gap-2">
              <span class="font-medium">{c.author}</span>
              <span class="text-xs text-muted-foreground" title={new Date(c.createdAt).toLocaleString()}>
                {ago(c.createdAt)}
              </span>
              <Show when={i() === 0}>
                <span class="flex-1" />
                <Show when={props.thread.resolved}>
                  <Badge variant="secondary">Resolved</Badge>
                </Show>
                <Show when={first()}>
                  {(f) => (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Reply on GitHub"
                      aria-label="Reply on GitHub"
                      onClick={() => props.store.openUrl(f().url)}
                    >
                      <ExternalLink />
                    </Button>
                  )}
                </Show>
              </Show>
            </div>
            <p class="mt-1 break-words whitespace-pre-wrap select-text">{c.body}</p>
          </div>
        )}
      </For>
    </div>
  );
}

function Draft(props: { draft: DraftComment; onEdit: () => void; onDelete: () => void }) {
  return (
    <div class="border-b p-3 dark:border-input" data-testid="comment-draft">
      <div class="flex items-center gap-2">
        <Badge variant="outline">Pending</Badge>
        <span class="flex-1" />
        <Button variant="ghost" size="icon-xs" title="Edit" aria-label="Edit draft" onClick={props.onEdit}>
          <Pencil />
        </Button>
        <Button variant="ghost" size="icon-xs" title="Delete" aria-label="Delete draft" onClick={props.onDelete} data-testid="draft-delete">
          <Trash />
        </Button>
      </div>
      <p class="mt-1 break-words whitespace-pre-wrap select-text">{props.draft.body}</p>
    </div>
  );
}
