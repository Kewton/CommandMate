/**
 * Claude's live region (Issue #3183; design doc §7 "claude").
 *
 * - **composer** — the input box: closing rule within 4 rows of the bottom, an
 *   opening rule within 40 rows above it, and a `>`/`❯` row right under the
 *   opening rule (`findClaudeInputBox`, the finder #2847 / the idle rule / the
 *   dialog rule already share). Measured: `tui-frame-footer-2776/
 *   claude-2.1.278-idle-quoted-footers.txt` L997-L1000.
 * - **dialog top** — the rule above the first option of the dialog that closes
 *   with Claude's footer (`claude-2.1.278-bash-approval.txt` L12 / L20 / L25,
 *   `claude-2.1.278-askuserquestion-picker.txt` L17 / L22 / L30, whose inner
 *   rule L27 is why the search starts at the option).
 *
 * @module lib/detection/tools/claude/live-region
 */

import { findClaudeInputBox } from '../../composer-text';
import { isClaudeFooter } from '../../tui-detection-frame';
import { fencedComposer, ruleAboveOptionRun } from '../live-region';
import type { LiveRegionSpec } from '../types';

export const CLAUDE_LIVE_REGION: LiveRegionSpec = {
  composer: fencedComposer(lines => findClaudeInputBox(lines)?.openingSeparator ?? -1),
  dialogTop: ruleAboveOptionRun({ footer: isClaudeFooter, rule: /^─{10,}$/, maxRows: 120 }),
  composerHidesDialogs: true,
};
