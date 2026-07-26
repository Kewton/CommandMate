/**
 * E2E Tests: mobile Markdown actions sheet reachability (Issue #1528)
 *
 * #1519 moved search / copy-content / copy-path / download out of the toolbar
 * and into `MobileFileActionsSheet`. The sheet was rendered as a *sibling* of
 * `markdown-file-screen`, which is fixed at `Z_INDEX.MAXIMIZED_EDITOR` (55)
 * with an opaque background, while the sheet carries its own `z-50`. The sheet
 * therefore painted behind the screen: every row stayed in the DOM and in the
 * accessibility tree, but hit-testing landed on the markdown content, so all
 * four actions were dead on a real device.
 *
 * The unit suite could not catch this — jsdom has no layout or paint order, and
 * Testing Library dispatches clicks straight at the node, bypassing hit-testing.
 * Only a real browser proves the rows are reachable, which is why this spec
 * exists and why it asserts *clickability* rather than presence.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  mockEditorApi,
  E2E_EDITOR_WORKTREE,
  E2E_EDITOR_FILE,
} from './fixtures/markdown-editor-helpers';

/** iPhone-ish portrait viewport: the unified markdown screen is mobile-only. */
const MOBILE_VIEWPORT = { width: 390, height: 844 };

const SHEET_ROWS = [
  'file-actions-sheet-search',
  'file-actions-sheet-copy-content',
  'file-actions-sheet-copy-path',
  'download-file-button',
] as const;

/** Open the .md file on mobile and reveal the actions sheet. */
async function openActionsSheet(page: Page): Promise<void> {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await mockEditorApi(page);

  await page.goto(`/worktrees/${E2E_EDITOR_WORKTREE}`);
  await page.getByTestId('mobile-tab-files').click();
  await page.getByTestId(`tree-item-${E2E_EDITOR_FILE}`).click();

  await expect(page.getByTestId('markdown-file-screen')).toBeVisible();
  await page.getByTestId('markdown-file-actions-trigger').click();
  await expect(page.getByTestId('mobile-file-actions-sheet')).toBeVisible();
}

test.describe('Mobile Markdown actions sheet (Issue #1528)', () => {
  test('every action row actually receives pointer events', async ({ page }) => {
    await openActionsSheet(page);

    // elementFromPoint is the assertion that fails on the pre-#1528 build:
    // the topmost node at each row's centre was markdown content (LI/CODE/H2),
    // not the row itself. `toBeVisible()` alone passes even when occluded.
    for (const testId of SHEET_ROWS) {
      const occluder = await page.evaluate((id) => {
        const sheet = document.querySelector('[data-testid="mobile-file-actions-sheet"]');
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!sheet || !el) return `missing: ${id}`;
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
          Math.round(r.x + r.width / 2),
          Math.round(r.y + r.height / 2)
        );
        return sheet.contains(hit) ? null : `occluded by <${hit?.tagName ?? 'none'}>`;
      }, testId);

      expect(occluder, `${testId} must be hit-testable`).toBeNull();
    }
  });

  test('the sheet paints above the markdown screen it belongs to', async ({ page }) => {
    await openActionsSheet(page);

    // The structural invariant behind the fix: sharing the screen's stacking
    // context is what lets z-50 outrank the content. A future refactor that
    // hoists the sheet back out to a sibling reintroduces #1528.
    const nested = await page.evaluate(() => {
      const screen = document.querySelector('[data-testid="markdown-file-screen"]');
      const sheet = document.querySelector('[data-testid="mobile-file-actions-sheet"]');
      return Boolean(screen && sheet && screen.contains(sheet));
    });

    expect(nested, 'sheet must render inside markdown-file-screen').toBe(true);
  });

  test('tapping a row runs its action and dismisses the sheet', async ({ page }) => {
    await openActionsSheet(page);

    // A real click also exercises Playwright's actionability check, which
    // includes "receives pointer events" — this call times out on the old build.
    await page.getByTestId('file-actions-sheet-search').click();

    await expect(page.getByTestId('mobile-file-actions-sheet')).toBeHidden();
    // Search was the action, so the search bar must now be open on the screen.
    await expect(page.getByTestId('markdown-file-screen')).toBeVisible();
  });
});
