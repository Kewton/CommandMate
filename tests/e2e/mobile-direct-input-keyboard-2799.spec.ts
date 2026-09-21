/**
 * E2E: the phone's direct-input keyboard (Issue #2799).
 *
 * Like #2106's spec, this one exists because the claims are PIXEL claims and
 * jsdom has no layout: the keyboard is 132px folded and 308px open, every key
 * is 44px tall, neighbouring keys share their edges (no dead gap between hit
 * areas), the page never scrolls sideways, and the terminal keeps enough height
 * to read the frame the keys are aimed at. It measures the same way
 * `mobile-opencode-quick-keys-2106.spec.ts` does, at the same two phone
 * viewports, over the same mocked `/api/`.
 *
 * ## The two terminal floors, and why only one is tool-dependent
 *
 * The fixture is opencode-named, but it is nothing more than `/api/` mocks, so
 * it serves this spec unchanged.
 *
 *  - IN the mode (360x640): the terminal must keep >= 200px with the character
 *    panel folded and >= 120px with it open. The mode hides the quick-keys slot
 *    (and every other pad of the tab), so these floors do not depend on the
 *    tool.
 *  - OUT of the mode: #2106's > 250px. That baseline DOES depend on the tool —
 *    opencode's folded quick-keys toggle takes a row the other tools do not —
 *    which is why it is re-checked here on the opencode fixture, the tighter
 *    case, after the mode is closed.
 *
 * Playwright's only project is Desktop Chrome without `hasTouch`, so `tap()` is
 * unavailable. Keys are driven with `click()` and the swipe with
 * `page.mouse.down/move/up` — the keyboard is built on pointer events, which a
 * mouse produces, so the same code path runs.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  E2E_OPENCODE_WORKTREE,
  PHONE_VIEWPORTS,
  mockOpencodeWorktreeApi,
  seedOpencodeActiveInstance,
  rectOf,
} from './fixtures/opencode-mobile-helpers';

/** #1127. */
const MIN_TAP_TARGET_PX = 44;
/** §2: confirm row 44 + special keys 88. */
const FOLDED_HEIGHT_PX = 132;
/** §2: + the character panel's four 44px rows. */
const OPEN_HEIGHT_PX = 308;
const HEIGHT_TOLERANCE_PX = 4;

/** Code point test ids, as `charKeyTestId` builds them. */
function charKey(char: string): string {
  return `direct-key-char-${char.codePointAt(0)}`;
}

async function openMobileTerminal(page: Page): Promise<void> {
  await page.goto(`/worktrees/${E2E_OPENCODE_WORKTREE}?pane=terminal`);
  await page.waitForSelector('[data-testid="mobile-terminal-region"]', { timeout: 30_000 });
}

async function openKeyboard(page: Page): Promise<void> {
  await page.getByTestId('mobile-more-actions-button').click();
  const row = page.getByTestId('actions-sheet-direct-input');
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAttribute('aria-disabled', 'true');
  await row.click();
  await expect(page.getByTestId('mobile-direct-input-keyboard')).toBeVisible();
  await expect(page.getByTestId('mobile-terminal-actions-sheet')).toHaveCount(0);
}

/** Every rendered key row of the keyboard: the rects of its buttons, left to right. */
function keyRows(page: Page): Promise<Array<Array<{ left: number; right: number; top: number; bottom: number; height: number }>>> {
  return page.evaluate(() => {
    const keyboard = document.querySelector('[data-testid="mobile-direct-input-keyboard"]');
    if (!keyboard) return [];
    return Array.from(keyboard.querySelectorAll('.grid')).map((row) =>
      Array.from(row.querySelectorAll(':scope > button')).map((button) => {
        const r = button.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
      }),
    );
  });
}

function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth ||
      document.body.scrollWidth > document.body.clientWidth,
  );
}

