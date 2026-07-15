/**
 * ConnectionStatusIndicator (Issue #1120).
 *
 * A subtle indicator of the realtime (WebSocket) connection. Stays out of the
 * way while connected (renders nothing) and surfaces a quiet "reconnecting" /
 * "offline" pill when the live push connection drops — at which point polling
 * has already taken over as the fallback, so this is informational only.
 */

'use client';

import { useRealtime } from '@/hooks/useRealtimeConnection';

export function ConnectionStatusIndicator() {
  const { status } = useRealtime();

  // While connected the push path is healthy — no indicator needed.
  if (status === 'connected') return null;

  const isConnecting = status === 'connecting';
  const label = isConnecting ? '再接続中' : 'オフライン';

  return (
    <span
      data-testid="connection-status-indicator"
      role="status"
      aria-live="polite"
      title={isConnecting ? 'ライブ接続を再確立しています（ポーリングで動作中）' : 'ライブ接続なし（ポーリングで動作中）'}
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
