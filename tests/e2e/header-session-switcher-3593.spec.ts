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
  // Issue #3589: the activity pane starts closed, so no Files search box
  // mounts and takes focus from the list mid-test. Make sure it stays so.
  await expect(page.getByTestId('terminal-split-container')).toBeVisible();
  await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
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

// ---- Issue #3616: row tooltip geometry ----

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The part of `a` inside `clip` (zero-sized when they do not meet). */
function intersect(a: Box, clip: Box): Box {
  const x = Math.max(a.x, clip.x);
  const y = Math.max(a.y, clip.y);
  const right = Math.min(a.x + a.width, clip.x + clip.width);
  const bottom = Math.min(a.y + a.height, clip.y + clip.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

async function openScreenWithSidebar(page: Page, options: RosterOptions): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('mcbd-sidebar-open', 'true');
    } catch {
      /* non-fatal */
    }
  });
  await openScreen(page, options);
}

/**
 * Opening the list focuses its first row, whose bubble then stays up on the
 * focus channel. Drop that focus (the list stays open: a blur to nowhere does
 * not close it) so the hover checks below only ever see the hovered row's.
 */
async function dropListFocus(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.getByTestId('desktop-session-others-list')).toBeVisible();
  await expect(page.getByRole('tooltip', { includeHidden: true })).toHaveCount(0);
}

/**
 * The one bubble on screen belongs to `row` (its text is the row's label) and,
 * once placed, covers no other row of the list — only the parts of rows the
 * list actually shows count — and not the list itself.
 */
