/**
 * The browser's reading of an `AskUserQuestion` confirm page (Issue #3748).
 *
 * Client-safe: types and string comparisons only. `useAutoYes` runs in the
 * client bundle, so this module must not reach `detection/tools/frame`,
 * `cli-patterns`, `logger`, `env`, `db` or `fs` — the frame predicates the
 * server's poller uses (`polling/auto-yes-confirm-page`) do, through
 * `logger` → `env` → `db-path-resolver` → `fs`, and broke `next build`.
 * `tests/unit/guards/use-auto-yes-client-imports-3748.test.ts` keeps it so.
 *
 * @module lib/polling/auto-yes-confirm-shape
 */

import type { PromptData } from '@/types/models';

/** Option 1 of a confirm page: `Submit` (Command Code) or `Submit answers` (Claude). */
const CONFIRM_SUBMIT_LABEL = /^Submit(?: answers)?$/i;
/** Option 2 of a confirm page. */
const CONFIRM_CANCEL_LABEL = /^Cancel$/i;

/**
 * Does this prompt READ like a confirm page — exactly two options, `Submit` /
 * `Submit answers` then `Cancel`?
 *
 * The browser's fallback never answers a prompt of this shape. It cannot run
 * the server's frame predicates (see above), and a frame it holds may be cut
 * above the question row anyway, so it goes by the prompt's options alone; the
 * server's poller, which reads the whole capture, still decides by the frame.
 * An ordinary `Yes` / `No` approval never has this shape.
 */
export function isConfirmPageShapedPrompt(promptData: PromptData): boolean {
  if (promptData.type !== 'multiple_choice' || promptData.options.length !== 2) return false;
  const [first, second] = promptData.options;
  return CONFIRM_SUBMIT_LABEL.test(first.label.trim()) && CONFIRM_CANCEL_LABEL.test(second.label.trim());
}
