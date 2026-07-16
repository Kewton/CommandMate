/**
 * ConnectionStatusIndicator (Issue #1120).
 *
 * A subtle indicator of the realtime (WebSocket) connection. Stays out of the
 * way while connected (renders nothing) and surfaces a quiet "reconnecting" /
 * "offline" pill when the live push connection drops — at which point polling
 * has already taken over as the fallback, so this is informational only.
 */

'use client';

import { useTranslations } from 'next-intl';
import { useRealtime } from '@/hooks/useRealtimeConnection';

export function ConnectionStatusIndicator() {
  const { status } = useRealtime();
  const t = useTranslations('common');

  // While connected the push path is healthy — no indicator needed.
  if (status === 'connected') return null;

  const isConnecting = status === 'connecting';
  const label = isConnecting ? t('connection.reconnecting') : t('connection.offline');

  return (
    <span
      data-testid="connection-status-indicator"
      role="status"
      aria-live="polite"
      title={isConnecting ? t('connection.reconnectingTooltip') : t('connection.offlineTooltip')}
      className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className={[
          'w-1.5 h-1.5 rounded-full',
          isConnecting ? 'bg-warning motion-safe:animate-pulse' : 'bg-muted-foreground',
        ].join(' ')}
      />
      {label}
    </span>
  );
}

export default ConnectionStatusIndicator;
