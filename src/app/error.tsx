'use client';

/**
 * Route-segment error boundary (Issue #1404, #2500).
 *
 * A chunk/module load failure is handled according to *why* it failed
 * (`classifyChunkError`):
 *   - `'build'`   — a stale tab requesting old-hash chunks after a GUI-driven
 *                   server upgrade. Self-heals with a single guarded reload.
 *   - `'network'` — the device is off the network (#2500). Nothing is reloaded:
 *                   the page says the connection is down and retries itself via
 *                   `reset()` the moment the server answers again.
 * Any other error shows a normal recoverable UI with a retry button (matching
 * ErrorBoundary), and is never auto-reloaded.
 *
 * The offline verdict and the "we are back" signal both come from #2501's
 * connectivity primitives rather than a second implementation of the same idea;
 * they are passed in as plain functions because a boundary cannot assume a
 * provider is still mounted above it.
 *
 * This boundary renders inside the root layout, so NextIntlClientProvider is
 * available and `useTranslations` is safe. The last-resort boundary for errors
 * in the root layout itself is `app/global-error.tsx`.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  browserChunkRetryEnv,
  isChunkLoadError,
  recoverFromChunkErrorInBrowser,
  retryWhenServerReturns,
} from '@/lib/error/chunk-reload';
import { probeServerReachable, subscribeServerReachability } from '@/hooks/useConnectivity';

interface AppErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AppError({ error, reset }: AppErrorProps) {
  const t = useTranslations('error');
  const tCommon = useTranslations('common');
  const chunk = isChunkLoadError(error);
  // `navigator.onLine` is client-only, so the cause is resolved in the effect
  // below rather than during render — the first client render has to match the
  // server's, and a boundary that flipped its copy during hydration would be a
  // hydration mismatch on top of an error.
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (!chunk) return;
    setOffline(recoverFromChunkErrorInBrowser(error) === 'offline');
  }, [chunk, error]);

  // While suppressed for being offline, wait for the server and retry without
  // asking the user to do anything.
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

  const title = offline
    ? t('chunkOffline.title')
    : chunk
      ? t('chunkReload.title')
      : t('unexpected.title');
  const description = offline
    ? t('chunkOffline.description')
    : chunk
      ? t('chunkReload.description')
      : t('unexpected.description');

  return (
    <main
      data-testid="app-error"
      data-error-kind={offline ? 'chunk-offline' : chunk ? 'chunk-reload' : 'unexpected'}
      className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 pt-safe pb-safe text-center"
    >
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
        {offline && (
          <p className="mx-auto max-w-sm text-xs text-muted-foreground" role="status" aria-live="polite">
            {t('chunkOffline.waiting')}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={chunk && !offline ? () => window.location.reload() : reset}
        className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-700"
      >
        {chunk && !offline ? tCommon('reload') : tCommon('retry')}
      </button>
    </main>
  );
}
