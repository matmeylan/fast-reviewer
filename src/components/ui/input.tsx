// Solid port of shadcn/ui Input and InputGroup (style: Nova).
import { splitProps, type JSX } from "solid-js";
import { cn } from "../../lib/utils";

export const inputClass =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

export function Input(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return <input data-slot="input" class={cn(inputClass, local.class)} {...rest} />;
}

export function InputGroup(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div
      data-slot="input-group"
      role="group"
      class={cn(
        "group/input-group relative flex h-8 w-full min-w-0 items-center rounded-lg border border-input transition-colors outline-none has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-3 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50 dark:bg-input/30",
        local.class,
      )}
      {...rest}
    />
  );
}

export function InputGroupAddon(props: JSX.HTMLAttributes<HTMLDivElement> & { align?: "inline-start" | "inline-end" }) {
  const [local, rest] = splitProps(props, ["class", "align"]);
  const align = () => local.align ?? "inline-start";
  return (
    <div
      data-slot="input-group-addon"
      data-align={align()}
      class={cn(
        "flex h-auto cursor-text items-center justify-center gap-2 py-1.5 text-sm font-medium text-muted-foreground select-none [&>svg:not([class*='size-'])]:size-4",
        align() === "inline-start" ? "order-first pl-2 has-[>kbd]:ml-[-0.15rem]" : "order-last pr-2 has-[>kbd]:mr-[-0.15rem]",
        local.class,
      )}
      {...rest}
    />
  );
}

export const inputGroupControlClass =
  "h-full flex-1 min-w-0 rounded-none border-0 bg-transparent px-2.5 py-1 text-sm shadow-none outline-none placeholder:text-muted-foreground group-has-[>[data-align=inline-start]]/input-group:pl-1.5 group-has-[>[data-align=inline-end]]/input-group:pr-1.5 [&::-webkit-search-cancel-button]:hidden";
