/**
 * OpenCode V2 screen detector — the fallback reader (Issue #2934, Phase 1).
 *
 * OpenCode V2's state comes from its server's SSE stream
 * (`@/lib/hooks/sources/opencode-v2`); this module is what decides when that
 * stream is not there (a pane launched `--standalone`, a subscription that has
 * not reattached yet). It reads, in this order:
 *
 *  - the approval dialog's button strip (`Allow once   Always allow   Reject`)
 *    → `waiting` (Issue #2965);
 *  - the question form's key hints (`↑↓ select  enter submit  esc dismiss`)
 *    → `waiting` (Issue #2965);
 *  - a dialog's title row (`Select variant … esc`, the model / variant
 *    pickers, Commands, Sessions, Select agent) anywhere on the pane
 *    → `waiting` (Issue #2971);
 *  - the footer's `esc interrupt` hint → `running`;
 *  - the completion row (`Build · <model> · 3.5s · 11.2 tok/s`) as the last
 *    transcript row → `ready` (Issue #2965);
 *  - the gutter-anchored empty composer (`┃  Ask anything…`) → `ready`;
 *  - otherwise the footer without that hint (`… 8.6K (1%)  ctrl+p commands`,
 *    the frame after a turn, whose composer is a bare gutter) → `ready`.
 *
 * Both dialogs are drawn INSIDE the composer's `┃` gutter and replace the
 * footer altogether (measured on 2.0.18, 80x200, 2026-09-29:
 * `tests/fixtures/opencode-v2-live-2945/permission-required.txt` /
 * `question.txt`), so before #2965 they reached the floor as `running` /
 * `default` — an unclassified frame, which is what wrote the "could not parse
 * it" row into the chat while the structured layer held the very approval.
 *
 * v1's opencode detector is deliberately not reused: its dialog rule keys on
 * v1's wording (`Allow always`, the reverse word order) and would misread v2.
 *
 * `detectDialog` (Issue #2984) reads the same three surfaces for the Auto-Yes
 * gate (`polling/auto-yes-dialog-gate`), measured on 2.0.18 at 80x200
 * (2026-09-29, `tests/fixtures/opencode-v2-dialogs-2984/`): the approval strip
 * (`keys` — a typed digit leaves it open), the question form (`numbered`,
 * `answer_only` — a typed `2` alone submitted `Blue`) and a dialog title
 * (`keys` — a digit goes into the filter). v2's approvals and questions are
 * still answered through the agent's own API (#2945); what the gate needs from
 * this module is the NO — an agent's reply that quotes a `❯ 1. Yes` dialog is
 * none of the three, so Auto-Yes does not type into the composer for it.
 *
 * @module lib/detection/tools/opencode-v2/detect
 */

import {
  detectThinking,
  findOpencodeV2DialogTitle,
  OPENCODE_V2_FOOTER_PATTERN,
  OPENCODE_V2_IDLE_COMPOSER_PATTERN,
  stripAnsi,
} from '../../cli-patterns';
import { STATUS_REASON } from '../../status-reason';
import { createToolStatusDetector } from '../run-detection';
import { OPENCODE_V2_VERIFIED_AGAINST } from '../verified-against';
import type { DialogVerdict, NormalizedFrame, ToolStatusVerdict } from '../types';

export const VERIFIED_AGAINST = OPENCODE_V2_VERIFIED_AGAINST;

/**
 * The approval dialog's button strip, on the composer's own `┃` gutter:
 * `┃   Allow once   Always allow   Reject  ctrl+f fullscreen  ⇆ select  enter con…`
 * (2.0.18). The gutter anchor keeps the same words reaching the pane inside a
 * reply from being read as a dialog, as v1's `OPENCODE_PERMISSION_PATTERN`
 * does; the word order is v2's own (`Always allow`, not v1's `Allow always`).
 */
export const OPENCODE_V2_PERMISSION_PATTERN =
  /^[^\S\n]*[│┃][^\S\n]*Allow once[^\S\n]{2,}Always allow[^\S\n]{2,}Reject\b/m;

/**
 * The question form's key hints, on the composer's gutter:
 * `┃  ↑↓ select  enter submit  esc dismiss` (2.0.18, below the numbered
 * choices and `Type your own answer`).
 */
