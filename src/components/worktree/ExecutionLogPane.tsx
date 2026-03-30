/**
 * ExecutionLogPane Component
 * Issue #294: Execution log list and schedule overview
 *
 * Shows:
 * - Execution log entries (most recent first)
 * - Log detail expansion
 * - Schedule list section
 */

'use client';

import React, { useState, useEffect, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';

// ============================================================================
// Types
// ============================================================================

/** Possible execution log status values */
type ExecutionLogStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';

/** Execution log entry from the list API (excludes result for performance) */
interface ExecutionLog {
  id: string;
  schedule_id: string;
  worktree_id: string;
  message: string;
  exit_code: number | null;
  status: ExecutionLogStatus;
  started_at: number;
  completed_at: number | null;
  created_at: number;
  schedule_name: string | null;
}

/** Execution log detail from the individual API (includes result) */
interface ExecutionLogDetail extends ExecutionLog {
  result: string | null;
}

/** Schedule entry from the schedules API */
interface Schedule {
  id: string;
  worktree_id: string;
  name: string;
  message: string;
  cron_expression: string;
  cli_tool_id: string;
  enabled: number;
  last_executed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ActiveSchedule {
  scheduleId: string;
  worktreeId: string;
  name: string;
  cronExpression: string;
  cliToolId: string;
  enabled: boolean;
  isExecuting: boolean;
  isCronActive: boolean;
  nextRunAt: number | null;
}

export interface ExecutionLogPaneProps {
  worktreeId: string;
  className?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** Format duration between two timestamps in human-readable form */
function formatDuration(startedAt: number, completedAt: number | null): string | null {
  if (completedAt === null) return null;
  const durationMs = completedAt - startedAt;
  if (durationMs < 0) return null;

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/** Map execution log status to Tailwind CSS color classes */
function getStatusColor(status: ExecutionLogStatus): string {
  switch (status) {
    case 'completed': return 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30';
    case 'failed': return 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30';
    case 'timeout': return 'text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/30';
    case 'running': return 'text-cyan-600 dark:text-cyan-400 bg-cyan-50 dark:bg-cyan-900/30';
    case 'cancelled': return 'text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800';
  }
}

// ============================================================================
// Component
// ============================================================================

export const ExecutionLogPane = memo(function ExecutionLogPane({
  worktreeId,
  className = '',
}: ExecutionLogPaneProps) {
  const t = useTranslations('schedule');
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [activeSchedules, setActiveSchedules] = useState<ActiveSchedule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [logDetail, setLogDetail] = useState<ExecutionLogDetail | null>(null);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [logsRes, schedulesRes, activeRes] = await Promise.all([
        fetch(`/api/worktrees/${worktreeId}/execution-logs`),
        fetch(`/api/worktrees/${worktreeId}/schedules`),
        fetch(`/api/worktrees/${worktreeId}/schedules/active`),
      ]);

      if (logsRes.ok) {
        const logsData = await logsRes.json();
        setLogs(logsData.logs || []);
      }

      if (schedulesRes.ok) {
        const schedulesData = await schedulesRes.json();
        setSchedules(schedulesData.schedules || []);
      }

      if (activeRes.ok) {
        const activeData = await activeRes.json();
        setActiveSchedules(activeData.schedules || []);
      } else {
        setActiveSchedules([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setIsLoading(false);
    }
  }, [worktreeId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleExpandLog = useCallback(async (logId: string) => {
    if (expandedLogId === logId) {
      setExpandedLogId(null);
      setLogDetail(null);
      return;
    }

    try {
      const res = await fetch(`/api/worktrees/${worktreeId}/execution-logs/${logId}`);
      if (res.ok) {
        const data = await res.json();
        setLogDetail(data.log);
        setExpandedLogId(logId);
      }
    } catch (err) {
      console.error('Failed to fetch log detail:', err);
    }
  }, [worktreeId, expandedLogId]);

  if (isLoading) {
    return (
      <div className={`flex items-center justify-center h-full p-4 ${className}`}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-4 border-gray-200 dark:border-gray-700 border-t-cyan-500 rounded-full animate-spin" />
          <span className="text-sm text-gray-500 dark:text-gray-400">{t('loading')}</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`flex items-center justify-center h-full p-4 ${className}`}>
        <div className="text-center">
          <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
          <button
            type="button"
            onClick={() => void fetchData()}
            className="ml-2 px-3 py-1 text-sm text-white bg-cyan-500 rounded hover:bg-cyan-600"
          >
            {t('retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-4 p-4 overflow-y-auto ${className}`}>
      {/* Schedules Section */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{t('title')} ({schedules.length})</h3>
        <div className="mb-3 rounded border border-cyan-100 bg-cyan-50/60 p-3 dark:border-cyan-900/40 dark:bg-cyan-950/20">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-cyan-900 dark:text-cyan-200">
              {t('activeSchedulesTitle')} ({activeSchedules.length})
            </span>
            <span className="text-xs text-cyan-700 dark:text-cyan-300">
              {t('activeSchedulesDescription')}
            </span>
          </div>
          {activeSchedules.length === 0 ? (
            <p className="text-xs text-cyan-800 dark:text-cyan-300">{t('noActiveSchedules')}</p>
          ) : (
            <div className="space-y-2">
              {activeSchedules.map((schedule) => (
                <div key={schedule.scheduleId} className="rounded border border-cyan-200/80 bg-white/80 p-3 dark:border-cyan-900/40 dark:bg-gray-900/60">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm text-gray-900 dark:text-gray-100">{schedule.name}</span>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded ${schedule.isCronActive ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'}`}>
                        {schedule.isCronActive ? t('activeState.active') : t('activeState.inactive')}
                      </span>
                      {schedule.isExecuting && (
                        <span className="text-xs px-2 py-0.5 rounded bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300">
                          {t('activeState.executing')}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                    <span>{t('cron')}: {schedule.cronExpression || 'N/A'}</span>
                    <span className="ml-3">{t('agentLabel')}: {schedule.cliToolId}</span>
                    {schedule.nextRunAt && (
                      <span className="ml-3">{t('nextRun')}: {formatTimestamp(schedule.nextRunAt)}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {schedules.length === 0 ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            <p className="font-medium text-gray-600 dark:text-gray-300 mb-3">{t('noSchedulesTitle')}</p>
            <ol className="text-sm text-left inline-block space-y-1.5 list-decimal list-inside">
              <li>{t('noSchedulesStep1')}</li>
              <li>{t('noSchedulesStep2')}</li>
              <li>{t('noSchedulesStep3')}</li>
              <li>{t('noSchedulesStep4')}</li>
            </ol>
          </div>
        ) : (
          <div className="space-y-2">
            {schedules.map((schedule) => (
              <div key={schedule.id} className="border border-gray-200 dark:border-gray-700 rounded p-3 bg-white dark:bg-gray-900">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm">{schedule.name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${schedule.enabled ? 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400' : 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400'}`}>
                    {schedule.enabled ? t('enabled') : t('disabled')}
                  </span>
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  <span>{t('cron')}: {schedule.cron_expression || 'N/A'}</span>
                  {schedule.last_executed_at && (
                    <span className="ml-3">{t('lastRun')}: {formatTimestamp(schedule.last_executed_at)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Execution Logs Section */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{t('executionLogs')} ({logs.length})</h3>
        {logs.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('noLogs')}</p>
        ) : (
          <div className="space-y-2">
            {logs.map((log) => (
              <div key={log.id} className="border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900">
                <button
                  type="button"
                  onClick={() => void handleExpandLog(log.id)}
                  className="w-full text-left p-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm truncate max-w-[60%]">{log.schedule_name || t('unknownSchedule')}</span>
                    <span className={`text-xs px-2 py-0.5 rounded ${getStatusColor(log.status)}`}>
                      {t(`status.${log.status}`)}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {formatTimestamp(log.started_at)}
                    {formatDuration(log.started_at, log.completed_at) && (
                      <span className="ml-2">({formatDuration(log.started_at, log.completed_at)})</span>
                    )}
                    {log.exit_code !== null && <span className="ml-2">{t('exitCode')}: {log.exit_code}</span>}
                  </div>
                </button>

                {expandedLogId === log.id && logDetail && (
                  <div className="border-t border-gray-200 dark:border-gray-700 p-3 bg-gray-50 dark:bg-gray-800 space-y-3">
                    <div>
                      <div className="text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1">{t('message')}</div>
                      <pre className="text-xs whitespace-pre-wrap font-mono text-gray-700 dark:text-gray-200">
                        {logDetail.message}
                      </pre>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1">{t('response')}</div>
                      <pre className="text-xs whitespace-pre-wrap font-mono text-gray-700 dark:text-gray-200 max-h-60 overflow-y-auto">
                        {logDetail.result || t('noOutput')}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

export default ExecutionLogPane;