async function checkRowTooltip(page: Page, row: Locator, opts: { expectWrapped?: boolean } = {}): Promise<void> {
  const bubble = page.getByRole('tooltip', { includeHidden: true });
  await expect(bubble).toHaveCount(1);
  await expect(bubble).toHaveText((await row.getAttribute('aria-label'))!);
  await expect.poll(async () => (await bubble.boundingBox())?.x ?? -9999).toBeGreaterThanOrEqual(0);
  const b = await box(bubble);
  const list = page.getByTestId('desktop-session-others-list');
  const listBox = await box(list);
  const rowId = await row.getAttribute('data-testid');
  const others = list.locator('[data-switcher-item]');
  for (let j = 0; j < (await others.count()); j++) {
    const other = others.nth(j);
    if ((await other.getAttribute('data-testid')) === rowId) continue;
    const visible = intersect(await box(other), listBox);
    if (visible.width === 0 || visible.height === 0) continue;
    expect(overlaps(b, visible), `tooltip of ${rowId} vs ${await other.getAttribute('data-testid')}`).toBe(false);
  }
  expect(overlaps(b, listBox), `tooltip of ${rowId} vs the list`).toBe(false);
  const viewport = page.viewportSize()!;
  expect(b.x >= 0 && b.x + b.width <= viewport.width).toBe(true);
  if (opts.expectWrapped) {
    // The label did not fit on one line beside the list: it was wrapped.
    expect(await bubble.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('normal');
  }
}

/** Hover `row` (in its visible part), check its bubble, then move away. */
async function hoverRowAndCheckTooltip(
  page: Page,
  row: Locator,
  opts: { expectWrapped?: boolean; atY?: 'center' | 'visible-part' } = {},
): Promise<void> {
  const r = await box(row);
  let y = r.y + r.height / 2;
  if (opts.atY === 'visible-part') {
    const listBox = await box(page.getByTestId('desktop-session-others-list'));
    y = (r.y + Math.min(r.y + r.height, listBox.y + listBox.height)) / 2;
  }
  await page.mouse.move(r.x + r.width / 2, y);
  await checkRowTooltip(page, row, opts);
  await page.mouse.move(5, 5);
  await expect(page.getByRole('tooltip', { includeHidden: true })).toHaveCount(0);
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

  // Issue #3616: a row's tooltip used to sit below the row (`bottom`), over
  // the next row's name. It now sits beside the row and covers no other row.
  test('a row tooltip, on hover and on focus, covers no other row of the list (#3616)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScreen(page, { count: 4 });
    const list = await openList(page);
    const sessionRows = list.locator('[data-testid^="desktop-agent-status-"]');
    const sessions = await sessionRows.count();
    expect(sessions).toBeGreaterThanOrEqual(3);

    await dropListFocus(page);
    for (let i = 0; i < sessions; i++) {
      await hoverRowAndCheckTooltip(page, sessionRows.nth(i));
    }

    // Keyboard focus on a middle row (pointer parked away from the list).
    await page.mouse.move(5, 5);
    await sessionRows.nth(1).focus();
    await checkRowTooltip(page, sessionRows.nth(1));
  });

  // Issue #3616 (review): a long label at 1024 with the sidebar open fits on
  // neither side of the list. The bubble must not be clamped back over the
  // list; it wraps beside it instead — also for a row the scrolled list shows
  // only in part at its bottom edge.
  test('a long row tooltip on a narrow screen, and on a partly visible row, covers no other row (#3616)', async ({
    page,
  }) => {
    const alias = (i: number) =>
      `session ${i} with a deliberately very long alias so that its tooltip cannot fit on either side of the list`;

    await page.setViewportSize({ width: 1024, height: 768 });
    await openScreenWithSidebar(page, { count: 4, alias });
    let list = await openList(page);
    await dropListFocus(page);
    let rows = list.locator('[data-testid^="desktop-agent-status-"]');
    for (let i = 0; i < (await rows.count()); i++) {
      await hoverRowAndCheckTooltip(page, rows.nth(i), { expectWrapped: true });
    }

    // A short screen: the list scrolls and its bottom row is cut in half.
    await page.setViewportSize({ width: 1024, height: 300 });
    await openScreenWithSidebar(page, { count: 9, alias });
    list = await openList(page);
    await dropListFocus(page);
    // Scroll so the list's bottom edge cuts a session row in half.
    await list.evaluate((el) => {
      const rowEls = Array.from(el.querySelectorAll<HTMLElement>('[data-testid^="desktop-agent-status-"]'));
      const visibleBottom = el.getBoundingClientRect().top + el.clientTop + el.clientHeight;
      const rect = rowEls[rowEls.length - 1].getBoundingClientRect();
      if (rect.bottom - rect.height / 2 < visibleBottom) throw new Error('the last row is not below the fold');
      el.scrollTop += rect.bottom - visibleBottom - rect.height / 2;
    });
    const listBox = await box(list);
    const listBottom = listBox.y + listBox.height;
    rows = list.locator('[data-testid^="desktop-agent-status-"]');
    let partial: Locator | null = null;
    for (let i = 0; i < (await rows.count()); i++) {
      const r = await box(rows.nth(i));
      if (r.y < listBottom - 6 && r.y + r.height > listBottom) {
        partial = rows.nth(i);
        break;
      }
    }
    expect(partial, 'a row cut by the list bottom').not.toBeNull();
    await hoverRowAndCheckTooltip(page, partial!, { expectWrapped: true, atY: 'visible-part' });
  });

  // Issue #3616 (review 2): a long label with no spaces only wraps with
  // `overflow-wrap: anywhere`. It must be measured with it too, or the bubble
  // is placed by a one-line height and runs off the bottom of the screen.
  test('a long row tooltip with no spaces stays on screen and covers no other row (#3616)', async ({ page }) => {
    const alias = (i: number) => `s${i}_` + 'x'.repeat(600);
    for (const height of [768, 300]) {
      await page.setViewportSize({ width: 1024, height });
      await openScreenWithSidebar(page, { count: 9, alias });
      const list = await openList(page);
      await dropListFocus(page);
      const rows = list.locator('[data-testid^="desktop-agent-status-"]');
      const listBox = await box(list);
      for (let i = 0; i < (await rows.count()); i++) {
        const r = await box(rows.nth(i));
        // Only the rows the list shows (at least half of them) can be hovered.
        if (r.y + r.height / 2 > listBox.y + listBox.height) continue;
        await page.mouse.move(r.x + r.width / 2, r.y + Math.min(r.height / 2, 4));
        const bubble = page.getByRole('tooltip', { includeHidden: true });
        await expect(bubble).toHaveText((await rows.nth(i).getAttribute('aria-label'))!);
        await checkRowTooltip(page, rows.nth(i), { expectWrapped: true });
        const b = await box(bubble);
        // Wrapped onto several lines, and the whole bubble is inside the screen.
        expect(b.height).toBeGreaterThan(30);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.y + b.height, `bottom of the tooltip of row ${i} at height ${height}`).toBeLessThanOrEqual(height);
        await page.mouse.move(5, 5);
        await expect(bubble).toHaveCount(0);
      }
    }
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
