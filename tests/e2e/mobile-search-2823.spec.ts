/**
 * E2E: searching on the phone (Issue #2823).
 *
 * Before the fix the chat surface had no working search entry, and both search
 * bars opened at `top-2` under the surface pill (`z-30`), hiding "next" and
 * "close". At #2106's two phone viewports, with and without the session row
 * (which moves the pill from `top-2` to `top-9`), this asserts that the sheet
 * row opens the right bar with its input focused (also when already open),
 * that every control (input, count, prev, next, close) is on top at its centre,
 * that the bar starts >= 4px below the pill, and that nothing scrolls sideways.
 * On the PC split, `chat-search-open` opens nothing. Labels are matched in both
 * locales; controls are found by structure.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  E2E_OPENCODE_WORKTREE,
  PHONE_VIEWPORTS,
  mockOpencodeWorktreeApi,
  seedOpencodeActiveInstance,
} from './fixtures/opencode-mobile-helpers';
import {
  DESKTOP_SPLIT_TOOLS,
  E2E_DESKTOP_OPENCODE_WORKTREE,
  mockDesktopOpencodeApi,
  seedDesktopOpencodeSplits,
} from './fixtures/opencode-desktop-helpers';

const TERMINAL_BAR = '[data-testid="mobile-terminal-region"] [role="search"]';
const CHAT_BAR = '[data-testid="chat-transcript"] [role="search"]';
const TERMINAL_LABEL = /ターミナル内を検索|Search terminal/;
const CHAT_LABEL = /この会話を検索|Search this conversation/;
const MIN_GAP_PX = 4;

interface BarReport {
  covered: string[];
  focused: boolean;
  gap: number;
  right: number;
}

/** Hit-test every control of the bar, and measure it against the pill. */
function measureBar(page: Page, selector: string): Promise<BarReport> {
  return page.evaluate((sel) => {
    const bar = document.querySelector(sel);
    const pill = document.querySelector('[data-testid="mobile-surface-mode-toggle"]');
    if (!bar || !pill) throw new Error(`missing ${bar ? 'pill' : sel}`);
    const controls: Array<[string, Element | null]> = [
      ['input', bar.querySelector('input')],
      ['count', bar.querySelector('[role="status"]')],
      ...Array.from(bar.querySelectorAll('button')).map(
        (b, i) => [['prev', 'next', 'close'][i] ?? `button${i}`, b] as [string, Element],
      ),
    ];
    const covered = controls
      .filter(([, el]) => {
        if (!el) return true;
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !(hit && (hit === el || el.contains(hit)));
      })
      .map(([name]) => name);
    const barRect = bar.getBoundingClientRect();
    return {
      covered: controls.length === 5 ? covered : [...covered, `controls=${controls.length}`],
      focused: document.activeElement === bar.querySelector('input'),
      gap: barRect.top - pill.getBoundingClientRect().bottom,
      right: barRect.right,
    };
  }, selector);
}

function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth ||
      document.body.scrollWidth > document.body.clientWidth,
  );
}

async function openSheetRow(page: Page) {
  await page.getByTestId('mobile-more-actions-button').click();
  const row = page.getByTestId('actions-sheet-search');
  await expect(row).toBeVisible();
  return row;
}

async function expectBarClear(page: Page, selector: string, width: number, label: string) {
  await expect(page.locator(selector)).toBeVisible();
  const report = await measureBar(page, selector);
  // eslint-disable-next-line no-console -- the measurement is the deliverable
  console.log(`MEASURE-2823 ${label} ${JSON.stringify(report)}`);
  expect(report.covered).toEqual([]);
  expect(report.focused).toBe(true);
  expect(report.gap).toBeGreaterThanOrEqual(MIN_GAP_PX);
  expect(report.right).toBeLessThanOrEqual(width);
  expect(await hasHorizontalScroll(page)).toBe(false);
}

