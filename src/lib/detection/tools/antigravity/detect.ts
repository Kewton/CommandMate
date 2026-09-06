/**
 * Antigravity (agy) status detector (Issue #1927, 方針書 §4 D2).
 *
 * A verbatim lift of the `cliToolId === 'antigravity'` blocks (priorities 0.9
 * and 2.8) out of `detectSessionStatus`, plus the Issue #2364 dialog reading in
 * `beforePrompt`.
 *
 * No `readIdleEvidence`: agy's idle branch reads the same always-visible `> `
 * input box that #1885 showed is not evidence on its own. Issue #2364 captured
 * the first live IDLE agy frame (`antigravity-live-2364/boot-idle.txt`: a bare
 * `>` between two rules over a `? for shortcuts` status row), so a rule could
 * now be measured — but it has not been, and per §4 D1 決定 1's tool-by-tool
 * rollout (DR2-002) a tool without a measured rule keeps the pre-#1927 reading.
 * Its rule must be read off ITS OWN frames rather than inferred from another
 * tool's — which is exactly the mistake #1979 corrected.
 */

import {
  detectThinking,
  getCliToolPatterns,
  stripBoxDrawing,
  ANTIGRAVITY_SELECTION_LIST_PATTERN,
  ANTIGRAVITY_SURVEY_PATTERN,
  isAntigravityNumberedDialog,
} from '../../cli-patterns';
import { STATUS_REASON } from '../../status-reason';
import { createToolStatusDetector } from '../run-detection';
import { ANTIGRAVITY_VERIFIED_AGAINST } from '../verified-against';
import { detectAntigravityNumberedDialogPrompt } from './dialog';
import type { ToolStatusVerdict } from '../types';

/** agy build these rules were read off (Issue #988 / #995 / #2364; value in ../verified-against, #1929). */
export const VERIFIED_AGAINST = ANTIGRAVITY_VERIFIED_AGAINST;

/**
 * An agy screen only the terminal can drive: the `/model` picker, the folder
 * trust screen, the slash-command popup — and the post-answer survey.
 *
 * `hasActivePrompt: false` with a reason in `SELECTION_LIST_REASONS` is what
 * puts NavigationButtons (and the chat surface's "drive it from the terminal"
 * card) on screen, and what makes `wait` stop with exit 10 instead of hanging.
 */
const SELECTION_LIST_VERDICT: ToolStatusVerdict = {
  status: 'waiting',
  confidence: 'high',
  reason: STATUS_REASON.ANTIGRAVITY_SELECTION_LIST,
  hasActivePrompt: false,
  evidence: 'positive',
};

/**
 * How close to the bottom of the content the survey row must be to count as
 * open: itself, a blank row and the `? for shortcuts` status row.
 */
const SURVEY_TAIL_ROWS = 3;

/**
 * Is the post-answer survey the live screen, rather than a row of it left in
 * the scrollback? (Issue #2364)
 *
 * agy retains scrollback, so the guard is positional: the `[1] Good … [0] Skip`
 * row is the survey only while it sits within the last few content rows and
 * no bare `>` composer has been drawn below it — the composer is what replaces
 * it once the digit is typed.
 */
function isAntigravitySurveyOpen(contentLines: readonly string[]): boolean {
  const tail = contentLines.slice(-SURVEY_TAIL_ROWS);
  const surveyAt = tail.findIndex(row => ANTIGRAVITY_SURVEY_PATTERN.test(row));
  if (surveyAt < 0) return false;
  const { promptPattern } = getCliToolPatterns('antigravity');
  return !tail.slice(surveyAt + 1).some(row => promptPattern.test(row));
}

