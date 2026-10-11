/**
 * E2E: the worktree screen starts with its panels closed, and the activity pane
 * opens OVER the body without narrowing the terminal (Issue #3589).
 *
 * What this proves that the component tests cannot: real layout. The terminal's
 * box is measured in a real browser before and after the pane opens, so "the
 * body keeps its width" is a coordinate, not a class name. The widths measured
 * here are printed (test annotations) for the PR.
 *
 * PC-only surface → self-skip outside chromium, mirroring the split specs.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  ACTIVITY_PANE_PINNED_KEY,
  E2E_WORKTREE_A,
  setupSplitTest,
} from './fixtures/terminal-split-helpers';

test.use({ viewport: { width: 1440, height: 900 } });

async function terminalBox(page: Page) {
  const box = await page.getByTestId('terminal-split-container').boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function openScreen(page: Page) {
  await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
  await expect(page.getByTestId('terminal-split-container')).toBeVisible({ timeout: 30_000 });
}

test.describe('Activity pane over the body (Issue #3589)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC-only layout (chromium only)');
    await setupSplitTest(page, [E2E_WORKTREE_A]);
  });

  test('starts with the activity pane and History closed', async ({ page }, testInfo) => {
    await openScreen(page);
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
    await expect(page.getByTestId('split-history-slot-0')).toHaveCount(0);
    await expect(page.getByTestId('toggle-history-pane')).toHaveAttribute('aria-pressed', 'false');

    const box = await terminalBox(page);
    const sidebarOpen = await page.getByTestId('sidebar-container').isVisible().catch(() => false);
    testInfo.annotations.push({
      type: 'terminal-width',
      description: `1440x900, sidebar ${sidebarOpen ? 'open' : 'closed'}, 1 split: ${Math.round(box.width)}px`,
    });
  });

  for (const sidebarOpen of [true, false]) {
    test(`the terminal is wider than in the pre-#3589 layout (sidebar ${sidebarOpen ? 'open' : 'closed'})`, async ({ page }, testInfo) => {
      await page.addInitScript(open => {
        try {
          localStorage.setItem('mcbd-sidebar-open', String(open));
        } catch {
          /* non-fatal */
        }
      }, sidebarOpen);
      await openScreen(page);
      const terminal = page.getByTestId('split-terminal-slot-0');
      const now = (await terminal.boundingBox())!.width;

      // The pre-#3589 first visit, rebuilt by hand: Files beside the body
      // (pinned) and History shown.
      await page.getByTestId('activity-bar-button-files').click();
      await page.getByTestId('activity-pane-pin').click();
      await page.getByTestId('toggle-history-pane').click();
      await expect(page.getByTestId('split-history-slot-0')).toBeVisible();
      await expect(page.getByTestId('activity-pane-slot')).toHaveAttribute('data-pinned', 'true');
      const before = (await terminal.boundingBox())!.width;

      expect(now).toBeGreaterThan(before);
      testInfo.annotations.push({
        type: 'terminal-width',
        description: `1440x900, sidebar ${sidebarOpen ? 'open' : 'closed'}, 1 split, terminal slot: ${Math.round(now)}px now / ${Math.round(before)}px pre-#3589 default`,
      });
    });
  }

  test('opening the pane does not move or narrow the terminal', async ({ page }) => {
    await openScreen(page);
    const before = await terminalBox(page);

    await page.getByTestId('activity-bar-button-files').click();
    const slot = page.getByTestId('activity-pane-slot');
    await expect(slot).toBeVisible();
    await expect(slot).toHaveAttribute('data-pinned', 'false');

    const after = await terminalBox(page);
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.width).toBeCloseTo(before.width, 0);

    // And the pane really is on top of the terminal, not beside it.
    const pane = (await slot.boundingBox())!;
    expect(pane.x + pane.width).toBeGreaterThan(before.x);
  });

  test('Esc and × close it and hand focus back to the icon', async ({ page }) => {
    await openScreen(page);
    const files = page.getByTestId('activity-bar-button-files');

    await files.click();
    await expect(page.getByTestId('activity-pane-slot')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
    await expect(files).toBeFocused();

    const git = page.getByTestId('activity-bar-button-git');
    await git.click();
    await expect(page.getByTestId('activity-pane-slot')).toBeVisible();
    await page.getByTestId('activity-pane-close').click();
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
    await expect(git).toBeFocused();
  });

  test('closes on a click in the terminal area', async ({ page }) => {
    await openScreen(page);
    await page.getByTestId('activity-bar-button-git').click();
    await expect(page.getByTestId('activity-pane-slot')).toBeVisible();
    const box = await terminalBox(page);
    // Right half of the terminal: never under the overlay.
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
  });

  test('a pinned pane sits beside the terminal and stays pinned after a reload', async ({ page }, testInfo) => {
    await openScreen(page);
    const unpinned = await terminalBox(page);

    await page.getByTestId('activity-bar-button-files').click();
    await page.getByTestId('activity-pane-pin').click();
    const slot = page.getByTestId('activity-pane-slot');
    await expect(slot).toHaveAttribute('data-pinned', 'true');
    expect(await page.evaluate(key => localStorage.getItem(key), ACTIVITY_PANE_PINNED_KEY)).toBe('true');

    const pinned = await terminalBox(page);
    expect(pinned.width).toBeLessThan(unpinned.width);
    const pane = (await slot.boundingBox())!;
    expect(pane.x + pane.width).toBeLessThanOrEqual(pinned.x + 1);

    await page.reload();
    await expect(page.getByTestId('terminal-split-container')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('activity-pane-slot')).toHaveAttribute('data-pinned', 'true');

    testInfo.annotations.push({
      type: 'terminal-width',
      description: `1440x900, 1 split: ${Math.round(unpinned.width)}px unpinned / ${Math.round(pinned.width)}px with Files pinned`,
    });
  });

  test('something floating inside the body stays under the overlaid pane', async ({ page }) => {
    await openScreen(page);
    await page.getByTestId('activity-bar-button-files').click();
    const slot = page.getByTestId('activity-pane-slot');
    await expect(slot).toHaveAttribute('data-pinned', 'false');
    const pane = (await slot.boundingBox())!;

    // A `z-30` layer inside the body, over the area the pane covers — what the
    // session memo editor (TerminalSplitPane) is.
    await page.evaluate(() => {
      const layer = document.createElement('div');
      layer.id = 'e2e-body-float';
      layer.style.cssText = 'position:absolute;inset:0;z-index:30;background:transparent';
      document.getElementById('worktree-right-pane')!.appendChild(layer);
    });
    const onTop = await page.evaluate(
      ([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit?.closest('[data-testid="activity-pane-slot"]') ? 'pane' : hit?.id ?? hit?.tagName ?? 'none';
      },
      [pane.x + pane.width / 2, pane.y + pane.height / 2],
    );
    expect(onTop).toBe('pane');
  });

  test('pinning and unpinning keep the same pane element (no remount)', async ({ page }) => {
    await openScreen(page);
    await page.getByTestId('activity-bar-button-files').click();
    await expect(page.getByTestId('activity-pane-frame')).toBeVisible();
    await page.evaluate(() => {
      (document.querySelector('[data-testid="activity-pane-frame"]') as HTMLElement).dataset.e2eMark = 'kept';
    });
    await page.getByTestId('activity-pane-pin').click();
    await expect(page.getByTestId('activity-pane-slot')).toHaveAttribute('data-pinned', 'true');
    await page.getByTestId('activity-pane-pin').click();
    await expect(page.getByTestId('activity-pane-slot')).toHaveAttribute('data-pinned', 'false');
    await expect(page.getByTestId('activity-pane-frame')).toHaveAttribute('data-e2e-mark', 'kept');
  });

  test('Esc on the icon closes a pinned pane too', async ({ page }) => {
    await page.addInitScript(key => {
      try {
        localStorage.setItem(key, 'true');
      } catch {
        /* non-fatal */
      }
    }, ACTIVITY_PANE_PINNED_KEY);
    await openScreen(page);
    const files = page.getByTestId('activity-bar-button-files');
    await files.click();
    await expect(page.getByTestId('activity-pane-slot')).toHaveAttribute('data-pinned', 'true');
    await files.focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
    await expect(files).toBeFocused();
  });

  test('Esc in the file search box clears it and keeps the pane open', async ({ page }) => {
    await openScreen(page);
    await page.getByTestId('activity-bar-button-files').click();
    const input = page.getByTestId('search-input');
    await input.fill('abc');
    await input.press('Escape');
    await expect(input).toHaveValue('');
    await expect(page.getByTestId('activity-pane-slot')).toBeVisible();

    // Esc elsewhere in the pane still closes it.
    await page.getByTestId('activity-pane-title').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
  });
});
