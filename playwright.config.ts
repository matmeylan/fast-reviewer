import { defineConfig } from "@playwright/test";

// Node global, declared here so the app tsconfig stays free of Node types.
declare const process: { env: Record<string, string | undefined> };

// E2E runs against the production bundle (what Tauri ships). The Vite dev server
// re-optimizes dependencies on a cold cache and force-reloads pages mid-test.
export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://localhost:1421" },
  webServer: {
    command: "pnpm exec vite build && pnpm exec vite preview --port 1421 --strictPort",
    port: 1421,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
