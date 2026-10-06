/**
 * Whether a published `autoYes.lastEnterFallback` says Auto-Yes sent its Enter
 * to the prompt on show (Issue #3397).
 *
 * Client-safe and import-free (a type import only), so the browser hooks that
 * carry the record to the prompt windows read it with the same rule:
 * `outcome === 'sent'` AND `currentPrompt`. `no-effect` (the screen outlived
 * the Enter), a record about another screen and no record at all are `false`,
 * which keeps the window's warning and its direct-input link.
 *
 * @module lib/polling/auto-yes-enter-sent
 */

import type { AutoYesEnterFallbackPublished } from './auto-yes-enter-fallback';

/** The fields this rule reads; a looser shape than the server type, for wire data. */
export type AutoYesEnterFallbackReading = Pick<AutoYesEnterFallbackPublished, 'currentPrompt'> & {
  outcome: string;
};

export function isAutoYesEnterSentToCurrentPrompt(
  record: AutoYesEnterFallbackReading | null | undefined,
): boolean {
  return record != null && record.outcome === 'sent' && record.currentPrompt === true;
}
