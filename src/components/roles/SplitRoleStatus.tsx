/**
 * The role of a split's session, in its header (Issue #4117): what it was started
 * with and what its next start would use, kept apart. Absent when no role is involved.
 *
 * Restart is the split's existing "end session", with its confirmation: the next
 * message starts a fresh process, and there is no other start.
 *
 * What it shows may be old when a read after a change failed (Issue #4133). The header
 * has no room for the sentence, so that is a mark, with the sentence in its title.
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { useInstanceRoleSettings } from '@/hooks/useInstanceRoleSettings';
import { ambiguityReasonText, roleApplicationView } from './role-display';

export interface SplitRoleStatusProps {
  worktreeId: string;
  instanceId: string;
  splitIndex: number;
  /** Moves when the session starts, ends or changes state, which is when launches get recorded. */
  sessionStatus: string;
  isRunning: boolean;
  /** The split's end-session action. Absent: no restart can be offered. */
  onRestart?: () => void;
}

export function SplitRoleStatus({
  worktreeId,
  instanceId,
  splitIndex,
  sessionStatus,
  isRunning,
  onRestart,
}: SplitRoleStatusProps): React.ReactElement | null {
  const t = useTranslations('common');
  const { settings, stale } = useInstanceRoleSettings(worktreeId, `${sessionStatus}:${isRunning}`);
  const entry = settings?.instances.find((candidate) => candidate.instanceId === instanceId);
  const view = entry ? roleApplicationView(entry, isRunning, t) : null;
  // With nothing to show too: "no role" may itself be the old answer. Not for a tool
  // roles do not apply to, which no newer answer would change.
  const showStale = stale && entry?.supported !== false;
  if (!view && !showStale) return null;
  const reason = entry ? ambiguityReasonText(entry.application.effectiveNext, t) : null;
  const staleText = t('agentRoles.savedStale');
  return (
    <>
      {showStale ? (
        <span
          role="status"
          data-testid={`split-role-stale-${splitIndex}`}
          title={staleText}
          aria-label={staleText}
          className="flex-shrink-0 text-warning"
        >
          <AlertTriangle size={12} aria-hidden="true" />
        </span>
      ) : null}
      {view ? (
        <span
          data-testid={`split-role-status-${splitIndex}`}
          data-pending={view.pending ? 'true' : undefined}
          title={reason ?? view.text}
          className={`min-w-0 max-w-[16rem] shrink-[2] truncate text-[11px] leading-none ${
            view.pending ? 'text-warning' : 'text-muted-foreground'
          }`}
        >
          {view.text}
        </span>
      ) : null}
      {view?.restartable && onRestart ? (
        <button
          type="button"
          data-testid={`split-role-restart-${splitIndex}`}
          title={t('agentRoles.application.restartHint')}
          onClick={onRestart}
          className="flex-shrink-0 rounded px-1 py-0.5 text-[11px] leading-none text-accent-700 dark:text-accent-300 underline hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('agentRoles.application.restart')}
        </button>
      ) : null}
    </>
  );
}
