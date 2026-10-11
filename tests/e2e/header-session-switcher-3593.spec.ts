/**
 * E2E: the header's session field — [current session][N others ▾][+]
 * (Issue #3593).
 *
 * What this proves that the component tests cannot:
 * - **the width is real layout**: at one screen width the field measures the
 *   same with 1, 7 and 10 sessions, long aliases and every state;
 * - **drag and drop with the real mouse**: a row dragged out of the open list
 *   drops onto a split the list itself covers (the list leaves hit testing
 *   while the drag runs), an unshown session dropped on a split is shown
 *   there, and a session another split shows is refused with a toast;
 * - **Esc cancels the drag**: the list closes and focus returns to its
 *   trigger;
 * - **keyboard only**: open, move, pick, close.
 *
 * Screenshots of the open list in light and dark land in the test output
 * (`testInfo.outputPath`), for the PR.
 *
 * PC-only surface → self-skip outside chromium, mirroring the split specs.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { E2E_WORKTREE_A, setupSplitTest } from './fixtures/terminal-split-helpers';

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

const idle = { isRunning: false, isWaitingForResponse: false, isProcessing: false };
const ready = { isRunning: true, isWaitingForResponse: false, isProcessing: false };
const running = { isRunning: true, isWaitingForResponse: false, isProcessing: true };
const waiting = { isRunning: true, isWaitingForResponse: true, isProcessing: false };

const TOOLS = ['claude', 'codex', 'gemini'] as const;

interface RosterOptions {
  count: number;
  alias?: (i: number) => string;
  status?: (i: number) => Record<string, unknown>;
}

/** The worktree's roster: `count` instances, the first three the primaries. */
function buildRoster({ count, alias, status }: RosterOptions) {
  const instances = Array.from({ length: count }, (_, i) => {
    const cliTool = TOOLS[i % TOOLS.length];
    const id = i < TOOLS.length ? cliTool : `${cliTool}-${Math.floor(i / TOOLS.length) + 1}`;
    return { id, cliTool, order: i, ...(alias ? { alias: alias(i) } : {}) };
  });
  const sessionStatusByInstance = Object.fromEntries(
    instances.map((inst, i) => [inst.id, status ? status(i) : idle]),
  );
  return { instances, sessionStatusByInstance };
}

/** Serves the worktree with this roster (registered after the catch-all, so it wins). */
async function mockRoster(page: Page, options: RosterOptions): Promise<void> {
  const { instances, sessionStatusByInstance } = buildRoster(options);
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
          sessionStatusByCli: { claude: idle },
          sessionStatusByInstance,
          gitStatus: {
            currentBranch: `E2E ${E2E_WORKTREE_A}`,
            initialBranch: `E2E ${E2E_WORKTREE_A}`,
            isBranchMismatch: false,
            commitHash: 'e2e0000',
            isDirty: false,
          },
        }),
      }),
  );
}

async function openScreen(page: Page, options: RosterOptions): Promise<void> {
  await setupSplitTest(page, [E2E_WORKTREE_A]);
  await mockRoster(page, options);
  await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
  await expect(page.getByTestId('desktop-session-switcher')).toBeVisible();
  // The Files pane focuses its search box 100ms after it mounts; let that
  // land first, or it takes focus from the list mid-test.
  await expect(page.getByRole('textbox', { name: 'Search files' })).toBeFocused();
}

/** From the current session's left edge to the "+"'s right edge. */
async function fieldWidth(page: Page): Promise<number> {
  const switcher = await box(page.getByTestId('desktop-session-switcher'));
  const plus = await box(page.getByTestId('agent-add-button'));
  return Math.round(plus.x + plus.width - switcher.x);
}

/** Two splits: split 1 shows claude, split 2 codex; gemini is shown nowhere. */
async function twoSplits(page: Page): Promise<void> {
  await page.getByTestId('split-layout-2').click();
  await expect(page.getByTestId('terminal-split-pane-1')).toBeVisible();
  await expect(page.getByTestId('cli-selector-0')).toContainText('Claude');
  await expect(page.getByTestId('cli-selector-1')).toContainText('Codex');
}

