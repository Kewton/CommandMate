/**
 * E2E: パネルの外側をクリックするとモーダルが閉じる（Issue #2715 / #2716）。
 *
 * この欠陥は実ブラウザでしか観測できない。原因はレイヤの重なりで、
 * backdrop（fixed）がパネルのラッパー（DOM順で後ろのpositioned要素）に
 * 覆われてクリックを受け取れない、というものだった。jsdomはヒットテストを
 * しないので、単体テストはbackdropへ直接イベントを撃てば壊れたコードでも通る。
 *
 * したがってこのspecは次の2つを実ブラウザで測る。
 *   1. document.elementFromPoint() が、パネル外の座標で何を返すか
 *   2. その座標を page.mouse.click() で実際に押したときにモーダルが閉じるか
 *
 * getByTestId(...).click() を使わないのは、ラッパーの中心がパネルの内側に
 * あるため、そのAPIでは「パネルの外側の既知の座標」を検査できないからである。
 *
 * 「閉じない」側の3本は expectStillOpen() を通す。理由はそのJSDocに書いた。
 */

import { test, expect, type Page } from '@playwright/test';
import { EXIT_ANIMATION_DURATION_MS } from '@/config/ui-feedback-config';

const HEADER_SETTINGS = 'header nav a[aria-haspopup="dialog"]';

async function openSettingsModal(page: Page): Promise<void> {
  await page.goto('/sessions');
  await page.locator(HEADER_SETTINGS).waitFor();
  await page.locator(HEADER_SETTINGS).click();
  await page.locator('[role="dialog"]').waitFor();
}

/** パネルの左脇にある、確実にパネル外の座標。 */
async function pointOutsidePanel(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('[data-testid="modal-panel"]').boundingBox();
  if (!box) throw new Error('modal panel has no box');
  return { x: Math.max(6, Math.round(box.x / 2)), y: Math.round(box.y + box.height / 2) };
}

/** パネルの内側の、ヘッダー付近の座標。 */
async function pointInsidePanel(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('[data-testid="modal-panel"]').boundingBox();
  if (!box) throw new Error('modal panel has no box');
  return { x: Math.round(box.x + 40), y: Math.round(box.y + 40) };
}

/**
 * 「閉じなかった」を測る。
 *
 * 操作の直後に `toHaveCount(1)` を置くだけでは**何も測れない**。Modal は閉じても
 * 退場アニメーションの窓（EXIT_ANIMATION_DURATION_MS / useExitAnimation、Issue #1114）の
 * あいだ DOM に残るので、閉じ始めていても最初のポーリングで count は 1 を返し、
 * 自動リトライの assert はその場で成功してしまう。実測でも、閉じる条件を
 * mousedown だけに落とす変異（下の 4 本目が捕まえるべき欠陥）を注入しても
 * 5 本すべて緑になった —— 空虚な緑である。
 *
 * だから窓を越えるまで待ち、そのうえで「まだ在る」と「まだ open のまま」を測る。
 * data-state も見るのは、窓が伸びたときに count だけの検査が再び空虚になるのを
 * 防ぐため（閉じ始めた瞬間に data-state は "closed" へ変わる）。
 */
async function expectStillOpen(page: Page): Promise<void> {
  await page.waitForTimeout(EXIT_ANIMATION_DURATION_MS * 2);
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="modal-panel"]')).toHaveAttribute(
    'data-state',
    'open'
  );
}

test.describe('Modal outside click (Issue #2715)', () => {
  test('クリックを受け取るのはラッパーで、そこを押すと閉じる', async ({ page }) => {
    await openSettingsModal(page);
    const pt = await pointOutsidePanel(page);

    const topmost = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el
          ? { testid: el.getAttribute('data-testid'), cls: String(el.className) }
          : null;
      },
      pt
    );
    expect(topmost?.testid).toBe('modal-backdrop-surface');

    await page.mouse.click(pt.x, pt.y);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  });

  test('パネルの中をクリックしても閉じない', async ({ page }) => {
    await openSettingsModal(page);
    const inside = await pointInsidePanel(page);
    await page.mouse.click(inside.x, inside.y);
    await expectStillOpen(page);
  });

  test('パネル内で押して外で離しても閉じない（テキスト選択のドラッグ）', async ({ page }) => {
    await openSettingsModal(page);
    const inside = await pointInsidePanel(page);
    const outside = await pointOutsidePanel(page);

    await page.mouse.move(inside.x, inside.y);
    await page.mouse.down();
    await page.mouse.move(outside.x, outside.y);
    await page.mouse.up();

    await expectStillOpen(page);
  });

  test('パネル外で押して中で離しても閉じない', async ({ page }) => {
    await openSettingsModal(page);
    const inside = await pointInsidePanel(page);
    const outside = await pointOutsidePanel(page);

    await page.mouse.move(outside.x, outside.y);
    await page.mouse.down();
    await page.mouse.move(inside.x, inside.y);
    await page.mouse.up();

    await expectStillOpen(page);
  });

  test('Escape と閉じるボタンは従来どおり閉じる', async ({ page }) => {
    await openSettingsModal(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    await openSettingsModal(page);
    await page.locator('[role="dialog"] button[aria-label]').first().click();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  });
});
