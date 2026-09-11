/**
 * E2E: the header's repository tab strip (Issue #2374)
 *
 * The jsdom suite proves the wiring; this proves it in a browser, where the
 * three things jsdom approximates all matter at once: a portalled popover that
 * must escape the strip's `overflow-x-auto` clip, real layout (the strip must
 * not wrap at 1366×768 with eight repositories), and a real App Router
 * navigation rather than a mocked `router.push`.
 *
 * The E2E server scans an empty, non-git root (playwright.config.ts), so it has
 * no worktrees of its own; `/api/worktrees` and `/api/sidebar/group-order` are
 * stubbed in the browser. Nothing is written to the server's DB, so the
 * destructive specs running in parallel are unaffected.
 */

import { test, expect, type Page } from '@playwright/test';

/** localStorage key for the desktop sidebar's open state (Issue #2374 Phase 1). */
const SIDEBAR_OPEN_KEY = 'mcbd-sidebar-open';

/** localStorage key for the cached repository order. */
const GROUP_ORDER_CACHE_KEY = 'mcbd-sidebar-group-order-cache';

/**
 * Saved order is the REVERSE of alphabetical, so "the tabs are in the sidebar's
 * order" cannot pass by rendering the default alphabetical grouping.
 */
const SAVED_ORDER = ['zebra-tools', 'alpha-app'];

interface StubWorktree {
  id: string;
  name: string;
  path: string;
  repositoryPath: string;
  repositoryName: string;
  updatedAt: string;
  selectedAgents: string[];
  sessionStatusByCli: Record<string, unknown>;
}

function buildWorktree(
  id: string,
  name: string,
  repositoryName: string
): StubWorktree {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    repositoryPath: `/tmp/${repositoryName}`,
    repositoryName,
    updatedAt: '2026-01-01T00:00:00.000Z',
    selectedAgents: ['claude'],
    sessionStatusByCli: {
      claude: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
    },
  };
}

const WORKTREES: StubWorktree[] = [
  buildWorktree('alpha-main', 'main', 'alpha-app'),
  buildWorktree('alpha-tabs', 'feature/tabs', 'alpha-app'),
  buildWorktree('zebra-main', 'main', 'zebra-tools'),
];

/** Eight repositories, for the "does the band wrap at 1366px?" check. */
const MANY_WORKTREES: StubWorktree[] = Array.from({ length: 8 }, (_, i) =>
  buildWorktree(`repo-${i}-main`, 'main', `repository-number-${i}`)
);

async function stubWorktrees(page: Page, worktrees: StubWorktree[]): Promise<void> {
  // Start collapsed. The sidebar toggle only exists on the worktree-detail
  // ActivityBar, and Phase 1 of this Issue is precisely that the collapsed
  // state survives a load — so seeding it is also the assertion's premise.
  await page.addInitScript(
    ([openKey, cacheKey, order]) => {
      window.localStorage.setItem(openKey as string, 'false');
      window.localStorage.setItem(cacheKey as string, JSON.stringify(order));
    },
    [SIDEBAR_OPEN_KEY, GROUP_ORDER_CACHE_KEY, SAVED_ORDER] as const
  );

  await page.route('**/api/sidebar/group-order', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, order: SAVED_ORDER }),
    })
  );

  await page.route('**/api/worktrees**', (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    if (pathname === '/api/worktrees') {
      return json({ worktrees, repositories: [] });
    }

    const detail = /^\/api\/worktrees\/([^/]+)(\/.*)?$/.exec(pathname);
    if (detail) {
      const id = decodeURIComponent(detail[1]);
      const sub = detail[2] ?? '';
      const wt = worktrees.find((w) => w.id === id);
      if (sub === '') {
        return wt ? json(wt) : route.fulfill({ status: 404, body: '{}' });
      }
      if (sub.startsWith('/current-output')) {
        return json({
          isRunning: false,
          cliToolId: 'claude',
          isGenerating: false,
          isPromptWaiting: false,
          content: '',
          fullOutput: '',
          realtimeSnippet: '',
          thinking: false,
          isSelectionListActive: false,
        });
      }
      if (sub.startsWith('/tree')) return json({ items: [] });
      return json([]);
    }

    return route.continue();
  });
}

