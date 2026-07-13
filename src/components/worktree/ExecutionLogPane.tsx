/**
 * ExecutionLogPane Component
 * Issue #294: Execution log list and schedule overview
 * Issue #826: UX Phase 3 — empty-state CTA, Schedules/Logs tab separation,
 *             inline row actions (toggle / edit / delete icons).
 *
 * Two tabs:
 * - Schedules: active schedule overview + configured schedule rows
 * - Logs: execution log entries (delegated to ExecutionLogsView)
 */

'use client';

import React, { useState, useEffect, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { ScheduleEditDialog, type ScheduleFormValues } from '@/components/worktree/schedules/ScheduleEditDialog';
import { ExecutionLogsView, type ExecutionLog } from '@/components/worktree/schedules/ExecutionLogsView';
import { formatTimestamp } from '@/components/worktree/schedules/format';
import { parseCmateContent } from '@/lib/cmate-validator';
import { parseCliToolColumn } from '@/lib/cmate-cli-tool-parser';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { Button } from '@/components/ui';
import { useConfirm } from '@/components/ui/ConfirmDialog';

// ============================================================================
// Types
// ============================================================================

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
  model?: string;
}

type ScheduleTab = 'schedules' | 'logs';

export interface ExecutionLogPaneProps {
  worktreeId: string;
  className?: string;
  /**
   * Issue #827: forwarded to ScheduleEditDialog so its "Ask AI" buttons can
   * draft a cron / message prompt into the active CLI tab's composer. Optional —
   * when omitted the buttons are hidden (graceful degradation).
   */
  onInsertToMessage?: (text: string) => void;
  /**
   * Issue #942: registered agent instances. Forwarded to ScheduleEditDialog so
   * its agent selector shows registered instance aliases. Schedule execution
   * still routes by the selected instance's backing CLI tool (UI-label only).
   */
  instances?: AgentInstance[];
}

// ============================================================================
// Icons (inline, so row actions stay icon-sized without an icon dep)
// ============================================================================

function EditIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
      <path d="M13.586 3.586a2 2 0 112.828 2.828l-8.5 8.5a1 1 0 01-.43.26l-3 .857a.5.5 0 01-.617-.618l.857-3a1 1 0 01.26-.43l8.5-8.5z" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
      <path fillRule="evenodd" d="M8 2a1 1 0 00-.894.553L6.382 4H3a1 1 0 000 2h.293l.668 9.357A2 2 0 005.956 17h8.088a2 2 0 001.995-1.643L16.707 6H17a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0012 2H8zm1 5a1 1 0 012 0v6a1 1 0 11-2 0V7zm-3 0a1 1 0 011 1v5a1 1 0 11-2 0V8a1 1 0 011-1z" clipRule="evenodd" />
    </svg>
  );
}

// ============================================================================
// Component
// ============================================================================