export const OPENCODE_V2_QUESTION_PATTERN =
  /^[^\S\n]*[│┃][^\S\n]*↑↓ select[^\S\n]+enter submit[^\S\n]+esc dismiss\b/m;

/**
 * The row that closes a finished turn: `Build · <model> · 3.5s · 11.2 tok/s`
 * (2.0.18). Transcript rows carry no gutter; the composer's model bar
 * (`┃  Build · <model> OpenCode Zen`) does and has no duration, so neither it
 * nor v1's `▣` row matches. A duration is required — the row without one is not
 * a completion (the lesson v1's #1893 learned).
 */
export const OPENCODE_V2_TURN_COMPLETE_PATTERN =
  /^[^\S\n│┃]*[A-Za-z][\w-]*(?: [\w-]+)* · [^\n]+? · \d+(?:\.\d+)?(?:ms|s|m(?: \d+s)?)(?: · [\d.]+ tok\/s)?[^\S\n]*$/;

/** The approval strip's buttons, in the order it draws them (2.0.18). */
export const OPENCODE_V2_PERMISSION_OPTIONS: readonly string[] = ['Allow once', 'Always allow', 'Reject'];

/** A row of the composer's gutter (`┃  …`). The question form is drawn entirely on it. */
const GUTTER_ROW_PATTERN = /^[^\S\n]*[│┃]/;

/** One choice of the question form: `┃  1. Red` (2.0.18). */
const QUESTION_OPTION_ROW_PATTERN = /^[^\S\n]*[│┃][^\S\n]*(\d+)\.[^\S\n]+(\S.*?)[^\S\n]*$/;

/**
 * The question form as a dialog (Issue #2984): the choices on the gutter rows
 * above its key hints, numbered 1..n without a gap. `null` when the hints row
 * is not in the status window or fewer than two choices can be read.
 *
 * `numbered` / `answer_only` because that is what the form does with a digit:
 * measured on 2.0.18, typing `2` with no Enter submitted `Blue`
 * (`tests/fixtures/opencode-v2-dialogs-2984/question-answered-by-digit.txt`).
 */
function readQuestionDialog(frame: NormalizedFrame): DialogVerdict | null {
  if (!OPENCODE_V2_QUESTION_PATTERN.test(frame.lastLines)) return null;
  const lines = frame.contentLines;
  let hints = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPENCODE_V2_QUESTION_PATTERN.test(lines[i])) {
      hints = i;
      break;
    }
  }
  if (hints < 0) return null;

  const options: string[] = [];
  for (let i = hints - 1; i >= 0 && GUTTER_ROW_PATTERN.test(lines[i]); i--) {
    const match = QUESTION_OPTION_ROW_PATTERN.exec(lines[i]);
    if (match) options.unshift(`${match[1]}. ${match[2]}`);
  }
  if (options.length < 2) return null;
  if (!options.every((option, index) => option.startsWith(`${index + 1}. `))) return null;

  return { kind: 'question', options, answerMode: 'numbered', submitMode: 'answer_only' };
}

/** Rows below the transcript that are chrome: gutter padding, the model bar, the rule, the footer, the version. */
function isChromeRow(line: string): boolean {
  if (/^[\s│┃╹▀]*$/.test(line)) return true;
  // The composer's model bar: gutter, then `<Agent> · <model> <provider>` with no second `·`.
  if (/^[^\S\n]*[│┃][^\S\n]*[A-Za-z][\w-]* · [^·\n]+$/.test(line)) return true;
  if (OPENCODE_V2_FOOTER_PATTERN.test(line)) return true;
  return /^\s*\d+\.\d+\.\d+\s*$/.test(line);
}

/**
 * Whether the last transcript row — the first row above the composer's chrome —
 * is the completion row. Only the LAST row counts: the completion row of an
 * earlier turn stays on the pane behind the next turn and behind a dialog.
 */
export function endsWithTurnComplete(frame: NormalizedFrame): boolean {
  const lines = frame.contentLines;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isChromeRow(lines[i])) continue;
    return OPENCODE_V2_TURN_COMPLETE_PATTERN.test(lines[i]);
  }
  return false;
}

