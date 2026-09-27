// Solid port of shadcn/ui Kbd (style: Nova).
import { splitProps, type JSX } from "solid-js";
import { cn } from "../../lib/utils";

export function Kbd(props: JSX.HTMLAttributes<HTMLElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <kbd
      data-slot="kbd"
      class={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm bg-muted px-1 font-sans text-xs font-medium text-muted-foreground select-none [&_svg:not([class*='size-'])]:size-3",
        local.class,
      )}
      {...rest}
    />
  );
}

export function KbdGroup(props: JSX.HTMLAttributes<HTMLElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return <kbd data-slot="kbd-group" class={cn("inline-flex items-center gap-1", local.class)} {...rest} />;
}
