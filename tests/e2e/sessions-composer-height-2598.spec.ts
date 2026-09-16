/**
 * E2E: the height handle on a `/sessions` tile (Issue #2598).
 *
 * The tile is a fixed 35rem card whose body keeps a 15rem floor
 * (`SESSION_TILE_BODY_FLOOR_CLASS`), so the handle's bound there is whatever
 * the body has above 240px — measured below, and written into the height
 * budget table of `SessionTile.tsx`. The claims:
 *
 * - the tile's composer draws the handle (a PC), and a drag changes the height;
 * - however far it is pulled, the body keeps its floor and the send button
 *   stays inside the card;
 * - the height is stored under the tile's own scope, not split 0's, and
 *   survives a reload.
 *
 * No agent process is involved; `/api/` is mocked in the browser.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  E2E_COMPOSER_WORKTREE,
  composerHeightKey,
  openSessionTiles,
} from './fixtures/composer-height-helpers';
import {
  COMPOSER_MIN_HEIGHT_PX,
  SESSION_TILE_COMPOSER_HEIGHT_SCOPE,
  composerHeightScopeForSplit,
} from '../../src/config/composer-height';

/** `SESSION_TILE_BODY_FLOOR_CLASS` (15rem) in px; mirrored, the module is a client component. */
const TILE_BODY_FLOOR_PX = 240;

const ID = E2E_COMPOSER_WORKTREE;

test.use({ viewport: { width: 1440, height: 900 } });

function rects(page: Page) {
  return page.evaluate(id => {
    const rect = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width };
    };
    const composer = `[data-testid="session-tile-composer-${id}"]`;
    return {
      tile: rect(`[data-testid="session-tile-${id}"]`),
      body: rect(`[data-testid="session-tile-body-${id}"]`),
      composer: rect(composer),
      textarea: rect(`${composer} [data-testid="message-input-textarea"]`),
      send: rect(`${composer} [data-testid="send-message-button"]`),
      toolbar: rect(`${composer} [data-testid="composer-toolbar"]`),
    };
  }, ID);
}

async function dragTileHandle(page: Page, dy: number): Promise<void> {
  const handle = page
    .getByTestId(`session-tile-composer-${ID}`)
    .getByRole('separator', { name: /message box|入力欄/ });
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 8 });
  await page.mouse.up();
}

test.describe('[#2598] sessions tile height handle', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'PC-only layout (chromium only)');
  });

  test('draws the two-row composer and a handle, and keeps the body on its floor', async ({ page }) => {
    await openSessionTiles(page);
    const composer = page.getByTestId(`session-tile-composer-${ID}`);
    await expect(composer.getByRole('separator', { name: /message box|入力欄/ })).toBeVisible();

    const before = await rects(page);
    // eslint-disable-next-line no-console -- the measurement is the deliverable
    console.log('MEASURE-2598 tile before ' + JSON.stringify(before));
    expect(before.textarea!.height).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(before.toolbar!.bottom).toBeLessThanOrEqual(before.textarea!.top + 0.5);

    // Pull it as far as it goes.
    await dragTileHandle(page, -1000);
    await expect.poll(async () => (await rects(page)).textarea!.height).toBeGreaterThan(COMPOSER_MIN_HEIGHT_PX);
    const after = await rects(page);
    // eslint-disable-next-line no-console -- the measurement is the deliverable
    console.log('MEASURE-2598 tile ceiling ' + JSON.stringify(after));

    expect(after.body!.height).toBeGreaterThanOrEqual(TILE_BODY_FLOOR_PX - 0.5);
    // The body gave up exactly what the textarea took.
    expect(
      Math.abs((after.textarea!.height - before.textarea!.height) - (before.body!.height - after.body!.height)),
    ).toBeLessThanOrEqual(1);
    // The send button is inside the card.
    expect(after.send!.bottom).toBeLessThanOrEqual(after.tile!.bottom + 0.5);
    expect(after.composer!.bottom).toBeLessThanOrEqual(after.tile!.bottom + 0.5);

    // Stored under the tile's scope, and not under split 0's.
    const stored = await page.evaluate(
      k => localStorage.getItem(k),
      composerHeightKey(ID, SESSION_TILE_COMPOSER_HEIGHT_SCOPE),
    );
    expect(stored).toBe(String(Math.round(after.textarea!.height)));
    expect(
      await page.evaluate(k => localStorage.getItem(k), composerHeightKey(ID, composerHeightScopeForSplit(0))),
    ).toBeNull();

    // It survives a reload.
    await page.reload();
    await page.getByTestId(`session-tile-composer-${ID}`).waitFor({ state: 'visible', timeout: 30_000 });
    await expect.poll(async () => (await rects(page)).textarea?.height).toBe(Number(stored));

    // Pulling down returns to one line; a double-click to auto-grow.
    await dragTileHandle(page, 400);
    await expect.poll(async () => (await rects(page)).textarea!.height).toBe(COMPOSER_MIN_HEIGHT_PX);
    await composer.getByRole('separator', { name: /message box|入力欄/ }).dblclick();
    await expect
      .poll(() =>
        page.evaluate(k => localStorage.getItem(k), composerHeightKey(ID, SESSION_TILE_COMPOSER_HEIGHT_SCOPE)),
      )
      .toBeNull();
  });

  test('does not let the split pane’s stored height into the tile', async ({ page }) => {
    await page.addInitScript(
      ({ key }) => {
        try {
          localStorage.setItem(key, '300');
        } catch {
          /* ignore */
        }
      },
      { key: composerHeightKey(ID, composerHeightScopeForSplit(0)) },
    );
    await openSessionTiles(page);
    expect((await rects(page)).textarea!.height).toBe(COMPOSER_MIN_HEIGHT_PX);
  });
});
