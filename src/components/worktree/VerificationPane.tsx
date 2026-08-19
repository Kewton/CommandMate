/**
 * VerificationPane (Issue #1816)
 *
 * The Web UI surface for the execution contract and the verification gates —
 * the two things that decide whether a delegated task is done, and which until
 * now existed only in `commandmate task show` / `commandmate verify` stdout.
 * See `docs/design/discoverability-principle.md`: a judgement an operator
 * cannot reach is operationally absent.
 *
 * Shared by both surfaces, exactly as `TodoPane` is:
 *   - PC: Activity Bar `Verification` activity (`WorktreeDetailDesktop`).
 *   - Mobile: `Tools` tab sub-tab (`NotesAndLogsPane`).
 *
 * Fully controlled: every field comes from {@link WorktreeVerificationState},
 * which one `useWorktreeVerification` in the detail controller owns. The pane
 * fetches nothing itself, so mounting it on a second surface cannot double the
 * request rate, and a component test can drive every state — including the
 * 202 → refetch path — from a plain object.
 *
 * Theme: the gate log tail keeps a dark surface in both themes, matching the
 * repository's convention for terminal output; everything else is painted from
 * theme tokens so it reads in light and dark alike. Nothing is hover-revealed —
 * every control is a button with a persistent label, so the pane behaves the
 * same under a finger as under a pointer.
 *
 * @module components/worktree/VerificationPane
 */

'use client';

import React, { memo, useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  FAILING_GATE_STATUSES,
  GATE_STATUS_VARIANT,
  RUN_STATUS_VARIANT,
  TASK_STATUS_VARIANT,
  excerptLogTail,
  formatGateDuration,
} from '@/config/verification-display';
import {
  MAX_DISPLAYED_LOG_TAIL_LINES,
  type TaskView,
  type VerificationGateResultView,
  type VerificationRunListItem,
} from '@/lib/api/verification-api';
import type { WorktreeVerificationState } from '@/hooks/useWorktreeVerification';

/** Characters of the contract goal shown before the "…" (the pane is not a reader). */
const GOAL_EXCERPT_LENGTH = 240;

export interface VerificationPaneProps {
  /** State owned by `useWorktreeVerification` in the detail controller. */
  state: WorktreeVerificationState;
  className?: string;
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Section wrapper: one heading + one body, so the three sections stay aligned. */
function Section({
  heading,
  action,
  children,
  testId,
}: {
  heading: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section className="border-b border-border px-3 py-3 last:border-b-0" data-testid={testId}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {heading}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * `key: value` row used throughout the contract summary.
 *
 * Stacked at every width on purpose. A `sm:`-gated two-column variant looked
 * right in the mobile Tools tab and wrong in the PC Activity pane: the
 * breakpoint reads the *viewport*, while this pane is ~230px wide inside a
 * 1600px window, so the label column would eat a third of it and wrap every
 * glob mid-token.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-xs text-foreground">{children}</span>
    </div>
  );
}

function ContractSummary({ task }: { task: TaskView }) {
  const t = useTranslations('worktree');
  const contract = task.contract;
  const goal = contract.goal ?? '';
  const goalExcerpt =
    goal.length > GOAL_EXCERPT_LENGTH ? `${goal.slice(0, GOAL_EXCERPT_LENGTH)}…` : goal;

  return (
    <div className="space-y-2" data-testid="verification-contract">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-medium text-foreground">
          {contract.title || task.title}
        </span>
        <Badge variant={TASK_STATUS_VARIANT[task.status]} data-testid="verification-task-status">
          {t(`task.status.${task.status}`)}
        </Badge>
      </div>
      <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{goalExcerpt}</p>
      <div className="space-y-1 pt-1">
        <Field label={t('verification.contract.scopeAllow')}>
          <span className="font-mono">{contract.scope.allow.join(', ') || '—'}</span>
        </Field>
        {contract.scope.deny.length > 0 && (
          <Field label={t('verification.contract.scopeDeny')}>
            <span className="font-mono">{contract.scope.deny.join(', ')}</span>
          </Field>
        )}
        <Field label={t('verification.contract.gates')}>
          <span className="font-mono">
            {contract.verify.gates === null
              ? t('verification.contract.gatesAll')
              : contract.verify.gates.join(', ') || t('verification.contract.gatesAll')}
          </span>
        </Field>
        <Field label={t('verification.contract.autoYes')}>
          <span className="font-mono">
            {contract.autoYes.mode ?? t('verification.contract.autoYesUnset')}
          </span>
        </Field>
        {task.contractPath && (
          <Field label={t('verification.contract.file')}>
            <span className="font-mono">{task.contractPath}</span>
          </Field>
        )}
        <Field label={t('verification.contract.updated')}>{formatTimestamp(task.updatedAt)}</Field>
      </div>
    </div>
  );
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: VerificationRunListItem;
  selected: boolean;
  onSelect: (runId: number) => void;
}) {
  const t = useTranslations('worktree');
  const verdict = t(`verification.runStatus.${run.status}`);
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(run.id)}
        aria-current={selected ? 'true' : undefined}
        aria-label={t('verification.runs.select', { runId: run.id, verdict })}
        data-testid={`verification-run-${run.id}`}
        className={`flex w-full flex-col gap-0.5 rounded-md border px-2 py-2 text-left text-xs transition-colors touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          selected
            ? 'border-accent-500 bg-accent-50 dark:bg-accent-900/30'
            : 'border-border bg-surface hover:bg-muted'
        }`}
      >
        {/* Two lines rather than one: this pane is ~230px wide on PC, and a
            single row pushed `trigger=` past the edge with no way to see it. */}
        <span className="flex items-center gap-2">
          <Badge variant={RUN_STATUS_VARIANT[run.status]} className="flex-shrink-0 font-mono">
            {verdict}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-foreground">
            {formatTimestamp(run.startedAt)}
          </span>
        </span>
        <span className="flex flex-wrap gap-x-2 font-mono text-[11px] text-muted-foreground">
          <span>{t('verification.runs.runLabel', { runId: run.id })}</span>
          <span>{t('verification.runs.trigger', { trigger: run.trigger })}</span>
        </span>
      </button>
    </li>
  );
}

