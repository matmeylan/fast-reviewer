// In-memory mock backend used outside Tauri (browser dev, Playwright).
// OWNER: app-shell agent (fill with realistic fixtures: multi-folder PR, TS/Python/HTML/CSS files, renames, binary, large file).
import type { Backend } from "./api";

export function createMockBackend(): Backend {
  throw new Error("mock backend not implemented");
}
