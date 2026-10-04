/**
 * Codex's live region (Issue #3183; design doc §7 "codex").
 *
 * - **composer** — the bottom-most genuine `›` row ({@link findCodexComposerRow},
 *   the #892 rule), with "is it the bottom of the pane?" answered by
 *   {@link isCodexComposerAtBottom} (the #2841 rule: the RAW glyph row's SGR
 *   first, the stripped last content row otherwise). Before #3183 those were two
 *   separate readings in two files; they are now the two halves of one marker.
 *   Measured: `codex-dialogs-0157/quoted-approval-idle.txt` L997 (composer) under
 *   the quotation at L40-L49.
 * - **dialog top** — not declared. codex removes its composer while a dialog is
 *   open and the dialog takes the bottom of the pane (`codex-dialogs-0157/
 *   approval.txt` L987-L1000), so the whole frame is the right fallback.
 *
 * @module lib/detection/tools/codex/live-region
 */

import {
  CODEX_STATUS_BAR_PATTERN,
  CODEX_TRAILED_STATUS_BAR_PATTERN,
  findCodexComposerRow,
} from '../../cli-patterns';
import { isCodexComposerAtBottom } from './cli-patterns';
import { lastContentRow } from '../live-region';
import type { LiveRegionHit, LiveRegionSpec } from '../types';

/**
 * Index of the Codex status bar within the last 10 content rows, or -1.
 *
 * Issue #2818: a bar carrying a thread title or the Plan-mode badge after the
 * path (codex 0.154.0+) is the same bar, so it is a boundary too. Without it
 * such frames fell to branch D, whose 15-row tail still holds a finished
 * turn's `• Ran …` record, and an idle session read `running`.
 */
export function findCodexFooterBoundary(contentLines: readonly string[]): number {
  for (let ci = contentLines.length - 1; ci >= Math.max(0, contentLines.length - 10); ci--) {
    const line = contentLines[ci];
    if (CODEX_STATUS_BAR_PATTERN.test(line) || CODEX_TRAILED_STATUS_BAR_PATTERN.test(line)) return ci;
  }
  return -1;
}

/**
 * Exclusive end of the conversation area — the row below the status bar, with
 * the padding above it walked off (Issue #1928).
 *
 * Falls back to the whole frame when the bar cannot be located, which is
 * Issue #1150's drift case: there the tail is the conversation, so the dialog
 * rule still has the right rows.
 */
export function findCodexContentEnd(contentLines: readonly string[]): number {
  const boundary = findCodexFooterBoundary(contentLines);
  let end = boundary >= 0 ? boundary - 1 : contentLines.length - 1;
  while (end >= 0 && contentLines[end].trim() === '') end--;
  return end + 1;
}

export const CODEX_LIVE_REGION: LiveRegionSpec = {
  composer: {
    locate({ raw, contentLines }): LiveRegionHit | null {
      const contentEnd = findCodexContentEnd(contentLines);
      const atBottom = isCodexComposerAtBottom(raw, contentLines, contentEnd);
      const row = findCodexComposerRow(contentLines);
      if (row >= 0) return { start: row, end: row, atBottom };
      if (!atBottom) return null;
      // The raw glyph row said "composer" although its text reads as a numbered
      // row (a hand-typed `1. buy milk`): the composer is the last content row.
      const start = lastContentRow(contentLines.slice(0, contentEnd));
      return start < 0 ? null : { start, end: start, atBottom: true };
    },
  },
  composerHidesDialogs: true,
};
