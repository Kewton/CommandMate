import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { OfflineReconnectButton } from '@/components/pwa/OfflineReconnectButton';

export const metadata: Metadata = {
  title: 'Offline',
};

/**
 * Offline fallback page (Issue #1124).
 *
 * Precached by the Service Worker on install and served when a navigation
 * cannot reach the network. Contains no user data so it is safe to cache and
 * to serve before authentication (see AUTH_EXCLUDED_PATHS).
 */
export default async function OfflinePage() {
  const t = await getTranslations('pwa');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 pt-safe pb-safe text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">{t('offline.title')}</h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          {t('offline.description')}
        </p>
      </div>
      <OfflineReconnectButton />
    </main>
  );
}
