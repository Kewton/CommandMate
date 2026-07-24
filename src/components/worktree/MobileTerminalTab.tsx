'use client';

/**
 * MobileTerminalTab (Issue #736, extracted for #1494/#1496)
 *
 * Mobile terminal tab content. Owns a per-(worktreeId, cliToolId) instance of
 * `useTerminalPanePolling` — the same hook the PC split panes use (#728) —
 * replacing the removed terminal reducer slice. Mounted only while the terminal
 * tab is active, so the poller stops when the user is on another mobile tab (and
 * the hook self-resets on a cliToolId change, mirroring the PC compositeKey reset).
 *
 * Issue #1494 / #1496: mobile previously rendered ONLY the read-only
 * TerminalDisplay, so an unclassified TUI overlay (e.g. Claude `/help`) had no
 * on-screen keys at all — the ESC hatch / navigation pad existed on desktop only.
 * This renders the shared {@link TerminalEscapeHatch} navigation pad below the
 * terminal under the same gate the PC footer uses, giving mobile parity for
 * ←/→/↑/↓/Enter/Esc in detection-independent overlays.
 */

import { memo } from 'react';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { TerminalEscapeHatch } from '@/components/worktree/TerminalEscapeHatch';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import type { CLIToolType } from '@/lib/cli-tools/types';

export interface MobileTerminalTabProps {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Issue #874: agent instance id for this tab (defaults to primary === cliToolId). */
  instanceId?: string;
  disableAutoFollow?: boolean;
}

export const MobileTerminalTab = memo(function MobileTerminalTab({
  worktreeId,
  cliToolId,
  instanceId,
  disableAutoFollow,
}: MobileTerminalTabProps) {
  const { terminal, prompt, setAutoScroll, refresh } = useTerminalPanePolling({
    worktreeId,
    cliToolId,
    instanceId,
  });
  // Issue #1172: compact the 1000-row layout padding for Claude/Codex (display only).
  const compactTuiLayoutPadding = cliToolId === 'claude' || cliToolId === 'codex';

  // Issue #1494 / #1496: detection-independent navigation hatch on mobile.
  // `terminal.isUnclassifiedActive` is already false whenever a selection list /
  // pager / prompt is detected server-side, so this surfaces the pad only for an
  // otherwise-unreachable TUI overlay. `!prompt.visible` mirrors the PC
  // `showEscapeHatch` gate so it stays hidden while a prompt panel is driving the
  // session (e.g. the `/model` misdetection tracked in #1495).
  const showEscapeHatch = terminal.isUnclassifiedActive && !prompt.visible;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0">
        <TerminalDisplay
          output={terminal.output}
          isActive={terminal.isRunning}
          isThinking={terminal.isThinking}
          autoScroll={terminal.autoScroll}
          onScrollChange={setAutoScroll}
          disableAutoFollow={disableAutoFollow}
          compactTuiLayoutPadding={compactTuiLayoutPadding}
          className="h-full"
        />
      </div>
      {showEscapeHatch ? (
        <div className="shrink-0 px-2 pt-1 pb-2">
          <TerminalEscapeHatch
            worktreeId={worktreeId}
            cliToolId={cliToolId}
            instanceId={instanceId}
            onKeysSent={refresh}
          />
        </div>
      ) : null}
    </div>
  );
});

export default MobileTerminalTab;
