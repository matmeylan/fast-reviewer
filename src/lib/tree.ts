// File tree built from PrDetail.files: nested folders, folders before files,
// natural case-insensitive order, single-child folder chains compacted.
import type { ChangedFile } from "./types";

export interface FileNode {
  kind: "file";
  name: string;
  path: string;
  file: ChangedFile;
}

export interface DirNode {
  kind: "dir";
  /** Display name; compacted chains read "src/lib/utils". */
  name: string;
  /** Full path of the deepest folder in the chain (stable key for collapse state). */
  path: string;
  children: TreeNode[];
  additions: number;
  deletions: number;
  fileCount: number;
}

export type TreeNode = FileNode | DirNode;

export interface Row {
  node: TreeNode;
  depth: number;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Natural, case-insensitive; falls back to code-unit order so the result is deterministic. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function newDir(name: string, path: string): DirNode {
  return { kind: "dir", name, path, children: [], additions: 0, deletions: 0, fileCount: 0 };
}

export function buildTree(files: readonly ChangedFile[]): DirNode {
  const root = newDir("", "");
  const dirs = new Map<string, DirNode>([["", root]]);

  for (const file of files) {
    const parts = file.path.split("/");
    let parent = root;
    let prefix = "";
    parent.additions += file.additions;
    parent.deletions += file.deletions;
    parent.fileCount++;
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      let dir = dirs.get(prefix);
      if (!dir) {
        dir = newDir(parts[i], prefix);
        dirs.set(prefix, dir);
        parent.children.push(dir);
      }
      dir.additions += file.additions;
      dir.deletions += file.deletions;
      dir.fileCount++;
      parent = dir;
    }
    parent.children.push({ kind: "file", name: parts[parts.length - 1], path: file.path, file });
  }

  sortAndCompact(root);
  return root;
}

function sortAndCompact(dir: DirNode): void {
  for (let i = 0; i < dir.children.length; i++) {
    let child = dir.children[i];
    if (child.kind !== "dir") continue;
    while (child.children.length === 1 && child.children[0].kind === "dir") {
      const only: DirNode = child.children[0];
      child = { ...only, name: `${child.name}/${only.name}` };
    }
    dir.children[i] = child;
    sortAndCompact(child);
  }
  dir.children.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : compareNames(a.name, b.name),
  );
}

/** File paths in visual (depth-first) order, ignoring collapse state. */
export function flattenFiles(root: DirNode): string[] {
  const out: string[] = [];
  const walk = (dir: DirNode) => {
    for (const child of dir.children) {
      if (child.kind === "dir") walk(child);
      else out.push(child.path);
    }
  };
  walk(root);
  return out;
}

/** Rows to render: children of collapsed folders are omitted. */
export function visibleRows(root: DirNode, isCollapsed: (dirPath: string) => boolean): Row[] {
  const out: Row[] = [];
  const walk = (dir: DirNode, depth: number) => {
    for (const child of dir.children) {
      out.push({ node: child, depth });
      if (child.kind === "dir" && !isCollapsed(child.path)) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** Case-insensitive path filter; every whitespace-separated token must appear. */
export function filterFiles(files: readonly ChangedFile[], query: string): readonly ChangedFile[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return files;
  return files.filter((f) => {
    const p = f.path.toLowerCase();
    return tokens.every((t) => p.includes(t));
  });
}

/** Folder paths (as used for collapse keys) that contain `filePath`. */
export function isAncestor(dirPath: string, filePath: string): boolean {
  return filePath.startsWith(dirPath + "/");
}
