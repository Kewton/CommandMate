/**
 * E2E: the Antigravity usage notice in a narrow split pane (Issue #4456 item 4,
 * re-instruction 1, I5').
 *
 * In the three-way split the composer's notice (shown before an antigravity
 * instance's first launch, until it is closed) wrapped into a tall block above
 * the input box and pushed the box below the pane's clipped edge. Measured in
 * Chromium, the way `composer-two-row-2598.spec.ts` checks that the send button
 * stays in the pane:
 *
 * - the textarea and the send button are inside the pane, in the 218px pane of
 *   the three-way split, at the Issue's 1440x900 and in a lower window;
 * - the terms / FAQ links are reached with Tab (they sit beside Close, outside
 *   the scrolling body) and are inside the pane;
 * - the scrolling body takes focus and scrolls from the keyboard.
 *
 * Fake tools only: `/api/` is mocked in the browser (the #2598 fixture), and
 * the antigravity instance reads as not running, which is when the notice
 * shows. The notice's "closed" record is per browser context, so it starts
 * unread.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import {
  E2E_COMPOSER_WORKTREE,
  mockComposerApi,
  seedComposerSplits,
} from './fixtures/composer-height-helpers';
import { mockStartPreview } from './fixtures/start-preview-helpers';

/** The three-way split of the #2598 table; antigravity in the 218px pane. */
const WIDTHS = [218, 455, 272] as const;
const TOOLS = ['antigravity', 'codex', 'copilot'] as const;
const NOTICE = 'antigravity-usage-notice';

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'chromium', 'PC-only split UI (chromium only)');
});

/**
 * The detail of the #2598 worktree (mirror of the fixture's `buildWorktree`),
 * with the antigravity instance not running. The fixture's builder is private,
 * and `route.fetch()` would go to the server, not to the earlier mock.
 */
function worktreeDetail(): Record<string, unknown> {
  const tools = ['claude', 'codex', 'copilot', 'antigravity', 'opencode'];
  return {
    id: E2E_COMPOSER_WORKTREE,
    name: `E2E ${E2E_COMPOSER_WORKTREE}`,
    path: `/tmp/${E2E_COMPOSER_WORKTREE}`,
    repositoryPath: `/tmp/${E2E_COMPOSER_WORKTREE}-repo`,
    repositoryName: 'e2e-repo',
    repositoryDisplayName: 'E2E Repo',
    description: 'E2E composer worktree',
    selectedAgents: tools,
    agentInstances: tools.map((cliTool, order) => ({ id: cliTool, cliTool, alias: cliTool, order })),
    cliToolId: tools[0],
    status: 'ready',
    sessionStatusByCli: Object.fromEntries(
      tools.map(cliTool => [
        cliTool,
        { isRunning: cliTool !== 'antigravity', isWaitingForResponse: false, isProcessing: false },
      ]),
    ),
    gitStatus: {
      currentBranch: 'main',
      initialBranch: 'main',
      isBranchMismatch: false,
      commitHash: 'e2e0000',
      isDirty: false,
    },
  };
}

/** antigravity has not been launched: the detail and its pane's poll say not running. */
async function antigravityNotRunning(page: Page): Promise<void> {
  // Registered after mockComposerApi, so it is asked first; anything else falls back.
  await page.route(
    url => url.pathname.startsWith('/api/worktrees/'),
    async (route: Route) => {
      const url = new URL(route.request().url());
      const detail = url.pathname.match(/\/api\/worktrees\/([^/]+)(\/.*)?$/);
      if (!detail) return route.fallback();
      const sub = detail[2] ?? '';
      if (sub.startsWith('/current-output') && url.searchParams.get('cliTool') === 'antigravity') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            isRunning: false,
            cliToolId: 'antigravity',
            sessionStatus: 'idle',
            content: '',
            fullOutput: '',
            realtimeSnippet: '',
            isGenerating: false,
            isPromptWaiting: false,
            thinking: false,
          }),
        });
      }
      if (sub === '' && decodeURIComponent(detail[1]) === E2E_COMPOSER_WORKTREE) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(worktreeDetail()) });
      }
      return route.fallback();
    },
  );
}

async function openWithNotice(page: Page): Promise<void> {
  await seedComposerSplits(page, WIDTHS, TOOLS);
  await mockComposerApi(page);
  await antigravityNotRunning(page);
  // #4227: this file mocks the worktree API itself, so it answers the start preview too.
  await mockStartPreview(page);
  await page.goto(`/worktrees/${E2E_COMPOSER_WORKTREE}`);
  await page.getByTestId('terminal-split-container').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('terminal-split-pane-0').getByTestId(NOTICE).waitFor({ state: 'visible', timeout: 30_000 });
}

type Rect = { x: number; y: number; width: number; height: number };

function inside(outer: Rect, inner: Rect, slack = 0.5): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1440, height: 640 },
] as const) {
  test.describe(`[#4456] the notice in the 218px pane of three splits (${viewport.width}x${viewport.height})`, () => {
    test.use({ viewport: { ...viewport } });

    test('the input box and the send button stay inside the pane (4456)', async ({ page }) => {
      await openWithNotice(page);
      const pane = page.getByTestId('terminal-split-pane-0');
      const paneBox = (await pane.boundingBox())!;
      const notice = (await pane.getByTestId(NOTICE).boundingBox())!;
      const textarea = (await pane.getByTestId('message-input-textarea').boundingBox())!;
      const send = (await pane.getByTestId('send-message-button').boundingBox())!;
      // eslint-disable-next-line no-console -- the measurement is the deliverable
      console.log('MEASURE-4456 ' + JSON.stringify({ viewport, pane: paneBox, notice, textarea, send }));
      expect(paneBox.width).toBeLessThan(260);
      expect(inside(paneBox, textarea)).toBe(true);
      expect(inside(paneBox, send)).toBe(true);
      expect(textarea.height).toBeGreaterThan(0);
      // The notice is above the input box, not over it.
      expect(notice.y + notice.height).toBeLessThanOrEqual(textarea.y + 0.5);
    });

    test('the terms and FAQ links are reached with Tab and are in the pane (4456)', async ({ page }) => {
      await openWithNotice(page);
      const pane = page.getByTestId('terminal-split-pane-0');
      const paneBox = (await pane.boundingBox())!;
      const body = pane.getByTestId(`${NOTICE}-body`);
      await body.focus();
      await expect(body).toBeFocused();
      await page.keyboard.press('Tab');
      const terms = pane.getByTestId(NOTICE).getByRole('link').nth(0);
      await expect(terms).toBeFocused();
      expect(inside(paneBox, (await terms.boundingBox())!)).toBe(true);
      await page.keyboard.press('Tab');
      const faq = pane.getByTestId(NOTICE).getByRole('link').nth(1);
      await expect(faq).toBeFocused();
      expect(inside(paneBox, (await faq.boundingBox())!)).toBe(true);
    });

    test('the body scrolls from the keyboard (4456)', async ({ page }) => {
      await openWithNotice(page);
      const body = page.getByTestId('terminal-split-pane-0').getByTestId(`${NOTICE}-body`);
      const overflow = await body.evaluate(el => el.scrollHeight - el.clientHeight);
      expect(overflow).toBeGreaterThan(0);
      await body.focus();
      await page.keyboard.press('End');
      await expect.poll(() => body.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      await page.keyboard.press('Home');
      await expect.poll(() => body.evaluate(el => el.scrollTop)).toBe(0);
    });
  });
}
