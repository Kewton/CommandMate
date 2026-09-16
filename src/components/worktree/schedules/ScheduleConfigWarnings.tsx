/**
 * ScheduleConfigWarnings Component
 * Issue #2576: CMATE.md warnings that do not depend on the edit dialog.
 *
 * CMATE.md is the source of truth and is edited by hand, so a warning that only
 * lives in ScheduleEditDialog never reaches a schedule written that way. This
 * reads the worktree's CMATE.md through the same files API ExecutionLogPane
 * uses to seed the dialog, runs the shared `collectScheduleWarnings()` judgment,
 * and lists the schedules it flags. It never blocks anything: it only renders.
 *
 * It reflects the *current* CMATE.md, which is why it is a banner and not a
 * badge on individual execution log rows — a run from before the Permission
 * cell changed must not be marked with a warning it did not have.
 */

'use client';

import React, { useEffect, useState, memo } from 'react';
import { useLocale } from 'next-intl';
import { collectScheduleWarnings, parseCmateContent, type CmateValidationWarning } from '@/lib/cmate-validator';
import { getCommandCodeWriteToolsWarningText } from './command-code-write-tools-warning';

export interface ScheduleConfigWarningsProps {
  worktreeId: string;
}

/**
 * Reads CMATE.md on mount and when `worktreeId` changes. There is no other
 * refresh trigger on purpose: in ExecutionLogPane every refetch (save, toggle,
 * delete, retry) swaps the whole tab body for a spinner, and switching to the
 * Logs tab mounts its body afresh, so the banner is remounted -- and re-reads --
 * each time.
 * A host that keeps it mounted across refetches has to add its own trigger.
 */
export const ScheduleConfigWarnings = memo(function ScheduleConfigWarnings({
  worktreeId,
}: ScheduleConfigWarningsProps) {
  const locale = useLocale();
  const [warnings, setWarnings] = useState<CmateValidationWarning[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Keep the same empty array when there was and is nothing to show, so the
    // common case does not re-render the host.
    const show = (next: CmateValidationWarning[]) => {
      if (cancelled) return;
      setWarnings((prev) => (prev.length === 0 && next.length === 0 ? prev : next));
    };

    void (async () => {
      try {
        const res = await fetch(`/api/worktrees/${worktreeId}/files/CMATE.md`);
        const data = res.ok ? await res.json() : null;
        const content = typeof data?.content === 'string' ? data.content : '';
        show(collectScheduleWarnings(parseCmateContent(content).get('Schedules') ?? []));
      } catch {
        // A network error or an unexpected payload: a missing warning must not
        // break the view it sits in.
        show([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [worktreeId]);

  if (warnings.length === 0) return null;

  const text = getCommandCodeWriteToolsWarningText(locale);

  return (
    <div
      role="status"
      data-testid="schedule-config-warnings"
      className="rounded border border-warning-border bg-warning-subtle p-3 text-warning-foreground"
    >
      <p className="text-sm font-semibold">{text.bannerTitle}</p>
      <ul className="mt-1 space-y-1">
        {warnings.map((warning) => (
          <li
            key={`${warning.row}-${warning.name}`}
            data-testid={`schedule-config-warning-${warning.name}`}
            data-warning-code={warning.code}
            className="text-xs"
          >
            <span className="font-medium">{warning.name}</span>
            <span className="ml-2 font-mono">
              {warning.cliToolId} / {warning.permission}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs">{text.body}</p>
    </div>
  );
});

export default ScheduleConfigWarnings;
