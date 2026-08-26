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
 *
 * Issue #2046: {@link OpencodeQuickKeys} is rendered here for the same reason —
 * a phone has no keyboard aimed at the pane at all, so opencode's `tab` /
 * `ctrl+p` / `ctrl+x` chords are unreachable without it.
 *
 * Issue #1879: the unsent-input bar ({@link UnsentComposerBar}) is rendered here
 * for the same reason — the PC footer has it, and a phone is where a half-typed
 * composer is most likely to be discovered. Its gate is the composer text, not a
 * detection flag, so the two bars can be on screen at once and neither implies
 * the other.
 */

import { memo } from 'react';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { TerminalEscapeHatch } from '@/components/worktree/TerminalEscapeHatch';
import { UnsentComposerBar, hasUnsentComposerText } from '@/components/worktree/UnsentComposerBar';
import { OpencodeQuickKeys } from '@/components/worktree/OpencodeQuickKeys';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import { getTerminalDisplayCompaction } from '@/config/terminal-display-compaction';
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
  const { terminal, prompt, agentSession, setAutoScroll, refresh } = useTerminalPanePolling({
    worktreeId,
    cliToolId,
    instanceId,
  });
  // Issue #1172 / #2049: compact the tall pane's layout padding (display only).
  // Shares the PC declaration in `TerminalSplitPaneContent` through one config
  // module — before #2049 this was a second hand-written copy of the tool list,
  // which is how PC and phone would come to render the same session differently.
  // Issue #2047 added `mobileWrapMode` to the same declaration: opencode's pane
  // is pinned to a fixed column count on the tmux side, so on a phone the frame
  // keeps that width and the pane scrolls sideways rather than re-wrapping every
  // row in half. PC (`TerminalSplitPaneContent`) deliberately does not read it.
  const { compactTuiLayoutPadding, preservePaintedPanelRows, mobileWrapMode } =
    getTerminalDisplayCompaction(cliToolId);

  // Issue #1494 / #1496: detection-independent navigation hatch on mobile.
  // `terminal.isUnclassifiedActive` is already false whenever a selection list /
  // pager / prompt is detected server-side, so this surfaces the pad only for an
  // otherwise-unreachable TUI overlay. `!prompt.visible` mirrors the PC
  // `showEscapeHatch` gate so it stays hidden while a prompt panel is driving the
  // session (e.g. the `/model` misdetection tracked in #1495).
  const showEscapeHatch = terminal.isUnclassifiedActive && !prompt.visible;

  // Issue #1879: contents-only gate, identical to the PC one. Deliberately not
  // combined with `showEscapeHatch` — an unclassified overlay and a composer
  // holding unsent text are unrelated conditions.
  const showUnsentComposerBar = hasUnsentComposerText(terminal.composerText);

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
          preservePaintedPanelRows={preservePaintedPanelRows}
          wrapMode={mobileWrapMode}
          className="h-full"
        />
      </div>
      {showUnsentComposerBar ? (
        <div className="shrink-0 px-2 pt-1">
          <UnsentComposerBar
            worktreeId={worktreeId}
            cliToolId={cliToolId}
            instanceId={instanceId}
            composerText={terminal.composerText}
            onActionSent={refresh}
          />
        </div>
      ) : null}
      {/* Issue #2046: opencode's own chords, on the phone for the same reason
          #1494 put the escape hatch here -- the mobile terminal is read-only and
          has no other way to send them. `compact` drops the key-notation suffix
          so seventeen 44px targets still wrap sensibly on a phone; the keys, the
          gate and the omissions are identical to PC because they come from one
          component. */}
      {terminal.isRunning ? (
        <div className="shrink-0 px-2 pt-1">
          <OpencodeQuickKeys
            worktreeId={worktreeId}
            cliToolId={cliToolId}
            instanceId={instanceId}
            hasAgentSession={agentSession.session !== null}
            onKeysSent={refresh}
            compact
          />
        </div>
      ) : null}
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
