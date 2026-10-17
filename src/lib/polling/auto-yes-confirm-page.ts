/**
 * The `AskUserQuestion` confirm pages Auto-Yes leaves to a human (Issue #3497,
 * Issue #3748).
 *
 * `Submit` on these pages picks nothing: it commits whatever stands as the
 * answers. On Kewton/Musunest#283 that was the worker's own proposal, which the
 * worker then implemented as though a human had approved it. So neither the
 * server's poller (`suppressIfNotOursToAnswer`, step 3.3) nor the browser's
 * fallback (`useAutoYes`, which answers only while no server poller runs) sends
 * a key to them.
 *
 * Server-only: `normalizeFrame` and the tools' detectors reach `logger` → `env`
 * → `fs`. The browser judges by the prompt's options instead
 * (`polling/auto-yes-confirm-shape`).
 *
 * @module lib/polling/auto-yes-confirm-page
 */

import { normalizeFrame } from '../detection/tools/frame';
import { isCommandCodeQuestionConfirmPage } from '../detection/tools/command-code/selection-shape';
import { isClaudeAskUserQuestionConfirmPage } from '../detection/tools/claude/detect';
import type { NormalizedFrame } from '../detection/tools/types';

/**
 * Is this frame one of the confirm pages Auto-Yes does not answer?
 *
 * - `command-code`: `❯ 1. Submit` / `2. Cancel` under the question's tab strip,
 *   with or without the back hint (#3497, `isCommandCodeQuestionConfirmPage`).
 * - `claude`: `Ready to submit your answers?` / `❯ 1. Submit answers` /
 *   `2. Cancel` (#3748, `isClaudeAskUserQuestionConfirmPage`).
 *
 * Every other tool: false — none has a measured confirm page.
 *
 * @param frame - The tick's one normalised frame (Issue #3183)
 */
export function isAutoYesDeclinedConfirmPage(cliToolId: string, frame: NormalizedFrame): boolean {
  // An empty capture draws no page (and Claude's reading walks the rows).
  if (!frame.raw) return false;
  if (cliToolId === 'command-code') return isCommandCodeQuestionConfirmPage(frame.raw);
  if (cliToolId === 'claude') return isClaudeAskUserQuestionConfirmPage(frame);
  return false;
}

/**
 * {@link isAutoYesDeclinedConfirmPage} on a capture as text. False for no frame.
 */
export function isAutoYesDeclinedConfirmFrame(
  cliToolId: string,
  output: string | null | undefined,
): boolean {
  if (!output) return false;
  if (cliToolId !== 'command-code' && cliToolId !== 'claude') return false;
  return isAutoYesDeclinedConfirmPage(cliToolId, normalizeFrame(output, cliToolId));
}
