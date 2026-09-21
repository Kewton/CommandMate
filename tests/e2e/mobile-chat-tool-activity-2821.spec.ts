/**
 * E2E: the phone's tool-activity toggle sits in the surface pill (Issue #2821).
 *
 * The defect was a PIXEL fact that jsdom cannot see: measured at 390x844, the
 * surface pill (`mobile-surface-mode-toggle`, x286 y150 96x50) covered the chat
 * transcript's tool-activity icon (x322 y150 28x28) and its search icon (x354
 * y150 28x28) completely. So this spec asserts, in a real browser at the two
 * phone viewports #2106 measured:
 *
 *  - the pill's tool-activity button exists on the chat surface only;
 *  - it is on top: `elementFromPoint` at its centre lands on the button itself;
 *  - it is a >= 44px target (#1127) and the pill stays inside the viewport;
 *  - the transcript draws neither of its own corner icons;
 *  - a tap flips the transcript's `data-tool-activity` and persists the answer
 *    in localStorage, which a reload reads back;
 *  - nothing scrolls sideways.
 *
 * Same mocked `/api/` as `mobile-direct-input-keyboard-2799.spec.ts`. The mock
 * serves an empty conversation, which is enough: `data-tool-activity` is on the
 * transcript's root whether or not there are rows. Playwright's only project is
 * Desktop Chrome without `hasTouch`, so taps are driven with `click()`.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  E2E_OPENCODE_WORKTREE,
  PHONE_VIEWPORTS,
  mockOpencodeWorktreeApi,
  seedOpencodeActiveInstance,
} from './fixtures/opencode-mobile-helpers';

/** #1127. */
const MIN_TAP_TARGET_PX = 44;
/** Mirror of `CHAT_TOOL_ACTIVITY_STORAGE_KEY` (`src/lib/chat/chat-tool-activity.ts`). */
const TOOL_ACTIVITY_STORAGE_KEY = 'commandmate:chatShowToolActivity';
const PILL_BUTTON_TESTID = 'mobile-chat-tool-activity-toggle';

async function openMobileTerminal(page: Page): Promise<void> {
  await page.goto(`/worktrees/${E2E_OPENCODE_WORKTREE}?pane=terminal`);
  await page.waitForSelector('[data-testid="mobile-terminal-region"]', { timeout: 30_000 });
}

function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth ||
      document.body.scrollWidth > document.body.clientWidth,
  );
}

/** True when the topmost element at the button's centre is the button (or its icon). */
function isOnTop(page: Page, testId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const button = document.querySelector(`[data-testid="${id}"]`);
    if (!button) return false;
    const r = button.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (hit === button || button.contains(hit));
  }, testId);
}

function readToolActivityPreference(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), TOOL_ACTIVITY_STORAGE_KEY);
}

test.describe('Issue #2821: the phone tool-activity toggle in the surface pill', () => {
  test.beforeEach(async ({ page }) => {
    await seedOpencodeActiveInstance(page);
    await mockOpencodeWorktreeApi(page);
  });

  for (const vp of PHONE_VIEWPORTS) {
    test(`is reachable and drives the transcript at ${vp.label}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openMobileTerminal(page);

      // --- terminal surface: no button ---------------------------------------
      await expect(page.getByTestId('mobile-surface-mode-toggle')).toBeVisible();
      await expect(page.getByTestId(PILL_BUTTON_TESTID)).toHaveCount(0);

      // --- chat surface: the button, on top ----------------------------------
      await page.getByTestId('mobile-surface-mode-chat').click();
      const transcript = page.getByTestId('chat-transcript');
      await expect(transcript).toBeVisible();
      const button = page.getByTestId(PILL_BUTTON_TESTID);
      await expect(button).toBeVisible();

      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX - 0.5);
      expect(box!.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX - 0.5);
      expect(await isOnTop(page, PILL_BUTTON_TESTID)).toBe(true);

      const pill = await page.getByTestId('mobile-surface-mode-toggle').boundingBox();
      expect(pill).not.toBeNull();
      expect(pill!.x).toBeGreaterThanOrEqual(0);
      expect(pill!.x + pill!.width).toBeLessThanOrEqual(vp.width);

      // The transcript's own corner icons are withdrawn on the phone.
      await expect(page.getByTestId('chat-transcript-tool-activity-toggle')).toHaveCount(0);
      await expect(page.getByTestId('chat-transcript-search-toggle')).toHaveCount(0);
      expect(await hasHorizontalScroll(page)).toBe(false);

      // eslint-disable-next-line no-console -- the measurement is the deliverable
      console.log(`MEASURE-2821 ${vp.label} ` + JSON.stringify({ pill, button: box }));

      // --- a tap opens, and is remembered -----------------------------------
      await expect(transcript).toHaveAttribute('data-tool-activity', 'folded');
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      await button.click();
      await expect(transcript).toHaveAttribute('data-tool-activity', 'shown');
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      expect(await readToolActivityPreference(page)).toBe('true');
      expect(await hasHorizontalScroll(page)).toBe(false);

      // --- a reload reads it back (the surface choice persists too) ---------
      await page.reload();
      await page.waitForSelector('[data-testid="mobile-terminal-region"]', { timeout: 30_000 });
      await expect(page.getByTestId('chat-transcript')).toHaveAttribute('data-tool-activity', 'shown');
      await expect(page.getByTestId(PILL_BUTTON_TESTID)).toHaveAttribute('aria-pressed', 'true');

      // --- and a second tap folds again -------------------------------------
      await page.getByTestId(PILL_BUTTON_TESTID).click();
      await expect(page.getByTestId('chat-transcript')).toHaveAttribute('data-tool-activity', 'folded');
      expect(await readToolActivityPreference(page)).toBe('false');

      // --- back to the terminal: the button goes with the chat surface ------
      await page.getByTestId('mobile-surface-mode-terminal').click();
      await expect(page.getByTestId(PILL_BUTTON_TESTID)).toHaveCount(0);
    });
  }
});
