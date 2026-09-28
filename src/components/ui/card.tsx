// Solid port of shadcn/ui Card (style: Nova).
import { splitProps, type JSX } from "solid-js";
import { cn } from "../../lib/utils";

type DivProps = JSX.HTMLAttributes<HTMLDivElement>;

const part = (slot: string, base: string) => (props: DivProps) => {
  const [local, rest] = splitProps(props, ["class"]);
  return <div data-slot={slot} class={cn(base, local.class)} {...rest} />;
};

export const Card = part(
  "card",
  "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground ring-1 ring-foreground/10 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 data-[size=lg]:[--card-spacing:--spacing(6)]",
);
export const CardHeader = part("card-header", "grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing)");
export const CardTitle = part("card-title", "font-heading text-base leading-snug font-medium");
export const CardDescription = part("card-description", "text-sm text-muted-foreground");
export const CardContent = part("card-content", "px-(--card-spacing)");
export const CardFooter = part(
  "card-footer",
  "flex items-center rounded-b-xl border-t bg-muted/50 p-(--card-spacing)",
);