export const ExecutionLogPane = memo(function ExecutionLogPane({
  worktreeId,
  className = '',
  onInsertToMessage,
  instances,
}: ExecutionLogPaneProps) {
  const t = useTranslations('schedule');
  const confirm = useConfirm();
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [activeSchedules, setActiveSchedules] = useState<ActiveSchedule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // View state (Issue #826)
  const [activeTab, setActiveTab] = useState<ScheduleTab>('schedules');
  const [manualStepsOpen, setManualStepsOpen] = useState(false);

  // Schedule edit dialog state (Issue #824)
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInitial, setDialogInitial] = useState<Partial<ScheduleFormValues> | undefined>(undefined);
  const [dialogOriginalName, setDialogOriginalName] = useState<string | undefined>(undefined);

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

  // --------------------------------------------------------------------------
  // Schedule edit/create/delete/toggle (Issue #824, CMATE.md write-only sync)
  // --------------------------------------------------------------------------

  /**
   * Read the worktree's CMATE.md and build full form values for a schedule by
   * name. CMATE.md is the source of truth for permission/model, which the DB
   * schedule list does not carry. Returns null when unavailable.
   */
  const buildInitialFromCmate = useCallback(
    async (name: string): Promise<Partial<ScheduleFormValues> | null> => {
      try {
        const res = await fetch(`/api/worktrees/${worktreeId}/files/CMATE.md`);
        if (!res.ok) return null;
        const data = await res.json();
        const content: string = typeof data.content === 'string' ? data.content : '';
        const rows = parseCmateContent(content).get('Schedules') ?? [];
        const row = rows.find((r) => (r[0] ?? '').trim() === name);
        if (!row) return null;
        const parsedTool = parseCliToolColumn(row[3] ?? 'claude');
        const enabledStr = (row[4] ?? 'true').trim().toLowerCase();
        return {
          name,
          cronExpression: (row[1] ?? '').trim(),
          message: (row[2] ?? '').trim(),
          cliToolId: parsedTool.cliToolId || 'claude',
          enabled: enabledStr === '' || enabledStr === 'true',
          permission: (row[5] ?? '').trim(),
          model: parsedTool.model ?? '',
        };
      } catch {
        return null;
      }
    },
    [worktreeId],
  );

  const handleNewSchedule = useCallback(() => {
    setDialogOriginalName(undefined);
    setDialogInitial(undefined);
    setDialogOpen(true);
  }, []);

  const handleEditSchedule = useCallback(
    async (schedule: Schedule) => {
      const built = await buildInitialFromCmate(schedule.name);
      setDialogOriginalName(schedule.name);
      setDialogInitial(
        built ?? {
          name: schedule.name,
          cronExpression: schedule.cron_expression,
          message: schedule.message,
          cliToolId: schedule.cli_tool_id,
          enabled: schedule.enabled === 1,
          permission: '',
          model: '',
        },
      );
      setDialogOpen(true);
    },
    [buildInitialFromCmate],
  );

  const handleDeleteSchedule = useCallback(
    async (name: string) => {
      if (!(await confirm({ description: t('edit.confirmDelete', { name }), variant: 'danger' }))) {
        return;
      }
      try {
        const res = await fetch(`/api/worktrees/${worktreeId}/cmate/schedules`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (res.ok) await fetchData();
      } catch (err) {
        console.error('Failed to delete schedule:', err);
      }
    },
    [worktreeId, t, fetchData, confirm],
  );

  const handleToggleSchedule = useCallback(
    async (schedule: Schedule) => {
      try {
        const res = await fetch(`/api/worktrees/${worktreeId}/cmate/schedules`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: schedule.name, enabled: schedule.enabled !== 1 }),
        });
        if (res.ok) await fetchData();
      } catch (err) {
        console.error('Failed to toggle schedule:', err);
      }
    },
    [worktreeId, fetchData],
  );

  if (isLoading) {
    return (
      <div className={`flex items-center justify-center h-full p-4 ${className}`}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-4 border-border border-t-accent-500 rounded-full animate-spin" />
          <span className="text-sm text-muted-foreground">{t('loading')}</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`flex items-center justify-center h-full p-4 ${className}`}>
        <div className="text-center">
          <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
          <Button
            variant="ghost"
            type="button"
            onClick={() => void fetchData()}
            className="ml-2 px-3 py-1 text-sm text-white bg-accent-500 rounded hover:bg-accent-600"
          >
            {t('retry')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Tab bar (Issue #826): separate "Schedules" view from "Logs" view */}
      <div className="flex shrink-0 border-b border-border px-4 pt-3">
        {/* Issue #1061: role=tab aria-selected セグメントタブ — 残置 */}
        <button
          type="button"
          data-testid="schedule-tab-schedules"
          role="tab"
          aria-selected={activeTab === 'schedules'}
          onClick={() => setActiveTab('schedules')}
          className={`-mb-px px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'schedules'
              ? 'border-accent-500 text-accent-700 dark:text-accent-300'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {t('tabs.schedules')} ({schedules.length})
        </button>
        {/* Issue #1061: role=tab aria-selected セグメントタブ — 残置 */}
        <button
          type="button"
          data-testid="schedule-tab-logs"
          role="tab"
          aria-selected={activeTab === 'logs'}
          onClick={() => setActiveTab('logs')}
          className={`-mb-px px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'logs'
              ? 'border-accent-500 text-accent-700 dark:text-accent-300'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {t('tabs.logs')} ({logs.length})
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'schedules' ? (
          <div className="flex flex-col gap-4">
            {/* Active Schedules overview */}
            <div className="rounded border border-accent-100 bg-accent-50/60 p-3 dark:border-accent-900/40 dark:bg-accent-950/20">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-accent-900 dark:text-accent-200">
                  {t('activeSchedulesTitle')} ({activeSchedules.length})
                </span>
                <span className="text-xs text-accent-700 dark:text-accent-300">
                  {t('activeSchedulesDescription')}
                </span>
              </div>
              {activeSchedules.length === 0 ? (
                <p className="text-xs text-accent-800 dark:text-accent-300">{t('noActiveSchedules')}</p>
              ) : (
                <div className="space-y-2">
                  {activeSchedules.map((schedule) => (
                    <div key={schedule.scheduleId} className="rounded border border-accent-200/80 bg-white/80 p-3 dark:border-accent-900/40 dark:bg-surface/60">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-sm text-foreground">{schedule.name}</span>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-2 py-0.5 rounded ${schedule.isCronActive ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'}`}>
                            {schedule.isCronActive ? t('activeState.active') : t('activeState.inactive')}
                          </span>
                          {schedule.isExecuting && (
                            <span className="text-xs px-2 py-0.5 rounded bg-accent-100 text-accent-700 dark:bg-accent-900/30 dark:text-accent-300">
                              {t('activeState.executing')}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        <span>{t('cron')}: {schedule.cronExpression || 'N/A'}</span>
                        <span className="ml-3">{t('agentLabel')}: {schedule.cliToolId}</span>
                        {schedule.model && (
                          <span className="ml-3">model: {schedule.model}</span>
                        )}
                        {schedule.nextRunAt && (
                          <span className="ml-3">{t('nextRun')}: {formatTimestamp(schedule.nextRunAt)}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Configured schedules */}
            {schedules.length === 0 ? (
              <div className="flex flex-col items-center text-center py-8 px-4">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-accent-50 text-accent-600 dark:bg-accent-900/30 dark:text-accent-300">
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-7 h-7">
                    <circle cx="12" cy="12" r="9" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5V12l3 2" />
                  </svg>
                </div>
                <p className="font-semibold text-foreground mb-1">{t('emptyState.title')}</p>
                <p className="text-sm text-muted-foreground mb-5 max-w-xs">{t('emptyState.description')}</p>
                <Button
                  variant="ghost"
                  type="button"
                  data-testid="schedule-empty-cta"
                  onClick={handleNewSchedule}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold text-white bg-accent-600 hover:bg-accent-700 rounded-lg shadow-sm transition-colors"
                >
                  <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path d="M10 4a1 1 0 011 1v4h4a1 1 0 110 2h-4v4a1 1 0 11-2 0v-4H5a1 1 0 110-2h4V5a1 1 0 011-1z" />
                  </svg>
                  {t('emptyState.createButton')}
                </Button>
                {/* Issue #1061: パディングなしテキストリンク（Button の余白/lift が外観を変える）— 残置 */}
                <button
                  type="button"
                  data-testid="schedule-manual-toggle"
                  aria-expanded={manualStepsOpen}
                  onClick={() => setManualStepsOpen((open) => !open)}
                  className="mt-5 text-xs text-accent-700 dark:text-accent-300 hover:underline"
                >
                  {t('emptyState.manualToggle')}
                </button>
                {manualStepsOpen && (
                  <ol
                    data-testid="schedule-manual-steps"
                    className="mt-3 text-xs text-left inline-block space-y-1.5 list-decimal list-inside text-muted-foreground"
                  >
                    <li>{t('noSchedulesStep1')}</li>
                    <li>{t('noSchedulesStep2')}</li>
                    <li>{t('noSchedulesStep3')}</li>
                    <li>{t('noSchedulesStep4')}</li>
                  </ol>
                )}
              </div>
            ) : (
              <div>
                <div className="mb-2 flex items-center justify-end">
                  <Button
                    variant="ghost"
                    type="button"
                    data-testid="schedule-new-button"
                    onClick={handleNewSchedule}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-white bg-accent-600 hover:bg-accent-700 rounded transition-colors whitespace-nowrap"
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                      <path d="M10 4a1 1 0 011 1v4h4a1 1 0 110 2h-4v4a1 1 0 11-2 0v-4H5a1 1 0 110-2h4V5a1 1 0 011-1z" />
                    </svg>
                    {t('edit.newSchedule')}
                  </Button>
                </div>
                <div className="space-y-2">
                  {schedules.map((schedule) => {
                    const isEnabled = schedule.enabled === 1;
                    return (
                      <div key={schedule.id} className="border border-border rounded p-3 bg-white dark:bg-surface">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm truncate">{schedule.name}</span>
                          <div className="flex items-center gap-1">
                            {/* Inline enabled toggle (1-click, no modal) */}
                            {/* Issue #1061: role=switch aria-checked トグルトラック（knob 描画）— 残置 */}
                            <button
                              type="button"
                              role="switch"
                              aria-checked={isEnabled}
                              aria-label={isEnabled ? t('edit.disable') : t('edit.enable')}
                              title={isEnabled ? t('edit.disable') : t('edit.enable')}
                              data-testid={`schedule-toggle-${schedule.name}`}
                              onClick={() => void handleToggleSchedule(schedule)}
                              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                                isEnabled ? 'bg-green-500' : 'bg-input'
                              }`}
                            >
                              <span
                                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                                  isEnabled ? 'translate-x-4' : 'translate-x-0.5'
                                }`}
                              />
                            </button>
                            <Button
                              variant="ghost"
                              type="button"
                              data-testid={`schedule-edit-${schedule.name}`}
                              aria-label={t('edit.edit')}
                              title={t('edit.edit')}
                              onClick={() => void handleEditSchedule(schedule)}
                              className="p-1.5 text-muted-foreground hover:text-accent-600 dark:hover:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-900/20 rounded transition-colors"
                            >
                              <EditIcon />
                            </Button>
                            <Button
                              variant="ghost"
                              type="button"
                              data-testid={`schedule-delete-${schedule.name}`}
                              aria-label={t('edit.delete')}
                              title={t('edit.delete')}
                              onClick={() => void handleDeleteSchedule(schedule.name)}
                              className="p-1.5 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded transition-colors"
                            >
                              <DeleteIcon />
                            </Button>
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          <span>{t('cron')}: {schedule.cron_expression || 'N/A'}</span>
                          {schedule.last_executed_at && (
                            <span className="ml-3">{t('lastRun')}: {formatTimestamp(schedule.last_executed_at)}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <ExecutionLogsView worktreeId={worktreeId} logs={logs} />
        )}
      </div>

      <ScheduleEditDialog
        isOpen={dialogOpen}
        worktreeId={worktreeId}
        initialValues={dialogInitial}
        originalName={dialogOriginalName}
        onInsertToMessage={onInsertToMessage}
        instances={instances}
        onClose={() => setDialogOpen(false)}
        onSaved={() => { void fetchData(); }}
      />
    </div>
  );
});

export default ExecutionLogPane;
