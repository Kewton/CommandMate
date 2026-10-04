'use client';

/**
 * SessionStartingNotice — "<agent> を起動中…" in place of a launching pane
 * (Issue #3179).
 *
 * Shown by every surface while the server publishes `startingSince`: the
 * phone's terminal tab, the PC split, the chat surface and the Sessions tile.
 * Until then those surfaces drew the half-launched pane — a shell prompt with
 * the launch command, a Navigate pad, a trust dialog's buttons — none of which
 * a human had to touch.
 *
 * Past {@link SESSION_STARTING_ELAPSED_THRESHOLD_MS} the elapsed time is added,
 * so a slow launch reads as slow rather than as stuck. The link shows the pane
 * for anybody who wants to watch the launch anyway.
 *
 * @module components/worktree/SessionStartingNotice
 */

import { memo, useEffect, useState } from 'react';
import { Loader2, TerminalSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatElapsed } from '@/components/common/format-elapsed';
import { SESSION_STARTING_ELAPSED_THRESHOLD_MS } from '@/config/session-starting-config';
import { getCliToolDisplayName, type CLIToolType } from '@/lib/cli-tools/types';

/** How often the elapsed time is re-read. */
const ELAPSED_TICK_MS = 1_000;

export interface SessionStartingNoticeProps {
  cliToolId: CLIToolType;
  /** Epoch ms the launch began (the server's `startingSince`). */
  startingSince: number;
  /** The "ターミナルを見る" link. Omitted, the link is not drawn. */
  onShowTerminal?: () => void;
  /**
   * `pane` fills the box the terminal would have filled; `strip` is a single
   * row for the chat surface's footer, under a transcript that stays visible.
   */
  variant?: 'pane' | 'strip';
}

/**
 * Milliseconds since the launch began, re-read every {@link ELAPSED_TICK_MS}.
 *
 * @param startingSince - Epoch ms the launch began
 */
export function useSessionStartingElapsed(startingSince: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, [startingSince]);
  // The two clocks are the server's and the browser's; a skew must not print a
  // negative time.
  return Math.max(0, now - startingSince);
}

export const SessionStartingNotice = memo(function SessionStartingNotice({
  cliToolId,
  startingSince,
  onShowTerminal,
  variant = 'pane',
}: SessionStartingNoticeProps) {
  const t = useTranslations('worktree');
  const elapsedMs = useSessionStartingElapsed(startingSince);
  const agent = getCliToolDisplayName(cliToolId);
  const title = elapsedMs > SESSION_STARTING_ELAPSED_THRESHOLD_MS
    ? t('sessionStarting.titleWithElapsed', { agent, elapsed: formatElapsed(elapsedMs) })
    : t('sessionStarting.title', { agent });

  const link = onShowTerminal ? (
    <button
      type="button"
      onClick={onShowTerminal}
      data-testid="session-starting-show-terminal"
      className="inline-flex min-h-[32px] shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
    >
      <TerminalSquare size={14} aria-hidden="true" />
      {t('sessionStarting.showTerminal')}
    </button>
  ) : null;

  if (variant === 'strip') {
    return (
      <div
        role="status"
        aria-label={t('sessionStarting.label')}
        data-testid="session-starting-notice"
        data-variant="strip"
        className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 px-2 py-1.5"
      >
        <Loader2 size={14} className="shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-xs text-foreground" data-testid="session-starting-title">
          {title}
        </span>
        {link}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-label={t('sessionStarting.label')}
      data-testid="session-starting-notice"
      data-variant="pane"
      className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 bg-surface px-4 text-center text-surface-foreground"
    >
      <Loader2 size={24} className="animate-spin text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground" data-testid="session-starting-title">
        {title}
      </p>
      <p className="text-xs text-muted-foreground">{t('sessionStarting.hint')}</p>
      {link}
    </div>
  );
});

export default SessionStartingNotice;
