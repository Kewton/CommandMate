'use client';

/**
 * Route-segment error boundary (Issue #1404).
 *
 * A `ChunkLoadError` — a stale tab requesting old-hash chunks after a GUI-driven
 * server upgrade — self-heals with a single guarded reload. Any other error
 * shows a normal recoverable UI with a retry button (matching ErrorBoundary),
 * and is never auto-reloaded.
 *
 * This boundary renders inside the root layout, so NextIntlClientProvider is
 * available and `useTranslations` is safe. The last-resort boundary for errors
 * in the root layout itself is `app/global-error.tsx`.
 */

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { isChunkLoadError, recoverFromChunkErrorInBrowser } from '@/lib/error/chunk-reload';

interface AppErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AppError({ error, reset }: AppErrorProps) {
  const t = useTranslations('error');
  const tCommon = useTranslations('common');
  const chunk = isChunkLoadError(error);

  useEffect(() => {
    if (chunk) {
      recoverFromChunkErrorInBrowser(error);
    }
  }, [chunk, error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 pt-safe pb-safe text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">
          {chunk ? t('chunkReload.title') : t('unexpected.title')}
        </h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          {chunk ? t('chunkReload.description') : t('unexpected.description')}
        </p>
      </div>
      <button
        type="button"
        onClick={chunk ? () => window.location.reload() : reset}
        className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-700"
      >
        {chunk ? tCommon('reload') : tCommon('retry')}
      </button>
    </main>
  );
}
