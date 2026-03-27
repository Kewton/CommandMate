/**
 * TimerPane Component
 * Issue #534: Timer-based delayed message sending UI
 *
 * Features:
 * - Timer registration form (agent + message + delay)
 * - Timer list with countdown display (setInterval 1s)
 * - Cancel button for pending timers
 * - Polling: TIMER_LIST_POLL_INTERVAL_MS [CON-C-003]
 * - visibilitychange-aware polling [IMP-C-002]
 * - formatTimeRemaining() reuse from auto-yes-config
 */

'use client';

import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { useTranslations } from 'next-intl';
import {
  TIMER_DELAYS,
  MAX_TIMERS_PER_WORKTREE,
  MAX_TIMER_MESSAGE_LENGTH,
  TIMER_LIST_POLL_INTERVAL_MS,
  DEFAULT_TIMER_HISTORY_LIMIT,
} from '@/config/timer-constants';
import { formatTimeRemaining } from '@/config/auto-yes-config';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { CLI_TOOL_IDS, getCliToolDisplayName } from '@/lib/cli-tools/types';

// =============================================================================
// Types
// =============================================================================

interface TimerPaneProps {
  worktreeId: string;
  /** @deprecated No longer used — CLI_TOOL_IDS is used directly */
  selectedAgents?: CLIToolType[];
}

interface TimerItem {
  id: string;
  cliToolId: string;
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

function formatDelayLabel(delayMs: number): string {
  const totalMinutes = Math.floor(delayMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${minutes}m`;
}

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

export const TimerPane = memo(function TimerPane({ worktreeId }: TimerPaneProps) {
  const t = useTranslations('schedule');
  const [timers, setTimers] = useState<TimerItem[]>([]);
  const [message, setMessage] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<CLIToolType>(CLI_TOOL_IDS[0]);
  const [selectedDelay, setSelectedDelay] = useState(TIMER_DELAYS[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
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

  const handleRegister = useCallback(async () => {
    if (!message.trim() || isSubmitting) return;

    setWarning(null);
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/worktrees/${worktreeId}/timers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cliToolId: selectedAgent,
          message: message.trim(),
          delayMs: selectedDelay,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.warning === 'session_not_running') {
          setWarning('session_not_running');
        }
        setMessage('');
        void fetchTimers();
      }
    } catch {
      // Error handled silently
    } finally {
      setIsSubmitting(false);
    }
  }, [worktreeId, selectedAgent, message, selectedDelay, isSubmitting, fetchTimers]);

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

  const pendingCount = timers.filter(t => t.status === 'pending').length;
  const canRegister = pendingCount < MAX_TIMERS_PER_WORKTREE && message.trim().length > 0;

  // ==========================================================================
  // Render
  // ==========================================================================

  return (
    <div className="flex flex-col h-full p-3 gap-3 overflow-auto">
      {/* Registration Form */}
      <div className="flex flex-col gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('timer.title')}
        </div>

        {/* Agent selector */}
        <select
          value={selectedAgent}
          onChange={(e) => setSelectedAgent(e.target.value as CLIToolType)}
          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
        >
          {CLI_TOOL_IDS.map((agent) => (
            <option key={agent} value={agent}>
              {getCliToolDisplayName(agent)}
            </option>
          ))}
        </select>

        {/* Message input */}
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t('timer.message')}
          maxLength={MAX_TIMER_MESSAGE_LENGTH}
          rows={2}
          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-cyan-500"
        />

        {/* Delay selector + Register button */}
        <div className="flex gap-2 items-center">
          <select
            value={selectedDelay}
            onChange={(e) => setSelectedDelay(Number(e.target.value))}
            className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
          >
            {TIMER_DELAYS.map((delay) => (
              <option key={delay} value={delay}>
                {formatDelayLabel(delay)}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={handleRegister}
            disabled={!canRegister || isSubmitting}
            className="px-4 py-2 text-sm font-medium text-white bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors whitespace-nowrap"
          >
            {t('timer.register')}
          </button>
        </div>

        {pendingCount >= MAX_TIMERS_PER_WORKTREE && (
          <div className="text-xs text-amber-600 dark:text-amber-400">
            {t('timer.maxReached', { max: MAX_TIMERS_PER_WORKTREE })}
          </div>
        )}

        {warning === 'session_not_running' && (
          <div className="text-xs p-2 rounded bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400">
            {t('timer.sessionWarning')}
          </div>
        )}
      </div>

      {/* Timer List */}
      {timers.length === 0 ? (
        <div className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
          {t('timer.noTimers')}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
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
                    {timer.cliToolId}
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
          {timers.some(t => t.status !== 'pending') && (
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
    </div>
  );
});

export default TimerPane;