/** Keys and the confirm row: nothing under 44px tall; neighbours share edges within 1px. */
async function expectKeyGeometry(page: Page): Promise<void> {
  const rows = await keyRows(page);
  expect(rows.length).toBeGreaterThanOrEqual(2);
  for (const row of rows) {
    for (const key of row) expect(key.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX - 0.5);
    for (let i = 1; i < row.length; i++) {
      expect(Math.abs(row[i].left - row[i - 1].right)).toBeLessThanOrEqual(1);
    }
  }
  for (let r = 1; r < rows.length; r++) {
    expect(Math.abs(rows[r][0].top - rows[r - 1][0].bottom)).toBeLessThanOrEqual(1);
  }
  const confirmButtons = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll('[data-testid="direct-input-confirm-row"] button'),
    ).map((button) => {
      const r = button.getBoundingClientRect();
      return { width: r.width, height: r.height };
    }),
  );
  for (const button of confirmButtons) {
    expect(button.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX - 0.5);
    expect(button.width).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX - 0.5);
  }
}

test.describe('Issue #2799: the phone direct-input keyboard', () => {
  test.beforeEach(async ({ page }) => {
    await seedOpencodeActiveInstance(page);
    await mockOpencodeWorktreeApi(page);
  });

  for (const vp of PHONE_VIEWPORTS) {
    test(`fits the phone at ${vp.label}: heights, tap targets, edges, and the terminal's share`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openMobileTerminal(page);
      await openKeyboard(page);

      // --- folded (the default) -------------------------------------------
      const folded = await rectOf(page, 'mobile-direct-input-keyboard');
      const foldedTerminal = await rectOf(page, 'mobile-terminal-region');
      expect(Math.abs(folded!.height - FOLDED_HEIGHT_PX)).toBeLessThanOrEqual(HEIGHT_TOLERANCE_PX);
      expect(await hasHorizontalScroll(page)).toBe(false);
      await expectKeyGeometry(page);
      // Every pad of the tab stands down in the mode (so these floors are tool-independent).
      await expect(page.getByTestId('mobile-quick-keys-slot')).toHaveCount(0);

      // --- open ------------------------------------------------------------
      await page.getByTestId('direct-input-toggle-chars').click();
      await expect(page.getByTestId('direct-input-char-panel')).toBeVisible();
      const open = await rectOf(page, 'mobile-direct-input-keyboard');
      const openTerminal = await rectOf(page, 'mobile-terminal-region');
      expect(Math.abs(open!.height - OPEN_HEIGHT_PX)).toBeLessThanOrEqual(HEIGHT_TOLERANCE_PX);
      expect(await hasHorizontalScroll(page)).toBe(false);
      await expectKeyGeometry(page);

      // --- closed again ------------------------------------------------------
      await page.getByTestId('direct-input-close').click();
      await expect(page.getByTestId('mobile-direct-input-keyboard')).toHaveCount(0);
      await expect(page.getByTestId('opencode-quick-keys-toggle')).toBeVisible();
      const closedTerminal = await rectOf(page, 'mobile-terminal-region');

      // eslint-disable-next-line no-console -- the measurement is the deliverable
      console.log(`MEASURE-2799 ${vp.label} ` + JSON.stringify({
        keyboardFolded: folded?.height,
        keyboardOpen: open?.height,
        terminalFolded: foldedTerminal?.height,
        terminalOpen: openTerminal?.height,
        terminalClosed: closedTerminal?.height,
      }));

      if (vp.label === '360x640') {
        // §8: the floors in the mode, measured on the smaller phone.
        expect(foldedTerminal!.height).toBeGreaterThanOrEqual(200);
        expect(openTerminal!.height).toBeGreaterThanOrEqual(120);
      }
      // #2106 holds again once the mode is closed.
      expect(closedTerminal!.height).toBeGreaterThan(250);
    });
  }

  test('stages taps without sending, then sends them in order as one request', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 730 });
    await openMobileTerminal(page);
    await openKeyboard(page);

    const posts: unknown[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/direct-input') && req.method() === 'POST') posts.push(req.postDataJSON());
    });

    await page.getByTestId('direct-key-esc').click();
    await page.getByTestId('direct-key-down').click();
    await page.getByTestId('direct-key-down').click();
    await page.getByTestId('direct-key-ctrl').click();
    await expect(page.getByTestId('direct-key-ctrl')).toHaveAttribute('aria-pressed', 'true');
    // Arming CTRL opened the letters.
    await page.getByTestId(charKey('a')).click();
    await expect(page.getByTestId('direct-input-chip')).toHaveText(['ESC', '↓×2', '^A']);
    await expect(page.getByTestId('direct-input-send')).toContainText('4');
    expect(posts).toHaveLength(0);

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/direct-input') && req.method() === 'POST'),
      page.getByTestId('direct-input-send').click(),
    ]);
    expect(JSON.parse(request.postData() ?? '{}')).toEqual({
      cliToolId: 'opencode',
      events: [
        { type: 'key', key: 'Escape' },
        { type: 'key', key: 'Down' },
        { type: 'key', key: 'Down' },
        { type: 'key', key: 'C-a' },
      ],
    });
    await expect(page.getByTestId('direct-input-chip')).toHaveCount(0);
  });

  test('BS swiped up stages DEL, and releasing over the confirm row presses nothing there', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await openMobileTerminal(page);
    await openKeyboard(page);
    await page.getByTestId('direct-key-esc').click();

    let posted = false;
    page.on('request', (req) => {
      if (req.url().includes('/direct-input')) posted = true;
    });

    const bs = await page.getByTestId('direct-key-bs').boundingBox();
    const send = await page.getByTestId('direct-input-send').boundingBox();
    expect(bs && send).toBeTruthy();
    await page.mouse.move(bs!.x + bs!.width / 2, bs!.y + bs!.height / 2);
    await page.mouse.down();
    // Up and across to 送信 — well past the 24px threshold.
    await page.mouse.move(send!.x + send!.width / 2, send!.y + send!.height / 2, { steps: 5 });
    await page.mouse.up();

    await expect(page.getByTestId('direct-input-chip')).toHaveText(['ESC', 'DEL']);
    await page.waitForTimeout(300);
    expect(posted).toBe(false);
  });

  test('a release outside the key stages nothing', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 730 });
    await openMobileTerminal(page);
    await openKeyboard(page);

    const esc = await page.getByTestId('direct-key-esc').boundingBox();
    await page.mouse.move(esc!.x + esc!.width / 2, esc!.y + esc!.height / 2);
    await page.mouse.down();
    // Sideways and down, off the key (a downward move is not a swipe).
    await page.mouse.move(esc!.x + esc!.width * 3, esc!.y + esc!.height * 1.5, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByTestId('direct-input-chip')).toHaveCount(0);
  });
});

