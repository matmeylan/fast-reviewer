import { expect, test, type Page } from "@playwright/test";

const ORDER = [
  "api/routes/orders.py",
  "api/routes/users.py",
  "api/__init__.py",
  "api/legacy_auth.py",
  "api/models.py",
  "api/server.py",
  "docs/step2-setup.md",
  "docs/step10-deploy.md",
  "packages/shared/src/index.ts",
  "src/components/forms/Input.tsx",
  "src/components/forms/Select.tsx",
  "src/components/Table/Table.tsx",
  "src/components/Table/TableRow.tsx",
  "src/components/Button.tsx",
  "src/components/Modal.tsx",
  "src/components/Sidebar.tsx",
  "src/generated/schema.ts",
  "src/lib/hooks/useFetch.ts",
  "src/lib/utils/debounce.ts",
  "src/lib/utils/strings.ts",
  "src/lib/api.ts",
  "src/lib/format.ts",
  "tests/test_orders.py",
  "web/assets/logo.png",
  "web/index.html",
  "web/styles.css",
  "package.json",
  "README.md",
];

const file = (page: Page, path: string) => page.locator(`[data-testid="tree-file"][data-path="${path}"]`);
const selectedPath = (page: Page) => page.locator(".row.file.selected").getAttribute("data-path");

async function openMainPr(page: Page, query = "") {
  await page.setViewportSize({ width: 1400, height: 1200 });
  await page.goto(`/${query}`);
  await expect(page.getByTestId("picker")).toBeVisible();
  await expect(page.getByTestId("picker-item").first()).toContainText("Refactor data table");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("picker")).toBeHidden();
  await expect(page.getByTestId("tree-file")).toHaveCount(ORDER.length);
}

test("opens a PR and renders the tree in visual order", async ({ page }) => {
  await openMainPr(page);
  const paths = await page.getByTestId("tree-file").evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));
  expect(paths).toEqual(ORDER);
  await expect(page.locator(".row.dir").first()).toHaveText(/^api\d+ left$/);
  await expect(page.locator('.row.dir[data-path="packages/shared/src"]')).toContainText("packages/shared/src");
  await expect(page.getByTestId("progress")).toContainText("2/28 viewed");
  await expect(file(page, "src/components/Table/Table.tsx")).toHaveAttribute("data-status", "renamed");
  await expect(file(page, "api/legacy_auth.py")).toHaveAttribute("data-status", "removed");
  // First unviewed file is selected and its diff shown.
  expect(await selectedPath(page)).toBe("api/routes/orders.py");
  await expect(page.getByTestId("current-path")).toHaveText("api/routes/orders.py");
  await expect(page.locator(".diff-host")).not.toBeEmpty();
});

test("r marks viewed and advances; s skips; j/k navigate", async ({ page }) => {
  await openMainPr(page);
  await page.keyboard.press("r");
  await expect(file(page, "api/routes/orders.py")).toHaveClass(/viewed/);
  expect(await selectedPath(page)).toBe("api/routes/users.py");
  await expect(page.getByTestId("progress")).toContainText("3/28 viewed");

  await page.keyboard.press("s");
  expect(await selectedPath(page)).toBe("api/__init__.py");
  await expect(file(page, "api/routes/users.py")).not.toHaveClass(/viewed/);

  await page.keyboard.press("k");
  expect(await selectedPath(page)).toBe("api/routes/users.py");
  await page.keyboard.press("j");
  await page.keyboard.press("ArrowDown");
  expect(await selectedPath(page)).toBe("api/legacy_auth.py");

  await page.keyboard.press("u");
  await expect(file(page, "api/legacy_auth.py")).toHaveClass(/viewed/);
  await page.keyboard.press("u");
  await expect(file(page, "api/legacy_auth.py")).not.toHaveClass(/viewed/);

  await file(page, "web/index.html").click();
  await expect(page.getByTestId("current-path")).toHaveText("web/index.html");
});

test("reviewing the last unviewed file shows 'All files reviewed'", async ({ page }) => {
  await openMainPr(page);
  await page.getByTestId("file-filter").fill("web/");
  await expect(page.getByTestId("tree-file")).toHaveCount(3);
  await page.keyboard.press("Enter");
  expect(await selectedPath(page)).toBe("web/assets/logo.png");
  await page.keyboard.press("r");
  await page.keyboard.press("r");
  await page.keyboard.press("r");
  await expect(page.getByTestId("all-reviewed")).toBeVisible();
  await expect(page.getByTestId("progress")).toContainText("5/28 viewed");
});

test("v toggles split/unified and persists", async ({ page }) => {
  await openMainPr(page);
  const unified = page.getByTestId("mode-toggle").getByText("Unified");
  await expect(unified).not.toHaveClass(/on/);
  await page.keyboard.press("v");
  await expect(unified).toHaveClass(/on/);
  await page.reload();
  // Last PR reopens and the mode is remembered.
  await expect(page.getByTestId("tree-file")).toHaveCount(ORDER.length);
  await expect(page.getByTestId("mode-toggle").getByText("Unified")).toHaveClass(/on/);
  await page.keyboard.press("v");
  await expect(page.getByTestId("mode-toggle").getByText("Split")).toHaveClass(/on/);
});

test("Cmd/Ctrl+K opens the picker; accepts pasted URLs; esc closes", async ({ page }) => {
  await openMainPr(page);
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("picker")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("picker")).toBeHidden();

  await page.keyboard.press("Control+k");
  await page.getByTestId("picker-input").fill("https://github.com/acme/api/pull/91");
  await expect(page.getByTestId("picker-item").first()).toContainText("Open acme/api#91");
  await page.keyboard.press("Enter");
  await expect(page.locator(".pr-title")).toHaveText("Fix pagination off-by-one in orders endpoint");
});

