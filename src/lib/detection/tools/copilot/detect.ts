/**
 * GitHub Copilot CLI's status detector (Issue #1927, 方針書 §4 D2).
 *
 * Every branch here is a verbatim lift of the `cliToolId === 'copilot'` blocks
 * that were interleaved with six other tools' branches inside
 * `detectSessionStatus`. Nothing about the reading changed — copilot's rules
 * were already the §4 D1 shape after #1885 and #1895, which is why it is one of
 * the three tools shipping with `enforce` (see `detection-evidence-config.ts`).
 */

import {
  isCopilotSelectionFrame,
  readCopilotStatusBar,
  stripBoxDrawing,
  buildDetectPromptOptions,
} from '../../cli-patterns';
import { detectPrompt } from '../../prompt-detector';
import { STATUS_REASON } from '../../status-reason';
import { createToolStatusDetector } from '../run-detection';
import { COPILOT_VERIFIED_AGAINST } from '../verified-against';
import type { StatusEvidence } from '@/lib/session/status-evidence';
import type { NormalizedFrame } from '../types';

/** copilot-cli build these rules were read off (#1885 / #1895; value in ../verified-against, #1929). */
export const VERIFIED_AGAINST = COPILOT_VERIFIED_AGAINST;

/**
 * §4 D1 決定 1: copilot's idle evidence is the bottom row of the pane.
 *
 * Recorded here for completeness rather than for effect: branch 2.9 below
 * already refuses to publish `ready` unless `readCopilotStatusBar` says `idle`,
 * and copilot opts out of the generic composer check, so no `ready` verdict can
 * reach the chain's evidence gate without this having been true. Stating it
 * anyway keeps the tool table honest — `detection-evidence-config.ts` says
 * copilot has a measured rule, and this is the rule.
 *
 * Do NOT widen this to a window. `status-vocabulary-in-response.txt` is a live
 * frame in which copilot printed ` ● Working esc interrupt` as body text; a
 * window match would pin a finished session to `running` forever.
 */
export function readIdleEvidence(frame: NormalizedFrame): StatusEvidence {
  return readCopilotStatusBar(frame.contentLines as string[]) === 'idle' ? 'positive' : 'none';
}

