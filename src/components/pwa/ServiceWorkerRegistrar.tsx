'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import { Z_INDEX } from '@/config/z-index';
import { shouldRegisterServiceWorker } from '@/lib/pwa/cache-policy';
import { useVersionMismatchBannerVisible } from '@/components/layout/VersionMismatchBanner';

/**
 * Registers the Service Worker (production builds only) and surfaces an
 * "update available" prompt (Issue #1124).
 *
 * Update flow: when a new worker finishes installing while an old one still
 * controls the page, a toast appears. Tapping reload posts SKIP_WAITING to the
 * waiting worker; its activation fires `controllerchange`, which reloads the
 * page onto the new version. Registration is skipped entirely in dev/test and
 * fails silently on insecure contexts (e.g. plain-HTTP LAN access).
 *
 * Two things about the toast are load-bearing, both from Issue #2271:
 *
 *  - It **yields to `VersionMismatchBanner`.** Both prompts mean "reload", and
 *    shown together they said it twice, in two places, in two different words.
 *    The banner wins because it is the more specific claim (a named version
 *    drift, with both versions in it).
 *  - Its full-width positioning container is `pointer-events-none`, and only
 *    the card inside it takes clicks. As a plain `fixed inset-x-0 bottom-0`
 *    element it swallowed every pointer event along the bottom edge of the
 *    viewport — including the composer's Auto-Yes switch, which became
 *    unclickable (Playwright: "intercepts pointer events"). It now sits in the
 *    bottom-right corner as well, so it does not cover the footer even while
 *    the pointer-events opt-out is in force.
 */
export function ServiceWorkerRegistrar() {
  const t = useTranslations('pwa');
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const reloadingRef = useRef(false);
  const versionBannerVisible = useVersionMismatchBannerVisible();

  useEffect(() => {
    if (!shouldRegisterServiceWorker(process.env.NODE_ENV)) return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    let cancelled = false;
    const promptUpdate = (worker: ServiceWorker) => {
      if (!cancelled) setWaitingWorker(worker);
    };

    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        // A worker may already be waiting if it installed before this mounted.
        if (registration.waiting && navigator.serviceWorker.controller) {
          promptUpdate(registration.waiting);
        }
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            // Only a *replacement* worker (controller present) is an update;
            // the very first install has no controller and should not prompt.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              promptUpdate(installing);
            }
          });
        });
      })
      .catch(() => {
        // Non-fatal: insecure context, blocked scope, etc.
      });

    const onControllerChange = () => {
      if (reloadingRef.current) return;
      reloadingRef.current = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  // The version-drift banner already says "reload"; don't say it twice (#2271).
  if (!waitingWorker || versionBannerVisible) return null;

  const applyUpdate = () => {
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  };

  return (
    <div
      data-testid="pwa-update-toast"
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-0 right-0 flex max-w-full justify-end px-4 pb-safe"
      style={{ zIndex: Z_INDEX.TOAST }}
    >
      <div
        data-testid="pwa-update-toast-card"
        className="pointer-events-auto mb-4 flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-lg"
      >
        <span className="text-sm font-medium text-foreground">{t('update.available')}</span>
        <button
          type="button"
          onClick={applyUpdate}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background dark:bg-accent-500 dark:hover:bg-accent-600"
        >
          <RefreshCw className="h-4 w-4" />
          {t('update.reload')}
        </button>
      </div>
    </div>
  );
}
