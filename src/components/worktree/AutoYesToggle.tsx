/**
 * AutoYesToggle - Toggle component for auto-yes mode
 *
 * Displays a toggle switch with countdown timer when enabled
 * and a notification when auto-response occurs.
 */

'use client';

import React, { memo, useEffect, useState, useCallback } from 'react';
import { AutoYesConfirmDialog } from './AutoYesConfirmDialog';

/** Props for AutoYesToggle component */
export interface AutoYesToggleProps {
  /** Whether auto-yes is currently enabled */
  enabled: boolean;
  /** Expiration timestamp (ms since epoch) */
  expiresAt: number | null;
  /** Callback when toggle is clicked */
  onToggle: (enabled: boolean) => Promise<void>;
  /** Last auto-response answer (for notification) */
  lastAutoResponse: string | null;
  /** If true, render without outer container styles (for inline embedding) */
  inline?: boolean;
}

/**
 * Format remaining time as MM:SS
 */
function formatTimeRemaining(expiresAt: number): string {
  const remaining = Math.max(0, expiresAt - Date.now());
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export const AutoYesToggle = memo(function AutoYesToggle({
  enabled,
  expiresAt,
  onToggle,
  lastAutoResponse,
  inline = false,
}: AutoYesToggleProps) {
  const [timeRemaining, setTimeRemaining] = useState<string>('');
  const [notification, setNotification] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  // Countdown timer
  useEffect(() => {
    if (!enabled || !expiresAt) {
      setTimeRemaining('');
      return;
    }

    const updateTime = () => {
      setTimeRemaining(formatTimeRemaining(expiresAt));
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, [enabled, expiresAt]);

  // Auto-response notification (2 second display)
  useEffect(() => {
    if (!lastAutoResponse) return;

    setNotification(`Auto responded: "${lastAutoResponse}"`);
    const timeout = setTimeout(() => setNotification(null), 2000);
    return () => clearTimeout(timeout);
  }, [lastAutoResponse]);

  const handleToggle = useCallback(() => {
    if (enabled) {
      // OFF: execute directly
      setToggling(true);
      onToggle(false).finally(() => setToggling(false));
    } else {
      // ON: show confirmation dialog
      setShowConfirmDialog(true);
    }
  }, [enabled, onToggle]);

  const handleConfirm = useCallback(() => {
    setShowConfirmDialog(false);
    setToggling(true);
    onToggle(true).finally(() => setToggling(false));
  }, [onToggle]);

  const handleCancel = useCallback(() => {
    setShowConfirmDialog(false);
  }, []);

  return (
    <div className={inline ? 'flex items-center gap-2' : 'flex items-center gap-3 px-4 py-2 bg-gray-50 border-b border-gray-200'}>
      {/* Toggle switch */}
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Auto Yes mode"
        disabled={toggling}
        onClick={handleToggle}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
          enabled ? 'bg-blue-600' : 'bg-gray-300'
        } ${toggling ? 'opacity-50' : ''}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            enabled ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
      <span className="text-sm font-medium text-gray-700">Auto Yes</span>

      {/* Countdown timer */}
      {enabled && timeRemaining && (
        <span className="text-sm text-gray-500" aria-label="Time remaining">
          {timeRemaining}
        </span>
      )}

      {/* Auto-response notification */}
      {notification && (
        <span className="text-sm text-green-600 animate-pulse">
          {notification}
        </span>
      )}

      <AutoYesConfirmDialog
        isOpen={showConfirmDialog}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </div>
  );
});

export default AutoYesToggle;
