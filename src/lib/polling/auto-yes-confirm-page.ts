/**
 * The `AskUserQuestion` confirm pages Auto-Yes leaves to a human (Issue #3497,
 * Issue #3748).
 *
 * `Submit` on these pages picks nothing: it commits whatever stands as the
 * answers. On Kewton/Musunest#283 that was the worker's own proposal, which the
 * worker then implemented as though a human had approved it. So neither the
 * server's poller (`suppressIfNotOursToAnswer`, step 3.3) nor the browser's
 * fallback (`useAutoYes`, which answers only while no server poller runs) sends
 * a key to them — and both ask this one module, so the two paths cannot decline
 * different frames.
 *
 * Pure and free of server-only imports: the browser runs it on the frame the
 * current-output payload carries.
 *
 * @module lib/polling/auto-yes-confirm-page
 */

import { normalizeFrame } from '../detection/tools/frame';
import { isCommandCodeQuestionConfirmPage } from '../detection/tools/command-code/selection-shape';
import { isClaudeAskUserQuestionConfirmPage } from '../detection/tools/claude/detect';
import type { NormalizedFrame } from '../detection/tools/types';
import type { PromptData } from '@/types/models';

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
 * {@link isAutoYesDeclinedConfirmPage} on a capture as text — the browser's
 * spelling (`fullOutput` of the current-output payload). False for no frame.
 */
export function isAutoYesDeclinedConfirmFrame(
  cliToolId: string,
  output: string | null | undefined,
): boolean {
  if (!output) return false;
  if (cliToolId !== 'command-code' && cliToolId !== 'claude') return false;
  return isAutoYesDeclinedConfirmPage(cliToolId, normalizeFrame(output, cliToolId));
}

/** Option 1 of a confirm page: `Submit` (Command Code) or `Submit answers` (Claude). */
const CONFIRM_SUBMIT_LABEL = /^Submit(?: answers)?$/i;
/** Option 2 of a confirm page. */
const CONFIRM_CANCEL_LABEL = /^Cancel$/i;

/**
 * Does this prompt READ like a confirm page — exactly two options, `Submit` /
 * `Submit answers` then `Cancel`? (Issue #3748)
 *
 * For the browser's fallback only. It judges the page from `fullOutput` (or the
 * shorter `realtimeSnippet`), and a frame that is missing or cut above the
 * question row cannot be told from "not a confirm page": the frame predicate
 * answers false for both, and the fallback would send `Submit`. So the browser
 * never answers a prompt of this shape, whatever the frame shows; the server's
 * poller, which reads the whole capture, still decides by the frame alone.
 * An ordinary `Yes` / `No` approval never has this shape.
 */
export function isConfirmPageShapedPrompt(promptData: PromptData): boolean {
  if (promptData.type !== 'multiple_choice' || promptData.options.length !== 2) return false;
  const [first, second] = promptData.options;
  return CONFIRM_SUBMIT_LABEL.test(first.label.trim()) && CONFIRM_CANCEL_LABEL.test(second.label.trim());
}
