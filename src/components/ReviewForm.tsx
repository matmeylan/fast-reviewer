import { createSignal, onMount, Show } from "solid-js";
import type { AppStore } from "../lib/store";
import type { ReviewEvent } from "../lib/types";
import Check from "lucide-solid/icons/check";
import CircleAlert from "lucide-solid/icons/circle-alert";
import ExternalLink from "lucide-solid/icons/external-link";
import MessageSquare from "lucide-solid/icons/message-square";
import { Button } from "./ui/button";
import { DialogContent, DialogDescription, DialogHeader, DialogOverlay, DialogTitle } from "./ui/dialog";
import { Kbd } from "./ui/kbd";
import { Spinner } from "./ui/spinner";
import { Textarea } from "./ui/textarea";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

export const OWN_PR_HINT = "GitHub doesn't allow approving your own pull request";

/**
 * Comment on or approve the open PR. The draft, result and error live in the store, so
 * the "All files reviewed" screen and the review dialog show the same review.
 * Not focused unless `autofocus`: on the done screen, single-key shortcuts keep working
 * until the textarea is clicked.
 */
export default function ReviewForm(props: { store: AppStore; autofocus?: boolean }) {
  const s = props.store;
  let textarea!: HTMLTextAreaElement;
  // The button that was pressed gets the spinner; the store only knows something is in flight.
  const [pressed, setPressed] = createSignal<ReviewEvent | null>(null);
  const pending = () => s.drafts().length;
  const canComment = () => !s.reviewSubmitting() && (s.reviewDraft().trim() !== "" || pending() > 0);
  const busy = (event: ReviewEvent) => s.reviewSubmitting() && pressed() === event;

  onMount(() => props.autofocus && textarea.focus());

  async function submit(event: ReviewEvent) {
    setPressed(event);
    await s.submitReview(event);
    setPressed(null);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canComment()) void submit("COMMENT");
    } else if (e.key === "Escape") {
      // Hand the keyboard back to the review shortcuts (in the dialog, Esc also closes it).
      textarea.blur();
    }
  }

  return (
    <Show
      when={s.reviewResult()}
      fallback={
        <div class="flex w-full flex-col gap-2 text-left text-wrap" data-testid="review-form">
          <Textarea
            ref={textarea}
            class="max-h-64 min-h-24 resize-none select-text"
            placeholder="Leave a comment"
            aria-label="Review comment"
            aria-invalid={!!s.reviewError()}
            value={s.reviewDraft()}
            onInput={(e) => s.setReviewDraft(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            data-testid="review-body"
          />
          <Show when={pending() > 0}>
            <p class="text-xs text-muted-foreground" data-testid="review-pending">
              {pending() === 1 ? "1 line comment" : `${pending()} line comments`} will be sent with this review.
            </p>
          </Show>
          <Show when={s.reviewError()}>
            {(err) => (
              <p class="flex items-start gap-1.5 text-sm text-destructive" role="alert" data-testid="review-error">
                <CircleAlert class="mt-0.5 size-3.5 flex-none" />
                <span class="min-w-0 break-words">{err()}</span>
              </p>
            )}
          </Show>
          <div class="mt-1 flex items-center gap-2">
            <span class="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Kbd>{isMac ? "⌘↵" : "Ctrl ↵"}</Kbd> to comment
            </span>
            <Button
              variant="outline"
              disabled={!canComment()}
              onClick={() => void submit("COMMENT")}
              data-testid="review-comment"
            >
              <Show when={busy("COMMENT")} fallback={<MessageSquare />}>
                <Spinner />
              </Show>
              Comment
            </Button>
            {/* Disabled buttons get no pointer events, so the wrapper carries the tooltip. */}
            <span class="inline-flex" title={s.ownPr() ? OWN_PR_HINT : undefined}>
              <Button
                disabled={s.reviewSubmitting() || s.ownPr()}
                onClick={() => void submit("APPROVE")}
                data-testid="review-approve"
              >
                <Show when={busy("APPROVE")} fallback={<Check />}>
                  <Spinner class="text-current" />
                </Show>
                Approve
              </Button>
            </span>
          </div>
        </div>
      }
    >
      {(r) => (
        <div class="flex w-full flex-col gap-3 rounded-lg border p-3 text-left dark:border-input" data-testid="review-success">
          <div class="flex items-center gap-2.5">
            <span class="grid size-8 flex-none place-items-center rounded-full bg-success/15 text-success">
              <Check class="size-4" stroke-width={2.5} />
            </span>
            <div class="flex min-w-0 flex-col">
              <span class="font-medium text-foreground">{r().event === "APPROVE" ? "Approved" : "Review submitted"}</span>
              <span class="text-xs text-muted-foreground">
                {r().event === "APPROVE" ? "Your approval is on GitHub." : "Your comment is on GitHub."}
              </span>
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => s.newReview()} data-testid="review-again">
              Write another review
            </Button>
            <Button variant="outline" size="sm" onClick={() => s.openReview()} data-testid="review-open">
              <ExternalLink />
              View on GitHub
            </Button>
          </div>
        </div>
      )}
    </Show>
  );
}

/** The review form over whatever is on screen (`a`, or the header's Review button). */
export function ReviewDialog(props: { store: AppStore }) {
  const s = props.store;
  return (
    <DialogOverlay onMouseDown={(e) => e.target === e.currentTarget && s.setOverlay("none")}>
      <DialogContent class="w-[520px] gap-4 p-5" aria-label="Review" data-testid="review-dialog">
        <DialogHeader class="gap-1.5">
          <DialogTitle>Review</DialogTitle>
          <Show when={s.pr()}>
            {(p) => (
              <DialogDescription class="truncate" title={p().title}>
                {p().owner}/{p().repo}#{p().number} · {p().title}
              </DialogDescription>
            )}
          </Show>
        </DialogHeader>
        <ReviewForm store={s} autofocus />
      </DialogContent>
    </DialogOverlay>
  );
}
