import { expect, test, type Locator, type Page } from "@playwright/test";

const ORDER = [
  "api/routes/orders.py",
  "api/routes/users.py",
  "api/__init__.py",
  "api/legacy_auth.py",
  "api/models.py",
  "api/server.py",
  "docs/guide.pdf",
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
  "web/assets/icon.svg",
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

test("shows the logo and welcome state until a PR is opened", async ({ page }) => {
  await page.goto("/");
  const welcome = page.getByTestId("welcome");
  await expect(welcome).toContainText("Fast Reviewer");
  // The logo image actually loaded (not a broken image).
  await expect
    .poll(() => welcome.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tree-file").first()).toBeVisible();
  await expect(welcome).toHaveCount(0);
});

test("opens a PR and renders the tree in visual order", async ({ page }) => {
  await openMainPr(page);
  const paths = await page.getByTestId("tree-file").evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));
  expect(paths).toEqual(ORDER);
  await expect(page.locator(".row.dir").first()).toHaveText(/^api\d+ left$/);
  await expect(page.locator('.row.dir[data-path="packages/shared/src"]')).toContainText("packages/shared/src");
  await expect(page.getByTestId("progress")).toContainText("2/30 viewed");
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
  await expect(page.getByTestId("progress")).toContainText("3/30 viewed");

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
  await expect(page.getByTestId("tree-file")).toHaveCount(4);
  await page.keyboard.press("Enter");
  expect(await selectedPath(page)).toBe("web/assets/icon.svg");
  await page.keyboard.press("r");
  await page.keyboard.press("r");
  await page.keyboard.press("r");
  await page.keyboard.press("r");
  await expect(page.getByTestId("all-reviewed")).toBeVisible();
  await expect(page.getByTestId("progress")).toContainText("6/30 viewed");
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

test("added files show unified, and the next file is split again", async ({ page }) => {
  await openMainPr(page);
  const mode = page.getByTestId("mode-toggle");
  await file(page, "api/__init__.py").click();
  await expect(mode.getByText("Unified")).toHaveClass(/on/);
  await expect(page.locator(".diff-view.unified")).toBeVisible();
  await file(page, "api/server.py").click();
  await expect(mode.getByText("Split")).toHaveClass(/on/);
  await expect(page.locator(".diff-view.split")).toBeVisible();
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
  await expect(page.getByTestId("progress")).toContainText("2/30 viewed");
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
  await expect(page.getByTestId("progress")).toContainText("2/30 viewed");
});

test("help overlay", async ({ page }) => {
  await openMainPr(page);
  await page.keyboard.press("?");
  await expect(page.getByTestId("help")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("help")).toBeHidden();
});

type MockReview = { number: number; event: string; body: string };
const mockReviews = (page: Page) =>
  page.evaluate(() => (window as unknown as { __mockReviews: MockReview[] }).__mockReviews);

test("review dialog: Comment needs text; Approve submits to GitHub", async ({ page }) => {
  await openMainPr(page);
  await page.getByTestId("review-button").click();
  const dialog = page.getByTestId("review-dialog");
  await expect(dialog).toContainText("acme/web#482");
  await expect(dialog.getByTestId("review-comment")).toBeDisabled();
  await dialog.getByTestId("review-body").fill("Looks great, thanks!");
  await expect(dialog.getByTestId("review-comment")).toBeEnabled();
  await dialog.getByTestId("review-approve").click();
  await expect(dialog.getByTestId("review-success")).toContainText("Approved");
  await expect(dialog.getByTestId("review-open")).toBeVisible();
  expect(await mockReviews(page)).toMatchObject([{ number: 482, event: "APPROVE", body: "Looks great, thanks!" }]);
  await expect(page.getByTestId("toast")).toContainText("Approved");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Shortcuts work again once the dialog is closed.
  await page.keyboard.press("j");
  expect(await selectedPath(page)).toBe("api/routes/users.py");
});

test("a opens the review dialog; Ctrl+Enter comments", async ({ page }) => {
  await openMainPr(page);
  await page.keyboard.press("a");
  const dialog = page.getByTestId("review-dialog");
  const body = dialog.getByTestId("review-body");
  await expect(body).toBeFocused();
  // The key that opened the dialog is not typed into it.
  await expect(body).toHaveValue("");
  await page.keyboard.type("nit: rename");
  await page.keyboard.press("Control+Enter");
  await expect(dialog.getByTestId("review-success")).toContainText("Review submitted");
  expect(await mockReviews(page)).toMatchObject([{ number: 482, event: "COMMENT", body: "nit: rename" }]);
  await dialog.getByTestId("review-again").click();
  await expect(dialog.getByTestId("review-body")).toHaveValue("");
});

test("a failed review shows GitHub's error and keeps the comment", async ({ page }) => {
  await openMainPr(page, "?mock=failreview");
  await page.keyboard.press("a");
  const dialog = page.getByTestId("review-dialog");
  await dialog.getByTestId("review-body").fill("Ship it");
  await dialog.getByTestId("review-approve").click();
  await expect(dialog.getByTestId("review-error")).toHaveText("GitHub API error 502: Server Error");
  await expect(dialog.getByTestId("review-body")).toHaveValue("Ship it");
  await expect(dialog.getByTestId("review-success")).toHaveCount(0);
  expect(await mockReviews(page)).toEqual([]);
});

test("the 'All files reviewed' screen has the review form", async ({ page }) => {
  await openMainPr(page);
  await page.getByTestId("file-filter").fill("web/");
  await page.keyboard.press("Enter");
  for (let i = 0; i < 4; i++) await page.keyboard.press("r");
  const done = page.getByTestId("all-reviewed");
  await expect(done.getByTestId("review-form")).toBeVisible();
  // Not focused: review shortcuts keep working until the textarea is clicked.
  await expect(done.getByTestId("review-body")).not.toBeFocused();
  await done.getByTestId("review-body").click();
  await page.keyboard.type("jk");
  await expect(done).toBeVisible();
  await done.getByTestId("review-approve").click();
  await expect(done.getByTestId("review-success")).toContainText("Approved");
  expect(await mockReviews(page)).toMatchObject([{ number: 482, event: "APPROVE", body: "jk" }]);
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

test("diff code can be selected and copied, one side at a time", async ({ page }) => {
  await openMainPr(page);
  await file(page, "src/components/Button.tsx").click();
  const view = page.locator('.diff-view[data-path="src/components/Button.tsx"]');
  const newCode = view.locator('.dc[data-side="new"] .dt');
  // Highlighting re-renders the lines when it arrives, which drops a selection: wait for it.
  await expect.poll(() => view.locator(".dt span[class*='k']").count()).toBeGreaterThan(20);
  const a = (await newCode.nth(0).boundingBox())!;
  const b = (await newCode.nth(2).boundingBox())!;
  await page.mouse.move(a.x + 1, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 60, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(view).toHaveAttribute("data-sel", "new");
  expect(await page.evaluate(() => document.getSelection()!.toString())).not.toBe("");

  const copied = await page.evaluate(() => {
    let text = "";
    addEventListener("copy", (e) => (text = (e as ClipboardEvent).clipboardData!.getData("text/plain")), {
      once: true,
    });
    document.execCommand("copy");
    return text;
  });
  const lines = copied.split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe(await newCode.nth(0).textContent());
  expect(lines[1]).toBe(await newCode.nth(1).textContent());
  expect(lines[2].length).toBeGreaterThan(0);
  expect((await newCode.nth(2).textContent())!.startsWith(lines[2])).toBe(true);
});

test("Ctrl+F finds in the diff: Enter steps, Esc closes, a selection prefills", async ({ page }) => {
  await openMainPr(page);
  await file(page, "src/components/Button.tsx").click();
  const view = page.locator('.diff-view[data-path="src/components/Button.tsx"]');
  // Highlighting re-renders the lines when it arrives, which drops a selection: wait for it.
  await expect.poll(() => view.locator(".dt span[class*='k']").count()).toBeGreaterThan(20);

  await page.keyboard.press("Control+f");
  const input = page.getByTestId("find-input");
  const status = page.getByTestId("find-status");
  await expect(input).toBeFocused();
  await input.pressSequentially("variant");
  await expect(status).toHaveText(/^1 of \d+$/);
  const total = Number((await status.textContent())!.split(" of ")[1]);
  expect(total).toBeGreaterThan(3);
  await expect(view.locator(".fc").first()).toHaveText(/variant/i);
  await page.keyboard.press("Enter");
  await expect(status).toHaveText(`2 of ${total}`);
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await expect(status).toHaveText(`${total} of ${total}`);
  // Typing in the bar does not trigger review shortcuts.
  await expect(page.getByTestId("current-path")).toHaveText("src/components/Button.tsx");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("find-bar")).toBeHidden();
  await expect(view.locator(".fm")).toHaveCount(0);

  // Selecting the second "splitProps" and pressing Ctrl+F finds that occurrence.
  const second = view.locator('.dc[data-side="new"] .dt', { hasText: "splitProps(" }).getByText("splitProps");
  await second.dblclick();
  expect(await page.evaluate(() => document.getSelection()!.toString())).toBe("splitProps");
  await page.keyboard.press("Control+f");
  await expect(input).toHaveValue("splitProps");
  await expect(status).toHaveText("2 of 2");
  await expect(view.locator(".fc")).toHaveText("splitProps");
  await expect(view.locator(".dt", { has: page.locator(".fc") })).toContainText("splitProps(props");
});

/** Every <img> in `scope` has decoded (naturalWidth > 0); returns their natural sizes. */
const loadedImages = (scope: Locator) =>
  scope.locator("img").evaluateAll((imgs: HTMLImageElement[]) =>
    imgs.map((i) => (i.complete && i.naturalWidth > 0 ? `${i.naturalWidth}x${i.naturalHeight}` : "not loaded")),
  );

test("images show before and after", async ({ page }) => {
  await openMainPr(page);
  await file(page, "web/assets/logo.png").click();
  const view = page.locator('[data-testid="image-diff"][data-path="web/assets/logo.png"]');
  await expect(view).toBeVisible();
  await expect(view.getByTestId("image-side")).toHaveCount(2);
  await expect.poll(() => loadedImages(view)).toEqual(["64x64", "96x64"]);
  await expect(view.getByTestId("image-meta").nth(1)).toContainText("96 × 64");
  // Unified stacks the same two images.
  await page.keyboard.press("v");
  await expect.poll(() => loadedImages(view)).toEqual(["64x64", "96x64"]);
});

test("SVGs show as images, with their source a toggle away", async ({ page }) => {
  await openMainPr(page);
  await file(page, "web/assets/icon.svg").click();
  const image = page.locator('[data-testid="image-diff"][data-path="web/assets/icon.svg"]');
  await expect.poll(() => loadedImages(image)).toEqual(["64x64", "64x64"]);
  const toggle = page.getByTestId("svg-toggle");
  await expect(toggle.getByText("Image")).toHaveClass(/on/);

  await toggle.getByText("Source").click();
  await expect(image).toHaveCount(0);
  const source = page.locator('.diff-view[data-path="web/assets/icon.svg"]');
  await expect(source.locator(".dc.del .dt", { hasText: "<circle" })).toHaveCount(1);
  await expect(source.locator(".dc.add .dt", { hasText: "<rect" })).toHaveCount(1);

  await toggle.getByText("Image").click();
  await expect.poll(() => loadedImages(image)).toEqual(["64x64", "64x64"]);
});

test("files the app can't show open in their default app", async ({ page }) => {
  await openMainPr(page);
  await file(page, "docs/guide.pdf").click();
  const view = page.locator('.diff-view[data-path="docs/guide.pdf"]');
  await expect(view).toContainText("Binary file not shown");
  // Added file: one button, for the new version.
  await expect(view.getByTestId("open-file")).toHaveCount(1);
  await view.getByRole("button", { name: "Open with default app" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as { __mockOpenedFiles?: unknown[] }).__mockOpenedFiles))
    .toEqual([{ owner: "acme", repo: "web", number: 482, path: "docs/guide.pdf", side: "new" }]);
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("line comments: read threads, write drafts, send them with the review", async ({ page }) => {
  await openMainPr(page);
  // The mock's orders.py has an open thread on an added line and a resolved one on a removed line.
  const popover = page.getByTestId("comment-popover");
  const marked = page.locator('.ln[data-cmt][data-side="new"]');
  await expect(marked).toHaveCount(1);
  await expect(page.locator('.ln[data-cmt][data-side="old"]')).toHaveCount(1);
  await marked.click();
  await expect(popover.getByTestId("comment-thread")).toHaveCount(1);
  await expect(popover).toContainText("Should this validate the page size?");
  await expect(popover).toContainText("I'll cap it at 100");
  await expect(popover.getByTestId("comment-body")).toHaveCount(0);
  // Clicking the open line again closes it.
  await marked.click();
  await expect(popover).toBeHidden();

  // A changed line without comments opens straight into a focused comment box.
  const line = page.locator('.ln.cm:not([data-cmt])[data-side="new"]').first();
  const lineNo = Number(await line.textContent());
  await line.click();
  await expect(popover.getByTestId("comment-body")).toBeFocused();
  // Typing in it doesn't trigger shortcuts.
  await page.keyboard.type("nit: rename j");
  await page.keyboard.press("Control+Enter");
  await expect(popover.getByTestId("comment-draft")).toContainText("nit: rename j");
  expect(await selectedPath(page)).toBe("api/routes/orders.py");
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(page.locator(`.ln[data-side="new"][data-cmt="1"]`, { hasText: new RegExp(`^${lineNo}$`) })).toHaveCount(1);

  // Drafts survive a restart.
  await page.reload();
  await expect(page.getByTestId("current-path")).toHaveText("api/routes/orders.py");
  await expect(page.locator('.ln[data-cmt][data-side="new"]')).toHaveCount(2);

  // A review of line comments alone needs no body.
  await page.keyboard.press("a");
  const dialog = page.getByTestId("review-dialog");
  await expect(dialog.getByTestId("review-pending")).toHaveText("1 line comment will be sent with this review.");
  await expect(dialog.getByTestId("review-comment")).toBeEnabled();
  await dialog.getByTestId("review-comment").click();
  await expect(dialog.getByTestId("review-success")).toContainText("Review submitted");
  expect(await mockReviews(page)).toMatchObject([
    { event: "COMMENT", body: "", comments: [{ path: "api/routes/orders.py", side: "new", line: lineNo, body: "nit: rename j" }] },
  ]);
  await page.keyboard.press("Escape");
  // The draft is now a thread on GitHub.
  await page.locator(`.ln[data-side="new"][data-cmt="1"]`, { hasText: new RegExp(`^${lineNo}$`) }).click();
  await expect(popover.getByTestId("comment-thread")).toContainText("nit: rename j");
  await expect(popover.getByTestId("comment-draft")).toHaveCount(0);
});

test("closing a comment box keeps the text as a draft; drafts can be edited and deleted", async ({ page }) => {
  await openMainPr(page);
  const popover = page.getByTestId("comment-popover");
  const first = page.locator('.ln.cm:not([data-cmt])[data-side="old"]').first();
  const lineNo = await first.textContent();
  const line = page.locator('.ln.cm[data-side="old"]', { hasText: new RegExp(`^${lineNo}$`) });
  await line.click();
  await page.keyboard.type("Why remove this?");
  // A click elsewhere closes it, keeping the text.
  await page.getByTestId("current-path").click();
  await expect(popover).toBeHidden();
  await expect(line).toHaveAttribute("data-cmt", "1");
  await line.click();
  await expect(popover.getByTestId("comment-draft")).toContainText("Why remove this?");
  await popover.getByRole("button", { name: "Edit draft" }).click();
  await popover.getByTestId("draft-edit").fill("Why was this removed?");
  await popover.getByTestId("draft-save").click();
  await expect(popover.getByTestId("comment-draft")).toContainText("Why was this removed?");
  await popover.getByTestId("draft-delete").click();
  await expect(popover.getByTestId("comment-draft")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(line).not.toHaveAttribute("data-cmt");
});
