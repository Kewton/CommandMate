/**
 * E2E: RouteLoading fallback height and centering (#2683, #2693).
 *
 * 測るのは className の文字列ではなく実寸 (getBoundingClientRect) である。
 * #2683 で導入された `flex-1` は、親の `<main data-view-transition="content">` が
 * `display: block` であるため効かず、ドットが上端 192px に寄っていた。
 * この E2E テストはその再発を実寸で防ぐ。
 *
 * `loading.tsx` のフォールバックはクライアント遷移のときだけ描画される。
 *
 * [Issue #4335] 窓の作り方を変えた。以前は RSC 取得（`_rsc`）を固定 3 秒遅らせ、クリック後に
 * Node から 50ms ごとに採取していたが、実測（helpers/route-loading-observer.ts の冒頭）では
 * RSC を止めている間フォールバックは一度も挿入されない（先読みが無いと、router は応答が来るまで
 * その segment に loading.tsx があることを知らない）。フォールバックは RSC の応答の後、遷移先の
 * page の client chunk を読む間だけ出る。そこで遷移先の chunk を止めて窓を作り、ブラウザ内の
 * 観測で挿入を捉えて実寸を測ってから chunk を解放する。固定の待ち時間は使わない。
 * 最後の control は、以前の固定 RSC 遅延ではフォールバックが止めている間に出ないことを記録する。
 */

import { test, expect, type Page } from '@playwright/test';
import {
  armFixedRscDelay,
  observeHeldRouteLoading,
  type LoadingObservation,
} from './helpers/route-loading-observer';

/** The client chunk of the destination page (/sessions); holding it keeps the fallback up. */
const SESSIONS_PAGE_CHUNK = (url: URL) => url.pathname.includes('/_next/static/chunks/app/sessions/');

/**
 * Click the sidebar's Sessions link with the fallback held, and return its measurement. A null
 * shot fails with the recorded facts (which request was caught, insertion / removal, document).
 */
async function captureRouteLoading(page: Page): Promise<LoadingObservation> {
  const { shot, diagnostics } = await observeHeldRouteLoading(page, SESSIONS_PAGE_CHUNK, () =>
    page.getByTestId('sidebar-nav-sessions').click(),
  );
  // eslint-disable-next-line no-console -- the recorded facts of this transition
  console.log('ROUTE-LOADING-4335', JSON.stringify(diagnostics));
  expect(diagnostics.held, `the destination page chunk was not requested: ${JSON.stringify(diagnostics)}`).toBeGreaterThan(0);
  expect(shot, `route-loading was not observed during the held transition: ${JSON.stringify(diagnostics)}`).not.toBeNull();
  return shot!;
}

