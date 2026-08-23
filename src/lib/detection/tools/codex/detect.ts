/**
 * Codex CLI's status detector (Issue #1927, 方針書 §4 D2).
 *
 * A verbatim lift of the `cliToolId === 'codex'` blocks (priorities 0.7, 0.75,
 * 0.8, the #1160 staleness guard and 2.7) out of `detectSessionStatus`.
 *
 * codex declares NO `readIdleEvidence`. That is the tool-by-tool rollout of
 * §4 D1 決定 1 (DR2-002), not an oversight: its idle row is the bare `›`
 * composer, and telling an empty composer from one holding residual text needs
 * the two SGR attributes `composer-text.ts` reads, which the ANSI-stripped frame
 * this chain runs on no longer carries. Until that rule is measured and
 * fixtured, codex's `input_prompt` keeps the pre-#1927 reading — which the chain
 * expresses by answering `'positive'` for a tool with no rule.
 */

import {
  detectThinking,
  CODEX_PROMPT_PATTERN,
  CODEX_SELECTION_LIST_PATTERN,
  CODEX_APPROVAL_FOOTER_PATTERN,
  CODEX_PAGER_FOOTER_PATTERN,
  CODEX_STATUS_BAR_PATTERN,
  getCodexLifecycleDialog,
  stripBoxDrawing,
  buildDetectPromptOptions,
} from '../../cli-patterns';
import { detectPrompt } from '../../prompt-detector';
import { STATUS_REASON } from '../../status-reason';
import { detectCodexDialog } from './prompt';
import { STATUS_CHECK_LINE_COUNT } from '../frame';
import { createToolStatusDetector } from '../run-detection';
import { CODEX_VERIFIED_AGAINST } from '../verified-against';
import { THINKING_TAIL_LINE_COUNT } from '@/config/thinking-constants';
import type { PromptDetectionResult } from '../../prompt-detector';
import type { ToolStatusVerdict } from '../types';

/** codex-cli build these rules were read off (#1628 / #1829 / #1890; value in ../verified-against, #1929). */
export const VERIFIED_AGAINST = CODEX_VERIFIED_AGAINST;

/**
 * Issue #1160: anchors for the BOTTOM edge of a Codex approval / numbered-choice
 * prompt. Used only by isCodexStalePrompt() to distinguish an ACTIVE prompt (the
 * bottom-most interactive element → waiting) from an already-ANSWERED one lingering
 * in scrollback with Codex processing below it (→ fall through to running detection).
 * Detection-wide Codex patterns live in cli-patterns.ts; these stay local to the guard.
 *
 * CODEX_CONFIRMATION_FOOTER_PATTERN matches the "press number/enter to confirm" footer
 * that closes a numbered prompt. CODEX_NUMBERED_OPTION_PATTERN matches an option line
 * ("1. Yes", optionally prefixed by a ❯/›/● selection indicator). Neither pattern uses
 * /g (keeps .test() stateless) nor nested quantifiers (ReDoS-safe).
 */
const CODEX_CONFIRMATION_FOOTER_PATTERN = /press\s+(?:number|enter)\s+to\s+confirm/i;
const CODEX_NUMBERED_OPTION_PATTERN = /^\s*[❯›●]?\s*\d{1,2}[.)]\s/;

/** Index of the Codex status bar within the last 10 content rows, or -1. */
function findCodexFooterBoundary(contentLines: readonly string[]): number {
  for (let ci = contentLines.length - 1; ci >= Math.max(0, contentLines.length - 10); ci--) {
    if (CODEX_STATUS_BAR_PATTERN.test(contentLines[ci])) return ci;
  }
  return -1;
}

/**
 * Exclusive end of the conversation area — the row below the status bar, with
 * the padding above it walked off (Issue #1928).
 *
 * The same boundary branches 0.8 and 2.7 compute inline, named once so
 * `detectDialog` reads the region THEY read. Falls back to the whole frame when
 * the bar cannot be located, which is Issue #1150's drift case: there the tail
 * is the conversation, so the dialog rule still has the right rows.
 */
function findCodexContentEnd(contentLines: readonly string[]): number {
  const boundary = findCodexFooterBoundary(contentLines);
  let end = boundary >= 0 ? boundary - 1 : contentLines.length - 1;
  while (end >= 0 && contentLines[end].trim() === '') end--;
  return end + 1;
}

