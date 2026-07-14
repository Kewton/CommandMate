'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';

/**
 * Reconnect button for the offline fallback page (Issue #1124).
 * Reloads the page so the browser retries the network / re-fetches the app.
 */
export function OfflineReconnectButton() {
  const t = useTranslations('pwa');
  return (
    <Button variant="primary" onClick={() => window.location.reload()}>
      {t('offline.reconnect')}
    </Button>
  );
}
