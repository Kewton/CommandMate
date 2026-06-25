/**
 * AutoYesToggle - Toggle component for auto-yes mode
 *
 * Displays a toggle switch with countdown timer when enabled
 * and a notification when auto-response occurs.
 *
 * Issue #225: Added duration propagation and HH:MM:SS countdown format
 * Issue #314: Added AutoYesToggleParams interface with stopPattern support
 */

'use client';

import React, { memo, useEffect, useState, useCallback } from 'react';
import { AutoYesConfirmDialog } from './AutoYesConfirmDialog';
import { formatTimeRemaining, AUTO_YES_COUNTDOWN_INTERVAL_MS } from '@/config/auto-yes-config';
import type { AutoYesDuration } from '@/config/auto-yes-config';
import { NOTIFICATION_DISMISS_MS } from '@/config/ui-feedback-config';
import { getCliToolDisplayNameSafe } from '@/lib/cli-tools/types';
// Issue #756: AutoYesToggleParams moved to a non-TSX module (`@/types/auto-yes`)
// so server-side type consumers compiled under tsconfig.server.json can import
// it without TS6142. Re-exported here for backward compatibility.
import type { AutoYesToggleParams } from '@/types/auto-yes';
export type { AutoYesToggleParams };

/** Props for AutoYesToggle component */
export interface AutoYesToggleProps {
  /** Whether auto-yes is currently enabled */
  enabled: boolean;
  /** Expiration timestamp (ms since epoch) */
  expiresAt: number | null;
  /** Callback when toggle is clicked (Issue #314: object parameter pattern) */
  onToggle: (params: AutoYesToggleParams) => Promise<void>;
  /** Last auto-response answer (for notification) */
  lastAutoResponse: string | null;
  /** Currently active CLI tool name (e.g. 'claude', 'codex') */
  cliToolName?: string;
  /** If true, render without outer container styles (for inline embedding) */
  inline?: boolean;
  /**
   * Optional callback fired once when the countdown reaches 00:00 (Issue #959).
   * Lets a parent proactively disable auto-yes the instant the timer expires
   * instead of waiting for the next server poll. Optional so existing callers
   * need not change.
   */
  onExpire?: () => void;
}

export const AutoYesToggle = memo(function AutoYesToggle({
  enabled,
  expiresAt,
  onToggle,
  lastAutoResponse,
  cliToolName,
  inline = false,
  onExpire,
}: AutoYesToggleProps) {
  const [timeRemaining, setTimeRemaining] = useState<string>('');
  const [notification, setNotification] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  // Issue #959: latch that flips the UI to OFF the instant the countdown hits
  // 00:00, so the toggle no longer shows ON while the server-side state catches
  // up on the next poll.
  const [hasExpired, setHasExpired] = useState(false);

  // Countdown timer
  useEffect(() => {
    if (!enabled || !expiresAt) {
      setTimeRemaining('');
      setHasExpired(false);
      return;
    }

    // Fresh enable window: clear any stale expiry latch from a previous run.
    setHasExpired(false);

    let expiredNotified = false;

    // Refresh the displayed time. Returns true once the countdown has reached
    // zero (Issue #959): at that point the UI proactively reflects expiry and
    // notifies the parent once, instead of waiting for the next polling cycle.
    const tick = (): boolean => {
      setTimeRemaining(formatTimeRemaining(expiresAt));
      if (expiresAt - Date.now() <= 0 && !expiredNotified) {
        expiredNotified = true;
        setHasExpired(true);
        onExpire?.();
        return true;
      }
      return false;
    };

    // Already past expiry at mount: no interval needed.
    if (tick()) {
      return;
    }

    const interval = setInterval(() => {
      if (tick()) clearInterval(interval);
    }, AUTO_YES_COUNTDOWN_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled, expiresAt, onExpire]);

  // Auto-response notification (2 second display)
  useEffect(() => {
    if (!lastAutoResponse) return;

    setNotification(`Auto responded: "${lastAutoResponse}"`);
    const timeout = setTimeout(() => setNotification(null), NOTIFICATION_DISMISS_MS);
    return () => clearTimeout(timeout);
  }, [lastAutoResponse]);

  // Issue #959: the UI presents as OFF the moment the countdown expires, even
  // before the parent's polled `enabled` prop catches up. Derive a single source
  // of truth so the visual state, click behaviour and countdown all agree.
  const displayEnabled = enabled && !hasExpired;

  const handleToggle = useCallback(() => {
    if (displayEnabled) {
      // OFF: execute directly
      setToggling(true);
      onToggle({ enabled: false }).finally(() => setToggling(false));
    } else {
      // ON: show confirmation dialog
      setShowConfirmDialog(true);
    }
  }, [displayEnabled, onToggle]);

  const handleConfirm = useCallback((duration: AutoYesDuration, stopPattern?: string) => {
    setShowConfirmDialog(false);
    setToggling(true);
    onToggle({ enabled: true, duration, stopPattern }).finally(() => setToggling(false));
  }, [onToggle]);

  const handleCancel = useCallback(() => {
    setShowConfirmDialog(false);
  }, []);

  return (
    <div className={inline ? 'flex items-center gap-2' : 'flex items-center gap-3 px-4 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700'}>
      {/* Toggle switch */}
      <button
        type="button"
        role="switch"
        aria-checked={displayEnabled}
        aria-label="Auto Yes mode"
        disabled={toggling}
        onClick={handleToggle}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 ${
          displayEnabled ? 'bg-cyan-600' : 'bg-gray-300 dark:bg-gray-600'
        } ${toggling ? 'opacity-50' : ''}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            displayEnabled ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Auto Yes</span>

      {/* Active CLI tool indicator (Issue #525: show regardless of enabled state) */}
      {cliToolName && (
        <span className="text-xs text-cyan-600 dark:text-cyan-400 font-medium" aria-label="Auto Yes target">
          ({getCliToolDisplayNameSafe(cliToolName, '')})
        </span>
      )}

      {/* Countdown timer */}
      {displayEnabled && timeRemaining && (
        <span className="text-sm text-gray-500 dark:text-gray-400" aria-label="Time remaining">
          {timeRemaining}
        </span>
      )}

      {/* Auto-response notification */}
      {notification && (
        <span className="text-sm text-green-600 dark:text-green-400 animate-pulse">
          {notification}
        </span>
      )}

      <AutoYesConfirmDialog
        isOpen={showConfirmDialog}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
        cliToolName={getCliToolDisplayNameSafe(cliToolName, '')}
      />
    </div>
  );
});