/** Repository names in the order the strip paints them. */
async function tabOrder(page: Page): Promise<string[]> {
  return page.getByTestId('repository-tab').evaluateAll((tabs) =>
    tabs.map((tab) => tab.getAttribute('data-repository') ?? '')
  );
}

/** Repository names in the order the sidebar paints its group headers. */
async function sidebarGroupOrder(page: Page): Promise<string[]> {
  return page
    .getByTestId('group-header')
    .evaluateAll((headers) => headers.map((h) => h.textContent?.trim() ?? ''));
}

test.describe('Repository tab bar (Issue #2374)', () => {
  test.beforeEach(async ({ page }) => {
    await stubWorktrees(page, WORKTREES);
  });

  test('appears with the sidebar collapsed and keeps the sidebar order', async ({
    page,
  }) => {
    await page.goto('/');

    const bar = page.getByTestId('repository-tab-bar');
    await expect(bar).toBeVisible();
    await expect(page.getByTestId('repository-tab')).toHaveCount(2);

    expect(await tabOrder(page)).toEqual(SAVED_ORDER);

    // The sidebar is collapsed (translated off-screen) but still rendered, so
    // its group headers are the ground truth the tabs must agree with.
    const groups = await sidebarGroupOrder(page);
    expect(groups[0]).toContain(SAVED_ORDER[0]);
    expect(groups[1]).toContain(SAVED_ORDER[1]);
  });

  test('lists the same branches as the sidebar group, and closes on Escape', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('repository-tab')).toHaveCount(2);

    await page.getByTestId('repository-tab').filter({ hasText: 'alpha-app' }).click();

    const popover = page.getByTestId('repository-tab-popover');
    await expect(popover).toBeVisible();
    await expect(popover).toHaveAttribute('data-repository', 'alpha-app');

    // Rows are compared by their accessible name ("<branch> - <repository>")
    // rather than their text: two repositories both have a `main`, and matching
    // on visible text alone would silently pair the wrong rows.
    const popoverRows = await popover
      .getByTestId('branch-list-item')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('aria-label') ?? ''));
    expect(popoverRows).toEqual(['main - alpha-app', 'feature/tabs - alpha-app']);

    // The sidebar's alpha-app group renders the same rows, in the same order.
    const sidebarRows = await page
      .getByTestId('sidebar-container')
      .getByTestId('branch-list-item')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('aria-label') ?? ''));
    expect(sidebarRows.filter((row) => row.endsWith(' - alpha-app'))).toEqual(popoverRows);

    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
  });

  test('closes on an outside click', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('repository-tab')).toHaveCount(2);

    await page.getByTestId('repository-tab').filter({ hasText: 'alpha-app' }).click();
    await expect(page.getByTestId('repository-tab-popover')).toBeVisible();

    await page.mouse.click(5, 400);
    await expect(page.getByTestId('repository-tab-popover')).toBeHidden();
  });

  test('navigates to the branch when a row is clicked', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('repository-tab')).toHaveCount(2);

    await page.getByTestId('repository-tab').filter({ hasText: 'zebra-tools' }).click();
    const popover = page.getByTestId('repository-tab-popover');
    await expect(popover).toBeVisible();

    await popover.getByTestId('branch-list-item').first().click();

    // Generous timeout: the App Router only commits the URL once the route's
    // payload is ready, and `/worktrees/[id]` compiles on first hit in dev.
    await expect(page).toHaveURL(/\/worktrees\/zebra-main$/, { timeout: 60_000 });
    await expect(page.getByTestId('repository-tab-popover')).toBeHidden();
    // The strip is on the worktree screen too, where the global header is not.
    await expect(page.getByTestId('repository-tab-bar')).toBeVisible();
  });

  test('goes away when the sidebar is open (the default visibility rule)', async ({
    page,
  }) => {
    await page.addInitScript((key) => {
      window.localStorage.setItem(key as string, 'true');
    }, SIDEBAR_OPEN_KEY);

    await page.goto('/');
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('repository-tab-bar')).toHaveCount(0);
  });

  test('does not wrap with eight repositories at 1366x768', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await stubWorktrees(page, MANY_WORKTREES);
    await page.goto('/');

    await expect(page.getByTestId('repository-tab')).toHaveCount(8);

    const strip = page.getByTestId('repository-tab-strip');
    const stripBox = await strip.boundingBox();
    expect(stripBox).not.toBeNull();

    // Every tab shares the strip's row: one line, however many repositories.
    const tops = await page
      .getByTestId('repository-tab')
      .evaluateAll((tabs) => tabs.map((tab) => Math.round(tab.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);

    // ...and every repository is still reachable. Which affordance carries that
    // depends on how wide eight names happen to render, so assert whichever one
    // the layout actually produced rather than pinning a pixel count:
    // either all eight tabs fit inside the strip, or the "…" menu lists them.
    const overflows = await strip.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    if (overflows) {
      await page.getByTestId('repository-tab-overflow').click();
      await expect(page.getByTestId('repository-tab-overflow-item')).toHaveCount(8);
    } else {
      const right = stripBox!.x + stripBox!.width;
      const rightEdges = await page
        .getByTestId('repository-tab')
        .evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().right));
      for (const edge of rightEdges) {
        expect(edge).toBeLessThanOrEqual(right + 1);
      }
    }
  });
});

