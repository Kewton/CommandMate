/**
 * Claude Code's status detector (Issue #1927, 方針書 §4 D2).
 *
 * Two of the three branches here are lifts of existing `status-detector.ts`
 * blocks, unchanged: the selection-list footer (priority 1.5) and the
 * interrupt-hint status bar (priority 2.6). The third — {@link readIdleEvidence}
 * — is what #1927 adds, and the whole reason Claude needed a module of its own.
 */

import {
  CLAUDE_SELECTION_LIST_FOOTER,
  CLAUDE_INTERRUPT_HINT_PATTERN,
} from '../../cli-patterns';
import { findClaudeInputBox } from '../../composer-text';
import { findClaudeTaskPanelLines } from '../../prompt-detect-multiple-choice';
import { STATUS_REASON } from '../../status-reason';
import { createToolStatusDetector } from '../run-detection';
import {
  CLAUDE_BANNER_PATTERN,
  CLAUDE_EFFORT_CHIP_PATTERN,
  CLAUDE_TRANSCRIPT_USER_TURN_PATTERN,
  CLAUDE_TURN_COMPLETE_PATTERN,
  VERIFIED_AGAINST,
} from './patterns';
import type { StatusEvidence } from '@/lib/session/status-evidence';
import type { NormalizedFrame } from '../types';

/**
 * Where Claude's transcript ends in this frame, or -1.
 *
 * Everything Claude pins to the bottom of the pane is chrome, not transcript:
 * the input box, the model/effort chip above it, and the task panel above that
 * (#1708 already had to identify the panel as a block, and its finder is reused
 * here rather than restated). The transcript tail is the first row above all of
 * them, which after `compactBlankRows` is a handful of rows up even when the
 * live pane put ~870 blank rows in between.
 *
 * Returning an index rather than a boolean keeps this usable by anything else
 * that needs "the last thing Claude actually said".
 */
export function findClaudeTranscriptTail(contentLines: readonly string[]): number {
  const lines = contentLines as string[];
  const box = findClaudeInputBox(lines);
  const end = box ? box.openingSeparator : lines.length;
  const panelRows = findClaudeTaskPanelLines(lines, 0, end);

  let index = end - 1;
  while (
    index >= 0 &&
    (lines[index].trim() === '' ||
      panelRows.has(index) ||
      CLAUDE_EFFORT_CHIP_PATTERN.test(lines[index]))
  ) {
    index--;
  }
  return index;
}

/**
 * §4 D1 決定 1: does this frame positively show that Claude's turn is over?
 *
 * Two acceptable answers, both measured (see `patterns.ts`):
 *
 *  - **item 2, a positively confirmed idle state**: the transcript tail is the
 *    duration-bearing completion marker `✻ <Verb> for <N>s`. Claude writes it
 *    when a turn ends and nowhere else — an in-flight turn's row is the
 *    present-participle form with no duration, and a streaming turn's tail is
 *    prose or a tool result.
 *  - **item 4, not-started**: the startup banner is on screen and no user turn
 *    has been echoed under it. A session that has never opened a turn is `ready`
 *    by construction, and this is the positive form of saying so — the banner
 *    proves the frame still shows the beginning of the session, so the missing
 *    user turn means "none was ever sent" rather than "it scrolled off".
 *
 * Everything else is `'none'`: an unrecognised overlay, a frame captured
 * mid-repaint, or — the case that matters — a generating turn whose busy marker
 * this build of Claude spells differently than
 * {@link CLAUDE_INTERRUPT_HINT_PATTERN} expects. That last one is what the
 * mutation fixture in `tests/unit/detection/tools/claude/` pins: change one word
 * of `esc to interrupt` and the frame must lose its evidence, not fall through
 * to a confident `ready`.
 */
export function readIdleEvidence(frame: NormalizedFrame): StatusEvidence {
  const tail = findClaudeTranscriptTail(frame.contentLines);
  if (tail >= 0 && CLAUDE_TURN_COMPLETE_PATTERN.test(frame.contentLines[tail])) {
    return 'positive';
  }

  const box = findClaudeInputBox(frame.contentLines as string[]);
  const transcript = frame.contentLines.slice(0, box ? box.openingSeparator : undefined);
  const hasBanner = transcript.some(line => CLAUDE_BANNER_PATTERN.test(line));
  const hasUserTurn = transcript.some(line => CLAUDE_TRANSCRIPT_USER_TURN_PATTERN.test(line));
  if (hasBanner && !hasUserTurn) return 'positive';

  return 'none';
}

export const claudeStatusDetector = createToolStatusDetector({
  tool: 'claude',
  verifiedAgainst: VERIFIED_AGAINST,

  afterPrompt(frame) {
    // 1.5. Claude CLI selection list detection
    // Claude CLI's multi-select/checkbox prompts (e.g., AskUserQuestion with checkboxes)
    // use arrow keys + Enter to navigate and toggle, not number input.
    // The 15-line window may miss the question line, causing SEC-001a rejection above.
    // Detect via the footer instruction pattern and show NavigationButtons instead of PromptPanel.
    if (CLAUDE_SELECTION_LIST_FOOTER.test(frame.lastLines)) {
      return {
        status: 'waiting' as const,
        confidence: 'high' as const,
        reason: STATUS_REASON.CLAUDE_SELECTION_LIST,
        hasActivePrompt: false,
        evidence: 'positive' as const,
      };
    }
    return null;
  },

  afterThinking(frame) {
    // 2.6. Claude status-bar "esc to interrupt" detection — wider STATUS_CHECK_LINE_COUNT window (Issue #805)
    // When Claude runs a subagent Task (e.g., /pm-auto-dev + general-purpose subagent), the
    // bottom-of-screen task panel ("⏺ main" / "◯ general-purpose ... 55s" rows) pushes BOTH the
    // "✶ Running…" spinner (top of the footer) and the "esc to interrupt" status bar above the
    // narrow THINKING_TAIL_LINE_COUNT (5) window used by step 2. The visible "❯" input box then
    // matches the input-prompt check at step 3, so the session was misreported as Ready.
    //
    // The "esc to interrupt" status bar appears only while Claude is actively processing (idle
    // sessions show "? for shortcuts" or the mode chip instead) and is repainted live rather than
    // lingering in scrollback, so matching it in the wider 15-line footer window is a safe running
    // signal and does not reintroduce the Issue #188 spinner-summary false positive (only the
    // spinner+ellipsis branch is restricted to the 5-line window).
    if (CLAUDE_INTERRUPT_HINT_PATTERN.test(frame.lastLines)) {
      return {
        status: 'running' as const,
        confidence: 'high' as const,
        reason: STATUS_REASON.THINKING_INDICATOR,
        hasActivePrompt: false,
        evidence: 'positive' as const,
      };
    }
    return null;
  },

  readIdleEvidence,

  // No `unreadableReason`: Claude does NOT opt out of the generic composer
  // check, so a Claude frame only reaches the floor when there was no composer
  // row to read either. That is the generic "nothing matched anywhere" case
  // `default` has always named, not a statement about Claude's own rules —
  // `unknown_frame` belongs to the two tools whose chain is the only chain
  // (copilot, opencode).
});
