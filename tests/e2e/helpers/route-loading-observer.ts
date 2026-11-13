/**
 * Issue #4335: observe the route-level `loading.tsx` fallback from inside the browser, and keep it
 * on screen by holding the request it actually waits for.
 *
 * What the old spec assumed, and what was measured (2026-11-13, dev server, /repositories →
 * /sessions, in-page MutationObserver + request log):
 *  - The old spec delayed the transition's `_rsc` request by a fixed 3 s and polled from Node for
 *    6 s after the click. The fallback is NEVER inserted while the RSC request is held: without a
 *    prefetch (none in dev; production prefetches are aborted by the spec) the router does not
 *    know the segment has a `loading.tsx` until the RSC answer arrives, so it keeps the old page.
 *  - The fallback is inserted after the RSC answer, while the page's client chunk
 *    (`/_next/static/chunks/app/sessions/page.js`) loads, and removed when that chunk arrives.
 *  - A cold `/sessions` compiles for ~10 s before the RSC answers (7615 modules), past the old
 *    6 s window: null every time. Warm, the chunk loads in milliseconds: a flash a 50 ms Node poll
 *    catches or misses. Hence red / green on retry in CI, and 3 / 3 red locally (cold).
 *
 * So the hold point here is the page's client chunk, not the RSC: holding it keeps the fallback up
 * for as long as it is held. The observer is installed in the page before the click, takes the
 * rect two animation frames after the insertion (in the browser, never by a Node poll racing it),
 * and the chunk is released only once that measurement exists (or a ceiling). Every fact is
 * recorded (`RouteLoadingDiagnostics`), so a failure says which branch it is.
 */

import type { Page, Route } from '@playwright/test';

export interface Rect {
  top: number;
  bottom: number;
  height: number;
}

export interface LoadingObservation {
  loadingRect: Rect;
  mainRect: Rect;
  navRect: Rect | null;
  paddingTop: number;
  paddingBottom: number;
  className: string;
  minHeight: string;
}

/** What the browser saw, in order. Times are `performance.now()` of the document. */
export interface BrowserRecord {
  /** Still the document the click was made in (false: a document navigation replaced it). */
  sameDocument: boolean;
  inserted: number[];
  removed: number[];
  /** Measurements taken two frames after an insertion; height 0 is kept, not dropped. */
  measured: Array<{ at: number; observation: LoadingObservation | null; reason?: string }>;
}

export interface RouteLoadingDiagnostics {
  /** Prefetch `_rsc` requests aborted (so the click has to fetch). */
  prefetchAborted: number;
  /** Non-prefetch `_rsc` requests made after the click (not held). */
  rscRequests: number;
  /** Page-chunk requests caught and held. */
  held: number;
  /** Released because the browser reported a measurement. */
  releasedOnMeasure: number;
  /** Released because the ceiling ran out with nothing measured. */
  releasedOnCeiling: number;
  browser: BrowserRecord | null;
}

declare global {
  interface Window {
    __routeLoading4335?: {
      marker: string;
      inserted: number[];
      removed: number[];
      measured: Array<{ at: number; observation: LoadingObservation | null; reason?: string }>;
      observer: MutationObserver;
    };
  }
}

/**
 * Install the in-page observer. Call after the page has loaded and BEFORE the click; it lives in
 * this document only, so after a document navigation `read()` reports `sameDocument: false`.
 */
async function installObserver(page: Page, marker: string): Promise<void> {
  await page.evaluate((m) => {
    const measure = (): { observation: LoadingObservation | null; reason?: string } => {
      const loading = document.querySelector('[data-testid="route-loading"]');
      const main = document.querySelector('main[data-view-transition="content"]');
      if (!loading) return { observation: null, reason: 'route-loading gone before it was measured' };
      if (!main) return { observation: null, reason: 'main[data-view-transition="content"] missing' };
      const lr = loading.getBoundingClientRect();
      const mr = main.getBoundingClientRect();
      const nav = document.querySelector('[data-testid="global-mobile-nav"]');
      const nr = nav ? nav.getBoundingClientRect() : null;
      const cs = window.getComputedStyle(main);
      const lcs = window.getComputedStyle(loading);
      return {
        observation: {
          loadingRect: { top: lr.top, bottom: lr.bottom, height: lr.height },
          mainRect: { top: mr.top, bottom: mr.bottom, height: mr.height },
          navRect: nr ? { top: nr.top, bottom: nr.bottom, height: nr.height } : null,
          paddingTop: parseFloat(cs.paddingTop) || 0,
          paddingBottom: parseFloat(cs.paddingBottom) || 0,
          className: (loading as HTMLElement).className,
          minHeight: lcs.minHeight,
        },
      };
    };
    let present = false;
    const record = {
      marker: m,
      inserted: [] as number[],
      removed: [] as number[],
      measured: [] as Array<{ at: number; observation: LoadingObservation | null; reason?: string }>,
      observer: null as unknown as MutationObserver,
    };
    record.observer = new MutationObserver(() => {
      const now = !!document.querySelector('[data-testid="route-loading"]');
      if (now === present) return;
      present = now;
      if (now) {
        record.inserted.push(performance.now());
        requestAnimationFrame(() =>
          requestAnimationFrame(() => record.measured.push({ at: performance.now(), ...measure() })),
        );
      } else {
        record.removed.push(performance.now());
      }
    });
    record.observer.observe(document.documentElement, { childList: true, subtree: true });
    window.__routeLoading4335 = record;
  }, marker);
}

