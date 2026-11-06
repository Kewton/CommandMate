/**
 * ExternalAppStatus Component
 * Displays health status indicator for an external app
 * Issue #42: Proxy routing for multiple frontend applications
 */

'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { ExternalAppHealth } from '@/types/external-apps';
import { useVisiblePolling, type VisiblePollingClaim } from '@/hooks/useVisiblePolling';

export interface ExternalAppStatusProps {
  /** External app ID */
  appId: string;
  /** Polling interval in milliseconds (default: 30000) */
  pollInterval?: number;
  /** Whether to show response time */
  showResponseTime?: boolean;
  /** Compact mode - only show dot indicator */
  compact?: boolean;
}

/**
 * ExternalAppStatus component
 * Periodically checks health of an external app and displays status
 *
 * @example
 * ```tsx
 * <ExternalAppStatus appId="abc-123" pollInterval={30000} />
 * ```
 */
export function ExternalAppStatus({
  appId,
  pollInterval = 30000,
  showResponseTime = false,
  compact = false,
}: ExternalAppStatusProps) {
  const t = useTranslations('externalApps');
  const [health, setHealth] = useState<ExternalAppHealth | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Issue #4174: rests while the tab is hidden, checks once on coming back. An answer
  // older than one already taken, for an app no longer shown (appId changed), or
  // arriving after unmount is dropped. A failed check still shows unhealthy.
  const checkHealth = useCallback(
    async (claim: VisiblePollingClaim) => {
      let next: ExternalAppHealth;
      try {
        const response = await fetch(`/api/external-apps/${appId}/health`);
        if (response.ok) {
          next = await response.json();
        } else {
          next = {
            id: appId,
            healthy: false,
            lastChecked: Date.now(),
            error: 'Failed to check health',
          };
        }
      } catch {
        next = {
          id: appId,
          healthy: false,
          lastChecked: Date.now(),
          error: 'Network error',
        };
      }
      if (!claim()) return;
      setHealth(next);
      setIsLoading(false);
    },
    [appId],
  );

  useVisiblePolling(checkHealth, pollInterval);

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground animate-pulse" />
        {!compact && <span className="text-xs text-muted-foreground">{t('status.checking')}</span>}
      </div>
    );
  }

  const isHealthy = health?.healthy ?? false;
  const statusColor = isHealthy ? 'bg-success' : 'bg-muted-foreground';
  const statusText = isHealthy ? t('status.running') : t('status.stopped');

  if (compact) {
    return (
      <span
        className={`inline-block h-2.5 w-2.5 rounded-full ${statusColor}`}
        title={statusText}
      />
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${statusColor}`} />
      <span className={`text-xs ${isHealthy ? 'text-success-foreground' : 'text-muted-foreground'}`}>
        {statusText}
      </span>
      {showResponseTime && health?.responseTime !== undefined && (
        <span className="text-xs text-muted-foreground">
          ({health.responseTime}ms)
        </span>
      )}
    </div>
  );
}
