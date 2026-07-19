'use client';

/**
 * Root error boundary (Issue #1404).
 *
 * `global-error.tsx` replaces the root layout when an error escapes it, so it
 * must render its own `<html>`/`<body>`. Two consequences drive this file:
 *   1. NextIntlClientProvider is NOT mounted — `useTranslations` would throw, so
 *      the copy comes from a small provider-independent fallback dictionary.
 *   2. `globals.css` (imported by the bypassed root layout) is NOT loaded — so
 *      Tailwind utility classes have no effect and styling must be inline.
 *
 * A `ChunkLoadError` (stale tab after a server upgrade) self-heals with a single
 * guarded reload; any other error stays put with a manual reload button.
 */

import { useEffect, useState } from 'react';
import { isChunkLoadError, recoverFromChunkErrorInBrowser } from '@/lib/error/chunk-reload';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

type FallbackLocale = 'en' | 'ja';

const FALLBACK_MESSAGES: Record<FallbackLocale, {
  chunkTitle: string;
  chunkDescription: string;
  genericTitle: string;
  genericDescription: string;
  reload: string;
}> = {
  en: {
    chunkTitle: 'Updating to the latest version',
    chunkDescription:
      'A newer version of CommandMate is available. Reloading to get the latest update…',
    genericTitle: 'Something went wrong',
    genericDescription: 'An unexpected error occurred. Please reload the page.',
    reload: 'Reload',
  },
  ja: {
    chunkTitle: '最新バージョンに更新しています',
    chunkDescription:
      'CommandMate の新しいバージョンが利用可能です。最新の状態にするため再読み込みします…',
    genericTitle: '問題が発生しました',
    genericDescription: '予期しないエラーが発生しました。ページを再読み込みしてください。',
    reload: '再読み込み',
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

export default function GlobalError({ error }: GlobalErrorProps) {
  const chunk = isChunkLoadError(error);
  // Default to 'en' for the SSR/first paint, then refine on the client where
  // document/navigator are available.
  const [locale, setLocale] = useState<FallbackLocale>('en');

  useEffect(() => {
    setLocale(detectLocale());
    if (chunk) {
      recoverFromChunkErrorInBrowser(error);
    }
  }, [chunk, error]);

  const m = FALLBACK_MESSAGES[locale];

  return (
    <html lang={locale} style={{ colorScheme: 'light dark' }}>
      <body
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
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: '0 0 0.5rem' }}>
            {chunk ? m.chunkTitle : m.genericTitle}
          </h1>
          <p style={{ fontSize: '0.875rem', opacity: 0.75, margin: 0 }}>
            {chunk ? m.chunkDescription : m.genericDescription}
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
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
          {m.reload}
        </button>
      </body>
    </html>
  );
}
