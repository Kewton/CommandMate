/**
 * ExecutionLogsView Component
 * Issue #826: Execution Logs separated from the Schedules view.
 *
 * Renders the execution log list with on-demand detail expansion. Extracted
 * from ExecutionLogPane so the "Logs" tab owns its own expansion state and
 * detail fetching, keeping the Schedules view focused.
 *
 * Issue #2577: a row whose `warning` is set (command-code reported blocked tool
 * calls) shows the warning under the timestamp and never renders a completed
 * status in the plain success colors.
 */

'use client';

import React, { useState, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { formatTimestamp, formatDuration } from './format';
import { ScheduleConfigWarnings } from './ScheduleConfigWarnings';

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
  /**
   * Issue #2577: the list API's one-line notice, e.g. command-code's
   * `Warning: command-code blocked 2 tool call(s) …`. Server-written English,
   * like the `Reason:` lines in `result`. Absent on older servers.
   */
  warning?: string | null;
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

/**
 * Map execution log status to Tailwind CSS color classes.
 *
 * Issue #2577: a completed run that carries a warning takes the warning tint, so
 * "the CLI exited 0 but refused the tool calls" cannot read as a plain success.
 * Failed / timeout keep their own colors; the warning line says the rest.
 */
function getStatusColor(status: ExecutionLogStatus, hasWarning: boolean): string {
  if (hasWarning && status === 'completed') return 'text-warning-foreground bg-warning-subtle';
  switch (status) {
    case 'completed': return 'text-success-foreground bg-success-subtle';
    case 'failed': return 'text-danger-foreground bg-danger-subtle';
    case 'timeout': return 'text-warning-foreground bg-warning-subtle';
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

  // Issue #2576: CMATE.md warnings sit above the runs they explain, and show
  // before the first run too.
  const configWarnings = <ScheduleConfigWarnings worktreeId={worktreeId} />;

  if (logs.length === 0) {
    return (
      <div className="space-y-2">
        {configWarnings}
        <p className="text-sm text-muted-foreground">{t('noLogs')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="execution-logs-view">
      {configWarnings}
      {logs.map((log) => (
        <div
          key={log.id}
          className="border border-border rounded bg-surface"
          data-testid="execution-log-row"
          data-warning={log.warning ? 'true' : undefined}
        >
          <button
            type="button"
            onClick={() => void handleExpandLog(log.id)}
            className="w-full text-left p-3 hover:bg-muted transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm truncate max-w-[60%]">{log.schedule_name || t('unknownSchedule')}</span>
              <span
                className={`text-xs px-2 py-0.5 rounded ${getStatusColor(log.status, Boolean(log.warning))}`}
                data-testid="execution-log-status"
              >
                {log.warning && <span aria-hidden="true">⚠ </span>}
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
            {log.warning && (
              <div
                className="text-xs text-warning-foreground mt-1 break-words"
                data-testid="execution-log-warning"
              >
                <span aria-hidden="true">⚠ </span>
                {log.warning}
              </div>
            )}
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
