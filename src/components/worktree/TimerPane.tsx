/**
 * TimerPane Component
 * Issue #534: Timer-based delayed message sending UI
 * Issue #945: input switched from an always-on inline form to a
 *             "+ Create Timer" button + popup dialog (unified with Schedule).
 *
 * Features:
 * - "+ Create Timer" / "+ New Timer" button opening TimerEditDialog
 * - Timer list with countdown display (setInterval 1s)
 * - Cancel button for pending timers
 * - Polling: TIMER_LIST_POLL_INTERVAL_MS [CON-C-003]
 * - visibilitychange-aware polling [IMP-C-002]
 * - formatTimeRemaining() reuse from auto-yes-config
 */

'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Clock } from 'lucide-react';
import {
  MAX_TIMERS_PER_WORKTREE,
  TIMER_LIST_POLL_INTERVAL_MS,
  DEFAULT_TIMER_HISTORY_LIMIT,
} from '@/config/timer-constants';
import { formatTimeRemaining } from '@/config/auto-yes-config';
import type { CLIToolType, AgentInstance } from '@/lib/cli-tools/types';
import { CLI_TOOL_IDS, agentInstancesFromSelectedAgents } from '@/lib/cli-tools/types';
import { formatDelayLabel } from './timers/timer-format';
import { TimerEditDialog } from './timers/TimerEditDialog';

// =============================================================================
// Types
// =============================================================================

interface TimerPaneProps {
  worktreeId: string;
  /**
   * Registered agent instances (Issue #942). Drives the agent selector so the
   * timer can target a specific instance session. Falls back to the primary
   * instance of every CLI tool when omitted/empty (legacy behavior).
   */
  instances?: AgentInstance[];
  /** @deprecated No longer used — instances drives the selector */
  selectedAgents?: CLIToolType[];
}

interface TimerItem {
  id: string;
  cliToolId: string;
  /** Target agent instance (Issue #942). Legacy rows fall back to cliToolId. */
  instanceId: string;
  message: string;
  delayMs: number;
  scheduledSendTime: number;
  status: string;
  createdAt: number;
  sentAt: number | null;
}

// =============================================================================
// Helpers
// =============================================================================

function getStatusColor(status: string): string {
  switch (status) {
    case 'pending': return 'text-blue-600 dark:text-blue-400';
    case 'sending': return 'text-yellow-600 dark:text-yellow-400';
    case 'sent': return 'text-green-600 dark:text-green-400';
    case 'failed': return 'text-red-600 dark:text-red-400';
    case 'cancelled': return 'text-gray-500 dark:text-gray-400';
    case 'no_session': return 'text-orange-600 dark:text-orange-400';
    default: return 'text-gray-600 dark:text-gray-400';
  }
}

// =============================================================================
// Component
// =============================================================================