/**
 * Issue #1160: decide whether a Codex prompt that detectPrompt() matched is a stale,
 * already-answered prompt left in the 50-line scan window rather than an active one.
 *
 * Codex keeps the answered "1. Yes / 2. No" block + "press number to confirm" footer in
 * its transcript (it draws on the normal screen, so tmux retains a scrollback for it —
 * TMUX_HISTORY_LIMIT lines deep) instead of repainting it away like Claude,
 * so detectPrompt() keeps matching it and the chain reports `waiting` even
 * after the user answered and Codex resumed — the sidebar status dot then stays orange
 * forever (the reported bug).
 *
 * Position-based guard (mirrors isCodexPromptReady()'s bottom-most-element idea): the
 * prompt is stale when a Codex thinking indicator (• Working / • Ran / …) sits strictly
 * BELOW the bottom-most prompt anchor (footer or numbered option) within the content
 * above the status bar. An UNANSWERED prompt has no running indicator below its block,
 * so this returns false and the caller keeps reporting `waiting` (Auto-Yes unaffected).
 *
 * The bare "›" input-line case ("answered, then › below") is already handled upstream by
 * detectPrompt()'s user-input barrier (prompt-detect-multiple-choice.ts), which returns
 * isPrompt=false before this guard runs, so only the thinking-indicator signal is needed
 * here — keeping the guard conservative against flipping a genuine prompt to running.
 */
export function isCodexStalePrompt(contentLines: readonly string[]): boolean {
  const footerBoundary = findCodexFooterBoundary(contentLines);
  const end = footerBoundary >= 0 ? footerBoundary : contentLines.length;

  let lastPromptIdx = -1;
  let lastThinkingIdx = -1;
  for (let i = 0; i < end; i++) {
    const line = contentLines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    if (
      CODEX_CONFIRMATION_FOOTER_PATTERN.test(trimmed) ||
      CODEX_NUMBERED_OPTION_PATTERN.test(trimmed)
    ) {
      lastPromptIdx = i;
    }
    // detectThinking('codex', …) requires the "•" activity prefix, so option text that
    // merely contains a word like "Running" cannot be mistaken for a running indicator.
    if (detectThinking('codex', line)) {
      lastThinkingIdx = i;
    }
  }

  return lastPromptIdx >= 0 && lastThinkingIdx > lastPromptIdx;
}

/**
 * Issue #1628: decide whether a Codex frame that matched CODEX_SELECTION_LIST_PATTERN
 * is the agent ASKING FOR APPROVAL rather than the user browsing a menu.
 *
 * Why this exists: Codex renders both with a "Press enter to confirm" footer, so the
 * selection-list branch (added for `/model` in Issue #622) also swallowed every approval
 * request and returned `hasActivePrompt: false`. `isPromptWaiting` is the only
 * blocked-on-a-human signal the current-output payload carries, so `commandmate wait
 * --on-prompt agent` could never raise exit 10 for a Codex worker sitting on
 * "Would you like to run the following command?" — it polled until the timeout while the
 * agent was stopped. Auto-Yes was unaffected because it calls detectPrompt() directly,
 * which parses these frames correctly; only the status-detector layer lost them.
 *
 * Two OR'd signals, both measured against live codex-cli 0.146.0 captures
 * (5 approval frames from one real session + 2 `/model` picker frames):
 *   1. an interrogative question line directly above the options
 *   2. the approval escape verb ("esc to cancel" vs a menu's "esc to go back")
 * Either alone covers every measured approval frame, so a rewording of one does not
 * reopen the bug.
 *
 * Gated on `promptDetection.isPrompt` so a frame detectPrompt() could not parse into
 * options (e.g. the unnumbered "Select a model" list of Issue #619) can never be
 * promoted to an active prompt.
 */
function isCodexApprovalRequest(
  promptDetection: PromptDetectionResult,
  selectionWindow: string,
): boolean {
  if (!promptDetection.isPrompt) return false;
  const question = promptDetection.promptData?.question?.trim() ?? '';
  return question.endsWith('?') || CODEX_APPROVAL_FOOTER_PATTERN.test(selectionWindow);
}

