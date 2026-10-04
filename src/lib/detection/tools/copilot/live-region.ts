/**
 * Copilot's live region (Issue #3183; design doc §7 "copilot").
 *
 * - **composer** — the bottom chrome `findCopilotChromeStart` locates: the cwd
 *   row, the fenced composer (`─` rules on 1.0.80, `╻▄` / `╹▀` frames on
 *   1.0.82) and the status bar under it. Measured: `copilot-live-1885/
 *   turn-complete.txt` L997-L1001 (1.0.80) and `copilot-live-2269/
 *   turn-complete.txt` L996-L1000 (1.0.82).
 * - **dialog top** — the `╭` corner the bottom `╰` row closes. copilot draws its
 *   dialogs in a box over the whole bottom of the pane, chrome gone. Measured:
 *   `copilot-live-1885/permission-dialog.txt` L987 / L1001 (1.0.80; 1.0.82's
 *   dialog has not been captured — design doc §6 item 3).
 *
 * `composerHidesDialogs: false`: the `/model` picker is drawn with the fenced
 * composer still on screen (`copilot-live-1885/model-picker.txt`; the comment
 * on `findCopilotChromeStart` records the blank header row it leaves), so only
 * numbered readings are vetoed by it. The numbered permission dialog replaces
 * the chrome (`permission-dialog.txt`).
 *
 * @module lib/detection/tools/copilot/live-region
 */

import { findCopilotChromeStart } from '../../cli-patterns';
import { dialogTopFrom, fencedComposer, lastContentRow } from '../live-region';
import type { LiveRegionSpec } from '../types';

/** How far above the bottom row the box's closing corner may sit. */
const BOX_BOTTOM_MAX_ROWS = 2;

/** How tall a dialog box may be before it stops looking like one. */
const BOX_MAX_ROWS = 120;

function findCopilotDialogBoxTop(lines: readonly string[]): number {
  const last = lastContentRow(lines);
  let bottom = -1;
  for (let i = last; i >= Math.max(0, last - BOX_BOTTOM_MAX_ROWS); i--) {
    if (lines[i].trimStart().startsWith('╰')) {
      bottom = i;
      break;
    }
  }
  if (bottom < 0) return -1;
  for (let i = bottom - 1; i >= Math.max(0, bottom - BOX_MAX_ROWS); i--) {
    if (lines[i].trimStart().startsWith('╭')) return i;
  }
  return -1;
}

export const COPILOT_LIVE_REGION: LiveRegionSpec = {
  composer: fencedComposer(lines => findCopilotChromeStart(lines)),
  dialogTop: dialogTopFrom(findCopilotDialogBoxTop),
  composerHidesDialogs: false,
};
