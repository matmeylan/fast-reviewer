// Solid port of shadcn/ui Badge (style: Nova).
import { cva, type VariantProps } from "class-variance-authority";
import { splitProps, type JSX } from "solid-js";
import { cn } from "../../lib/utils";

export const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium transition-all [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        destructive: "bg-destructive/10 text-destructive dark:bg-destructive/20",
        ghost: "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge(props: JSX.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  const [local, rest] = splitProps(props, ["class", "variant"]);
  return <span data-slot="badge" class={cn(badgeVariants({ variant: local.variant }), local.class)} {...rest} />;
}
