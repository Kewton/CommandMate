'use client';

/**
 * OpencodeSidebarNotice — tell the user their opencode pane is in two columns,
 * and which key puts it back (Issue #2095).
 *
 * ## Why a notice and not a button
 *
 * opencode's sidebar shares capture ROWS with the transcript, so once it is on
 * every reader in this repo sees `<transcript> … <sidebar>` on one line. Issue
 * #2046 measured the effect at the 80 columns production runs opencode at: a
 * finished turn reads `running` / `unknown_frame`, `isOpenCodeComplete` goes
 * false, and the sidebar's own text is saved as the assistant's reply. Escape
 * does not undo it.
 *
 * #2046 took `b` out of `OPENCODE_LEADER_CHORD_VALUES` and the special-keys
 * route refuses it, so this component **cannot** offer a button that closes the
 * sidebar — and re-opening that decision to give itself one would be putting the
 * key that causes the defect back on the screen. opencode's own `ctrl+p` palette
 * still lists `Show sidebar   ctrl+x b`, which is the path a user reaches it by,
 * so what is missing is not a control: it is knowing what happened. This says
 * so, and names the keystroke.
 *
 * ## Why it derives the signal instead of reading a payload field
 *
 * The server publishes the same finding as `paneObstruction` on `capture --json`
 * — but this reads the frame the pane already holds, exactly as
 * {@link UnsentComposerBar} does for #1879 and for the same reason: the two
 * delivery paths (`terminal_snapshot` over WebSocket, which carries the frame
 * and a fixed set of flags, and the `/current-output` poll, throttled to 15s
 * while push is healthy) would otherwise disagree for up to that whole window.
 * A banner that lingers after the sidebar is closed is worse than no banner.
 *
 * Judged on the same 100-row window the server judges on, so the notice and
 * `capture --json` cannot say different things about one frame.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  detectOpenCodePaneObstruction,
  OPENCODE_SIDEBAR_RECOVERY_CHORD,
} from '@/lib/detection/opencode-pane-obstruction';

export interface OpencodeSidebarNoticeProps {
  cliToolId: CLIToolType;
  /**
   * The last 100 rows of the pane, raw. `terminal.realtimeSnippet` on both
   * delivery paths; `terminal.output` is accepted as a fallback for the tick
   * before the first payload lands.
   */
  frame: string;
}

/**
 * The notice's display gate, shared by the PC footer and the mobile terminal tab.
 *
 * A function rather than an expression repeated at both call sites, for the
 * reason {@link hasUnsentComposerText} is one: a condition that drifts on one
 * surface and not the other is how PC and phone come to disagree about the same
 * session. Tolerates a missing frame — a pane that renders nothing because the
 * snippet had not arrived yet would be a far worse failure than a notice that
 * appears one tick late.
 */
export function hasOpenCodeSidebarObstruction(
  cliToolId: CLIToolType,
  frame: string | null | undefined,
): boolean {
  if (cliToolId !== 'opencode') return false;
  return detectOpenCodePaneObstruction(frame ?? '') !== null;
}

export function OpencodeSidebarNotice({ cliToolId, frame }: OpencodeSidebarNoticeProps) {
  const t = useTranslations('worktree');

  // The frame changes on every poll and the scan walks 100 rows; memoise on the
  // frame itself so an unrelated re-render does not re-walk it.
  const obstructed = useMemo(
    () => hasOpenCodeSidebarObstruction(cliToolId, frame),
    [cliToolId, frame],
  );

  if (!obstructed) return null;

  return (
    <div
      data-testid="opencode-sidebar-notice"
      role="status"
      aria-label={t('opencodeSidebar.regionLabel')}
      className="flex flex-wrap items-center gap-2 px-2 py-1.5 bg-warning-subtle border border-warning-border rounded-lg"
    >
      <span className="text-xs font-medium text-warning-foreground shrink-0">
        {t('opencodeSidebar.label')}
      </span>
      <span className="flex-1 min-w-0 text-xs text-foreground">
        {t('opencodeSidebar.body')}
      </span>
      {/* The chord is physical key notation in opencode's own spelling — identical
          in every locale, and imported rather than written here so this surface,
          the history row and `wait`'s stderr cannot drift apart. */}
      <code
        data-testid="opencode-sidebar-notice-chord"
        className="shrink-0 font-mono text-xs px-1.5 py-0.5 rounded bg-surface border border-warning-border text-warning-foreground"
      >
        {OPENCODE_SIDEBAR_RECOVERY_CHORD}
      </code>
    </div>
  );
}

export default OpencodeSidebarNotice;
