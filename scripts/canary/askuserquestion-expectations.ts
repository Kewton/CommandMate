/**
 * Pure expectations for the AskUserQuestion picker scenarios (Issue #2486).
 *
 * Every predicate here reads an {@link Observation}, so `tests/unit/canary/`
 * replays them against committed frames — the canary's own captures and the
 * hand-driven ones in `tests/fixtures/claude-live-2486/` — with no tmux and no
 * API cost.
 *
 * Each picker expectation makes two independent claims, the rule
 * `opencode-expectations.ts` set down:
 *
 * 1. **The production verdicts** `respond` depends on: the status path publishes
 *    the prompt (what `wait --on-prompt agent` exits 10 on), `detectPrompt`
 *    publishes the picker's own options and question, claude's `detectDialog`
 *    vouches for the frame (what `/prompt-response` re-verifies with), and
 *    Auto-Yes would answer it just as it answers a single question.
 * 2. **A structural fact about the frame** — that the tab bar and/or the
 *    preview is really on screen — spelled HERE rather than imported from
 *    `tools/claude/picker-chrome.ts`. Sharing the detector's pattern would move
 *    both claims at once when it changes, and "did the run reach the shape it
 *    was meant to exercise?" would stop being answerable.
 */

import { stripAnsi } from '@/lib/detection/ansi';
import { stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { STATUS_REASON } from '@/lib/detection/status-detector';
import { evaluateAutoYesDialogGate, evaluateDialogPresence } from '@/lib/polling/auto-yes-dialog-gate';
import { resolveAutoAnswer } from '@/lib/polling/auto-yes-resolver';
import type { Expectation, Observation } from './types';

/** What one picker scenario must find on its first screen. */
export interface AskUserQuestionPickerShape {
  /** Names the expectation in the run report. */
  id: string;
  /** Every question's header, in order. The tab bar names them all. */
  headers: readonly string[];
  /** Whether the multi-question tab bar (`← … ✔ Submit →`) must be on screen. */
  tabBar: boolean;
  /** Text question 1's highlighted preview begins with, or null when it has none. */
  previewText: string | null;
  /** Question 1, exactly as the payload asked it. */
  question: string;
  /** The options `respond` must be offered, from option 1, all of them. */
  options: readonly string[];
}

/** The preview pane's outline. No option label and no question may carry it. */
const PANE_OUTLINE = /[┌┐└┘│]/;

/**
 * The environment the Auto-Yes gate is judged under: no `CM_AUTOYES_DIALOG_GATE`,
 * so an operator's kill switch cannot decide a canary verdict. `NODE_ENV` is
 * there only because the typings require it; the gate does not read it.
 */
const GATE_ENV_WITHOUT_KILL_SWITCH: NodeJS.ProcessEnv = { NODE_ENV: 'production' };

/** Whitespace-insensitive: the pane width decides where a long question wraps. */
function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

function screenRows(frame: string): string[] {
  return stripAnsi(frame)
    .split('\n')
    .map(row => row.trim());
}

/** The tab bar is on screen: one row, the opening arrow, every header, `Submit`. */
export function showsTabBar(frame: string, headers: readonly string[]): boolean {
  return screenRows(frame).some(
    row => row.startsWith('←') && row.includes('Submit') && headers.every(header => row.includes(header))
  );
}

/** The tab bar marks `header` as answered (`☒`) — question 1 is behind us. */
export function showsAnsweredTab(frame: string, header: string): boolean {
  return screenRows(frame).some(row => row.startsWith('←') && row.includes(`☒ ${header}`));
}

/**
 * `text` is on screen, however the pane width wrapped it.
 *
 * Box drawing is removed first: the picker draws its question behind a `│ `
 * gutter, so a wrapped question reads `…24 │ 系へ…` across the break.
 */
export function showsText(frame: string, text: string): boolean {
  return squash(stripBoxDrawing(stripAnsi(frame))).includes(squash(text));
}

/** The answer review with its own `Submit answers` / `Cancel`. */
export function showsReviewScreen(frame: string): boolean {
  const rows = screenRows(frame);
  return rows.includes('Ready to submit your answers?') && rows.some(row => /^❯\s*1\. Submit answers$/.test(row));
}

/** A picker footer is still drawn, i.e. the picker has not closed. */
function showsPickerFooter(frame: string): boolean {
  return screenRows(frame).some(row => /^Enter to select\b/.test(row));
}

/**
 * The first screen of an AskUserQuestion picker, read the way `respond` needs it.
 *
 * `evaluateAutoYesDialogGate` is handed an empty environment so an operator's
 * `CM_AUTOYES_DIALOG_GATE` cannot decide the verdict, and the ANSI- and
 * box-stripped spelling, which is what the Auto-Yes poller hands it.
 */
export function expectAskUserQuestionPicker(shape: AskUserQuestionPickerShape): Expectation {
  return {
    label:
      `${shape.id}: waiting/prompt_detected, options [${shape.options.join(' | ')}], ` +
      'question without the tab row or the previous tool, vouched by detectDialog, Auto-Yes answers 1',
    matches: (o: Observation): boolean => {
      if (showsTabBar(o.frame, shape.headers) !== shape.tabBar) return false;
      if (shape.previewText !== null && !showsText(o.frame, shape.previewText)) return false;

      if (
        o.status.status !== 'waiting' ||
        o.status.reason !== STATUS_REASON.PROMPT_DETECTED ||
        !o.status.hasActivePrompt
      ) {
        return false;
      }

      const promptData = o.autoYes.promptData;
      if (!o.autoYes.isPrompt || promptData?.type !== 'multiple_choice') return false;
      if (promptData.isAskUserQuestion !== true) return false;

      const labels = promptData.options.map(option => option.label);
      if (labels.length !== shape.options.length) return false;
      if (shape.options.some((label, i) => labels[i] !== label)) return false;
      if (labels.some(label => PANE_OUTLINE.test(label))) return false;
      if (squash(promptData.question) !== squash(shape.question)) return false;

      if (!evaluateDialogPresence('claude', 'multiple_choice', o.frame).present) return false;
      const gate = evaluateAutoYesDialogGate(
        'claude',
        'multiple_choice',
        stripBoxDrawing(stripAnsi(o.frame)),
        GATE_ENV_WITHOUT_KILL_SWITCH
      );
      if (!gate.allowed) return false;
      return resolveAutoAnswer(promptData) === '1';
    },
  };
}

/**
 * The picker has closed and Claude's transcript records every answer — the only
 * screen that proves the answers reached the agent, rather than that keys were
 * pressed.
 *
 * @param answers - The option label chosen for each question, in order
 */
export function expectAskUserQuestionAnswered(answers: readonly string[]): Expectation {
  return {
    label: `picker closed, transcript records the answers: ${answers.join(' / ')}`,
    matches: (o: Observation): boolean =>
      showsText(o.frame, "User answered Claude's questions:") &&
      !showsPickerFooter(o.frame) &&
      answers.every(answer => showsText(o.frame, `→ ${answer}`)),
  };
}
