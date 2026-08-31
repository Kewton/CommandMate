/**
 * VerificationStatusChip (Issue #1816, Issue #2064)
 *
 * The worktree detail header's answer to "what was this branch told to do, and
 * did it pass?" — the two facts that until now existed only in `commandmate
 * task show` / `verify` stdout.
 *
 * Shown by both surfaces: the PC header (`DesktopHeader`) and the mobile shell.
 *
 * Issue #2064 — the chip is an ENTRY POINT, so it no longer hides itself on a
 * branch that was never delegated with a contract. The people who most need to
 * find Verification are exactly the ones who have never sent a contract, and
 * the old `if (!task) return null` meant the feature was invisible to them.
 * With no task row the chip names the pane and reports the branch as *not
 * verified*, which is a fact worth stating rather than noise.
 *
 * Discoverability (`docs/design/discoverability-principle.md`, 実装規約 1): the
 * chip carries the *reason* for its verdict, not just the verdict. Until #2064
 * the reason lived in `aria-label` and `title` only — reachable by screen
 * reader and by mouse hover, and by nothing at all on a touch device. It now
 * also has its own toggle (the ⓘ button) that opens the reason as a popover, so
 * a finger reaches the same text a pointer does. Nothing here is hover-revealed:
 * the chip, both badges and the toggle are always painted.
 *
 * @module components/worktree/VerificationStatusChip
 */

'use client';

import React, { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Info, ShieldCheck } from 'lucide-react';
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
  /**
   * Latest task for this worktree, or `null` when the branch was never
   * delegated with an execution contract. Issue #2064: `null` no longer hides
   * the chip — it selects the "no contract" wording.
   */
  task: TaskView | null;
  /** Latest verification run, or `null` when the branch has never been verified. */
  latestRun: VerificationRunListItem | null;
  /**
   * Gate rows belonging to {@link latestRun}, when the caller happens to have
   * them loaded.
   *
   * Both shells derive this from the Verification pane's *selected* run, so
   * they stop supplying it the moment the operator selects an older run in the
   * pane. The failing gate ids are the actionable half of the reason, so the
   * chip keeps the last rows it was given for this same run id instead of
   * letting the header go quiet — see {@link useGatesOfLatestRun} (Issue #2064).
   */
  latestRunGates?: VerificationGateResultView[] | null;
  /** Open the Verification pane. */
  onOpen: () => void;
  className?: string;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Gate rows for `latestRun`, held across changes of the pane's selection.
 *
 * Issue #2064: `latestRunGates` arrives only while the pane's selected run *is*
 * the latest one, which is the default but stops being true as soon as the
 * operator browses history. The rows are keyed by run id, so a genuinely new
 * run clears them rather than showing the previous run's failures under the new
 * verdict.
 */
function useGatesOfLatestRun(
  latestRun: VerificationRunListItem | null,
  supplied: VerificationGateResultView[] | null | undefined
): VerificationGateResultView[] | null {
  const heldRef = useRef<{ runId: number; gates: VerificationGateResultView[] } | null>(null);

  if (latestRun !== null && supplied && supplied.length > 0) {
    heldRef.current = { runId: latestRun.id, gates: supplied };
  }
  if (supplied && supplied.length > 0) return supplied;
  if (latestRun !== null && heldRef.current?.runId === latestRun.id) return heldRef.current.gates;
  return null;
}