async function readBrowser(page: Page, marker: string): Promise<BrowserRecord | null> {
  try {
    return await page.evaluate((m) => {
      const r = window.__routeLoading4335;
      if (!r || r.marker !== m) return { sameDocument: false, inserted: [], removed: [], measured: [] };
      return { sameDocument: true, inserted: [...r.inserted], removed: [...r.removed], measured: [...r.measured] };
    }, marker);
  } catch {
    return null;
  }
}

const isRsc = (url: URL) => url.searchParams.has('_rsc');

/**
 * Arm the observer and the hold, click, and return the first measurement of the fallback taken
 * while `holdChunk` requests were held — with the diagnostics either way.
 *
 * `holdChunk` matches the destination page's client chunk; `click` triggers the transition. The
 * page must already be loaded. Prefetches are aborted as before, so the click has to fetch.
 */
export async function observeHeldRouteLoading(
  page: Page,
  holdChunk: (url: URL) => boolean,
  click: () => Promise<void>,
  { ceilingMs = 45_000 }: { ceilingMs?: number } = {},
): Promise<{ shot: LoadingObservation | null; diagnostics: RouteLoadingDiagnostics }> {
  const marker = `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const diagnostics: RouteLoadingDiagnostics = {
    prefetchAborted: 0,
    rscRequests: 0,
    held: 0,
    releasedOnMeasure: 0,
    releasedOnCeiling: 0,
    browser: null,
  };
  let release!: () => void;
  const released = new Promise<'measured'>((resolve) => {
    release = () => resolve('measured');
  });

  await installObserver(page, marker);
  const onRsc = async (route: Route) => {
    if (route.request().headers()['next-router-prefetch'] === '1') {
      diagnostics.prefetchAborted += 1;
      return route.abort();
    }
    diagnostics.rscRequests += 1;
    return route.continue();
  };
  const onChunk = async (route: Route) => {
    diagnostics.held += 1;
    const ceiling = new Promise<'ceiling'>((resolve) => setTimeout(() => resolve('ceiling'), ceilingMs));
    const why = await Promise.race([released, ceiling]);
    if (why === 'measured') diagnostics.releasedOnMeasure += 1;
    else diagnostics.releasedOnCeiling += 1;
    return route.continue().catch(() => undefined);
  };
  await page.route(isRsc, onRsc);
  await page.route(holdChunk, onChunk);

  try {
    await click();
    const deadline = Date.now() + ceilingMs;
    let shot: LoadingObservation | null = null;
    while (Date.now() < deadline) {
      const record = await readBrowser(page, marker);
      diagnostics.browser = record;
      const first = record?.measured[0];
      if (first) {
        shot = first.observation;
        break;
      }
      if (record && !record.sameDocument) break;
      await page.waitForTimeout(50);
    }
    release();
    // The fallback goes once the chunk arrives; record its removal too.
    await page
      .waitForFunction(() => !document.querySelector('[data-testid="route-loading"]'), undefined, { timeout: 10_000 })
      .catch(() => undefined);
    diagnostics.browser = (await readBrowser(page, marker)) ?? diagnostics.browser;
    return { shot, diagnostics };
  } finally {
    release();
    await page.unroute(holdChunk, onChunk).catch(() => undefined);
    await page.unroute(isRsc, onRsc).catch(() => undefined);
  }
}

/**
 * The OLD arming, kept as the control's subject: every non-prefetch `_rsc` request is delayed by a
 * fixed `delayMs`, and the browser's `performance.now()` at the release is recorded so the control
 * can compare it with the fallback's insertion times. Returns a reader for the browser record.
 */
export async function armFixedRscDelay(
  page: Page,
  delayMs: number,
): Promise<{ releasedAt: () => number[]; read: () => Promise<BrowserRecord | null> }> {
  const marker = `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const releases: number[] = [];
  await installObserver(page, marker);
  await page.route(isRsc, async (route) => {
    if (route.request().headers()['next-router-prefetch'] === '1') return route.abort();
    await new Promise((r) => setTimeout(r, delayMs));
    const at = await page.evaluate(() => performance.now()).catch(() => Number.NaN);
    releases.push(at);
    return route.continue().catch(() => undefined);
  });
  return { releasedAt: () => [...releases], read: () => readBrowser(page, marker) };
}
