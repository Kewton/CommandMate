/**
 * OpenCode session controls (Issue #2038)
 *
 * The three session operations opencode has and no other supported agent does,
 * rendered beside the composer for opencode instances only:
 *
 *   - **New session** — `POST /tui/execute-command { command: "session_new" }`
 *   - **Session list** — `POST /tui/open-sessions`, opencode's own picker
 *   - **Fork** — `POST /session/:id/fork`, then `select-session` so the pane
 *     actually moves to the branch
 *
 * All three go through `POST /api/worktrees/:id/opencode/session`, which holds
 * the port lookup and the measured caveats; see that route for why the session
 * *list* is opencode's dialog rather than a list this UI renders (`GET /session`
 * is HOME-wide, measured on 1.18.22).
 *
 * ## Why the labels are in this file
 *
 * They are not translated through `next-intl` because Issue #2038's change scope
 * excludes `locales/`, and a `useTranslations` key with no dictionary entry
 * renders the key path to the operator. A two-locale map keeps the buttons
 * readable in both languages today; moving these five strings into
 * `locales/{en,ja}/…` is a follow-up, and the component reads `useLocale()` so
 * that move is a deletion rather than a rewrite.
 */

'use client';

import React, { memo, useCallback, useState } from 'react';
import { useLocale } from 'next-intl';
import { GitFork, ListTree, MessageSquarePlus } from 'lucide-react';
import { Button, Spinner } from '@/components/ui';
import type { CLIToolType } from '@/lib/cli-tools/types';

/** The actions the route accepts. Mirrors `OPENCODE_SESSION_ACTIONS`. */
export type OpencodeSessionAction = 'new' | 'list' | 'fork';

export interface OpencodeSessionControlsProps {
  worktreeId: string;
  /** Rendered only for `'opencode'`; anything else renders nothing at all. */
  cliToolId: CLIToolType;
  /** Agent instance id. Defaults to the primary instance (`=== cliToolId`). */
  instanceId?: string;
  /** Disabled while no session is running — every action needs a live server. */
  disabled?: boolean;
  /** Called after an action the server accepted. */
  onActionComplete?: (action: OpencodeSessionAction) => void;
}

const LABELS = {
  en: {
    new: 'New opencode session',
    list: 'Open opencode session list',
    fork: 'Fork this opencode session',
  },
  ja: {
    new: '新規セッション',
    list: 'セッション一覧',
    fork: 'セッションを fork',
  },
} as const;

export const OpencodeSessionControls = memo(function OpencodeSessionControls({
  worktreeId,
  cliToolId,
  instanceId,
  disabled = false,
  onActionComplete,
}: OpencodeSessionControlsProps) {
  const locale = useLocale();
  const labels = locale.startsWith('ja') ? LABELS.ja : LABELS.en;
  const [pending, setPending] = useState<OpencodeSessionAction | null>(null);

  const run = useCallback(
    async (action: OpencodeSessionAction) => {
      setPending(action);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}/opencode/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, instanceId: instanceId ?? cliToolId }),
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          console.error(
            '[OpencodeSessionControls] action failed:',
            action,
            detail.error || response.statusText
          );
          return;
        }
        onActionComplete?.(action);
      } catch (error) {
        console.error('[OpencodeSessionControls] request error:', error);
      } finally {
        setPending(null);
      }
    },
    [worktreeId, cliToolId, instanceId, onActionComplete]
  );

  // Not a runtime feature flag: every endpoint behind these buttons exists only
  // on opencode's server, so for any other tool there is nothing to render.
  if (cliToolId !== 'opencode') return null;

  const actions: { action: OpencodeSessionAction; icon: React.ReactNode }[] = [
    { action: 'new', icon: <MessageSquarePlus className="h-5 w-5" aria-hidden="true" /> },
    { action: 'list', icon: <ListTree className="h-5 w-5" aria-hidden="true" /> },
    { action: 'fork', icon: <GitFork className="h-5 w-5" aria-hidden="true" /> },
  ];

  return (
    <div className="flex items-center gap-1" data-testid="opencode-session-controls">
      {actions.map(({ action, icon }) => (
        <Button
          key={action}
          variant="ghost"
          type="button"
          onClick={() => void run(action)}
          disabled={disabled || pending !== null}
          className="flex-shrink-0 p-2 text-muted-foreground hover:text-accent-600 hover:bg-accent-50 dark:hover:text-accent-400 dark:hover:bg-accent-900/30 rounded-full transition-colors disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
          aria-label={labels[action]}
          title={labels[action]}
          data-testid={`opencode-session-${action}`}
        >
          {pending === action ? <Spinner size="md" /> : icon}
        </Button>
      ))}
    </div>
  );
});