test.describe('Issue #2799: focus and the terminal\'s last row', () => {
  test('never leaves focus on an input, and keeps the terminal on its last row', async ({ page }) => {
    // claude, not the opencode default: opencode's pane is `disableAutoFollow`
    // (a full-screen TUI read from the top), so it is never pinned to the end.
    await seedOpencodeActiveInstance(page, E2E_OPENCODE_WORKTREE, 'claude');
    await mockOpencodeWorktreeApi(page, E2E_OPENCODE_WORKTREE, 'claude');
    await page.setViewportSize({ width: 360, height: 640 });
    await openMobileTerminal(page);

    // From a focused composer, the way the OS keyboard would be up on a phone.
    await page.getByTestId('message-input-textarea').focus();
    await openKeyboard(page);
    await page.getByTestId('direct-key-up').click();
    await page.getByTestId('direct-input-toggle-chars').click();
    await page.getByTestId(charKey('q')).click();

    const focusOnInput = await page.evaluate(() =>
      document.activeElement?.matches('input, textarea, select, [contenteditable="true"]') ?? false,
    );
    expect(focusOnInput).toBe(false);

    // The keyboard took height from the terminal; its last row is still in view.
    const gap = await page.evaluate(() => {
      const log = document.querySelector('[data-testid="mobile-terminal-region"] [role="log"]') as HTMLElement | null;
      if (!log) return null;
      return log.scrollHeight - log.clientHeight - log.scrollTop;
    });
    expect(gap).not.toBeNull();
    expect(gap!).toBeLessThanOrEqual(2);
  });
});
