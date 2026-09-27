import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://localhost:1420" },
  webServer: { command: "pnpm dev", port: 1420, reuseExistingServer: true },
});
