// OWNER: diff-view agent. Contract used by the app shell:
import type { FileDiff } from "../lib/types";

export type DiffMode = "split" | "unified";

export interface DiffViewProps {
  diff: FileDiff;
  mode: DiffMode;
  /** Incremented by the shell to request scrolling to next (+1) / previous (-1) hunk. */
  hunkNav?: { dir: 1 | -1; seq: number };
}

export default function DiffView(props: DiffViewProps) {
  return <div class="diff-view">{props.diff.path}</div>;
}
