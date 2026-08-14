/**
 * What *kind* of waiting a session is in (Issue #1786).
 *
 * `isWaitingForResponse` answers "does this session need a human?" and nothing
 * else, so every surface that shows it has to render one orange dot for three
 * situations a user would act on differently:
 *
 *  - a y/n or numbered prompt the app itself can answer for them (`prompt`);
 *  - a selection list or a pager, which only the terminal can drive (`menu`);
 *  - a dialog only the agent's own events reported, or a frame neither layer
 *    could classify (`unclassified`).
 *
 * Kept a pure function of the detector's verdict — no clock, no store, no tmux —
 * because it is the one piece of #1786 that the display Issues (#1787/#1788)
 * will read literally and therefore the one piece that has to be pinned by unit
 * tests rather than by a live session.
 *
 * @module lib/session/waiting-kind
 */

import { SELECTION_LIST_REASONS, type SessionStatus } from '@/lib/detection/status-detector';

/**
 * The waiting taxonomy published by the list API.
 *
 * Stable by contract: #1787 (in-screen affordances), #1788 (WS push) and #1790
 * (push notifications) branch on these exact strings.
 */
export type WaitingKind = 'prompt' | 'menu' | 'unclassified';

/** Everything the derivation is allowed to look at. */
export interface WaitingKindInput {
  /** The composed verdict — scraper OR structured. `false` forces `null`. */
  waiting: boolean;
  /** `StatusDetectionResult.hasActivePrompt` for the frame just read. */
  hasActivePrompt: boolean;
  /** `StatusDetectionResult.status` for the same frame. */
  scraperStatus: SessionStatus;
  /** `StatusDetectionResult.reason` for the same frame. */
  scraperReason: string;
}

/**
 * Classify a waiting session, or answer null when it is not waiting.
 *
 * The order is a precedence, not a sequence of independent tests: a frame that
 * carries an answerable prompt is a `prompt` even if the reason string would
 * also pass the menu test, because "you can answer this from the app" is the
 * more actionable fact.
 *
 * | condition                                        | kind             |
 * |--------------------------------------------------|------------------|
 * | not waiting                                       | `null`           |
 * | `hasActivePrompt`                                 | `'prompt'`       |
 * | scraper `waiting` + a {@link SELECTION_LIST_REASONS} reason | `'menu'` |
 * | anything else that is still waiting                | `'unclassified'` |
 *
 * The `menu` row is the same expression `current-output-builder` publishes as
 * `isSelectionListActive`, and the pager (`codex_pager`) is a member of that set
 * — so the pager lands in `menu` for the reason the Issue asks for, without a
 * second copy of the membership test.
 *
 * `unclassified` is the honest fallback rather than a fourth guess. In practice
 * it is reached when only the structured layer sees the dialog: every scraper
 * `waiting` verdict is either `prompt_detected` (→ `prompt`) or a selection-list
 * reason (→ `menu`), so a waiting session the scraper never classified is one it
 * could not read at all.
 */
export function deriveWaitingKind(input: WaitingKindInput): WaitingKind | null {
  if (!input.waiting) return null;
  if (input.hasActivePrompt) return 'prompt';
  if (input.scraperStatus === 'waiting' && SELECTION_LIST_REASONS.has(input.scraperReason)) {
    return 'menu';
  }
  return 'unclassified';
}
