/**
 * VersionMismatchBanner (#1338 / #1356)
 *
 * When the server is swapped for a newer build while a tab stays open, that tab
 * keeps running the old bundle: lazily-loaded `/_next/static/chunks/*` 404 and
 * realtime events silently drift. The failure disguises itself as a different
 * bug every time (empty sidebar, "client-side exception"), so users burn time
 * chasing phantom defects that a single reload would fix.
 *
 * The server detects the drift during the WebSocket version handshake
 * (useWebSocket sends the bundle version on connect; ws-server replies with a
 * `version_mismatch` event) and this banner turns that signal into an explicit,
 * persistent reload nudge. It never auto-reloads — that would discard whatever
 * the user is typing — and never shows while the versions agree.
 *
 * Both sides of that handshake are **build identities** since #2271: a release
 * that bumps package.json without rebuilding the served `.next` moves neither,
 * so this banner stays silent until a rebuild actually swaps the bundle out.
 *
 * Mounted at the app shell level so it is present on every screen (the #1337
 * lesson: worktree-scoped update UI never mounts on the sidebar/home routes).
 */

'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { Z_INDEX } from '@/config/z-index';
import { useRealtimeListener } from '@/hooks/useRealtimeConnection';
import {
  VERSION_MISMATCH_EVENT_TYPE,
  type RealtimeEvent,
  type VersionMismatchEvent,
} from '@/lib/realtime/types';

interface Mismatch {
  serverVersion: string;
  clientVersion: string;
}

// ---------------------------------------------------------------------------
// Banner visibility store (Issue #2271)
// ---------------------------------------------------------------------------
//
// The Service Worker's "an update is ready" toast and this banner are two
// different signals that both resolve to "reload the page", and #2271 had them
// on screen together saying it twice — the toast at the bottom, over the
// composer's Auto-Yes switch. Rather than move one of them behind the other,
// the toast now yields while the banner is up.
//
// The banner owns the answer because only it knows whether it is *rendered*:
// the raw `version_mismatch` event keeps arriving on every reconnect, so a
// listener in the toast would stay suppressed forever once the user dismissed
// the banner. A count rather than a boolean because React StrictMode
// (`reactStrictMode: true`) runs the publishing effect setup → cleanup → setup,
// and AppShell mounts the banner from either its mobile or its desktop branch.

/** How many mounted banners are currently showing the nudge. */
let visibleBannerCount = 0;
const bannerVisibilityListeners = new Set<() => void>();

function notifyBannerVisibility(): void {
  for (const listener of bannerVisibilityListeners) listener();
}

function subscribeBannerVisibility(listener: () => void): () => void {
  bannerVisibilityListeners.add(listener);
  return () => {
    bannerVisibilityListeners.delete(listener);
  };
}

function getBannerVisibleSnapshot(): boolean {
  return visibleBannerCount > 0;
}

/** Server render has no banner yet, so nothing may be suppressed on its account. */
function getBannerVisibleServerSnapshot(): boolean {
  return false;
}

/**
 * Whether a {@link VersionMismatchBanner} is on screen right now (Issue #2271).
 *
 * Consumed by `ServiceWorkerRegistrar` so the two reload prompts are never
 * shown at the same time. Returns false on the server and before hydration.
 */
export function useVersionMismatchBannerVisible(): boolean {
  return useSyncExternalStore(
    subscribeBannerVisibility,
    getBannerVisibleSnapshot,
    getBannerVisibleServerSnapshot,
  );
}

export function VersionMismatchBanner() {
  const t = useTranslations('common');
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);
  // Once the user dismisses the nudge for a given server version, don't nag
  // again for that same version (reconnects re-emit the event). A later, newer
  // server version re-shows the banner.
  const [dismissedServerVersion, setDismissedServerVersion] = useState<string | null>(null);

  const onEvent = useCallback(
    (event: RealtimeEvent) => {
      if (event.type !== VERSION_MISMATCH_EVENT_TYPE) return;
      const { serverVersion, clientVersion } = event as VersionMismatchEvent;
      if (typeof serverVersion !== 'string' || typeof clientVersion !== 'string') return;
      if (!serverVersion || !clientVersion) return;
      if (serverVersion === dismissedServerVersion) return;
      setMismatch({ serverVersion, clientVersion });
    },
    [dismissedServerVersion],
  );

  useRealtimeListener(onEvent);

  // Publish this banner's visibility so the Service Worker toast can stand down
  // while it is up (Issue #2271).
  const isShowing = mismatch !== null;
  useEffect(() => {
    if (!isShowing) return;
    visibleBannerCount += 1;
    notifyBannerVisibility();
    return () => {
      visibleBannerCount -= 1;
      notifyBannerVisibility();
    };
  }, [isShowing]);

  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  const handleDismiss = useCallback(() => {
    setMismatch((current) => {
      if (current) setDismissedServerVersion(current.serverVersion);
      return null;
    });
  }, []);

  if (!mismatch) return null;

  return (
    <div
      data-testid="version-mismatch-banner"
      role="alert"
      aria-live="assertive"
      className="fixed top-3 left-1/2 -translate-x-1/2 flex items-start gap-3 max-w-[92vw] rounded-lg border border-warning-border bg-warning-subtle px-4 py-3 text-warning-foreground shadow-lg"
      style={{ zIndex: Z_INDEX.TOAST }}
    >
      <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex flex-col gap-0.5 text-sm">
        <span className="font-semibold">{t('versionMismatch.title')}</span>
        <span>
          {t('versionMismatch.description', {
            serverVersion: mismatch.serverVersion,
            clientVersion: mismatch.clientVersion,
          })}
        </span>
      </div>
      <button
        type="button"
        data-testid="version-mismatch-reload"
        onClick={handleReload}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-warning-border px-3 py-1.5 text-sm font-medium hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-offset-2"
      >
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        {t('versionMismatch.reload')}
      </button>
      <button
        type="button"
        data-testid="version-mismatch-dismiss"
        onClick={handleDismiss}
        aria-label={t('versionMismatch.dismiss')}
        className="shrink-0 hover:opacity-70 focus:outline-none focus:ring-2 focus:ring-offset-2"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
