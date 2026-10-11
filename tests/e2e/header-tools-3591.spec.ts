/**
 * E2E: the vertical activity bar's column is gone; the worktree's tools sit at
 * the right of the header and their pane opens from the right (Issue #3591).
 *
 * What this proves that the component tests cannot: real widths. At 1440×900
 * every tool is one click away from the top (nine header tools plus the
 * Verification chip on the second row); on a narrow window the trailing tools
 * fold behind "…" (two clicks); with the sidebar closed the only column left
 * of the body is the app's icon rail. Keyboard paths are driven with real key
 * presses, so the focus that comes back after a close is the browser's.
 *
 * PC-only surface → self-skip outside chromium, mirroring the split specs.
 */

import { test, expect, type Page } from '@playwright/test';
import { E2E_WORKTREE_A, setupSplitTest } from './fixtures/terminal-split-helpers';

const TOOL_IDS = ['files', 'git', 'notes', 'schedules', 'agent', 'timer', 'todo', 'skills', 'env'];

async function setSidebar(page: Page, open: boolean) {
  await page.addInitScript(value => {
    try {
      localStorage.setItem('mcbd-sidebar-open', String(value));
    } catch {
      /* non-fatal */
    }
  }, open);
}

async function openScreen(page: Page) {
  await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
  await expect(page.getByTestId('terminal-split-container')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('header-tool-bar')).toBeVisible();
}

test.describe('Worktree tools in the header (Issue #3591)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC-only layout (chromium only)');
    await setupSplitTest(page, [E2E_WORKTREE_A]);
  });

  for (const sidebarOpen of [true, false]) {
    test(`1440×900: every tool is one click away from the top (sidebar ${sidebarOpen ? 'open' : 'closed'})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await setSidebar(page, sidebarOpen);
      await openScreen(page);

      const header = (await page.getByTestId('desktop-header').boundingBox())!;
      for (const id of TOOL_IDS) {
        const tool = page.getByTestId(`header-tool-${id}`);
        await expect(tool).toBeVisible();
        const b = (await tool.boundingBox())!;
        expect(b.y).toBeGreaterThanOrEqual(header.y);
        expect(b.y + b.height).toBeLessThanOrEqual(header.y + header.height + 0.5);
        expect(b.x + b.width).toBeLessThanOrEqual(header.x + header.width + 0.5);
      }
      await expect(page.getByTestId('header-tool-more')).toHaveCount(0);
      await expect(page.getByTestId('header-tool-verification')).toHaveCount(0);
      await expect(page.getByTestId('verification-status-chip')).toBeVisible();

      testInfo.annotations.push({
        type: 'header',
        description: `1440x900, sidebar ${sidebarOpen ? 'open' : 'closed'}: header ${Math.round(header.width)}px, 9 tools in a row`,
      });
    });
  }

  test('no vertical activity bar: with the sidebar closed the icon rail is the only column left of the body', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setSidebar(page, false);
    await openScreen(page);
    await expect(page.getByTestId('activity-bar')).toHaveCount(0);

    const rail = (await page.getByTestId('sidebar-rail').boundingBox())!;
    const header = (await page.getByTestId('desktop-header').boundingBox())!;
    const body = (await page.getByTestId('desktop-layout').boundingBox())!;
    expect(header.x).toBeLessThanOrEqual(rail.x + rail.width + 1);
    expect(body.x).toBeLessThanOrEqual(rail.x + rail.width + 1);
  });

  test('the pane opens from the right over the body, which keeps its width', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScreen(page);
    const before = (await page.getByTestId('terminal-split-container').boundingBox())!;

    await page.getByTestId('header-tool-notes').click();
    const slot = page.getByTestId('activity-pane-slot');
    await expect(slot).toBeVisible();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'notes');

    const after = (await page.getByTestId('terminal-split-container').boundingBox())!;
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.width).toBeCloseTo(before.width, 0);
    const pane = (await slot.boundingBox())!;
    expect(pane.x).toBeGreaterThan(before.x + before.width / 2);
  });

  test('keyboard: ←/→ and Home/End move, Enter opens, Esc closes and focus comes back', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScreen(page);
    const files = page.getByTestId('header-tool-files');
    await files.focus();

    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('header-tool-git')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByTestId('header-tool-env')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(files).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('header-tool-env')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('header-tool-git')).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'git');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
    await expect(page.getByTestId('header-tool-git')).toBeFocused();

    // Space toggles too, and × hands focus back as well.
    await page.keyboard.press(' ');
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'git');
    await page.getByTestId('activity-pane-close').click();
    await expect(page.getByTestId('header-tool-git')).toBeFocused();
  });

  test('the Verification chip opens its pane, and Esc hands focus back to the chip', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScreen(page);
    const chip = page.getByTestId('verification-status-chip');
    await chip.click();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'verification');
    await chip.focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
    await expect(chip).toBeFocused();
  });

  test('narrow window: trailing tools fold behind "…", reachable by mouse and keyboard', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await setSidebar(page, true);
    await openScreen(page);

    const more = page.getByTestId('header-tool-more');
    await expect(more).toBeVisible();
    const visible: string[] = [];
    for (const id of TOOL_IDS) {
      if ((await page.getByTestId(`header-tool-${id}`).count()) > 0) visible.push(id);
    }
    // The visible ones are a prefix: the trailing ones fold first.
    expect(visible).toEqual(TOOL_IDS.slice(0, visible.length));
    expect(visible.length).toBeLessThan(TOOL_IDS.length);
    const folded = TOOL_IDS.slice(visible.length);
    const last = folded[folded.length - 1];

    // Mouse: two clicks.
    await more.click();
    await page.getByTestId(`header-tool-more-item-${last}`).click();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', last);
    // The open tool is folded: "…" carries the mark.
    await expect(more).toHaveAttribute('data-active', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('data-active', 'false');

    // Keyboard: Enter on "…" opens the list on its first tool; Tab moves through it.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(`header-tool-more-item-${folded[0]}`)).toBeFocused();
    if (folded.length > 1) {
      await page.keyboard.press('Tab');
      await expect(page.getByTestId(`header-tool-more-item-${folded[1]}`)).toBeFocused();
    }
    await page.keyboard.press('Enter');
    const picked = folded.length > 1 ? folded[1] : folded[0];
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', picked);
    await expect(more).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
    await expect(more).toBeFocused();

    testInfo.annotations.push({
      type: 'header',
      description: `1024x768, sidebar open: ${visible.length} tools in the row, ${folded.length} behind "…"`,
    });
  });
});
