// Styling of shadcn/ui Dialog and Command (style: Nova). Behaviour (focus, keys) stays in each overlay.
import { splitProps, type JSX } from "solid-js";
import { cn } from "../../lib/utils";

export function DialogOverlay(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div
      data-slot="dialog-overlay"
      class={cn(
        "fixed inset-0 z-50 flex items-start justify-center bg-black/10 pt-[12vh] duration-100 animate-in fade-in-0 supports-backdrop-filter:backdrop-blur-xs dark:bg-black/40",
        local.class,
      )}
      {...rest}
    />
  );
}

export function DialogContent(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div
      data-slot="dialog-content"
      role="dialog"
      class={cn(
        "relative grid w-full max-w-[calc(100%-2rem)] gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-100 animate-in fade-in-0 zoom-in-95",
        local.class,
      )}
      {...rest}
    />
  );
}

export const DialogHeader = (props: JSX.HTMLAttributes<HTMLDivElement>) => {
  const [local, rest] = splitProps(props, ["class"]);
  return <div data-slot="dialog-header" class={cn("flex flex-col gap-2", local.class)} {...rest} />;
};

export const DialogTitle = (props: JSX.HTMLAttributes<HTMLHeadingElement>) => {
  const [local, rest] = splitProps(props, ["class"]);
  return <h2 data-slot="dialog-title" class={cn("font-heading text-base leading-none font-medium", local.class)} {...rest} />;
};

export const DialogDescription = (props: JSX.HTMLAttributes<HTMLParagraphElement>) => {
  const [local, rest] = splitProps(props, ["class"]);
  return <p data-slot="dialog-description" class={cn("text-sm text-muted-foreground", local.class)} {...rest} />;
};