export const copilotStatusDetector = createToolStatusDetector({
  tool: 'copilot',
  verifiedAgainst: VERIFIED_AGAINST,

  beforePrompt(frame) {
    // 0. Copilot: picker detection BEFORE thinking detection
    // COPILOT_THINKING_PATTERN includes "Reasoning\s+[■▪▮]" which matches the
    // "Reasoning ■■■ medium" UI element shown in /model selection lists.
    // Without this early check, the selection list would be misdetected as thinking.
    // However, yes/no prompts also contain "to navigate · enter to select" footer,
    // so we must check detectPrompt first — if a prompt is detected, it takes priority
    // over selection list (prompts show PromptPanel with Yes/No buttons). That branch
    // is not hypothetical on 1.0.80: `/permissions` is a picker whose body is a
    // two-option numbered list, and it is the one of the eleven that belongs on
    // PromptPanel rather than on NavigationButtons.
    //
    // Issue #1895 replaced what this reads. The 30-row window it used to match
    // `COPILOT_SELECTION_LIST_PATTERN` against was wrong in both directions at once:
    // it matched none of 1.0.80's eleven pickers (so `/model` fell through to the
    // `running`/`default` floor with no NavigationButtons and `wait` sat on it until
    // the operator closed the picker), and it matched copilot's own prose whenever a
    // reply mentioned "Select Model" or "Search models..." (so a finished turn was
    // published as `waiting`). `isCopilotSelectionFrame` is positional instead: a
    // picker is what copilot draws INSTEAD of its bottom chrome, so the evidence is
    // the bottom row of the pane -- the same row the status-bar branches read -- and
    // never the transcript. Ordering against them is therefore settled inside the
    // helper: it declines any frame that still has a status bar.
    if (isCopilotSelectionFrame(frame.contentLines as string[])) {
      const promptOptions = buildDetectPromptOptions('copilot');
      const promptDetection = detectPrompt(stripBoxDrawing(frame.clean), promptOptions);
      if (promptDetection.isPrompt) {
        // Distinguish yes/no prompts (2-3 options, e.g., "Do you want to run this command?")
        // from ask_user multi-select prompts (4+ options). Yes/no prompts should show
        // PromptPanel with buttons; ask_user prompts need NavigationButtons for ↑↓ selection.
        const optionsCount = promptDetection.promptData?.options?.length ?? 0;
        if (optionsCount <= 3) {
          return {
            status: 'waiting' as const,
            confidence: 'high' as const,
            reason: STATUS_REASON.PROMPT_DETECTED,
            hasActivePrompt: true,
            evidence: 'positive' as const,
            promptDetection,
          };
        }
        // 4+ options: treat as selection list (NavigationButtons)
      }
      return {
        status: 'waiting' as const,
        confidence: 'high' as const,
        reason: STATUS_REASON.COPILOT_SELECTION_LIST,
        hasActivePrompt: false,
        evidence: 'positive' as const,
        promptDetection,
      };
    }

    // 0.5. Copilot: the bottom status bar carries the running half of the turn
    // (Issue #547 put a thinking check here; Issue #1885 replaced what it reads).
    //
    // Copilot keeps the "❯" composer drawn between its two full-width rules even
    // while it generates, so prompt detection matches every frame and the running
    // state has to be resolved before it -- that part is unchanged since #547.
    // What changed is the evidence. `COPILOT_THINKING_PATTERN` was written for
    // copilot's pre-1.0.79 vocabulary and matches NOTHING that 1.0.80 draws
    // (measured: 0 of 44 live generating frames), which is how every frame of a
    // generating session reached the composer check and was published as
    // `ready`/`input_prompt` -- the sidebar showed no glow and `wait` reported the
    // running agent as Completed on its first poll.
    //
    // 1.0.80 puts the state in the bottom row of the pane: " ◉ Working · 1.5 KiB
    // esc interrupt" while the turn runs, key hints when it does not. Reading that
    // ROW rather than a 15-line window is what makes this safe to keep ahead of
    // `detectPrompt`: a dialog takes the row away entirely (its box occupies the
    // bottom of the pane), so a frame with a permission prompt on it cannot reach
    // this branch and still lands on `waiting` at the shared prompt step. The
    // window form would also have matched copilot's own response text -- see
    // `status-vocabulary-in-response.txt`.
    if (readCopilotStatusBar(frame.contentLines as string[]) === 'working') {
      const promptOptions = buildDetectPromptOptions('copilot');
      const promptDetection = detectPrompt(stripBoxDrawing(frame.clean), promptOptions);
      return {
        status: 'running' as const,
        confidence: 'high' as const,
        reason: STATUS_REASON.THINKING_INDICATOR,
        hasActivePrompt: false,
        evidence: 'positive' as const,
        promptDetection,
      };
    }

    return null;
  },

  afterThinking(frame) {
    // 2.9. Copilot: the idle status bar is the completion evidence (Issue #1885)
    //
    // The other rendering of the row branch 0.5 read. Copilot has no completion
    // marker of its own -- no `▣ Build · model · duration` -- and its composer is
    // drawn throughout a turn, so this bar is the only thing on the screen that
    // changes when the turn ends. Seeing the key hints is therefore an affirmative
    // observation that copilot is not working, which is what design rule D1
    // (`docs/design/multi-agent-state-architecture.md` §4 D1 decision 1, item 2)
    // requires before `ready` may be published; the old route to `ready` here was
    // the generic composer check matching an always-visible `❯`, which is the
    // "absence of a busy marker" inference D1 forbids and Issue #1885 reported.
    //
    // Placed after prompt detection, unlike its running counterpart: a `waiting`
    // verdict must never be overtaken by an idle bar, even though no measured
    // 1.0.80 frame draws a dialog and the status bar at once.
    //
    // The wire value stays `ready`/`input_prompt` (DR3-002) -- this is the same
    // verdict claude's `❯` row and codex's `›` row publish, so nothing downstream
    // has to learn a new reason code.
    if (readCopilotStatusBar(frame.contentLines as string[]) === 'idle') {
      return {
        status: 'ready' as const,
        confidence: 'high' as const,
        reason: STATUS_REASON.INPUT_PROMPT,
        hasActivePrompt: false,
        evidence: 'positive' as const,
      };
    }
    return null;
  },

  // Issue #1885: copilot opts out of the generic composer check. Its `❯` row is
  // drawn during generation as well as after it, so that check answered `ready`
  // for every frame of a running turn -- the reported bug. Leaving it in would
  // also make branch 2.9 unobservable: every frame the status bar declined to
  // vouch for would be re-admitted with the same verdict, and the anchor would
  // stop being load-bearing.
  skipGenericInputPrompt: true,

  readIdleEvidence,

  // With the generic check off, this module's own rules are the ONLY rules that
  // run for copilot. A frame that reaches the floor is one they could not read
  // -- a `/model` picker this build draws differently, an unrecognised overlay --
  // and saying so names something an operator can act on (capture it as a
  // fixture) where `default` would only say "nothing matched".
  unreadableReason: STATUS_REASON.UNKNOWN_FRAME,
});
