// Solid port of shadcn/ui Empty (style: Nova).
import { splitProps, type JSX } from "solid-js";
import { cn } from "../../lib/utils";

type DivProps = JSX.HTMLAttributes<HTMLDivElement>;

const part = (slot: string, base: string) => (props: DivProps) => {
  const [local, rest] = splitProps(props, ["class"]);
  return <div data-slot={slot} class={cn(base, local.class)} {...rest} />;
};

export const Empty = part(
  "empty",
  "flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-xl p-6 text-center text-balance",
);
export const EmptyHeader = part("empty-header", "flex max-w-sm flex-col items-center gap-2");
export const EmptyMedia = part(
  "empty-media",
  "mb-2 flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*='size-'])]:size-5",
);
export const EmptyTitle = part("empty-title", "font-heading text-base font-medium tracking-tight");
export const EmptyDescription = part("empty-description", "text-sm/relaxed text-muted-foreground");
export const EmptyContent = part("empty-content", "flex w-full max-w-sm min-w-0 flex-col items-center gap-2.5 text-sm text-balance");
