/**
 * E2E: with two or more splits, the agent's name in each split's 30px title
 * bar stays readable (Issue #3631).
 *
 * #3615 kept the name readable in the lone split's second row; the title bar
 * each split gets from two splits up had no such floor, so in a narrow quarter
 * of the 2x2 grid the selector (`min-w-0 max-w-[12rem]`) was the item that
 * gave way and the name could shrink to "C". Measured here in a real browser,
 * by the label's box width (not by its text, which is whole in the DOM however
 * it is clipped):
 *
 * - 4 splits at 1280x800, sidebar open, Files pinned and History shown, a
 *   long model id on every split (positive — before the fix every name was
 *   drawn 0px wide): each name is drawn at least as wide as its readable width
 *   (or whole, if shorter), nothing spills past the selector's border, and
 *   the search button is still inside the split;
 * - 2 splits at 1280x800, default layout (negative): every name is drawn
 *   whole and no wider — the floor never pads a short name.
 *
 * PC-only surface → self-skip outside chromium, mirroring the split specs.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  E2E_WORKTREE_A,
  ensureFilesActivityVisible,
  seedSideBySideLayout,
  setupSplitTest,
} from './fixtures/terminal-split-helpers';

/** Mirror of TerminalSplitPane's BAR_SESSION_LABEL_MIN_WIDTH (about 7 characters). */
const READABLE_PX = 48;

const TOOLS = ['claude', 'codex', 'gemini', 'opencode'] as const;
const ready = { isRunning: true, isWaitingForResponse: false, isProcessing: false };
/** Long enough that the model chip, not the name, is what has to give way. */
const LONG_MODEL = 'claude-opus-4-1-20250805-extended-context';

/** Serves the worktree with four running instances, each reporting a long model. */
async function mockFourInstances(page: Page): Promise<void> {
  const instances = TOOLS.map((cliTool, i) => ({ id: cliTool, cliTool, order: i }));
  const sessionStatusByInstance = Object.fromEntries(
    instances.map((inst) => [inst.id, { ...ready, model: LONG_MODEL, reasoningEffort: 'high' }]),
  );
  await page.route(
    (url) => url.pathname === `/api/worktrees/${E2E_WORKTREE_A}`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: E2E_WORKTREE_A,
          name: `E2E ${E2E_WORKTREE_A}`,
          path: `/tmp/${E2E_WORKTREE_A}`,
          repositoryPath: `/tmp/${E2E_WORKTREE_A}-repo`,
          repositoryName: 'e2e-repo',
          repositoryDisplayName: 'E2E Repo',
          selectedAgents: [...TOOLS],
          agentInstances: instances,
          cliToolId: 'claude',
          status: 'ready',
          sessionStatusByCli: { claude: ready },
          sessionStatusByInstance,
          gitStatus: {
            currentBranch: 'main',
            initialBranch: 'main',
            isBranchMismatch: false,
            commitHash: 'e2e0000',
            isDirty: false,
          },
        }),
      }),
  );
}

async function openSplits(page: Page, count: 2 | 4, sideBySide: boolean): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('mcbd-sidebar-open', 'true');
    } catch {
      /* non-fatal */
    }
  });
  await setupSplitTest(page, [E2E_WORKTREE_A]);
  // The side-by-side layout (Files pinned beside the body, History shown):
  // what leaves each quarter of the grid narrowest at this width.
  if (sideBySide) await seedSideBySideLayout(page);
  await mockFourInstances(page);
  await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
  await expect(page.getByTestId('terminal-split-container')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sidebar-container')).toBeVisible();
  if (sideBySide) await ensureFilesActivityVisible(page);
  await page.getByTestId(`split-layout-${count}`).click();
  await expect(page.getByTestId(`split-layout-${count}`)).toHaveAttribute('aria-pressed', 'true');
  for (let i = 0; i < count; i++) {
    await expect(page.getByTestId(`split-header-${i}`)).toBeVisible();
    await expect(page.getByTestId(`split-agent-model-${i}`)).toBeVisible();
  }
}

/** The selector in split `i`'s title bar. */
function selectorIn(page: Page, i: number): Locator {
  return page.getByTestId(`split-header-${i}`).getByTestId(`cli-selector-${i}`);
}

/** The name's drawn width, and the width it needs to be whole. */
async function labelWidths(selector: Locator): Promise<{ drawn: number; whole: number }> {
  const label = selector.locator('span.truncate');
  const b = await label.boundingBox();
  expect(b).not.toBeNull();
  const whole = await label.evaluate((el) => el.scrollWidth);
  return { drawn: b!.width, whole };
}

test.describe("Each split's title-bar agent name stays readable (Issue #3631)", () => {
  test.beforeEach(async ({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC-only split surface (chromium only)');
  });

  test('4 splits at 1280x800, sidebar + Files + History open: every name is readable', async ({
    page,
  }, testInfo) => {
    await openSplits(page, 4, true);
    for (let i = 0; i < 4; i++) {
      const selector = selectorIn(page, i);
      await expect(selector).toBeVisible();
      const { drawn, whole } = await labelWidths(selector);
      expect(drawn).toBeGreaterThanOrEqual(Math.min(whole, READABLE_PX) - 0.5);
      // The floor is the selector's, not just the label's: nothing spills past
      // the selector's border onto the control beside it.
      const spill = await selector.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(spill).toBeLessThanOrEqual(0);
      // The right-hand controls are still on screen inside the split.
      const pane = (await page.getByTestId(`terminal-split-pane-${i}`).boundingBox())!;
      const search = (await page.getByTestId(`terminal-search-button-${i}`).boundingBox())!;
      expect(search.x + search.width).toBeLessThanOrEqual(pane.x + pane.width + 0.5);
    }
    await page.screenshot({ path: testInfo.outputPath('four-splits-1280.png') });
  });

  test('2 splits at 1280x800: every name is whole and the selector is not stretched (negative)', async ({
    page,
  }) => {
    await openSplits(page, 2, false);
    for (let i = 0; i < 2; i++) {
      const selector = selectorIn(page, i);
      const { drawn, whole } = await labelWidths(selector);
      expect(whole).toBeGreaterThan(0);
      // Whole, and no wider than the name: a floor must never pad a short name.
      expect(drawn).toBeGreaterThanOrEqual(whole - 0.5);
      expect(drawn).toBeLessThanOrEqual(whole + 0.5);
    }
  });
});