test("picker: fuzzy filter and repo browsing", async ({ page }) => {
  await openMainPr(page);
  await page.keyboard.press("Control+k");
  const input = page.getByTestId("picker-input");
  await input.fill("dotfiles");
  await expect(page.getByTestId("picker-item").first()).toContainText("Add zsh aliases");
  await expect(page.locator(".picker-section", { hasText: "Repositories" })).toBeVisible();
  await page.getByTestId("picker-item").filter({ hasText: "octocat/dotfiles" }).filter({ hasText: "My shell setup" }).click();
  await expect(page.locator(".crumb")).toHaveText("octocat/dotfiles");
  await expect(page.getByTestId("picker-item").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".crumb")).toBeHidden();
});

test("file filter with '/' shortcut", async ({ page }) => {
  await openMainPr(page);
  await page.keyboard.press("/");
  await expect(page.getByTestId("file-filter")).toBeFocused();
  await page.keyboard.type("tsx");
  await expect(page.getByTestId("tree-file")).toHaveCount(7);
  // Typing in the filter must not trigger shortcuts.
  await page.keyboard.type("r");
  await expect(page.getByTestId("progress")).toContainText("2/28 viewed");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tree-file")).toHaveCount(ORDER.length);
});

test("folders collapse and expand", async ({ page }) => {
  await openMainPr(page);
  await page.locator('.row.dir[data-path="src"]').click();
  await expect(page.getByTestId("tree-file")).toHaveCount(ORDER.length - 13);
  await page.locator('.row.dir[data-path="src"]').click();
  await expect(page.getByTestId("tree-file")).toHaveCount(ORDER.length);
});

test("folders count the files left to review", async ({ page }) => {
  await openMainPr(page);
  const routes = page.locator('.row.dir[data-path="api/routes"]');
  await expect(routes).toHaveText(/^routes2 left$/);
  await page.keyboard.press("r");
  await expect(routes).toHaveText(/^routes1 left$/);
  await page.keyboard.press("r");
  await expect(routes.getByLabel("All reviewed")).toBeVisible();
  await expect(page.locator('.row.dir[data-path="api"]')).toHaveText(/^api4 left$/);
});

test("flat list keeps the review order, shows folders and is remembered", async ({ page }) => {
  await openMainPr(page);
  await page.getByTestId("tree-view-toggle").click();
  await expect(page.locator(".row.dir")).toHaveCount(0);
  const paths = await page.getByTestId("tree-file").evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));
  expect(paths).toEqual(ORDER);
  await expect(file(page, "src/components/Button.tsx")).toContainText("src/components");
  await page.reload();
  await expect(page.getByTestId("tree-file").first()).toBeVisible();
  await expect(page.locator(".row.dir")).toHaveCount(0);
  await page.getByTestId("tree-view-toggle").click();
  await expect(page.locator(".row.dir").first()).toBeVisible();
});

test("filter matches are highlighted", async ({ page }) => {
  await openMainPr(page);
  await page.getByTestId("file-filter").fill("table");
  await expect(file(page, "src/components/Table/TableRow.tsx").locator("mark")).toHaveText("Table");
});

test("failed viewed sync rolls back with a toast", async ({ page }) => {
  await openMainPr(page, "?mock=failviewed");
  await page.keyboard.press("r");
  await expect(page.getByTestId("toast")).toContainText("Couldn't mark orders.py as viewed");
  await expect(file(page, "api/routes/orders.py")).not.toHaveClass(/viewed/);
  await expect(page.getByTestId("progress")).toContainText("2/28 viewed");
});

test("help overlay", async ({ page }) => {
  await openMainPr(page);
  await page.keyboard.press("?");
  await expect(page.getByTestId("help")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("help")).toBeHidden();
});

test("sign in when unauthenticated", async ({ page }) => {
  await page.goto("/?mock=unauth");
  await expect(page.getByTestId("auth")).toBeVisible();
  await page.getByTestId("token-input").fill("ghp_example_token");
  await page.getByRole("button", { name: "Save token" }).click();
  await expect(page.getByTestId("picker")).toBeVisible();
});

test("2400-file PR stays virtualized and navigable", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.getByTestId("picker-input").fill("monorepo");
  await expect(page.getByTestId("picker-item").first()).toContainText("bump versions");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("progress")).toContainText("0/2400 viewed");
  expect(await page.getByTestId("tree-file").count()).toBeLessThan(120);
  const first = await selectedPath(page);
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) await page.keyboard.press("r");
  await expect(page.getByTestId("progress")).toContainText("20/2400 viewed");
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(await selectedPath(page)).not.toBe(first);
});

test("diff shows syntax colors and intra-line highlights", async ({ page }) => {
  await openMainPr(page);
  await file(page, "src/components/Button.tsx").click();
  const view = page.locator('.diff-view[data-path="src/components/Button.tsx"]');
  await expect(view).toBeVisible();
  // Shiki token spans arrive from the worker; changed-character marks come with the diff.
  await expect.poll(() => view.locator(".dt span[class*='k']").count()).toBeGreaterThan(20);
  expect(await view.locator(".dc.del .dt span.x").count()).toBeGreaterThan(0);
  expect(await view.locator(".dc.add .dt span.x").count()).toBeGreaterThan(0);
  const colors = await view.locator(".dt span[class*='k']").evaluateAll(
    (els) => new Set(els.map((e) => getComputedStyle(e).color)).size,
  );
  expect(colors).toBeGreaterThan(3);
});
