/**
 * AutoYesToggle - Toggle component for auto-yes mode
 *
 * Displays a toggle switch with countdown timer when enabled.
 *
 * Issue #3821: the "Auto responded" notification is gone with the browser's
 * own Auto-Yes answer it announced; the server's poller answers, and the
 * answer panel says when it does not.
 *
 * Issue #225: Added duration propagation and HH:MM:SS countdown format
 * Issue #314: Added AutoYesToggleParams interface with stopPattern support
 * Issue #3863: the answer mode — chosen in the confirm dialog, shown beside the ON switch
 */

'use client';

import React, { memo, useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Switch } from '@/components/ui/Switch';
import { AutoYesConfirmDialog } from './AutoYesConfirmDialog';
import { formatTimeRemaining, AUTO_YES_COUNTDOWN_INTERVAL_MS } from '@/config/auto-yes-config';
import type { AutoYesDuration } from '@/config/auto-yes-config';
import { getCliToolDisplayNameSafe } from '@/lib/cli-tools/types';
// Issue #756: AutoYesToggleParams moved to a non-TSX module (`@/types/auto-yes`)
// so server-side type consumers compiled under tsconfig.server.json can import
// it without TS6142. Re-exported here for backward compatibility.
import type { AutoYesToggleParams } from '@/types/auto-yes';
import type { AutoYesAnswerMode } from '@/types/auto-yes-answer-mode';
export type { AutoYesToggleParams };

/** Props for AutoYesToggle component */
export interface AutoYesToggleProps {
  /** Whether auto-yes is currently enabled */
  enabled: boolean;
  /** Expiration timestamp (ms since epoch) */
  expiresAt: number | null;
  /** Callback when toggle is clicked (Issue #314: object parameter pattern) */
  onToggle: (params: AutoYesToggleParams) => Promise<void>;
  /**
   * Last auto-response answer. Issue #3821: no longer shown — the browser no
   * longer answers, so there is no answer of its own to announce, and this UI
   * does not make one up. Kept so the callers that pass it compile unchanged.
   */
  lastAutoResponse?: string | null;
  /** Currently active CLI tool name (e.g. 'claude', 'codex') */
  cliToolName?: string;
  /** If true, render without outer container styles (for inline embedding) */
  inline?: boolean;
  /**
   * Issue #1080: whether to show the active CLI tool name next to the label
   * (e.g. "(Claude)"). Defaults to true (per-split PC disambiguation, #525).
   * The mobile composer meta row sets this false since the active agent tab is
   * already shown alongside.
   */
  showToolName?: boolean;
  /**
   * Optional callback fired once when the countdown reaches 00:00 (Issue #959).
   * Lets a parent proactively disable auto-yes the instant the timer expires
   * instead of waiting for the next server poll. Optional so existing callers
   * need not change.
   */
  onExpire?: () => void;
  /**
   * Issue #3723: armed, but the contract running on this instance says
   * `autoYes.mode: 'off'`, so nothing will be answered. The switch still shows
   * ON (it is armed, and turning it off still works); a label beside it says
   * the contract is holding it. Optional, false by default, so the callers that
   * do not know (the Sessions tile) render what they did.
   */
  blockedByContract?: boolean;
  /**
   * Issue #3730: OFF because the last server restart released the grant (the
   * server reports `stopReason: 'server-restart'` until the grant's own
   * deadline, or until it is turned on or off again). A label beside the OFF
   * switch says so; nothing is re-enabled. Optional, false by default.
   */
  releasedByRestart?: boolean;
  /**
   * Issue #3863: the answer mode of the enabled grant (`recommended` /
   * `careful`), shown as a label beside the ON switch. Undefined renders
   * nothing — a server older than the field, or a surface that cannot read it
   * (the Sessions tile's list row), is "unknown", never assumed `recommended`.
   */
  answerMode?: AutoYesAnswerMode;
}

export const AutoYesToggle = memo(function AutoYesToggle({
  enabled,
  expiresAt,
  onToggle,
  cliToolName,
  inline = false,
  showToolName = true,
  onExpire,
  blockedByContract = false,
  releasedByRestart = false,
  answerMode,
}: AutoYesToggleProps) {
  const t = useTranslations('autoYes');
  const [timeRemaining, setTimeRemaining] = useState<string>('');
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

  const handleConfirm = useCallback((duration: AutoYesDuration, stopPattern?: string, chosenMode?: AutoYesAnswerMode) => {
    setShowConfirmDialog(false);
    setToggling(true);
    // Issue #3863: the dialog names a mode only when it is not the default, and
    // so does this call (an omitted `answerMode` is the default).
    onToggle({ enabled: true, duration, stopPattern, ...(chosenMode ? { answerMode: chosenMode } : {}) })
      .finally(() => setToggling(false));
  }, [onToggle]);

  const handleCancel = useCallback(() => {
    setShowConfirmDialog(false);
  }, []);

  return (
    <div className={inline ? 'flex items-center gap-2' : 'flex items-center gap-3 px-4 py-2 bg-surface-2 border-b border-border'}>
      {/* Toggle switch (Issue #1080: shared Radix ui/Switch) */}
      <Switch
        checked={displayEnabled}
        onCheckedChange={handleToggle}
        disabled={toggling}
        aria-label={t('toggleLabel')}
      />
      <span className="text-sm font-medium text-foreground">{t('label')}</span>

      {/* Active CLI tool indicator (Issue #525: show regardless of enabled state) */}
      {showToolName && cliToolName && (
        <span className="text-xs text-accent-600 dark:text-accent-400 font-medium" aria-label={t('targetLabel')}>
          ({getCliToolDisplayNameSafe(cliToolName, '')})
        </span>
      )}

      {/* Countdown timer */}
      {displayEnabled && timeRemaining && (
        <span className="text-sm text-muted-foreground" aria-label={t('timeRemaining')}>
          {timeRemaining}
        </span>
      )}

      {/* Issue #3863: how a question is answered while ON; unknown shows nothing */}
      {displayEnabled && answerMode && (
        <span
          className="text-xs font-medium text-muted-foreground"
          title={t(`answerModeBadgeTitle.${answerMode}`)}
          data-testid="auto-yes-answer-mode"
          data-answer-mode={answerMode}
        >
          {t(`answerModeBadge.${answerMode}`)}
        </span>
      )}

      {/* Issue #3723: armed, but the contract keeps Auto-Yes from answering */}
      {displayEnabled && blockedByContract && (
        <span
          className="text-xs font-medium text-warning-foreground"
          title={t('blockedByContractTitle')}
          data-testid="auto-yes-blocked-by-contract"
        >
          {t('blockedByContract')}
        </span>
      )}

      {/* Issue #3730: OFF because the server restarted, not because it was never on */}
      {!displayEnabled && releasedByRestart && (
        <span
          className="text-xs font-medium text-warning-foreground"
          title={t('releasedByRestartTitle')}
          data-testid="auto-yes-released-by-restart"
        >
          {t('releasedByRestart')}
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