export const antigravityStatusDetector = createToolStatusDetector({
  tool: 'antigravity',
  verifiedAgainst: VERIFIED_AGAINST,

  beforePrompt(frame): ToolStatusVerdict | null {
    // 0.85. Issue #2364: the survey agy draws in place of its composer after a
    // tool decision — `[1] Good  [2] Fine  [3] Bad  [0] Skip` under `How's the
    // CLI experience so far?`. Nothing else on that frame is readable: there is
    // no `↑/↓ Navigate` footer and no bare `>` row, so it used to reach the
    // `default` floor as `running`, and the chat surface showed "generating"
    // over a screen waiting for a keypress.
    //
    // Published as a selection list rather than as a `multiple_choice` prompt
    // on purpose. The screen takes a TYPED digit (`0` closes it), while
    // `sendPromptAnswer` drives every numeric agy answer with arrow keys +
    // Enter (Issue #999) — a `0. Skip` button on PromptPanel would send `Up`,
    // `Enter` to a screen that does not navigate. As a selection list the
    // frame is `waiting`, `wait` returns, the waiting push fires, and the chat
    // surface's card points at the terminal, where a single `0` is the answer.
    if (isAntigravitySurveyOpen(frame.contentLines)) return SELECTION_LIST_VERDICT;

    // 0.9. Antigravity: selection list detection BEFORE thinking detection (Issue #995)
    // agy's "Switch Model" (and other) selection TUIs render an "esc to cancel"
    // footer that ANTIGRAVITY_THINKING_PATTERN also matches, so the generic thinking
    // check (and the footer branch below) would otherwise misreport the selection
    // screen as "generating" and NavigationButtons would never be shown. Detecting the
    // selection list here — ahead of thinking — is the fix. Mirrors the Copilot /
    // Codex early-detection pattern.
    if (!ANTIGRAVITY_SELECTION_LIST_PATTERN.test(frame.lastLines)) return null;

    // Issue #2270 / #2364: except when the frame is a NUMBERED dialog.
    //
    // #997 widened the pattern above to the bare `↑/↓ Navigate` footer so the
    // "Do you want to proceed?" menu would reach this branch — but this branch
    // answers `hasActivePrompt: false` and a reason in `SELECTION_LIST_REASONS`,
    // and those two are what the chat surface turns into "a selection list is
    // open, drive it from the terminal" plus a pair of arrow buttons. Enter on
    // those approves the highlighted option 1; nothing on that surface could
    // reach 2-4. Meanwhile the poller stored the SAME frame as a `prompt` row
    // with four `multiple_choice` options and the push notification sent
    // `kind: 'prompt'` — one screen, two answers.
    //
    // #2270 returned null here and let priority 1's generic `detectPrompt` read
    // the frame. That held for the one dialog it measured and broke on the next
    // two (#2364): the file-creation menu never passed its `Do you want to
    // proceed?` discriminator, and a Bash approval whose option labels wrap —
    // agy prints the command inside the label, so most of them do — passed it
    // and then failed in the one-row-per-option parser, after which the `esc
    // to cancel` status row matched the thinking pattern and the pane went out
    // as `running` / `thinking_indicator`. So the discriminator is structural
    // now (`isAntigravityNumberedDialog`), the frame is read by agy's own
    // reader (`./dialog.ts`), and a frame the reader cannot parse is published
    // as UNCLASSIFIED — never as a picker, and never as "generating", which is
    // the worst answer a waiting dialog can get: `wait` never returns from it.
    //
    // `stripBoxDrawing` here, as priority 1 applies it before `detectPrompt`,
    // so this verdict and the response poller's (`detectPromptWithOptions`,
    // which reads the same helper over the same spelling) carry one question,
    // one option list and one `instructionText` for one screen.
    //
    // #995's own case is untouched: the Switch Model picker carries no numbered
    // rows, so it still resolves below and still keeps NavigationButtons.
    const text = stripBoxDrawing(frame.clean);
    if (isAntigravityNumberedDialog(text)) {
      const promptDetection = detectAntigravityNumberedDialogPrompt(text);
      if (promptDetection !== null) {
        return {
          status: 'waiting',
          confidence: 'high',
          reason: STATUS_REASON.PROMPT_DETECTED,
          hasActivePrompt: true,
          evidence: 'positive',
          promptDetection,
        };
      }
      return {
        status: 'running',
        confidence: 'low',
        reason: STATUS_REASON.UNKNOWN_FRAME,
        hasActivePrompt: false,
        evidence: 'none',
      };
    }

    return SELECTION_LIST_VERDICT;
  },

  afterThinking(frame): ToolStatusVerdict | null {
    // 2.8. Antigravity (agy) footer-based detection (Issue #988)
    // agy renders inline (scrollback retained), with the status bar as the last
    // non-empty line and a bare "> " input box always visible just above it — even
    // while generating. So the always-visible "> " would make the generic composer
    // check report ready during generation. The footer is the source of
    // truth: "esc to cancel" + braille spinner / "Generating..." while running,
    // "? for shortcuts" when idle. Resolve running explicitly here first, then idle.
    if (detectThinking('antigravity', frame.lastLines)) {
      return {
        status: 'running',
        confidence: 'high',
        reason: STATUS_REASON.THINKING_INDICATOR,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }
    // Idle: bare "> " input prompt visible and the response has completed.
    const { promptPattern } = getCliToolPatterns('antigravity');
    if (promptPattern.test(frame.lastLines)) {
      return {
        status: 'ready',
        confidence: 'high',
        reason: STATUS_REASON.INPUT_PROMPT,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }
    return null;
  },
});