export const TimerPane = memo(function TimerPane({ worktreeId, instances }: TimerPaneProps) {
  const t = useTranslations('schedule');

  // Resolve the agent roster: explicit instances when configured, otherwise the
  // primary instance of every CLI tool (legacy behavior). Used here only to
  // render the instance alias on each timer row; the dialog owns the selector.
  const resolvedInstances = useMemo<AgentInstance[]>(
    () => (instances && instances.length > 0
      ? instances
      : agentInstancesFromSelectedAgents([...CLI_TOOL_IDS])),
    [instances]
  );

  const [timers, setTimers] = useState<TimerItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [, setTick] = useState(0); // Force re-render for countdown

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastCreatedAtRef = useRef<number | null>(null);

  // ==========================================================================
  // Fetch timers
  // ==========================================================================

  // [SF-002] fetchTimers: polling-only, depends only on worktreeId (Issue #540)
  const fetchTimers = useCallback(async () => {
    try {
      const res = await fetch(`/api/worktrees/${worktreeId}/timers`);
      if (res.ok) {
        const data = await res.json();
        setTimers(data.timers);
        setHasMore(data.hasMore ?? false);
        if (data.timers.length > 0) {
          lastCreatedAtRef.current = data.timers[data.timers.length - 1].createdAt;
        } else {
          lastCreatedAtRef.current = null;
        }
      }
    } catch {
      // Silently ignore fetch errors during polling
    }
  }, [worktreeId]);

  // [SF-002] loadMoreTimers: on-demand, cursor-based (Issue #540)
  const loadMoreTimers = useCallback(async () => {
    if (lastCreatedAtRef.current == null) return;
    try {
      const params = new URLSearchParams();
      params.set('before', String(lastCreatedAtRef.current));
      params.set('limit', String(DEFAULT_TIMER_HISTORY_LIMIT));
      const res = await fetch(`/api/worktrees/${worktreeId}/timers?${params}`);
      if (res.ok) {
        const data = await res.json();
        setTimers(prev => [...prev, ...data.timers]);
        setHasMore(data.hasMore ?? false);
        if (data.timers.length > 0) {
          lastCreatedAtRef.current = data.timers[data.timers.length - 1].createdAt;
        }
      }
    } catch {
      // Silently ignore fetch errors
    }
  }, [worktreeId]);

  // ==========================================================================
  // Polling with visibilitychange [IMP-C-002]
  // ==========================================================================

  useEffect(() => {
    /** Start polling and countdown intervals, returning a cleanup function. */
    function startIntervals(): () => void {
      void fetchTimers();
      pollingRef.current = setInterval(() => {
        void fetchTimers();
      }, TIMER_LIST_POLL_INTERVAL_MS);
      countdownRef.current = setInterval(() => {
        setTick(prev => prev + 1);
      }, 1000);
      return stopIntervals;
    }

    /** Stop all active intervals. */
    function stopIntervals(): void {
      if (pollingRef.current) clearInterval(pollingRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
      pollingRef.current = null;
      countdownRef.current = null;
    }

    startIntervals();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopIntervals();
      } else {
        startIntervals();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopIntervals();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchTimers]);

  // ==========================================================================
  // Actions
  // ==========================================================================

  const handleCancel = useCallback(async (timerId: string) => {
    try {
      const res = await fetch(`/api/worktrees/${worktreeId}/timers?timerId=${timerId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        void fetchTimers();
      }
    } catch {
      // Error handled silently
    }
  }, [worktreeId, fetchTimers]);

  // [CS-SF-003] Clear history with confirmation (Issue #540)
  const handleClearHistory = useCallback(async () => {
    if (!window.confirm(t('timer.clearConfirm'))) return;
    try {
      const res = await fetch(`/api/worktrees/${worktreeId}/timers/history`, {
        method: 'DELETE',
      });
      if (res.ok) {
        void fetchTimers();
      }
    } catch {
      // Error handled silently
    }
  }, [worktreeId, fetchTimers, t]);

  // ==========================================================================
  // Derived state
  // ==========================================================================

  const pendingCount = timers.filter(timer => timer.status === 'pending').length;
  // Disable the opener (not a dialog field) when the worktree is at capacity, so
  // the user cannot open a dialog whose registration would be rejected.
  const atMax = pendingCount >= MAX_TIMERS_PER_WORKTREE;

  // ==========================================================================
  // Render
  // ==========================================================================

  return (
    <div className="flex flex-col h-full p-3 gap-3 overflow-auto">
      {timers.length === 0 ? (
        /* Empty state: centered CTA (mirrors the Schedule pane's empty state) */
        <div className="flex flex-col items-center text-center py-8 px-4">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-cyan-50 text-cyan-600 dark:bg-cyan-900/30 dark:text-cyan-300">
            <Clock className="w-7 h-7" />
          </div>
          <p className="font-semibold text-gray-700 dark:text-gray-200 mb-1">{t('timer.title')}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-5 max-w-xs">{t('timer.noTimers')}</p>
          <button
            type="button"
            data-testid="timer-empty-cta"
            onClick={() => setDialogOpen(true)}
            className="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold text-white bg-cyan-600 hover:bg-cyan-700 rounded-lg shadow-sm transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('timer.createButton')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {/* Header: new-timer button (disabled at capacity) + max-reached note */}
          <div className="flex items-center justify-end gap-2">
            {atMax && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                {t('timer.maxReached', { max: MAX_TIMERS_PER_WORKTREE })}
              </span>
            )}
            <button
              type="button"
              data-testid="timer-new-button"
              onClick={() => setDialogOpen(true)}
              disabled={atMax}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-white bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('timer.newTimer')}
            </button>
          </div>

          {timers.map((timer) => (
            <div
              key={timer.id}
              className="flex items-center gap-2 p-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-900 dark:text-gray-100 truncate">
                  {timer.message.length > 60 ? timer.message.slice(0, 60) + '...' : timer.message}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-cyan-600 dark:text-cyan-400 font-medium">
                    {resolvedInstances.find((inst) => inst.id === timer.instanceId)?.alias ?? timer.cliToolId}
                  </span>
                  <span className={getStatusColor(timer.status)}>
                    {t(`timer.status.${timer.status}`)}
                  </span>
                  {timer.status === 'pending' && (
                    <span className="text-gray-500 dark:text-gray-400">
                      {formatTimeRemaining(timer.scheduledSendTime)}
                    </span>
                  )}
                  <span className="text-gray-400 dark:text-gray-500">
                    {formatDelayLabel(timer.delayMs)}
                  </span>
                </div>
              </div>

              {timer.status === 'pending' && (
                <button
                  type="button"
                  onClick={() => handleCancel(timer.id)}
                  className="px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded transition-colors"
                >
                  {t('timer.cancel')}
                </button>
              )}
            </div>
          ))}

          {/* Load more button (Issue #540) */}
          {hasMore && (
            <button
              type="button"
              onClick={loadMoreTimers}
              className="px-3 py-2 text-sm text-cyan-600 dark:text-cyan-400 hover:bg-cyan-50 dark:hover:bg-cyan-900/20 rounded-md transition-colors text-center"
            >
              {t('timer.loadMore')}
            </button>
          )}

          {/* Clear history button (Issue #540) */}
          {timers.some(timer => timer.status !== 'pending') && (
            <button
              type="button"
              onClick={handleClearHistory}
              className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors text-center"
            >
              {t('timer.clearHistory')}
            </button>
          )}
        </div>
      )}

      <TimerEditDialog
        isOpen={dialogOpen}
        worktreeId={worktreeId}
        instances={instances}
        onClose={() => setDialogOpen(false)}
        onSaved={() => { void fetchTimers(); }}
      />
    </div>
  );
});

export default TimerPane;
