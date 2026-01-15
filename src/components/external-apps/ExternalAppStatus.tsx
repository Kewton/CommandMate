/**
 * ExternalAppStatus Component
 * Displays health status indicator for an external app
 * Issue #42: Proxy routing for multiple frontend applications
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ExternalAppHealth } from '@/types/external-apps';

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
  const [health, setHealth] = useState<ExternalAppHealth | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const checkHealth = useCallback(async () => {
    try {
      const response = await fetch(`/api/external-apps/${appId}/health`);
      if (response.ok) {
        const data = await response.json();
        setHealth(data);
      } else {
        setHealth({
          id: appId,
          healthy: false,
          lastChecked: Date.now(),
          error: 'Failed to check health',
        });
      }
    } catch {
      setHealth({
        id: appId,
        healthy: false,
        lastChecked: Date.now(),
        error: 'Network error',
      });
    } finally {
      setIsLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    // Initial check
    checkHealth();

    // Set up polling
    const interval = setInterval(checkHealth, pollInterval);

    return () => clearInterval(interval);
  }, [checkHealth, pollInterval]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-gray-300 animate-pulse" />
        {!compact && <span className="text-xs text-gray-400">Checking...</span>}
      </div>
    );
  }

  const isHealthy = health?.healthy ?? false;
  const statusColor = isHealthy ? 'bg-green-500' : 'bg-gray-400';
  const statusText = isHealthy ? 'Running' : 'Stopped';

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
      <span className={`text-xs ${isHealthy ? 'text-green-600' : 'text-gray-500'}`}>
        {statusText}
      </span>
      {showResponseTime && health?.responseTime !== undefined && (
        <span className="text-xs text-gray-400">
          ({health.responseTime}ms)
        </span>
      )}
    </div>
  );
}
