/**
 * `wait --on-prompt agent` → `respond "1"`, screen by screen, against a live
 * AskUserQuestion picker (Issue #2486).
 *
 * The canary runs no CommandMate server, so it runs both halves of that
 * exchange the way the server does:
 *
 * - **`wait`** exits 10 on what `/current-output` publishes from the status
 *   path — an active `multiple_choice` prompt ({@link waitWouldStopOnPrompt}).
 * - **`respond`** posts to `/prompt-response`, whose keystroke path
 *   (`src/app/api/worktrees/[id]/prompt-response/route.ts`) re-verifies the
 *   frame — `detectPrompt` over the box-stripped capture, `evaluateDialogPresence`
 *   over the raw one, `judgePromptResponse` over both — resolves the answer with
 *   `resolvePromptAnswer`, and hands it to `sendPromptAnswer` together with the
 *   frame it verified. {@link verifyLikePromptResponse} is those calls in that
 *   order with nothing of its own. The keystrokes go through the PRODUCTION
 *   `sendPromptAnswer` → `src/lib/tmux/tmux.ts`, with `$TMUX` pointed at the
 *   canary's private server by `ScenarioDriver.withProductionTmux`, which asserts
 *   the redirect before a key can be sent.
 *
 * Left out, deliberately: the structured-decision path (claude publishes no
 * decision ids) and `applyAskUserQuestion` (the canary session injects no hooks,
 * so no payload is held). Both decline before the keystroke path for a claude
 * session with no payload, and the Issue's refusal happened before either could
 * matter.
 */

import { stripAnsi } from '@/lib/detection/ansi';
import { buildDetectPromptOptions, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { STATUS_REASON } from '@/lib/detection/status-detector';
import { evaluateDialogPresence, judgePromptResponse } from '@/lib/polling/auto-yes-dialog-gate';
import { resolvePromptAnswer } from '@/lib/prompt-answer-semantic';
import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import type { PromptData } from '@/types/models';
import { ScenarioStepError, type Observation, type ScenarioDriver } from './types';

/** The walk is written against claude's picker; nothing else draws one. */
const WALK_TOOL = 'claude' as const;

/** How long a screen may take to give way to the next after an answer. */
const NEXT_SCREEN_TIMEOUT_MS = 30_000;

/** What `wait --on-prompt agent` exits 10 on: an active multiple_choice prompt. */
export function waitWouldStopOnPrompt(o: Observation): boolean {
  return (
    o.status.status === 'waiting' &&
    o.status.reason === STATUS_REASON.PROMPT_DETECTED &&
    o.status.hasActivePrompt === true &&
    o.status.promptDetection.promptData?.type === 'multiple_choice'
  );
}

/** `/prompt-response`'s decision about one frame, before any key is sent. */
export type PromptResponseVerdict =
  | { ok: true; input: string; promptData: PromptData }
  | { ok: false; reason: string; message?: string };

/**
 * The route's pre-send verification and answer resolution, over one raw frame.
 *
 * Pure: the same frame always gets the same verdict, which is what lets
 * `tests/unit/canary/` pin it against committed captures.
 */
export function verifyLikePromptResponse(frame: string, answer: string): PromptResponseVerdict {
  const promptCheck = detectPrompt(stripBoxDrawing(stripAnsi(frame)), buildDetectPromptOptions(WALK_TOOL));
  const presence = evaluateDialogPresence(WALK_TOOL, promptCheck.promptData?.type, frame);
  const refusal = judgePromptResponse(promptCheck, presence);
  if (refusal) return { ok: false, ...refusal };
  // `judgePromptResponse` clears only a frame with a prompt on it.
  const promptData = promptCheck.promptData as PromptData;
  const { input } = resolvePromptAnswer({ answer, useDefault: false, promptData });
  return { ok: true, input, promptData };
}

/** One screen of the walk: the answer to give there, and where it must lead. */
export interface RespondWalkStep {
  /** Names the screen in the log and in a red result. */
  screen: string;
  answer: string;
  /** The screen the answer must lead to. */
  next: { label: string; reached(o: Observation): boolean };
}

/**
 * Answer every screen in turn, the way an orchestrator would: `wait`, then
 * `respond`, then wait for the next screen.
 *
 * @throws {ScenarioStepError} when `wait` would not have stopped on a screen or
 *   `respond` would have been refused there — the scenario goes red on the frame
 *   it happened on
 */
export async function walkWithRespond(
  driver: ScenarioDriver,
  steps: readonly RespondWalkStep[]
): Promise<void> {
  for (const step of steps) {
    const at = await driver.observe();
    if (!waitWouldStopOnPrompt(at)) {
      throw new ScenarioStepError(
        `${step.screen}: \`wait --on-prompt agent\` would not stop here ` +
          `(status=${at.status.status} reason=${at.status.reason})`,
        at
      );
    }

    const verdict = verifyLikePromptResponse(at.frame, step.answer);
    if (!verdict.ok) {
      throw new ScenarioStepError(
        `${step.screen}: \`respond "${step.answer}"\` refused — ${verdict.reason}` +
          (verdict.message ? ` (${verdict.message})` : ''),
        at
      );
    }

    await driver.withProductionTmux(sessionName =>
      sendPromptAnswer({
        sessionName,
        answer: verdict.input,
        cliToolId: WALK_TOOL,
        promptData: verdict.promptData,
        frame: at.frame,
      })
    );
    driver.log(`  ${step.screen}: respond "${step.answer}" sent`);

    await driver.waitFor(step.next.reached, {
      timeoutMs: NEXT_SCREEN_TIMEOUT_MS,
      pollIntervalMs: 1_000,
      label: step.next.label,
    });
  }
}
