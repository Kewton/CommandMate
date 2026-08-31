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
 * Issue #2061 puts an onboarding block at the top. The pane used to say nothing
 * at all about `.commandmate/verify.yaml` — it did not read it — so a repository
 * that had never declared a gate looked exactly like one that had simply never
 * been verified, and pressing Re-verify answered with an English sentence
 * buried in a failed run's `config` gate. The block resolves that into four
 * states with four different next moves; see {@link resolveVerificationPhase}
 * for the precedence and why.
 *
 * @module components/worktree/VerificationPane
 */

'use client';

import React, { memo, useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
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
  VERIFY_CONFIG_DOC_URL,
  VERIFY_CONFIG_RELATIVE_PATH,
  type TaskView,
  type VerificationGateResultView,
  type VerificationRunListItem,
  type VerifyConfigGateView,
  type VerifyConfigResponse,
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

/**
 * Elapsed wall-clock for the run in flight.
 *
 * Not {@link formatGateDuration}: that formats a *gate's* measured duration and
 * rounds anything over ten seconds to whole seconds, so a five-minute run reads
 * `312s`. A run is the thing a human is waiting on, so it is spelled the way a
 * stopwatch does.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * The gates a run adds on top of the declared ones (`work-evidence`, `scope`,
 * and `env-clean` when a declaration switched it on).
 *
 * Subtracted from the server's `plannedGateIds` rather than listed here: the
 * composition is the runner's, it is conditional, and a copy in the browser
 * would be a second answer to "what actually runs" that nothing keeps in step.
 */
function builtinGateIds(config: VerifyConfigResponse | null): string[] {
  if (config === null) return [];
  const declared = new Set(config.gates.map((gate) => gate.id));
  return config.plannedGateIds.filter((id) => !declared.has(id));
}

/** One declared gate, as `verify.yaml` spells it. */
function DeclaredGateRow({ gate }: { gate: VerifyConfigGateView }) {
  return (
    <li
      className="flex flex-col gap-0.5 rounded-md border border-border bg-surface px-2 py-1.5"
      data-testid={`verification-declared-gate-${gate.id}`}
    >
      <span className="break-all font-mono text-xs font-medium text-foreground">{gate.id}</span>
      <span className="break-all font-mono text-[11px] text-muted-foreground">{gate.command}</span>
    </li>
  );
}

/** Small paragraph used throughout the onboarding block. */
function Note({
  children,
  testId,
  tone = 'muted',
}: {
  children: React.ReactNode;
  testId?: string;
  tone?: 'muted' | 'warning';
}) {
  const className =
    tone === 'warning'
      ? 'rounded border border-warning-border bg-warning-subtle px-2 py-1 text-xs text-warning-foreground'
      : 'text-xs text-muted-foreground';
  return (
    <p
      className={`whitespace-pre-line break-words ${className}`}
      data-testid={testId}
      role={tone === 'warning' ? 'alert' : undefined}
    >
      {children}
    </p>
  );
}

/**
 * The pane's first block: what verification is, and what to do next here
 * (Issue #2061).
 *
 * `data-phase` is on the section rather than only implied by which testid is
 * present, because "these four states render differently" is the acceptance
 * criterion and an attribute is the one place a snapshot can read the pane's
 * own answer instead of a tester's inference.
 */
function OnboardingSection({ state }: { state: WorktreeVerificationState }) {
  const t = useTranslations('worktree');
  const { config, configError, phase, runs, selectedRun, latestRun } = state;
  const path = config?.path ?? VERIFY_CONFIG_RELATIVE_PATH;

  const handleDraft = useCallback(() => {
    void state.draftConfig();
  }, [state]);
  const handleRun = useCallback(() => {
    void state.rerun();
  }, [state]);
  const handleShowLatest = useCallback(() => {
    if (latestRun) state.selectRun(latestRun.id);
  }, [latestRun, state]);

  const runningRun = runs.find((run) => run.status === 'running') ?? null;
  // Gate rows are created as each gate starts, so the run's own list is the
  // numerator; the denominator has to come from the config, which knows how
  // many gates a default run will execute. `Math.max` keeps the total honest if
  // a task contract added gates the file does not declare (#1791).
  const recorded = selectedRun && runningRun && selectedRun.id === runningRun.id
    ? selectedRun.gates
    : [];
  const done = recorded.filter((gate) => gate.status !== 'running').length;
  const total = Math.max(config?.plannedGateIds.length ?? 0, recorded.length);
  const elapsedMs = runningRun ? Date.now() - new Date(runningRun.startedAt).getTime() : 0;

  return (
    <section
      className="space-y-2 border-b border-border px-3 py-3"
      data-testid="verification-onboarding"
      data-phase={phase}
    >
      <Note testId="verification-onboarding-what">{t('verification.onboarding.what', { path })}</Note>
      <Note testId="verification-onboarding-how">{t('verification.onboarding.how')}</Note>

      {configError !== null && (
        <Note tone="warning" testId="verification-config-error">
          {t('verification.onboarding.configError', { message: configError })}
        </Note>
      )}
      {config?.error != null && (
        <Note tone="warning" testId="verification-config-invalid">
          {t('verification.onboarding.invalid', { path, message: config.error })}
        </Note>
      )}

      {phase === 'unknown' && (
        <Note testId="verification-onboarding-unknown">{t('verification.onboarding.loading')}</Note>
      )}

      {phase === 'no-config' && (
        <div className="space-y-2" data-testid="verification-onboarding-no-config">
          <Note>{t('verification.onboarding.noConfig.body', { path })}</Note>
          <Note>{t('verification.onboarding.noConfig.hint')}</Note>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={handleDraft}
              disabled={state.draftPending}
              data-testid="verification-draft-button"
            >
              {state.draftPending
                ? t('verification.onboarding.noConfig.pending')
                : t('verification.onboarding.noConfig.action')}
            </Button>
            <a
              href={VERIFY_CONFIG_DOC_URL}
              target="_blank"
              rel="noreferrer noopener"
              data-testid="verification-docs-link"
              className="inline-flex items-center gap-1 rounded text-xs font-medium text-accent-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-accent-400 touch-manipulation"
            >
              {t('verification.onboarding.noConfig.docs')}
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          </div>
          {state.draftFailure && (
            <Note tone="warning" testId="verification-draft-failure">
              {state.draftFailure.kind === 'conflict'
                ? t('verification.onboarding.noConfig.conflict', { path })
                : state.draftFailure.kind === 'empty'
                  ? t('verification.onboarding.noConfig.empty', { path })
                  : t('verification.onboarding.noConfig.error', {
                      message: state.draftFailure.message,
                    })}
            </Note>
          )}
        </div>
      )}

      {phase === 'configured' && (
        <div className="space-y-2" data-testid="verification-onboarding-configured">
          <Note>
            {t('verification.onboarding.configured.body', {
              path,
              count: config?.gates.length ?? 0,
            })}
          </Note>
          {state.draftResult?.created && (
            <Note testId="verification-draft-created">
              {t('verification.onboarding.noConfig.created', {
                path: state.draftResult.path,
                count: state.draftResult.gates.length,
              })}
            </Note>
          )}
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('verification.onboarding.configured.gatesHeading')}
          </h4>
          <ul className="space-y-1" data-testid="verification-declared-gates">
            {(config?.gates ?? []).map((gate) => (
              <DeclaredGateRow key={gate.id} gate={gate} />
            ))}
          </ul>
          <Note testId="verification-builtin-gates">
            {t('verification.onboarding.configured.builtin', {
              gates: builtinGateIds(config).join(', '),
            })}
          </Note>
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={handleRun}
            disabled={state.rerunPending}
            data-testid="verification-run-button"
          >
            {state.rerunPending
              ? t('verification.runs.rerunPending')
              : t('verification.onboarding.configured.action')}
          </Button>
        </div>
      )}

      {phase === 'running' && runningRun !== null && (
        <div className="space-y-1" data-testid="verification-onboarding-running">
          <Note testId="verification-running-progress">
            {t('verification.onboarding.running.progress', { done, total })}
          </Note>
          <Note testId="verification-running-elapsed">
            {t('verification.onboarding.running.elapsed', { elapsed: formatElapsed(elapsedMs) })}
          </Note>
          <Note>{t('verification.onboarding.running.hint')}</Note>
          {/*
            A labelled Refresh, not a Cancel: cancelling a run is Issue #2063's
            surface. What this state can offer today is "stop waiting for the
            poll tick", which the header's icon-only button also does — but the
            operator watching a progress line should not have to know that.
          */}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={state.refresh}
            data-testid="verification-running-refresh-button"
          >
            {t('verification.onboarding.running.action')}
          </Button>
        </div>
      )}

      {phase === 'result' && latestRun !== null && (
        <div className="space-y-2" data-testid="verification-onboarding-result">
          <Note testId="verification-result-body">
            {t('verification.onboarding.result.body', {
              runId: latestRun.id,
              verdict: t(`verification.runStatus.${latestRun.status}`),
            })}
          </Note>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={handleShowLatest}
            data-testid="verification-show-latest-button"
          >
            {t('verification.onboarding.result.action')}
          </Button>
        </div>
      )}
    </section>
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
              {/*
                Terminal output surface: stays dark in BOTH themes (#1075 (a)).
                The intent used to be carried by raw `neutral-*` plus this
                comment, which no guard can read; `terminal-*` is declared once
                in globals.css with no `.dark` counterpart, so the always-dark
                contract is now in the token itself (#1892).
              */}
              <pre className="max-h-64 overflow-auto rounded bg-terminal-surface p-2 font-mono text-[11px] leading-relaxed text-terminal-foreground">
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
    worktreeId,
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
          <OnboardingSection state={state} />

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
                {t('verification.runs.empty', { worktreeId })}
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