/** The tab of one repository, by name. */
function tabFor(page: Page, repositoryName: string) {
  return page.locator(
    `[data-testid="repository-tab"][data-repository="${repositoryName}"]`
  );
}

/** Whether a repository's tab lies wholly inside the strip's visible box. */
async function isTabInsideStrip(page: Page, repositoryName: string): Promise<boolean> {
  return page.getByTestId('repository-tab-strip').evaluate((strip, name) => {
    const tab = strip.querySelector(
      `[data-testid="repository-tab"][data-repository="${name}"]`
    );
    if (!tab) return false;
    const box = strip.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    return rect.left >= box.left - 1 && rect.right <= box.right + 1;
  }, repositoryName);
}

async function stripScrollLeft(page: Page): Promise<number> {
  return page.getByTestId('repository-tab-strip').evaluate((el) => el.scrollLeft);
}

/**
 * Issue #2480: the strip scrolls without a scrollbar.
 *
 * macOS draws a classic, always-visible scrollbar while a mouse is connected,
 * and on the 32px band that bar took 15px and squashed every tab into the top
 * half. That cannot show in Playwright's usual browser (see the first test),
 * so it is recreated there and the band is measured under it.
 *
 * A 1024px window makes eight repositories overflow the strip, so every
 * assertion here is about a strip that really scrolls.
 */