async function openList(page: Page): Promise<Locator> {
  await page.getByTestId('desktop-agent-status-overflow').click();
  const list = page.getByTestId('desktop-session-others-list');
  await expect(list).toBeVisible();
  return list;
}

/** A point inside both the list and the split under it. */
async function pointUnderList(page: Page, splitIndex: number): Promise<{ x: number; y: number }> {
  const list = await box(page.getByTestId('desktop-session-others-list'));
  const pane = await box(page.getByTestId(`terminal-split-pane-${splitIndex}`));
  const left = Math.max(list.x, pane.x);
  const right = Math.min(list.x + list.width, pane.x + pane.width);
  const top = Math.max(list.y, pane.y);
  const bottom = Math.min(list.y + list.height, pane.y + pane.height);
  expect(right - left).toBeGreaterThan(10);
  expect(bottom - top).toBeGreaterThan(10);
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

/** Real-mouse drag of `source` to `to`. */
async function mouseDrag(page: Page, source: Locator, to: { x: number; y: number }): Promise<void> {
  const from = await box(source);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 5, from.y + from.height / 2 + 5, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

test.describe('Header session field (Issue #3593)', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC-only header (chromium only)');
  });

  test('is the same width with 1, 7 and 10 sessions, long names and every state', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const states = [idle, ready, running, waiting];
    const cases: RosterOptions[] = [
      { count: 1 },
      { count: 7, status: (i) => states[i % states.length] },
      { count: 10, status: (i) => states[(i + 1) % states.length] },
      {
        count: 10,
        alias: (i) => `a rather long alias for session number ${i}`,
        status: (i) => states[(i + 2) % states.length],
      },
      { count: 2, alias: () => 'x', status: () => waiting },
    ];
    const widths: number[] = [];
    for (const options of cases) {
      await openScreen(page, options);
      widths.push(await fieldWidth(page));
    }
    console.log('MEASURE-3593 field widths ' + JSON.stringify(widths));
    expect(new Set(widths).size).toBe(1);
  });

  test('drops a row onto the split the list covers, refuses one in use, and shows the screenshots', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScreen(page, {
      count: 3,
      status: (i) => [running, idle, waiting][i],
    });
    await twoSplits(page);
    await page.getByTestId('terminal-split-pane-0').click({ position: { x: 40, y: 80 } });
    await expect(page.locator('[data-session-current]')).toHaveAttribute(
      'data-testid',
      'desktop-agent-status-claude',
    );

    // Screenshots of the open list, light and dark.
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await openList(page);
      await page.mouse.move(5, 5);
      await page.screenshot({
        path: testInfo.outputPath(`header-session-switcher-3593-${scheme}.png`),
        clip: { x: 0, y: 0, width: 1440, height: 360 },
      });
      await page.keyboard.press('Escape');
    }
    await page.emulateMedia({ colorScheme: 'light' });

    // Gemini is shown nowhere: drop it on split 2, at a point the list covers.
    const list = await openList(page);
    const target = await pointUnderList(page, 1);
    await mouseDrag(page, list.getByTestId('desktop-agent-status-gemini'), target);
    await expect(page.getByTestId('cli-selector-1')).toContainText('Gemini');
    await expect(page.getByText('Moved Gemini to Split 2')).toBeVisible();
    // The list closed and handed focus back; split 2 is the selected one now.
    await expect(page.getByTestId('desktop-session-others-list')).toBeHidden();
    await expect(page.getByTestId('desktop-agent-status-overflow')).toBeFocused();
    await expect(page.locator('[data-session-current]')).toHaveAttribute(
      'data-testid',
      'desktop-agent-status-gemini',
    );

    // Claude is in split 1: dropping it on split 2 is refused with a toast.
    const list2 = await openList(page);
    const target2 = await pointUnderList(page, 1);
    await mouseDrag(page, list2.getByTestId('desktop-agent-status-claude'), target2);
    await expect(page.getByText('Claude is already in use by split 1')).toBeVisible();
    await expect(page.getByTestId('cli-selector-1')).toContainText('Gemini');
    await expect(page.getByTestId('cli-selector-0')).toContainText('Claude');
  });

  test('Esc cancels a drag: the list closes and focus returns to its trigger', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScreen(page, { count: 3 });
    const list = await openList(page);
    const row = list.getByTestId('desktop-agent-status-codex');
    const from = await box(row);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 40, from.y + from.height / 2 + 120, { steps: 8 });
    // The drag is running: the list ignores the pointer.
    await expect(page.getByTestId('desktop-session-others-list')).toHaveAttribute('data-dragging', 'true');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.getByTestId('desktop-session-others-list')).toBeHidden();
    await expect(page.getByTestId('desktop-agent-status-overflow')).toBeFocused();
    // Nothing was dropped.
    await expect(page.locator('[data-session-current]')).toHaveAttribute(
      'data-testid',
      'desktop-agent-status-claude',
    );
  });

  test('works with the keyboard only', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScreen(page, { count: 3 });
    const trigger = page.getByTestId('desktop-agent-status-overflow');
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('desktop-session-others-list')).toBeVisible();
    await expect(page.getByTestId('desktop-agent-status-codex')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('desktop-agent-status-gemini')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('desktop-session-others-list')).toBeHidden();
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('desktop-agent-status-codex')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    // Gemini was shown nowhere: it is shown in the selected split (split 1).
    await expect(page.getByTestId('cli-selector-0')).toContainText('Gemini');
    await expect(page.locator('[data-session-current]')).toHaveAttribute(
      'data-testid',
      'desktop-agent-status-gemini',
    );
    await expect(page.getByTestId('desktop-session-others-list')).toBeHidden();
  });

  test('a short screen: the list scrolls, the last row and "Add session…" are reachable, and the form hands focus back', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 360 });
    // 9 sessions: one under the limit, so "Add session…" is on.
    await openScreen(page, { count: 9 });
    const trigger = page.getByTestId('desktop-agent-status-overflow');
    await trigger.focus();
    await page.keyboard.press('ArrowUp');
    const add = page.getByTestId('desktop-session-add');
    await expect(add).toBeFocused();
    const list = page.getByTestId('desktop-session-others-list');
    const sizes = await list.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(sizes.scroll).toBeGreaterThan(sizes.client);
    const addBox = await box(add);
    expect(addBox.y + addBox.height).toBeLessThanOrEqual(360);
    await page.keyboard.press('ArrowUp');
    const lastRow = page.getByTestId('desktop-agent-status-gemini-3');
    await expect(lastRow).toBeFocused();
    await expect(lastRow).toBeInViewport({ ratio: 1 });

    // The row's tooltip is drawn above the list.
    const z = await page.evaluate(() => {
      const bubble = document.querySelector('[role="tooltip"]');
      const listEl = document.querySelector('[data-testid="desktop-session-others-list"]');
      return bubble && listEl
        ? { bubble: Number(getComputedStyle(bubble).zIndex), list: Number(getComputedStyle(listEl).zIndex) }
        : null;
    });
    expect(z).not.toBeNull();
    expect(z!.bubble).toBeGreaterThan(z!.list);

    // Add session → the form → Escape: focus is back on "N more".
    await page.keyboard.press('End');
    await expect(add).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('agent-add-form')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('agent-add-form')).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('a tall screen: the list does not scroll; at 10 sessions "Add session…" is off and says why', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScreen(page, { count: 3 });
    const list = await openList(page);
    const sizes = await list.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(sizes.scroll).toBe(sizes.client);
    await expect(page.getByTestId('desktop-session-add')).toBeEnabled();
    await expect(page.getByTestId('desktop-session-add-limit')).toHaveCount(0);

    await openScreen(page, { count: 10 });
    await openList(page);
    await expect(page.getByTestId('desktop-session-add')).toBeDisabled();
    await expect(page.getByTestId('desktop-session-add-limit')).toHaveText('Up to 10 agents per branch');
    await expect(page.getByTestId('agent-add-button')).toBeDisabled();
  });
});
