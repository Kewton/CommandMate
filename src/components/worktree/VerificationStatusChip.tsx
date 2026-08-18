/**
 * VerificationStatusChip (Issue #1816)
 *
 * The worktree detail header's answer to "what was this branch told to do, and
 * did it pass?" — the two facts that until now existed only in `commandmate
 * task show` / `verify` stdout.
 *
 * Shown by both surfaces: the PC header (`DesktopHeader`) and the mobile shell.
 * Renders nothing at all when the worktree has no task row, which is the
 * ordinary case for a branch nobody delegated with a contract — an empty chip
 * would be noise on every other screen.
 *
 * Discoverability (`docs/design/discoverability-principle.md`, 実装規約 1): the
 * chip carries the *reason* for its verdict, not just the verdict. The failing
 * gate ids — the thing that actually tells an operator what to do next — go
 * into `aria-label` and `title`, so the reason is reachable by screen reader
 * and by pointer without opening anything. Nothing here is hover-revealed: the
 * chip and both badges are always painted, so a touch device sees exactly what
 * a mouse does, and the same reason is spelled out in the pane the chip opens.
 *
 * @module components/worktree/VerificationStatusChip
 */

'use client';

import React, { memo, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import {
  FAILING_GATE_STATUSES,
  RUN_STATUS_VARIANT,
  TASK_STATUS_VARIANT,
} from '@/config/verification-display';
import type {
  TaskView,
  VerificationGateResultView,
  VerificationRunListItem,
} from '@/lib/api/verification-api';

/** Characters of the task title kept inline before ellipsis. */
const TITLE_MAX_LENGTH = 36;

export interface VerificationStatusChipProps {
  /** Latest task for this worktree. `null` hides the chip entirely. */
  task: TaskView | null;
  /** Latest verification run, or `null` when the branch has never been verified. */
  latestRun: VerificationRunListItem | null;
  /**
   * Gate rows for {@link latestRun}, when they happen to be loaded. Used only
   * to name the failing gates in the reason text; absent simply means the
   * reason stops at the verdict.
   */
  latestRunGates?: VerificationGateResultView[] | null;
  /** Open the Verification pane. */
  onOpen: () => void;
  className?: string;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export const VerificationStatusChip = memo(function VerificationStatusChip({
  task,
  latestRun,
  latestRunGates,
  onOpen,
  className = '',
}: VerificationStatusChipProps) {
  const t = useTranslations('worktree');

  const reason = useMemo(() => {
    if (!task) return '';
    const parts: string[] = [
      t('verification.chip.taskReason', {
        title: task.title,
        status: t(`task.status.${task.status}`),
      }),
    ];

    if (!latestRun) {
      parts.push(t('verification.chip.noRun'));
    } else {
      parts.push(
        t('verification.chip.runReason', {
          verdict: t(`verification.runStatus.${latestRun.status}`),
          runId: latestRun.id,
        })
      );
      if (latestRunGates && latestRunGates.length > 0) {
        const failing = latestRunGates.filter((gate) =>
          FAILING_GATE_STATUSES.includes(gate.status)
        );
        parts.push(
          failing.length > 0
            ? t('verification.chip.failingGates', {
                gates: failing.map((gate) => gate.gateId).join(', '),
              })
            : t('verification.chip.gatesPassed', { count: latestRunGates.length })
        );
      }
    }

    parts.push(t('verification.chip.openHint'));
    return parts.join(' · ');
  }, [task, latestRun, latestRunGates, t]);

  // Issue #1816: 表示条件 — the worktree has a task row. Nothing to report
  // otherwise, and an empty chip on every non-delegated branch is pure noise.
  if (!task) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="verification-status-chip"
      aria-label={reason}
      title={reason}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation ${className}`.trim()}
    >
      <ShieldCheck size={14} aria-hidden="true" className="flex-shrink-0 text-muted-foreground" />
      <span className="truncate font-medium" data-testid="verification-chip-title">
        {truncate(task.title, TITLE_MAX_LENGTH)}
      </span>
      <Badge
        variant={TASK_STATUS_VARIANT[task.status]}
        className="flex-shrink-0 px-1.5 py-0"
        data-testid="verification-chip-task-status"
      >
        {t(`task.status.${task.status}`)}
      </Badge>
      {/* Prefixed with the CLI's own `RESULT` keyword: without it the two
          badges read as one status repeated twice whenever a task and its run
          share a word (`failed`, `not_started`). */}
      <Badge
        variant={latestRun ? RUN_STATUS_VARIANT[latestRun.status] : 'gray'}
        className="flex-shrink-0 px-1.5 py-0 font-mono"
        data-testid="verification-chip-run-status"
      >
        {latestRun
          ? t('verification.chip.resultBadge', {
              verdict: t(`verification.runStatus.${latestRun.status}`),
            })
          : t('verification.chip.dash')}
      </Badge>
    </button>
  );
});

export default VerificationStatusChip;
