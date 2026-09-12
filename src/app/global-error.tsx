'use client';

/**
 * Root error boundary (Issue #1404, #2500).
 *
 * `global-error.tsx` replaces the root layout when an error escapes it, so it
 * must render its own `<html>`/`<body>`. Two consequences drive this file:
 *   1. NextIntlClientProvider is NOT mounted — `useTranslations` would throw, so
 *      the copy comes from a small provider-independent fallback dictionary.
 *   2. `globals.css` (imported by the bypassed root layout) is NOT loaded — so
 *      Tailwind utility classes have no effect and styling must be inline.
 *
 * A chunk load failure caused by a stale build (a tab left open across a server
 * upgrade) self-heals with a single guarded reload. One caused by the device
 * being off the network does NOT (Issue #2500): reloading fetches nothing and
 * throws away whatever the user had in progress, so the page says the connection
 * is down and retries itself via `reset()` once the server answers again.
 * Any other error stays put with a manual reload button.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  browserChunkRetryEnv,
  isChunkLoadError,
  recoverFromChunkErrorInBrowser,
  retryWhenServerReturns,
} from '@/lib/error/chunk-reload';
import { probeServerReachable, subscribeServerReachability } from '@/hooks/useConnectivity';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

type FallbackLocale = 'en' | 'ja';

const FALLBACK_MESSAGES: Record<FallbackLocale, {
  chunkTitle: string;
  chunkDescription: string;
  offlineTitle: string;
  offlineDescription: string;
  offlineWaiting: string;
  genericTitle: string;
  genericDescription: string;
  reload: string;
  retry: string;
}> = {
  en: {
    chunkTitle: 'Updating to the latest version',
    chunkDescription:
      'A newer version of CommandMate is available. Reloading to get the latest update…',
    offlineTitle: "You're offline",
    offlineDescription:
      'Part of the page could not be loaded because the device is off the network. It will be retried automatically as soon as the connection is back.',
    offlineWaiting: 'Waiting for the connection to come back…',
    genericTitle: 'Something went wrong',
    genericDescription: 'An unexpected error occurred. Please reload the page.',
    reload: 'Reload',
    retry: 'Retry',
  },
  ja: {
    chunkTitle: '最新バージョンに更新しています',
    chunkDescription:
      'CommandMate の新しいバージョンが利用可能です。最新の状態にするため再読み込みします…',
    offlineTitle: '接続が切れています',
    offlineDescription:
      'ネットワークに接続できないため、ページの一部を読み込めませんでした。接続が戻り次第、自動でやり直します。',
    offlineWaiting: '接続の回復を待っています…',
    genericTitle: '問題が発生しました',
    genericDescription: '予期しないエラーが発生しました。ページを再読み込みしてください。',
    reload: '再読み込み',
    retry: '再試行',
  },
};

/** Best-effort locale detection without the i18n provider (cookie → navigator). */
function detectLocale(): FallbackLocale {
  if (typeof document !== 'undefined') {
    const match = document.cookie.match(/(?:^|;\s*)locale=([^;]+)/);
    if (match && decodeURIComponent(match[1]).toLowerCase().startsWith('ja')) {
      return 'ja';
    }
  }
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ja')) {
    return 'ja';
  }
  return 'en';
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  const chunk = isChunkLoadError(error);
  // Default to 'en' for the SSR/first paint, then refine on the client where
  // document/navigator are available. `navigator.onLine` is client-only for the
  // same reason, so the offline verdict is resolved here too rather than during
  // render.
  const [locale, setLocale] = useState<FallbackLocale>('en');
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    setLocale(detectLocale());
    if (chunk) {
      setOffline(recoverFromChunkErrorInBrowser(error) === 'offline');
    }
  }, [chunk, error]);

  // Offline: retry as soon as the server answers, without asking the user.
  useEffect(() => {
    if (!offline) return;
    return retryWhenServerReturns(
      reset,
      browserChunkRetryEnv({
        subscribeReachability: subscribeServerReachability,
        probe: () => probeServerReachable(),
      })
    );
  }, [offline, reset]);

  const handleAction = useCallback(() => {
    // Offline: a reload would fetch nothing — re-render the tree instead.
    if (offline) reset();
    else window.location.reload();
  }, [offline, reset]);

  const m = FALLBACK_MESSAGES[locale];
  const title = offline ? m.offlineTitle : chunk ? m.chunkTitle : m.genericTitle;
  const description = offline
    ? m.offlineDescription
    : chunk
      ? m.chunkDescription
      : m.genericDescription;

  return (
    <html lang={locale} style={{ colorScheme: 'light dark' }}>
      <body
        data-error-kind={offline ? 'chunk-offline' : chunk ? 'chunk-reload' : 'unexpected'}
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1.5rem',
          padding: '1.5rem',
          textAlign: 'center',
          background: 'Canvas',
          color: 'CanvasText',
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <div style={{ maxWidth: '24rem' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: '0 0 0.5rem' }}>{title}</h1>
          <p style={{ fontSize: '0.875rem', opacity: 0.75, margin: 0 }}>{description}</p>
          {offline && (
            <p
              role="status"
              aria-live="polite"
              style={{ fontSize: '0.75rem', opacity: 0.6, margin: '0.5rem 0 0' }}
            >
              {m.offlineWaiting}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleAction}
          style={{
            appearance: 'none',
            cursor: 'pointer',
            borderRadius: '0.5rem',
            border: '1px solid currentColor',
            background: 'transparent',
            color: 'inherit',
            padding: '0.5rem 1rem',
            fontSize: '0.875rem',
            fontWeight: 500,
          }}
        >
          {offline ? m.retry : m.reload}
        </button>
      </body>
    </html>
  );
}
