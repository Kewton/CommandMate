/**
 * ConnectionStatusIndicator (Issue #1120).
 *
 * A subtle indicator of the connection to the server. Stays out of the way
 * while connected (renders nothing) and surfaces a quiet "reconnecting" /
 * "offline" pill when it is not — at which point polling has already taken over
 * as the fallback, so this is informational only.
 *
 * Issue #2501: the verdict now comes from `useConnectivity` rather than the
 * WebSocket status alone, so "the live push dropped" and "the server cannot be
 * reached at all" are no longer the same pill. This component is the desktop
 * surface; `MobileConnectionBanner` is the phone's, because `Header` — the only
 * place this is mounted — is not rendered by AppShell's mobile branch.
 */

'use client';

import { useTranslations } from 'next-intl';
import { useConnectivity } from '@/hooks/useConnectivity';

export function ConnectionStatusIndicator() {
  const { shouldSurface, isReconnecting } = useConnectivity();
  const t = useTranslations('common');

  // Connected — or degraded for less than the settle window, which a page load
  // passes through on its way to connected. Nothing to say either way.
  if (!shouldSurface) return null;

  const label = isReconnecting ? t('connection.reconnecting') : t('connection.offline');

  return (
    <span
      data-testid="connection-status-indicator"
      data-connection-state={isReconnecting ? 'reconnecting' : 'offline'}
      role="status"
      aria-live="polite"
      title={isReconnecting ? t('connection.reconnectingTooltip') : t('connection.offlineTooltip')}
      className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className={[
          'w-1.5 h-1.5 rounded-full',
          isReconnecting ? 'bg-warning motion-safe:animate-pulse' : 'bg-muted-foreground',
        ].join(' ')}
      />
      {label}
    </span>
  );
}

export default ConnectionStatusIndicator;
