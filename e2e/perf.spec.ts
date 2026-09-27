// Latency checks for the review loop. Timings are measured inside the page
// (performance.now) and polled every animation frame, so they include render time.
import { expect, test, type Page } from "@playwright/test";

const file = (page: Page, path: string) => page.locator(`[data-testid="tree-file"][data-path="${path}"]`);
const selectedPath = (page: Page) => page.locator(".row.file.selected").getAttribute("data-path");

async function openMainPr(page: Page, query = "") {
  await page.setViewportSize({ width: 1400, height: 1200 });
  await page.goto(`/${query}`);
  await expect(page.getByTestId("picker-item").first()).toContainText("Refactor data table");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("picker")).toBeHidden();
  await expect(page.getByTestId("tree-file")).toHaveCount(28);
}

/** Run `act`, then return ms until each of `conds` (evaluated in the page, in order) holds. */
async function timesUntil(page: Page, act: () => Promise<void>, conds: string[], arg: string): Promise<number[]> {
  const t0 = await page.evaluate(() => performance.now());
  await act();
  const out: number[] = [];
  for (const cond of conds) {
    const handle = await page.waitForFunction(
      ([src, a]) => (new Function("a", `return (${src})`)(a) ? performance.now() : false),
      [cond, arg] as const,
      { polling: "raf", timeout: 10_000 },
    );
    out.push(((await handle.jsonValue()) as number) - t0);
  }
  return out;
}

const timeUntil = async (page: Page, act: () => Promise<void>, cond: string, arg: string) =>
  (await timesUntil(page, act, [cond], arg))[0];

const DIFF_SHOWN = `document.querySelector('.diff-view[data-path="' + a + '"]')`;
const TOKENS_SHOWN = `document.querySelector('.diff-view[data-path="' + a + '"] .dt span[class*="k"]')`;

test("r advances instantly even when GitHub takes 2s to mark the file viewed", async ({ page }) => {
  await openMainPr(page, "?mockViewedDelay=2000");
  await expect(page.locator('.diff-view[data-path="api/routes/orders.py"]')).toBeVisible();
  // Let the prefetch of the next files land (the mock's getFileDiff takes ~30ms).
  await page.waitForTimeout(300);

  const next = "api/routes/users.py";
  const [shown, ticked, highlighted] = await timesUntil(
    page,
    () => page.keyboard.press("r"),
    [
      DIFF_SHOWN,
      `document.querySelector('[data-testid="tree-file"][data-path="api/routes/orders.py"]').classList.contains("viewed")`,
      TOKENS_SHOWN,
    ],
    next,
  );
  console.log(
    `[perf] r -> next diff shown: ${shown.toFixed(1)}ms, checkmark: ${ticked.toFixed(1)}ms, highlighted: ${highlighted.toFixed(1)}ms (setFileViewed delay 2000ms)`,
  );
  // Prefetched diffs are highlighted ahead of time too.
  expect(highlighted).toBeLessThan(150);
  expect(shown).toBeLessThan(100);
  // The checkmark and counter are applied at once, not when the (slow) write resolves.
  expect(ticked).toBeLessThan(100);
  await expect(page.getByTestId("progress")).toContainText("3/28 viewed", { timeout: 100 });

  // Keep going while the first write is still pending.
  for (const path of ["api/__init__.py", "api/legacy_auth.py", "api/models.py"]) {
    const t = await timeUntil(page, () => page.keyboard.press("r"), DIFF_SHOWN, path);
    expect(t).toBeLessThan(100);
  }
  expect(await selectedPath(page)).toBe("api/models.py");
  await expect(page.getByTestId("progress")).toContainText("6/28 viewed", { timeout: 100 });
  // Once the writes land nothing is rolled back.
  await page.waitForTimeout(2200);
  await expect(page.getByTestId("progress")).toContainText("6/28 viewed");
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("first highlight per language is fast (highlighter warmed on PR open)", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1200 });
  await page.goto("/");
  await expect(page.getByTestId("picker-item").first()).toContainText("Refactor data table");
  const [plain, first] = await timesUntil(
    page,
    () => page.keyboard.press("Enter"),
    [DIFF_SHOWN, TOKENS_SHOWN],
    "api/routes/orders.py",
  );
  console.log(`[perf] PR open: first diff (plain) ${plain.toFixed(0)}ms, highlighted ${first.toFixed(0)}ms`);
  // The reviewer reads the first file for a moment before moving on.
  await page.waitForTimeout(1500);

  const timings: Record<string, number> = { "python (PR open)": first };
  for (const [lang, path] of [
    ["tsx", "src/components/Button.tsx"],
    ["typescript", "src/lib/format.ts"],
    ["css", "web/styles.css"],
    ["html", "web/index.html"],
    ["markdown", "README.md"],
  ]) {
    timings[lang] = await timeUntil(page, () => file(page, path).dispatchEvent("click"), TOKENS_SHOWN, path);
  }
  console.log(
    "[perf] first tokens per language: " +
      Object.entries(timings)
        .map(([k, v]) => `${k}=${v.toFixed(0)}ms`)
        .join(", "),
  );
  for (const [lang, t] of Object.entries(timings)) {
    if (lang.startsWith("python")) continue;
    expect(t, `${lang} first highlight`).toBeLessThan(150);
  }
});