export const opencodeV2StatusDetector = createToolStatusDetector({
  tool: 'opencode-v2',
  verifiedAgainst: VERIFIED_AGAINST,

  // Issue #2965: the two dialogs, ahead of everything. Each is the agent
  // blocked on a human whatever else is on the pane — the question frame keeps
  // the previous turn's completion row above it — and ahead of the generic
  // numbered-list parser too, because the question's `1. Red / 2. Blue` is
  // driven by ↑↓ + Enter (hence `hasActivePrompt: false` and a reason from
  // `SELECTION_LIST_REASONS`, which draws the arrow keys instead of offering to
  // type a number). Issue #2984 measured that a typed digit also commits it,
  // with no Enter — see `detectDialog` below.
  beforePrompt(frame): ToolStatusVerdict | null {
    if (OPENCODE_V2_PERMISSION_PATTERN.test(frame.lastLines)) {
      return {
        status: 'waiting',
        confidence: 'high',
        reason: STATUS_REASON.OPENCODE_PERMISSION_PROMPT,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }
    if (OPENCODE_V2_QUESTION_PATTERN.test(frame.lastLines)) {
      return {
        status: 'waiting',
        confidence: 'high',
        reason: STATUS_REASON.OPENCODE_SELECTION_LIST,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }
    // Issue #2971: a dialog opened over the composer keeps the footer (and
    // often the placeholder) on screen, so every rule below read it as `ready`
    // and `wait` completed a turn that never started. Its title row sits ~150
    // rows above the bottom of an 80x200 pane, outside `lastLines`, so the
    // whole frame is read. The reason is v1's (#2112): the same kind of
    // overlay, driven by ↑↓ + Enter and closed with `esc` — no number answers
    // it, hence `hasActivePrompt: false`.
    if (findOpencodeV2DialogTitle(stripAnsi(frame.raw)) !== null) {
      return {
        status: 'waiting',
        confidence: 'high',
        reason: STATUS_REASON.OPENCODE_MODAL_OVERLAY,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }
    return null;
  },

  afterThinking(frame): ToolStatusVerdict | null {
    if (detectThinking('opencode-v2', frame.lastLines)) {
      return {
        status: 'running',
        confidence: 'high',
        reason: STATUS_REASON.THINKING_INDICATOR,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }

    // Issue #2965: the completion row as the last transcript row, with no
    // `esc interrupt` (ruled out just above) — a finished turn, whether or not
    // the footer made it into the capture.
    if (endsWithTurnComplete(frame)) {
      return {
        status: 'ready',
        confidence: 'high',
        reason: STATUS_REASON.OPENCODE_RESPONSE_COMPLETE,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }

    // The placeholder against the ANSI-stripped frame with its box drawing
    // intact (the pattern anchors on the `┃` gutter). The footer is on every
    // frame, and the running hint was ruled out just above.
    if (
      OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(stripAnsi(frame.raw)) ||
      OPENCODE_V2_FOOTER_PATTERN.test(frame.lastLines)
    ) {
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

  // Issue #2984: the seam the Auto-Yes gate and `respond` read. The same three
  // rules `beforePrompt` reports `waiting` on, in the same order, so the gate
  // and the status API agree about which frames carry a dialog.
  //
  // The strip and the question form are anchored on the composer's `┃` gutter,
  // which `stripBoxDrawing` removes: on the spelling the Auto-Yes poller judges
  // they answer `null` (v1's #1893 precedent). For Auto-Yes `null` and `keys`
  // both send nothing, and the question form never reaches the gate anyway —
  // it draws no `❯` for the generic parser to key on.
  detectDialog(frame): DialogVerdict | null {
    if (OPENCODE_V2_PERMISSION_PATTERN.test(frame.lastLines)) {
      return { kind: 'permission', options: OPENCODE_V2_PERMISSION_OPTIONS, answerMode: 'keys' };
    }
    const question = readQuestionDialog(frame);
    if (question !== null) return question;
    if (findOpencodeV2DialogTitle(stripAnsi(frame.raw)) !== null) {
      return { kind: 'picker', options: [], answerMode: 'keys' };
    }
    return null;
  },
});
