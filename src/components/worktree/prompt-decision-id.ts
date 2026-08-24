/**
 * Reading the approval id off a live prompt payload (Issue #1932).
 *
 * ## Why this is a defensive read rather than a field access
 *
 * The server already HAS the id. `StructuredPromptWaitingState.decisionId`
 * (`lib/session/agent-event-state`) holds it for exactly the sources that
 * publish one, and `current-output-builder` reads that same record to decide
 * whether to publish `decisionOptions` at all — the three verdicts a dialog
 * accepts are offered precisely when an id exists to address them to.
 *
 * What it does not do is put the id ON the payload:
 * `buildStructuredPromptData` copies `source` / `message` / `toolName` /
 * `askUserQuestion` / `decisionOptions` and stops there, so
 * {@link StructuredPromptWaitingData} declares no `decisionId` and the browser
 * cannot see one. Both files live under `src/lib/session/`, which Issue #1930
 * holds for the duration of this cycle, so this Issue publishes the receiving
 * end and reads the field the moment the sending end appears — one property in
 * `buildStructuredPromptData` and one line in the interface.
 *
 * Written as a validating read, not a cast: an id that is absent, empty or not
 * a string is answered as "no addressable approval", which is what leaves the
 * panel showing its pre-#1932 "answer it in the terminal" text.
 *
 * @module components/worktree/prompt-decision-id
 */

import type { LivePromptData } from '@/types/models';

/**
 * The decision id this payload names, or null.
 *
 * @param promptData - The live prompt from `/current-output`, or null
 * @returns The id, or null when the payload carries none
 */
export function readPromptDecisionId(promptData: LivePromptData | null): string | null {
  if (!promptData) return null;
  const candidate = (promptData as { decisionId?: unknown }).decisionId;
  return typeof candidate === 'string' && candidate !== '' ? candidate : null;
}