test.describe('Repository tab bar without a scrollbar (Issue #2480)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await stubWorktrees(page, MANY_WORKTREES);
  });

  test('keeps the whole band for the tabs where the OS draws a classic scrollbar', async ({
    playwright,
    baseURL,
  }) => {
    // Playwright starts headless Chromium with --hide-scrollbars, under which
    // no scrollbar takes any space and the defect cannot show at all — the
    // test passed with the fix reverted. So this one drives a browser of its
    // own without that flag, and the shared `page` goes unused.
    const browser = await playwright.chromium.launch({
      ignoreDefaultArgs: ['--hide-scrollbars'],
    });
    try {
      const page = await browser.newPage({ baseURL, viewport: { width: 1024, height: 768 } });
      await stubWorktrees(page, MANY_WORKTREES);
      await page.goto('/');
      await expect(page.getByTestId('repository-tab')).toHaveCount(8);

      // Even without the flag, Chromium on macOS draws overlay scrollbars;
      // this rule makes them classic ones that take layout space, and a bare
      // control scroller proves it took effect before the strip is judged.
      await page.addStyleTag({
        content:
          '[data-testid="repository-tab-strip"]::-webkit-scrollbar,' +
          ' #classic-scrollbar-control::-webkit-scrollbar { height: 15px; }',
      });
      const controlBarHeight = await page.evaluate(() => {
        const control = document.createElement('div');
        control.id = 'classic-scrollbar-control';
        control.style.cssText = 'overflow-x: auto; width: 50px';
        control.innerHTML = '<div style="width: 200px; height: 10px"></div>';
        document.body.appendChild(control);
        const barHeight = control.offsetHeight - control.clientHeight;
        control.remove();
        return barHeight;
      });
      expect(controlBarHeight).toBe(15);

      const strip = await page.getByTestId('repository-tab-strip').evaluate((el) => ({
        overflows: el.scrollWidth > el.clientWidth + 1,
        offsetHeight: (el as HTMLElement).offsetHeight,
        clientHeight: el.clientHeight,
      }));
      expect(strip.overflows).toBe(true);
      // No scrollbar eats into the band...
      expect(strip.clientHeight).toBe(strip.offsetHeight);
      // ...so every tab keeps its full height: the 32px band less its 1px
      // bottom border, at the default (medium) display size.
      expect(strip.offsetHeight).toBe(31);
      const tabHeights = await page
        .getByTestId('repository-tab')
        .evaluateAll((tabs) => tabs.map((tab) => Math.round(tab.getBoundingClientRect().height)));
      expect(new Set(tabHeights)).toEqual(new Set([31]));
    } finally {
      await browser.close();
    }
  });

  test('scrolls sideways under a vertical mouse wheel, and still under a trackpad swipe', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('repository-tab')).toHaveCount(8);
    expect(await stripScrollLeft(page)).toBe(0);

    await page.getByTestId('repository-tab-strip').hover();
    await page.mouse.wheel(0, 300);
    await expect.poll(() => stripScrollLeft(page)).toBeGreaterThan(0);

    // A swipe arrives as a horizontal wheel delta, which the browser scrolls
    // on its own; the wheel handler must leave that alone.
    await page.getByTestId('repository-tab-strip').evaluate((el) => {
      el.scrollLeft = 0;
    });
    await page.mouse.wheel(300, 0);
    await expect.poll(() => stripScrollLeft(page)).toBeGreaterThan(0);
  });

  test('reaches a scrolled-out tab through the "…" menu', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('repository-tab')).toHaveCount(8);
    expect(await isTabInsideStrip(page, 'repository-number-7')).toBe(false);

    await page.getByTestId('repository-tab-overflow').click();
    await page
      .locator(
        '[data-testid="repository-tab-overflow-item"][data-repository="repository-number-7"]'
      )
      .click();

    await expect(page.getByTestId('repository-tab-popover')).toHaveAttribute(
      'data-repository',
      'repository-number-7'
    );
    await expect.poll(() => isTabInsideStrip(page, 'repository-number-7')).toBe(true);
  });

  test('shows the current repository on a cold load of a worktree scrolled out of the strip', async ({
    page,
  }) => {
    // `/worktrees/[id]` compiles on first hit in dev.
    test.slow();
    await page.goto('/worktrees/repo-7-main');

    await expect(tabFor(page, 'repository-number-7')).toHaveAttribute('aria-current', 'true', {
      timeout: 60_000,
    });
    await expect.poll(() => isTabInsideStrip(page, 'repository-number-7')).toBe(true);
  });

  test('brings the current repository back into view after a navigation', async ({ page }) => {
    test.slow();
    await page.goto('/worktrees/repo-0-main');
    await expect(tabFor(page, 'repository-number-0')).toHaveAttribute('aria-current', 'true', {
      timeout: 60_000,
    });

    // `/worktrees/[id]` renders its own AppShell, so every navigation below
    // arrives at a freshly mounted strip scrolled to its start.

    // Go to the last repository through the "…" menu and its popover; on
    // arrival its tab is the one in view, which pushes the first tab out...
    await page.getByTestId('repository-tab-overflow').click();
    await page
      .locator(
        '[data-testid="repository-tab-overflow-item"][data-repository="repository-number-7"]'
      )
      .click();
    await page.getByTestId('repository-tab-popover').getByTestId('branch-list-item').first().click();
    await expect(page).toHaveURL(/\/worktrees\/repo-7-main$/, { timeout: 60_000 });
    await expect(tabFor(page, 'repository-number-7')).toHaveAttribute('aria-current', 'true', {
      timeout: 60_000,
    });
    await expect.poll(() => isTabInsideStrip(page, 'repository-number-7')).toBe(true);
    expect(await isTabInsideStrip(page, 'repository-number-0')).toBe(false);

    // ...then back, which must bring the first tab into view again.
    await page.goBack();
    await expect(page).toHaveURL(/\/worktrees\/repo-0-main$/, { timeout: 60_000 });
    await expect(tabFor(page, 'repository-number-0')).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => isTabInsideStrip(page, 'repository-number-0')).toBe(true);
  });
});
