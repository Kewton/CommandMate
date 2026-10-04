/**
 * Antigravity's (agy) live region (Issue #3183; design doc §7 "antigravity").
 *
 * - **composer** — the bottom-most bare `>` row (or the mode banner that
 *   replaces it, `ANTIGRAVITY_PROMPT_PATTERN`). A user turn echoed into the
 *   transcript has text after its `>` and does not match. It is the bottom of
 *   the pane unless a numbered row is drawn under it: agy draws its approval
 *   dialogs IN PLACE of the composer, but `/feedback`'s category menu BELOW it
 *   (`antigravity-live-2364/dialog-feedback-category.txt`), so a numbered row
 *   under the composer is live and one above it is a quotation (#2845 / #2851).
 *   The Switch Model picker is drawn below it too (`picker-switch-model.txt`
 *   L43 rule, L44-L58 picker), so a `↑/↓ Navigate` row under the composer
 *   also means the composer is not the bottom.
 *   Measured: `antigravity-live-2364/idle-after-deny.txt` L41-L44.
 * - **dialog top** — the row after the nearest boundary above the `↑/↓ Navigate`
 *   footer (`locateAntigravityDialogRegion`, #2364). Measured:
 *   `antigravity-live-2364/dialog-bash-oneline.txt` L27 / L38.
 *
 * Rows are read through `stripBoxDrawing`, the spelling the #2845 rule was
 * measured on; it maps line for line, so indices are unchanged.
 *
 * @module lib/detection/tools/antigravity/live-region
 */

import {
  ANTIGRAVITY_NUMBERED_OPTION_PATTERN,
  ANTIGRAVITY_PROMPT_PATTERN,
  ANTIGRAVITY_SELECTION_LIST_PATTERN,
  locateAntigravityDialogRegion,
  stripBoxDrawing,
} from '../../cli-patterns';
import { bottomMostComposerRow, dialogTopFrom } from '../live-region';
import type { LiveRegionSpec } from '../types';

export const ANTIGRAVITY_LIVE_REGION: LiveRegionSpec = {
  composer: bottomMostComposerRow({
    isComposerRow: row => ANTIGRAVITY_PROMPT_PATTERN.test(stripBoxDrawing(row)),
    atBottom: ({ contentLines }, composerRow) =>
      !contentLines.slice(composerRow + 1).some(row => {
        const text = stripBoxDrawing(row);
        return ANTIGRAVITY_NUMBERED_OPTION_PATTERN.test(text) || ANTIGRAVITY_SELECTION_LIST_PATTERN.test(text);
      }),
  }),
  dialogTop: dialogTopFrom(lines => locateAntigravityDialogRegion(lines)?.start ?? -1),
  composerHidesDialogs: true,
};
