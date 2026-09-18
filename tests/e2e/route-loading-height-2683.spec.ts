/**
 * E2E: RouteLoading fallback height and centering (#2683, #2693).
 *
 * 測るのは className の文字列ではなく実寸 (getBoundingClientRect) である。
 * #2683 で導入された `flex-1` は、親の `<main data-view-transition="content">` が
 * `display: block` であるため効かず、ドットが上端 192px に寄っていた。
 * この E2E テストはその再発を実寸で防ぐ。
 *
 * `loading.tsx` のフォールバックはクライアント遷移のときだけ描画される。
 * 通常の遷移では Next.js の高速な処理や先読みによって表示窓が非常に短いため、
 * `page.route` で RSC 取得（`_rsc`）を遅延させて窓を作り、その間に実寸を測定する。
 */

import { test, expect, type Page } from '@playwright/test';

interface LoadingObservation {
  loadingRect: {
    top: number;
    bottom: number;
    height: number;
  };
  mainRect: {
    top: number;
    bottom: number;
    height: number;
  };
  navRect: {
    top: number;
    bottom: number;
    height: number;
  } | null;
  paddingTop: number;
  paddingBottom: number;
  className: string;
  minHeight: string;
}

/**
 * ページを開き終えてから武装する（初回ロードの RSC まで遅らせない）。
 * 先読みは abort して、クリック時にネットワーク取得（RSC）を起こして窓を作る。
 */
async function armRouteDelay(page: Page, delayMs = 3000): Promise<void> {
  await page.route(
    (url) => url.searchParams.has('_rsc'),
    async (route) => {
      if (route.request().headers()['next-router-prefetch'] === '1') {
        return route.abort();
      }
      await new Promise((r) => setTimeout(r, delayMs));
      return route.continue();
    },
  );
}

/**
 * 窓の中で、フォールバックが現れるまで短い間隔（50〜60ms）でポーリングする。
 * waitForSelector は現れた瞬間の寸法を取り逃しうるので、page.evaluate で矩形ごと取る。
 */
async function captureRouteLoading(page: Page, timeoutMs = 6000): Promise<LoadingObservation | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const observation = await page.evaluate(() => {
        const loading = document.querySelector('[data-testid="route-loading"]');
        const main = document.querySelector('main[data-view-transition="content"]');
        if (!loading || !main) return null;

        const loadingRect = loading.getBoundingClientRect();
        if (loadingRect.height === 0) return null;

        const mainRect = main.getBoundingClientRect();
        const nav = document.querySelector('[data-testid="global-mobile-nav"]');
        const navRect = nav ? nav.getBoundingClientRect() : null;
        const cs = window.getComputedStyle(main);
        const loadingCs = window.getComputedStyle(loading);

        return {
          loadingRect: {
            top: loadingRect.top,
            bottom: loadingRect.bottom,
            height: loadingRect.height,
          },
          mainRect: {
            top: mainRect.top,
            bottom: mainRect.bottom,
            height: mainRect.height,
          },
          navRect: navRect
            ? {
                top: navRect.top,
                bottom: navRect.bottom,
                height: navRect.height,
              }
            : null,
          paddingTop: parseFloat(cs.paddingTop) || 0,
          paddingBottom: parseFloat(cs.paddingBottom) || 0,
          className: loading.className,
          minHeight: loadingCs.minHeight,
        };
      });

      if (observation) {
        return observation;
      }
    } catch {
      // ナビゲーション中の一時的なコンテキスト破棄を無視して再試行
    }
    await page.waitForTimeout(50);
  }
  return null;
}

test.describe.serial('[#2693] route-loading fallback height and centering', () => {
  test.setTimeout(60_000);

  test('PC でメイン領域を満たす', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/repositories');
    await expect(page.getByTestId('app-shell')).toBeVisible();

    await armRouteDelay(page, 3000);
    await page.getByTestId('sidebar-nav-sessions').click();

    const shot = await captureRouteLoading(page);
    expect(shot, 'route-loading was not observed during the delayed transition').not.toBeNull();
    if (!shot) return;

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

    // フォールバックの高さがビューポート高さ（900）未満である
    expect(loadingRect.height).toBeLessThan(900);
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

    await armRouteDelay(page, 3000);
    await page.getByTestId('sidebar-nav-sessions').click();

    const shot = await captureRouteLoading(page);
    expect(shot, 'route-loading was not observed during the delayed transition').not.toBeNull();
    if (!shot) return;

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

    await armRouteDelay(page, 3000);
    await page.getByTestId('sidebar-nav-sessions').click();

    const shot = await captureRouteLoading(page);
    expect(shot, 'route-loading was not observed during the delayed transition').not.toBeNull();
    if (!shot) return;

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
});