export const VerificationStatusChip = memo(function VerificationStatusChip({
  task,
  latestRun,
  latestRunGates,
  onOpen,
  className = '',
}: VerificationStatusChipProps) {
  const t = useTranslations('worktree');
  const [reasonOpen, setReasonOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverId = useId();

  const gates = useGatesOfLatestRun(latestRun, latestRunGates);

  /**
   * The reason, one clause per fact. Rendered as a list inside the popover and
   * joined into the accessible name of the chip itself, so the two channels can
   * never say different things.
   */
  const reasonParts = useMemo(() => {
    const parts: string[] = [
      task
        ? t('verification.chip.taskReason', {
            title: task.title,
            status: t(`task.status.${task.status}`),
          })
        : t('verification.chip.noTask'),
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
      if (gates && gates.length > 0) {
        const failing = gates.filter((gate) => FAILING_GATE_STATUSES.includes(gate.status));
        parts.push(
          failing.length > 0
            ? t('verification.chip.failingGates', {
                gates: failing.map((gate) => gate.gateId).join(', '),
              })
            : t('verification.chip.gatesPassed', { count: gates.length })
        );
      }
    }

    parts.push(t('verification.chip.openHint'));
    return parts;
  }, [task, latestRun, gates, t]);

  const reason = reasonParts.join(' · ');

  const handleOpen = useCallback(() => {
    setReasonOpen(false);
    onOpen();
  }, [onOpen]);

  const toggleReason = useCallback(() => {
    setReasonOpen((open) => !open);
  }, []);

  // Dismiss on Escape or a press outside. `pointerdown` rather than `click` so
  // the popover is gone before the press lands on whatever is underneath it.
  useEffect(() => {
    if (!reasonOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setReasonOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setReasonOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [reasonOpen]);

  return (
    <div ref={rootRef} className={`relative inline-flex max-w-full ${className}`.trim()}>
      {/* `grow`: the mobile shell passes `w-full justify-start` to the root, and
          the pill used to be the root — without it the strip would go from a
          full-width chip to one that hugs its text. */}
      <div className="inline-flex min-w-0 max-w-full grow items-center gap-1 rounded-full border border-border bg-surface-2 pr-1 text-xs text-foreground">
        <button
          type="button"
          onClick={handleOpen}
          data-testid="verification-status-chip"
          aria-label={reason}
          // Kept for pointer users; #2064 makes it the redundant channel rather
          // than the only one.
          title={reason}
          className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-full px-2 py-1 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
        >
          <ShieldCheck size={14} aria-hidden="true" className="flex-shrink-0 text-muted-foreground" />
          <span className="truncate font-medium" data-testid="verification-chip-title">
            {task ? truncate(task.title, TITLE_MAX_LENGTH) : t('verification.title')}
          </span>
          {/* No task row means there is no task status to report; the run badge
              below still says where the branch stands. */}
          {task && (
            <Badge
              variant={TASK_STATUS_VARIANT[task.status]}
              className="flex-shrink-0 px-1.5 py-0"
              data-testid="verification-chip-task-status"
            >
              {t(`task.status.${task.status}`)}
            </Badge>
          )}
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
              : t('verification.chip.unverified')}
          </Badge>
        </button>
        {/* Issue #2064: the reason on a touch device. A second control rather
            than a gesture on the chip itself, because the chip's tap has to keep
            meaning "open the pane". */}
        <button
          type="button"
          onClick={toggleReason}
          data-testid="verification-chip-reason-toggle"
          aria-expanded={reasonOpen}
          aria-controls={popoverId}
          aria-label={t(reasonOpen ? 'verification.chip.hideReason' : 'verification.chip.showReason')}
          className="inline-flex min-h-[32px] min-w-[32px] flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
        >
          <Info size={14} aria-hidden="true" />
        </button>
      </div>
      {reasonOpen && (
        <div
          id={popoverId}
          role="tooltip"
          data-testid="verification-chip-reason-popover"
          className="absolute left-0 top-full z-50 mt-1 w-72 max-w-[80vw] rounded-lg border border-border bg-surface p-3 text-xs leading-relaxed text-foreground shadow-lg"
        >
          <p className="mb-1 font-semibold">{t('verification.chip.reasonHeading')}</p>
          <ul className="space-y-1">
            {reasonParts.map((part) => (
              <li key={part} className="break-words">
                {part}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
});

export default VerificationStatusChip;