function GateRow({ gate }: { gate: VerificationGateResultView }) {
  const t = useTranslations('worktree');
  const failing = FAILING_GATE_STATUSES.includes(gate.status);
  // Failing gates open with their log, matching what the CLI prints; a passing
  // gate's log is one click away rather than in the reader's face.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? failing;
  const excerpt = excerptLogTail(gate.logTail, MAX_DISPLAYED_LOG_TAIL_LINES);
  const duration = formatGateDuration(gate.durationMs);

  return (
    <li
      className="rounded-md border border-border bg-surface p-2"
      data-testid={`verification-gate-${gate.gateId}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={GATE_STATUS_VARIANT[gate.status]} className="flex-shrink-0 font-mono">
          {t(`verification.gateStatus.${gate.status}`)}
        </Badge>
        <span className="min-w-0 break-all font-mono text-xs font-medium text-foreground">
          {gate.gateId}
        </span>
        {gate.source === 'contract' && (
          <span className="font-mono text-[10px] text-muted-foreground">
            {t('verification.gates.contractSource')}
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
        {gate.exitCode !== null && gate.exitCode !== undefined && (
          <span>{t('verification.gates.exitCode', { code: gate.exitCode })}</span>
        )}
        {duration && <span>{t('verification.gates.duration', { duration })}</span>}
        {gate.command && <span className="break-all">{gate.command}</span>}
      </div>
      <button
        type="button"
        onClick={() => setOverride(!open)}
        aria-expanded={open}
        data-testid={`verification-gate-log-toggle-${gate.gateId}`}
        className="mt-1 rounded text-[11px] font-medium text-accent-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-accent-400 touch-manipulation"
      >
        {open ? t('verification.gates.hideLog') : t('verification.gates.showLog')}
      </button>
      {open && (
        <div className="mt-1" data-testid={`verification-gate-log-${gate.gateId}`}>
          {excerpt.lines.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t('verification.gates.noLog')}</p>
          ) : (
            <>
              {excerpt.omitted > 0 && (
                <p className="mb-1 text-[11px] text-muted-foreground">
                  {t('verification.gates.logOmitted', {
                    count: excerpt.omitted,
                    runId: gate.runId,
                  })}
                </p>
              )}
              {/* Terminal output surface: stays dark in both themes (repo convention). */}
              <pre className="max-h-64 overflow-auto rounded bg-neutral-900 p-2 font-mono text-[11px] leading-relaxed text-neutral-100">
                {excerpt.lines.join('\n')}
              </pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export const VerificationPane = memo(function VerificationPane({
  state,
  className = '',
}: VerificationPaneProps) {
  const t = useTranslations('worktree');
  const {
    task,
    runs,
    selectedRunId,
    selectedRun,
    loading,
    error,
    detailError,
    detailLoading,
    rerunPending,
    rerunFailure,
    selectRun,
    refresh,
    rerun,
  } = state;

  const handleRerun = useCallback(() => {
    void rerun();
  }, [rerun]);

  return (
    <div
      className={`flex h-full flex-col overflow-y-auto bg-surface ${className}`.trim()}
      data-testid="verification-pane"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldCheck size={16} aria-hidden="true" className="flex-shrink-0 text-muted-foreground" />
          <h2 className="truncate text-sm font-semibold text-foreground">
            {t('verification.title')}
          </h2>
        </div>
        <button
          type="button"
          onClick={refresh}
          aria-label={t('verification.refresh')}
          title={t('verification.refresh')}
          data-testid="verification-refresh-button"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>

      {error && (
        <p
          className="border-b border-danger-border bg-danger-subtle px-3 py-2 text-xs text-danger-foreground"
          data-testid="verification-error"
          role="alert"
        >
          {t('verification.loadError', { message: error })}
        </p>
      )}

      {loading ? (
        <p className="px-3 py-4 text-xs text-muted-foreground" data-testid="verification-loading">
          {t('verification.loading')}
        </p>
      ) : (
        <>
          <Section heading={t('verification.contract.heading')} testId="verification-contract-section">
            {task ? (
              <ContractSummary task={task} />
            ) : (
              <p
                className="whitespace-pre-line text-xs text-muted-foreground"
                data-testid="verification-contract-empty"
              >
                {t('verification.contract.empty')}
              </p>
            )}
          </Section>

          <Section
            heading={t('verification.runs.heading')}
            testId="verification-runs-section"
            action={
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={handleRerun}
                disabled={rerunPending}
                data-testid="verification-rerun-button"
              >
                {rerunPending ? t('verification.runs.rerunPending') : t('verification.runs.rerun')}
              </Button>
            }
          >
            {rerunFailure && (
              <p
                className="mb-2 rounded border border-warning-border bg-warning-subtle px-2 py-1 text-xs text-warning-foreground"
                data-testid="verification-rerun-failure"
                role="alert"
              >
                {rerunFailure.kind === 'conflict'
                  ? rerunFailure.runningRunId !== null
                    ? t('verification.runs.rerunConflict', { runId: rerunFailure.runningRunId })
                    : t('verification.runs.rerunConflictUnknown')
                  : t('verification.runs.rerunError', { message: rerunFailure.message })}
              </p>
            )}
            {runs.length === 0 ? (
              <p
                className="whitespace-pre-line text-xs text-muted-foreground"
                data-testid="verification-runs-empty"
              >
                {t('verification.runs.empty')}
              </p>
            ) : (
              <ul className="space-y-1" data-testid="verification-runs">
                {runs.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    selected={run.id === selectedRunId}
                    onSelect={selectRun}
                  />
                ))}
              </ul>
            )}
          </Section>

          {selectedRunId !== null && (
            <Section
              heading={t('verification.gates.heading', { runId: selectedRunId })}
              testId="verification-gates-section"
            >
              {detailError !== null ? (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="verification-gates-error"
                  role="alert"
                >
                  {detailError === 'not-found'
                    ? t('verification.gates.notFound')
                    : t('verification.gates.loadError', { message: detailError })}
                </p>
              ) : selectedRun === null ? (
                <p className="text-xs text-muted-foreground" data-testid="verification-gates-loading">
                  {detailLoading ? t('verification.gates.loading') : t('verification.gates.empty')}
                </p>
              ) : selectedRun.gates.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="verification-gates-empty">
                  {t('verification.gates.empty')}
                </p>
              ) : (
                <ul className="space-y-1.5" data-testid="verification-gates">
                  {selectedRun.gates.map((gate) => (
                    <GateRow key={gate.id} gate={gate} />
                  ))}
                </ul>
              )}
            </Section>
          )}
        </>
      )}
    </div>
  );
});

export default VerificationPane;
