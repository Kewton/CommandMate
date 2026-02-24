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

import React, { useState, useEffect, useCallback, useMemo, memo } from 'react';
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

/** Map execution log status to Tailwind CSS color classes */
function getStatusColor(status: ExecutionLogStatus): string {
  switch (status) {
    case 'completed': return 'text-green-600 bg-green-50';
    case 'failed': return 'text-red-600 bg-red-50';
    case 'timeout': return 'text-yellow-600 bg-yellow-50';
    case 'running': return 'text-blue-600 bg-blue-50';
    case 'cancelled': return 'text-gray-600 bg-gray-50';
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
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [logDetail, setLogDetail] = useState<ExecutionLogDetail | null>(null);

  const scheduleNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of schedules) {
      map.set(s.id, s.name);
    }
    return map;
  }, [schedules]);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [logsRes, schedulesRes] = await Promise.all([
        fetch(`/api/worktrees/${worktreeId}/execution-logs`),
        fetch(`/api/worktrees/${worktreeId}/schedules`),
      ]);

      if (logsRes.ok) {
        const logsData = await logsRes.json();
        setLogs(logsData.logs || []);
      }

      if (schedulesRes.ok) {
        const schedulesData = await schedulesRes.json();
        setSchedules(schedulesData.schedules || []);
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
          <div className="w-8 h-8 border-4 border-gray-200 border-t-blue-500 rounded-full animate-spin" />
          <span className="text-sm text-gray-500">{t('loading')}</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`flex items-center justify-center h-full p-4 ${className}`}>
        <div className="text-center">
          <span className="text-sm text-red-600">{error}</span>
          <button
            type="button"
            onClick={() => void fetchData()}
            className="ml-2 px-3 py-1 text-sm text-white bg-blue-500 rounded hover:bg-blue-600"
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
        <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('title')} ({schedules.length})</h3>
        {schedules.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <p className="font-medium text-gray-600 mb-3">{t('noSchedulesTitle')}</p>
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
              <div key={schedule.id} className="border border-gray-200 rounded p-3 bg-white">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm">{schedule.name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${schedule.enabled ? 'bg-green-50 text-green-600' : 'bg-gray-50 text-gray-500'}`}>
                    {schedule.enabled ? t('enabled') : t('disabled')}
                  </span>
                </div>
                <div className="text-xs text-gray-500 mt-1">
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
        <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('executionLogs')} ({logs.length})</h3>
        {logs.length === 0 ? (
          <p className="text-sm text-gray-500">{t('noLogs')}</p>
        ) : (
          <div className="space-y-2">
            {logs.map((log) => (
              <div key={log.id} className="border border-gray-200 rounded bg-white">
                <button
                  type="button"
                  onClick={() => void handleExpandLog(log.id)}
                  className="w-full text-left p-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm truncate max-w-[60%]">{scheduleNameMap.get(log.schedule_id) || t('unknownSchedule')}</span>
                    <span className={`text-xs px-2 py-0.5 rounded ${getStatusColor(log.status)}`}>
                      {t(`status.${log.status}`)}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {formatTimestamp(log.started_at)}
                    {log.exit_code !== null && <span className="ml-2">{t('exitCode')}: {log.exit_code}</span>}
                  </div>
                </button>

                {expandedLogId === log.id && logDetail && (
                  <div className="border-t border-gray-200 p-3 bg-gray-50 space-y-3">
                    <div>
                      <div className="text-xs font-semibold text-gray-600 mb-1">{t('message')}</div>
                      <pre className="text-xs whitespace-pre-wrap font-mono text-gray-700">
                        {logDetail.message}
                      </pre>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-gray-600 mb-1">{t('response')}</div>
                      <pre className="text-xs whitespace-pre-wrap font-mono text-gray-700 max-h-60 overflow-y-auto">
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
