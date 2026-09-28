// Solid port of shadcn/ui Spinner.
import LoaderCircle from "lucide-solid/icons/loader-circle";
import { cn } from "../../lib/utils";

/** Fades in after 150ms so fast loads never flash a spinner. */
export function Spinner(props: { class?: string }) {
  return (
    <LoaderCircle
      role="status"
      aria-label="Loading"
      class={cn("spinner size-4 animate-spin text-muted-foreground", props.class)}
    />
  );
}
