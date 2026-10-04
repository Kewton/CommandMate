/**
 * Command Code's live region (Issue #3183; design doc §7 "command-code").
 *
 * - **composer** — the input box between two rules pinned to the bottom, with a
 *   `❯` row under the opening rule (`findCommandCodeChromeStart`, the same
 *   shape as claude's). A `❯ 1.` row there is a question dialog's cursor, not
 *   the composer, and is refused. Measured: `tui-frame-footer-2776/
 *   command-code-1.58.0-idle-quoted-footers.txt` L29-L32 under the quoted
 *   footers at L18-L21.
 * - **dialog top** — the rule above the first option of a dialog closed by the
 *   `↑/↓ navigate · enter select` footer. Measured: `command-code-live-2250/
 *   dialog-shell-command.txt` L29 / L36 / L40.
 *
 * @module lib/detection/tools/command-code/live-region
 */

import { findCommandCodeChromeStart, stripAnsi } from '../../cli-patterns';
import { fencedComposer, ruleAboveOptionRun } from '../live-region';
import type { LiveRegionSpec } from '../types';

/** A numbered cursor row (`❯ 1. Yes`) — a dialog's, never the composer's. */
const NUMBERED_CURSOR_ROW = /^❯\s*\d{1,2}[.)]\s/;

export const COMMAND_CODE_LIVE_REGION: LiveRegionSpec = {
  composer: fencedComposer(lines => {
    const start = findCommandCodeChromeStart(lines);
    if (start < 0) return -1;
    return NUMBERED_CURSOR_ROW.test(stripAnsi(lines[start + 1] ?? '')) ? -1 : start;
  }),
  dialogTop: ruleAboveOptionRun({
    footer: row => /↑\/↓ navigate · enter select/.test(row),
    rule: /^─{10,}$/,
    maxRows: 120,
  }),
  composerHidesDialogs: true,
};
