/**
 * ExecutionLogsView Component
 * Issue #826: Execution Logs separated from the Schedules view.
 *
 * Renders the execution log list with on-demand detail expansion. Extracted
 * from ExecutionLogPane so the "Logs" tab owns its own expansion state and
 * detail fetching, keeping the Schedules view focused.
 */

'use client';

import React, { useState, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { formatTimestamp, formatDuration } from './format';

// ============================================================================
// Types
// ============================================================================

/** Possible execution log status values */
export type ExecutionLogStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';

/** Execution log entry from the list API (excludes result for performance) */
export interface ExecutionLog {
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
export interface ExecutionLogDetail extends ExecutionLog {
  result: string | null;
}

export interface ExecutionLogsViewProps {
  worktreeId: string;
  logs: ExecutionLog[];
}

// ============================================================================
// Helpers
// ============================================================================

/** Map execution log status to Tailwind CSS color classes */
function getStatusColor(status: ExecutionLogStatus): string {
  switch (status) {
    case 'completed': return 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30';
    case 'failed': return 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30';
    case 'timeout': return 'text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/30';
    case 'running': return 'text-accent-600 dark:text-accent-400 bg-accent-50 dark:bg-accent-900/30';
    case 'cancelled': return 'text-muted-foreground bg-muted';
  }
}

// ============================================================================
// Component
// ============================================================================

export const ExecutionLogsView = memo(function ExecutionLogsView({
  worktreeId,
  logs,
}: ExecutionLogsViewProps) {
  const t = useTranslations('schedule');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [logDetail, setLogDetail] = useState<ExecutionLogDetail | null>(null);

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

  if (logs.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noLogs')}</p>;
  }

  return (
    <div className="space-y-2" data-testid="execution-logs-view">
      {logs.map((log) => (
        <div key={log.id} className="border border-border rounded bg-surface">
          <button
            type="button"
            onClick={() => void handleExpandLog(log.id)}
            className="w-full text-left p-3 hover:bg-muted transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm truncate max-w-[60%]">{log.schedule_name || t('unknownSchedule')}</span>
              <span className={`text-xs px-2 py-0.5 rounded ${getStatusColor(log.status)}`}>
                {t(`status.${log.status}`)}
              </span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {formatTimestamp(log.started_at)}
              {formatDuration(log.started_at, log.completed_at) && (
                <span className="ml-2">({formatDuration(log.started_at, log.completed_at)})</span>
              )}
              {log.exit_code !== null && <span className="ml-2">{t('exitCode')}: {log.exit_code}</span>}
            </div>
          </button>

          {expandedLogId === log.id && logDetail && (
            <div className="border-t border-border p-3 bg-muted space-y-3">
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1">{t('message')}</div>
                <pre className="text-xs whitespace-pre-wrap font-mono text-foreground">
                  {logDetail.message}
                </pre>
              </div>
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1">{t('response')}</div>
                <pre className="text-xs whitespace-pre-wrap font-mono text-foreground max-h-60 overflow-y-auto">
                  {logDetail.result || t('noOutput')}
                </pre>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
});

export default ExecutionLogsView;
