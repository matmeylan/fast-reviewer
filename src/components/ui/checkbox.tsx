// Solid port of shadcn/ui Checkbox (style: Nova) as a native toggle button.
import CheckIcon from "lucide-solid/icons/check";
import { splitProps, type JSX } from "solid-js";
import { cn } from "../../lib/utils";

export const checkboxClass =
  "peer flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground dark:bg-input/30 dark:data-checked:bg-primary";

export function Checkbox(
  props: Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
    checked: boolean;
    onChange?: (checked: boolean) => void;
  },
) {
  const [local, rest] = splitProps(props, ["class", "checked", "onChange", "onClick"]);
  return (
    <button
      type="button"
      role="checkbox"
      data-slot="checkbox"
      aria-checked={local.checked}
      data-state={local.checked ? "checked" : "unchecked"}
      class={cn(checkboxClass, local.class)}
      onClick={(e) => {
        if (typeof local.onClick === "function") local.onClick(e);
        local.onChange?.(!local.checked);
      }}
      {...rest}
    >
      {local.checked && <CheckIcon class="size-3.5" stroke-width={3} />}
    </button>
  );
}
