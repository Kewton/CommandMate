/**
 * The footer's render gates for `TerminalSplitPaneContent` (Issue #3569).
 *
 * Moved out of the component as they were, so its body stays below the
 * complexity budget; each takes exactly the values the inline expression read.
 */
import { showsPromptUnderAutoYes } from '@/components/worktree/prompt-answer';

type PromptGateData = Parameters<typeof showsPromptUnderAutoYes>[0];

export function shouldShowPromptPanel({
  visible,
  isStarting,
  autoYesEnabled,
  data,
  answerable,
}: {
  visible: boolean;
  isStarting: boolean;
  autoYesEnabled: boolean;
  data: PromptGateData;
  answerable: boolean | undefined;
}): boolean {
  // Issue #2755: Auto-Yes hides the answer panel, because the poller is
  // supposed to be answering instead — and on a CHECKBOX question it is
  // measured never to answer at all (`resolveBaseAnswer` returns null: a digit
  // ticks a box and the confirm is a separate row, so a default is half an
  // answer). Hiding the panel there left a screen nobody could answer, by hand
  // or automatically, until the operator turned Auto-Yes off. So a multi-select
  // prompt is shown whatever Auto-Yes is doing; nothing is auto-sent either way.
  // Issue #3397: and so is a screen CommandMate cannot read
  // (`prompt.answerable === false`): Auto-Yes sends it at most one Enter, and
  // the panel is where that — or the direct-input link when it did not take —
  // is said. See `showsPromptUnderAutoYes`.
  return (
    visible && !isStarting
    && (!autoYesEnabled || showsPromptUnderAutoYes(data, answerable))
  );
}

export function shouldShowNav({
  isSelectionListFrame,
  isChatSurface,
  isStarting,
}: {
  isSelectionListFrame: boolean;
  isChatSurface: boolean;
  isStarting: boolean;
}): boolean {
  // Issue #3179: and never while the agent is launching.
  return isSelectionListFrame && !isChatSurface && !isStarting;
}

export function shouldShowEscapeHatch({
  isUnclassifiedActive,
  isSelectionListFrame,
  promptVisible,
  isChatSurface,
  isStarting,
}: {
  isUnclassifiedActive: boolean;
  isSelectionListFrame: boolean;
  promptVisible: boolean;
  isChatSurface: boolean;
  isStarting: boolean;
}): boolean {
  // Issue #1017 / #1494: detection-independent navigation safety net (←/→/↑/↓/Enter/
  // Esc, plus Codex 'q'). Shown only when the session is interactive but detection
  // could not classify the frame (isUnclassifiedActive) — the "stuck in an
  // unrecognized TUI overlay" case such as Claude `/help`, where NavigationButtons is
  // not rendered — and no selection list / prompt panel is already driving it. Stays
  // hidden during normal generation ('thinking_indicator') and at an idle input prompt
  // ('ready'), so Enter/'q' can never reach the composer.
  // Issue #2254 added the `!isChatSurface` term; the other three are unchanged.
  // `!isSelectionListFrame` is redundant here: the shared hook
  // (useTerminalPanePolling) already drops selection-list frames first, which is
  // why MobileTerminalTab carries no such term.
  return (
    isUnclassifiedActive &&
    !isSelectionListFrame &&
    !promptVisible &&
    !isChatSurface &&
    !isStarting
  );
}
