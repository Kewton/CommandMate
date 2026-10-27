/**
 * The screen `/respond` reads right before it delivers a person's answer
 * (Issue #3907, review P2; shared with the structured branch by Issue #3925).
 *
 * Its own module so the stored-message branch (`route.ts`) and the structured
 * branch (`structured-decision.ts`) read the screen the same way without the
 * structured module importing the route (which imports it).
 *
 * @module app/api/worktrees/[id]/respond/screen-at-send
 */

import { createLogger } from '@/lib/logger';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutputFresh } from '@/lib/session/cli-session';
import { assessPromptAnswerability } from '@/lib/polling/auto-yes-dialog-gate';
import { instanceInputReadMark } from '@/lib/session/instance-input-lock';
import type { PromptData } from '@/types/models';

const logger = createLogger('api/respond');

/** The screen an answer is delivered at: the frame, and the prompt read off it. */
export interface ScreenAtSend {
  /** The raw capture, or undefined when it could not be taken. */
  frame: string | undefined;
  promptData: PromptData | null;
  /**
   * Issue #3952 review P2-1: the session's input order, taken right before the
   * capture — handed to `sendPromptAnswer` so a send admitted after this read
   * makes the answer read the screen again.
   */
  readMark: number;
}

/**
 * The screen the answer is about to go to (Issue #3907, review P2), for the
 * send it registers with Auto-Yes (`noteManualSendStarting`) AND for
 * `sendPromptAnswer`'s own checks: one frame for both, as `/prompt-response`
 * hands its verified frame to the sender. Read off a fresh capture with the
 * same reading `/prompt-response` re-verifies with
 * (`assessPromptAnswerability`), not off the stored row: the row was read
 * before the ownership check's await, and a hold at the row's screen is
 * dropped as "another prompt" when the screen has moved on — leaving the
 * screen the keys actually went to free for Auto-Yes. Without the frame passed
 * on, a numeric answer's guard re-read the pane, and a screen changed in that
 * await was not the one registered.
 *
 * Issue #3925: the structured branch registers its answer at this screen too —
 * the confirmation an Auto-Yes tick would otherwise answer over it.
 *
 * When the capture fails or no prompt is read, `promptData` is null: the hold
 * is then at an unidentified screen, which covers the next confirmation read
 * (and the sender reads the pane itself when there is no frame). Never throws.
 */
export async function screenAtSend(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string,
): Promise<ScreenAtSend> {
  const readMark = instanceInputReadMark();
  let frame: string;
  try {
    frame = await captureSessionOutputFresh(worktreeId, cliToolId, undefined, instanceId);
  } catch {
    logger.warn('failed-to-read-screen-before-send');
    return { frame: undefined, promptData: null, readMark };
  }
  try {
    const { promptCheck } = assessPromptAnswerability(cliToolId, frame);
    return { frame, promptData: promptCheck?.isPrompt ? promptCheck.promptData ?? null : null, readMark };
  } catch {
    logger.warn('failed-to-read-screen-before-send');
    return { frame, promptData: null, readMark };
  }
}