/** The worktree list with a model on the instance, which draws the session row. */
async function serveSessionRow(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/worktrees',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repositories: [],
          worktrees: [
            {
              id: E2E_OPENCODE_WORKTREE,
              name: `E2E ${E2E_OPENCODE_WORKTREE}`,
              path: `/tmp/${E2E_OPENCODE_WORKTREE}`,
              repositoryPath: `/tmp/${E2E_OPENCODE_WORKTREE}-repo`,
              repositoryName: 'e2e-repo',
              cliToolId: 'opencode',
              selectedAgents: ['opencode'],
              agentInstances: [{ id: 'opencode', cliTool: 'opencode', alias: 'opencode', order: 0 }],
              sessionStatusByInstance: { opencode: { isRunning: true, model: 'gpt-5.5' } },
            },
          ],
        }),
      }),
  );
}

test.describe('Issue #2823: search on the phone', () => {
  for (const sessionRow of [false, true]) {
    for (const vp of PHONE_VIEWPORTS) {
      const label = `${vp.label}${sessionRow ? ' with session row' : ''}`;
      test(`both bars open clear of the pill at ${label}`, async ({ page }) => {
        await seedOpencodeActiveInstance(page);
        await mockOpencodeWorktreeApi(page);
        if (sessionRow) await serveSessionRow(page);
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(`/worktrees/${E2E_OPENCODE_WORKTREE}?pane=terminal`);
        await page.waitForSelector('[data-testid="mobile-terminal-region"]', { timeout: 30_000 });
        await expect(page.getByTestId('mobile-session-row')).toHaveCount(sessionRow ? 1 : 0, { timeout: 15_000 });

        // --- terminal surface: unchanged row, bar below the pill ----------------
        const terminalRow = await openSheetRow(page);
        await expect(terminalRow).toHaveText(TERMINAL_LABEL);
        await terminalRow.click();
        await expect(page.getByTestId('mobile-terminal-actions-sheet')).toHaveCount(0);
        await expectBarClear(page, TERMINAL_BAR, vp.width, `${label} terminal`);

        // --- chat surface: the row searches the conversation --------------------
        await page.getByTestId('mobile-surface-mode-chat').click();
        await expect(page.getByTestId('chat-transcript')).toBeVisible();
        await expect(page.getByTestId('chat-transcript-search-toggle')).toHaveCount(0);
        const chatRow = await openSheetRow(page);
        await expect(chatRow).toHaveText(CHAT_LABEL);
        await chatRow.click();
        await expect(page.getByTestId('mobile-terminal-actions-sheet')).toHaveCount(0);
        await expectBarClear(page, CHAT_BAR, vp.width, `${label} chat`);

        // --- already open: the row puts focus back in the input -----------------
        await page.getByTestId('mobile-more-actions-button').focus();
        await (await openSheetRow(page)).click();
        await expect(page.locator(CHAT_BAR)).toHaveCount(1);
        await expect(page.locator(`${CHAT_BAR} input`)).toBeFocused();
      });
    }
  }
});

test.describe('Issue #2823: the PC split ignores chat-search-open', () => {
  test('opens no transcript search bar', async ({ page }) => {
    await seedDesktopOpencodeSplits(page, []);
    await page.addInitScript(
      ({ id, count }) => {
        for (let i = 0; i < count; i++) {
          localStorage.setItem(`commandmate.worktree.surfaceMode-${id}-split-${i}`, 'chat');
        }
      },
      { id: E2E_DESKTOP_OPENCODE_WORKTREE, count: DESKTOP_SPLIT_TOOLS.length },
    );
    await mockDesktopOpencodeApi(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/worktrees/${E2E_DESKTOP_OPENCODE_WORKTREE}`);
    const toggles = page.getByTestId('chat-transcript-search-toggle');
    await expect(toggles).toHaveCount(DESKTOP_SPLIT_TOOLS.length, { timeout: 30_000 });

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-search-open')));
    await page.waitForTimeout(300);
    await expect(page.locator(CHAT_BAR)).toHaveCount(0);
    await expect(toggles).toHaveCount(DESKTOP_SPLIT_TOOLS.length);

    // Control: the selector does find a bar the PC way.
    await toggles.first().click();
    await expect(page.locator(CHAT_BAR)).toHaveCount(1);
  });
});
