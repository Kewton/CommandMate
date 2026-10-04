/**
 * The polled state the chat surface renders, shared by the PC split
 * (`TerminalSplitPaneContent`) and the phone tab (`MobileTerminalTab`).
 *
 * Both used to build this object by hand; Issue #2373 was a field added to one
 * copy and not the other. Built from the same `prompt` object the prompt sheet is
 * driven by, so the banner's "a wait nobody could read" case and the sheet cannot
 * disagree about one frame — see `ChatSurfaceLiveState` for why `isPromptWaiting`
 * is `prompt.visible`.
 */
import { useMemo } from 'react';
import type { ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';
import type { PanePromptState, PaneTerminalState } from '@/hooks/useTerminalPanePolling';

export function useChatSurfaceLiveState(
  terminal: PaneTerminalState,
  prompt: PanePromptState,
): ChatSurfaceLiveState {
  return useMemo(
    () => ({
      isRunning: terminal.isRunning,
      // Issue #2445: without this the surface cannot tell "tmux says
      // there is no session" from the hook's own pre-first-poll default.
      attaching: terminal.attaching,
      // Issue #2238: the generating verdict the surface actually gates
      // its in-flight bubble on. `isRunning` above stays because the
      // surface still reports on the session; it is no longer mistaken
      // for the turn.
      sessionStatus: terminal.sessionStatus,
      isThinking: terminal.isThinking,
      isPromptWaiting: prompt.visible,
      promptData: prompt.data,
      isSelectionListActive: terminal.isSelectionListActive,
      isPagerActive: terminal.isPagerActive,
      // Issue #2373: the field #2369 added and did not copy across. The
      // surface falls back to reading `frame` when this is absent, so the
      // card was already correct — but that fallback reads the raw
      // capture's last 15 rows while the server read `frame.lastLines`,
      // and an explicit `false` from the server could never win because it
      // never arrived. Copied here so the server's answer is the answer.
      isDismissablePanelActive: terminal.isDismissablePanelActive,
      isUnclassifiedActive: terminal.isUnclassifiedActive,
      // Issue #3179: the surface draws the starting strip from this.
      startingSince: terminal.startingSince,
    }),
    [
      terminal.isRunning,
      terminal.attaching,
      terminal.sessionStatus,
      terminal.isThinking,
      terminal.isSelectionListActive,
      terminal.isPagerActive,
      terminal.isDismissablePanelActive,
      terminal.isUnclassifiedActive,
      terminal.startingSince,
      prompt.visible,
      prompt.data,
    ],
  );
}