export const codexStatusDetector = createToolStatusDetector({
  tool: 'codex',
  verifiedAgainst: VERIFIED_AGAINST,

  beforePrompt(frame): ToolStatusVerdict | null {
    const { contentLines } = frame;

    // 0.7. Codex: pager / edit-previous (transcript) mode detection (Issue #1017)
    // Codex's transcript pager renders scroll / edit key-hint footers, e.g.:
    //   "↑/↓ to scroll   pgup/pgdn to page   home/end to jump"
    //   "q to quit   esc/← to edit prev   → to edit next   enter to edit message"
    // together with a scroll-percentage separator ("─ N% ─") in place of the usual
    // "model · N% left · path" status bar. So neither CODEX_SELECTION_LIST_PATTERN
    // (footer is "enter to edit message", not "press enter to confirm/select") nor the
    // status-bar boundary logic below fires, leaving the read-only TerminalDisplay
    // with no way to scroll or escape. Detect the pager footer directly — independent of
    // the "N% left ·" status bar — and surface it as a selection list so NavigationButtons
    // render (isSelectionListActive via SELECTION_LIST_REASONS). Checked ahead of
    // detectPrompt/thinking because the pager has no active y/n prompt and its transcript
    // content must not be misread as one. CODEX_PAGER_FOOTER_PATTERN does not match the
    // genuine "/model" selection footer, so the 0.8 path below is unaffected (no regression).
    if (CODEX_PAGER_FOOTER_PATTERN.test(frame.lastLines)) {
      return {
        status: 'waiting',
        confidence: 'high',
        reason: STATUS_REASON.CODEX_PAGER,
        hasActivePrompt: false,
        evidence: 'positive',
        promptDetection: detectPrompt(
          stripBoxDrawing(frame.clean),
          buildDetectPromptOptions('codex'),
        ),
      };
    }

    // 0.75. Codex: the hooks review screens (Issue #1829)
    // codex-cli 0.148.0 answers "1. Review hooks" with a two-screen review UI:
    //   screen 2 "Press t to trust all; enter to review hooks; esc to close"
    //   screen 3 "Press t to trust; esc to go back"
    // Neither carries a numbered option, a "press enter to confirm" footer, or any
    // thinking indicator, so every branch below falls through to the `running`
    // default -- which is how two live sessions sat parked on screen 3 while the UI
    // and `cmate wait` both reported them as busy. They are the bottom-most
    // interactive element and nothing but a keypress moves them: that is `waiting`.
    // Checked ahead of prompt detection because the transcript rows on screen 2 are
    // ordinary text that must not be read as options.
    const codexLifecycleDialog = getCodexLifecycleDialog(frame.clean);
    if (codexLifecycleDialog === 'hooks-list' || codexLifecycleDialog === 'hooks-detail') {
      return {
        status: 'waiting',
        confidence: 'high',
        reason: STATUS_REASON.CODEX_HOOKS_REVIEW,
        hasActivePrompt: false,
        evidence: 'positive',
        promptDetection: detectPrompt(
          stripBoxDrawing(frame.clean),
          buildDetectPromptOptions('codex'),
        ),
      };
    }

    // 0.8. Codex: selection list detection BEFORE prompt detection (Issue #622)
    // CODEX_SELECTION_LIST_PATTERN matches "press enter to confirm/select" footer.
    // Without this early check, detectPrompt() would detect the numbered
    // options (e.g., "› 1. gpt-5.4") as a multiple_choice prompt, preventing
    // NavigationButtons from being shown. This mirrors the Copilot pattern.
    //
    // The pattern is scoped to the content window immediately above the Codex status
    // bar (mirroring branch 2.7's boundary detection). Matching against the full content
    // would allow stale "Press enter to confirm" text from already-answered approval
    // prompts high in scrollback to falsely trigger NavigationButtons.
    //
    // Issue #1150: the status bar is located via CODEX_STATUS_BAR_PATTERN (version-
    // independent; matches both legacy "N% left ·" and v0.141 "model · path" bars).
    const codexFooterBoundary = findCodexFooterBoundary(contentLines);
    let codexContentEnd =
      codexFooterBoundary >= 0 ? codexFooterBoundary - 1 : contentLines.length - 1;
    while (codexContentEnd >= 0 && contentLines[codexContentEnd].trim() === '') {
      codexContentEnd--;
    }
    if (codexContentEnd >= 0) {
      const codexSelectionWindow = contentLines
        .slice(Math.max(0, codexContentEnd - STATUS_CHECK_LINE_COUNT + 1), codexContentEnd + 1)
        .join('\n');
      if (CODEX_SELECTION_LIST_PATTERN.test(codexSelectionWindow)) {
        const codexPromptDetection = detectPrompt(
          stripBoxDrawing(frame.clean),
          buildDetectPromptOptions('codex'),
        );
        // Issue #1628: an approval request wears the same footer as a menu but is the
        // agent blocked on the human, so it must surface as an active prompt (exit 10
        // for `wait`, PromptPanel in the UI) instead of a navigable list. The #1160
        // staleness guard still applies: an ALREADY-ANSWERED approval whose footer is
        // still inside the window, with Codex running below it, is dead scrollback.
        if (
          isCodexApprovalRequest(codexPromptDetection, codexSelectionWindow) &&
          !isCodexStalePrompt(contentLines)
        ) {
          return {
            status: 'waiting',
            confidence: 'high',
            reason: STATUS_REASON.PROMPT_DETECTED,
            hasActivePrompt: true,
            evidence: 'positive',
            promptDetection: codexPromptDetection,
          };
        }
        return {
          status: 'waiting',
          confidence: 'high',
          reason: STATUS_REASON.CODEX_SELECTION_LIST,
          hasActivePrompt: false,
          evidence: 'positive',
          promptDetection: codexPromptDetection,
        };
      }
    }

    return null;
  },

  isStalePrompt(frame) {
    return isCodexStalePrompt(frame.contentLines);
  },

  // §4 D1 決定 4 (Issue #1928). All three inputs are readings this module
  // already performs for its status branches, passed rather than recomputed:
  // the content boundary (0.8 / 2.7), the #1160 staleness guard and the #1829
  // lifecycle screens. `prompt.ts` therefore needs no import from this file.
  detectDialog(frame) {
    return detectCodexDialog(frame, {
      contentEnd: findCodexContentEnd(frame.contentLines),
      stalePrompt: isCodexStalePrompt(frame.contentLines),
      lifecycleDialog: getCodexLifecycleDialog(frame.clean),
    });
  },

  afterThinking(frame): ToolStatusVerdict | null {
    const { contentLines } = frame;
    // 2.7. Codex TUI content area detection (thinking + idle prompt)
    // Codex TUI layout: conversation area (top) | empty padding (~30 lines) | input area + status bar (bottom).
    // Standard windowed checks (last 5/15 lines) only see padding/status bar, missing both:
    // A. Thinking indicators (• Ran, • Planning) in the conversation area → should show spinner
    // B. Idle prompt (›) at the end of the conversation area → should show ready
    // Strategy: find the Codex status bar, extract content above it, then check for thinking/idle.
    const codexFooterBoundary = findCodexFooterBoundary(contentLines);
    if (codexFooterBoundary >= 0) {
      // Find last non-empty content line above footer (skip padding + input area)
      let lastContentIdx = codexFooterBoundary - 1;
      while (lastContentIdx >= 0 && contentLines[lastContentIdx].trim() === '') {
        lastContentIdx--;
      }
      if (lastContentIdx >= 0) {
        // A. Check content area for thinking indicators (wider window than the shared step)
        const codexThinkingWindow = contentLines
          .slice(Math.max(0, lastContentIdx - THINKING_TAIL_LINE_COUNT + 1), lastContentIdx + 1)
          .join('\n');
        if (detectThinking('codex', codexThinkingWindow)) {
          return {
            status: 'running',
            confidence: 'high',
            reason: STATUS_REASON.THINKING_INDICATOR,
            hasActivePrompt: false,
            evidence: 'positive',
          };
        }

        // B. Check if the last content line is the idle › prompt.
        // The last non-empty line above the status bar is the current active line.
        // When Codex is idle, this is the › prompt (with optional suggestion text).
        // When processing, this is command output (not ›), so the check naturally fails.
        //
        // The evidence stays `positive` here: codex has no measured idle rule yet
        // (see the module docstring), so DR2-002 keeps its pre-#1927 reading.
        if (CODEX_PROMPT_PATTERN.test(contentLines[lastContentIdx].trim())) {
          return {
            status: 'ready',
            confidence: 'high',
            reason: STATUS_REASON.INPUT_PROMPT,
            hasActivePrompt: false,
            evidence: 'positive',
          };
        }

        // C. Fallback: status bar present but neither thinking nor idle › detected.
        // This means Codex is actively processing — command output has pushed the
        // • Ran/• Working indicators beyond the 5-line thinking window.
        // The status bar ("model · N% left · path") is always visible during Codex
        // sessions, and the only idle state (›) was checked in B above.
        return {
          status: 'running',
          confidence: 'high',
          reason: STATUS_REASON.THINKING_INDICATOR,
          hasActivePrompt: false,
          evidence: 'positive',
        };
      }
    } else {
      // D. Status-bar-independent running detection (Issue #1150, mitigation B).
      // Defense-in-depth for the next Codex CLI status-bar format drift: if the bar
      // can't be located (the exact failure that broke Issue #1150), fall back to the
      // Codex thinking indicator in the wider 15-line footer window — mirroring
      // Claude's interrupt-hint net. Gated so idle frames are unaffected:
      // only fires when the tail is NOT the idle › prompt, so an idle session still
      // falls through to the generic composer check.
      let codexTailIdx = contentLines.length - 1;
      while (codexTailIdx >= 0 && contentLines[codexTailIdx].trim() === '') {
        codexTailIdx--;
      }
      const codexTailIsIdlePrompt =
        codexTailIdx >= 0 && CODEX_PROMPT_PATTERN.test(contentLines[codexTailIdx].trim());
      if (!codexTailIsIdlePrompt && detectThinking('codex', frame.lastLines)) {
        return {
          status: 'running',
          confidence: 'high',
          reason: STATUS_REASON.THINKING_INDICATOR,
          hasActivePrompt: false,
          evidence: 'positive',
        };
      }
    }

    return null;
  },
});
