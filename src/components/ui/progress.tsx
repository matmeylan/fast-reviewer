// Solid port of shadcn/ui Progress (style: Nova).
import { cn } from "../../lib/utils";

export function Progress(props: { value: number; class?: string; indicatorClass?: string }) {
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(props.value)}
      class={cn("relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted", props.class)}
    >
      <div
        data-slot="progress-indicator"
        class={cn("size-full flex-1 bg-primary transition-all duration-200 ease-out", props.indicatorClass)}
        style={{ transform: `translateX(-${100 - (props.value || 0)}%)` }}
      />
    </div>
  );
}