test.describe.serial('[#2693] route-loading fallback height and centering', () => {
  test.setTimeout(60_000);

  test('PC でメイン領域を満たす', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/repositories');
    await expect(page.getByTestId('app-shell')).toBeVisible();

    const shot = await captureRouteLoading(page);

    const { loadingRect, mainRect } = shot;

    // eslint-disable-next-line no-console -- measurement evidence
    console.log('MEASURE-2693 PC', JSON.stringify({ loadingRect, mainRect }));

    // フォールバックの高さが <main> の高さの 95% 以上である
    expect(loadingRect.height).toBeGreaterThanOrEqual(mainRect.height * 0.95);

    // フォールバックの上端・下端が <main> の矩形に収まる（±2px の許容）
    expect(loadingRect.top).toBeGreaterThanOrEqual(mainRect.top - 2);
    expect(loadingRect.bottom).toBeLessThanOrEqual(mainRect.bottom + 2);

    // フォールバックの縦中心と <main> の縦中心の差が 4px 以内である
    const mainCenter = (mainRect.top + mainRect.bottom) / 2;
    const loadingCenter = (loadingRect.top + loadingRect.bottom) / 2;
    expect(Math.abs(loadingCenter - mainCenter)).toBeLessThanOrEqual(4);

    // フォールバックがビューポートからはみ出さない（100vh で <main> を越えない）。
    // Issue #3579: 全幅の帯をやめて <main> がビューポートの全高になったので、
    // 「900 未満」ではなく「<main> の高さ以下・ビューポート高さ（900）以下」で確かめる。
    expect(loadingRect.height).toBeLessThanOrEqual(mainRect.height + 2);
    expect(loadingRect.height).toBeLessThanOrEqual(900);
  });

  test('スマホで下部ナビに重ならない', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/repositories');
    await expect(page.getByTestId('app-shell')).toBeVisible();

    // 下部ナビの「サイドバーを開く」を押してドロワーを開く
    const openSidebarBtn = page.getByTestId('mobile-nav-open-sidebar');
    await expect(openSidebarBtn).toBeVisible();
    await openSidebarBtn.click();
    await expect(page.getByTestId('sidebar-container')).toBeVisible();

    const shot = await captureRouteLoading(page);

    const { loadingRect, mainRect, navRect, paddingTop, paddingBottom } = shot;

    // eslint-disable-next-line no-console -- measurement evidence
    console.log('MEASURE-2693 Mobile', JSON.stringify({ loadingRect, mainRect, navRect, paddingTop, paddingBottom }));

    // [data-testid="global-mobile-nav"] が存在し、高さが 0 より大きい
    expect(navRect).not.toBeNull();
    expect(navRect!.height).toBeGreaterThan(0);

    // フォールバックの下端が下部ナビの上端を越えない（+1px の許容）
    expect(loadingRect.bottom).toBeLessThanOrEqual(navRect!.top + 1);

    // <main> の「利用可能領域」に対して中央に来ている
    const availTop = mainRect.top + paddingTop;
    const availBottom = mainRect.bottom - paddingBottom;
    const availHeight = availBottom - availTop;

    // 高さ: 利用可能領域の 95% 以上
    expect(loadingRect.height).toBeGreaterThanOrEqual(availHeight * 0.95);

    // 中心: |(loadingTop+loadingBottom)/2 - (availTop+availBottom)/2| <= 4
    const availCenter = (availTop + availBottom) / 2;
    const loadingCenter = (loadingRect.top + loadingRect.bottom) / 2;
    expect(Math.abs(loadingCenter - availCenter)).toBeLessThanOrEqual(4);
  });

  test('高さ auto の親でも潰れない（実寸で見る）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/repositories');
    await expect(page.getByTestId('app-shell')).toBeVisible();

    const shot = await captureRouteLoading(page);

    // 窓の中で、フォールバックの className をそのまま読み取ってから
    const height = await page.evaluate((cls) => {
      const host = document.createElement('div'); // 高さ auto の親
      const probe = document.createElement('div');
      probe.className = cls;
      host.appendChild(probe);
      document.body.appendChild(host);
      const h = probe.getBoundingClientRect().height;
      host.remove();
      return h;
    }, shot.className);

    expect(height).toBeGreaterThanOrEqual(192);

    // eslint-disable-next-line no-console -- measurement evidence
    console.log('MEASURE-2693 Auto', JSON.stringify({ height, observedClassName: shot.className, minHeight: shot.minHeight }));

    // あわせて、描かれたフォールバックの getComputedStyle(el).minHeight が '192px' であることも確かめる
    expect(shot.minHeight).toBe('192px');
  });

  test('control (#4335): a fixed RSC delay never shows the fallback while it holds', async ({ page }) => {
    // The old arming, recorded: the fallback's insertions are all after the RSC was released, so
    // a window made by holding the RSC has no fallback in it (the old spec's null at line 125).
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/repositories');
    await expect(page.getByTestId('app-shell')).toBeVisible();

    const old = await armFixedRscDelay(page, 3000);
    await page.getByTestId('sidebar-nav-sessions').click();
    await expect.poll(() => old.releasedAt().length, { timeout: 45_000 }).toBeGreaterThan(0);
    await expect(page).toHaveURL(/\/sessions/, { timeout: 45_000 });
    await expect(page.getByTestId('route-loading')).toHaveCount(0, { timeout: 15_000 });

    const record = await old.read();
    // eslint-disable-next-line no-console -- the recorded facts of the old arming
    console.log('ROUTE-LOADING-4335 control', JSON.stringify({ releasedAt: old.releasedAt(), record }));
    expect(record?.sameDocument).toBe(true);
    const [releasedAt] = old.releasedAt();
    for (const insertedAt of record!.inserted) expect(insertedAt).toBeGreaterThan(releasedAt);
  });
});
