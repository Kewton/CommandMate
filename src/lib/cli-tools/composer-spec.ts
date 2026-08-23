/**
 * What each tool's composer is, in one declaration per tool (Issue #1933, §6.3).
 *
 * Before this module `submit-verified-sender.ts` carried the same knowledge as
 * three unrelated module-level tables — `INPUT_LINE_MARKER_TOOLS`, a
 * `cliToolId === 'opencode'` branch in `verifyCaptureLines()`, and
 * `COMPOSER_CLEAR_SUPPORTED_TOOLS` — plus a fourth fact (`submitEnterCount`)
 * that only vibe-local's call site knew. Adding a tool meant finding four
 * places, and #1906 is what happens when one of them is missed: opencode went
 * through the marker reader, never matched, and every opencode send was
 * classified `submitted` without evidence for the whole life of #1471's
 * recovery.
 *
 * ## Why the table is here rather than only on the tool classes
 *
 * `BaseCLITool.describeComposer()` answers from this function and every tool
 * may override it, which is the §4 D4 shape. The lookup still exists because
 * `sendMessageWithSubmitVerification` is imported *by* the tool modules: asking
 * it to reach back for a tool instance would put a cycle under every send. So
 * the sender takes a `ComposerSpec` when it is given one and resolves the
 * tool's default here when it is not, and both roads lead to this one table.
 *
 * @module lib/cli-tools/composer-spec
 */

import { OPENCODE_PANE_HEIGHT } from '@/config/tmux-pane-config';
import type { ComposerSpec } from '@/types/cli-tool-contracts';
import type { CLIToolType } from './types';

/**
 * Rows of pane tail read back when verifying a submit on a marker tool.
 *
 * The composer is the last thing on those panes, so a short tail is enough and
 * keeps `capture-pane` cheap.
 */
export const COMPOSER_VERIFY_WINDOW_LINES = 12;

/**
 * The claude-shaped default, which is also `BaseCLITool`'s.
 *
 * A marked input line at the bottom of the pane, a twelve-row read-back, one
 * Enter to submit, and the composer emptied before the body is typed (#1880 —
 * claude is the tool that was measured for it).
 */
export const DEFAULT_COMPOSER_SPEC: ComposerSpec = {
  reader: 'input-line-marker',
  verifyCaptureLines: COMPOSER_VERIFY_WINDOW_LINES,
  clearBeforeSend: true,
  submitEnterCount: 1,
};

/**
 * Per-tool composer descriptions.
 *
 * Every value is the behaviour that was already in force before this Issue;
 * `tests/unit/cli-tools/composer-spec-1933.test.ts` pins each one against the
 * constant or the call site it came from, so this is a move, not a redesign.
 */
const COMPOSER_SPECS: Record<CLIToolType, ComposerSpec> = {
  claude: DEFAULT_COMPOSER_SPEC,

  // Joined the clear-before-send path in #1890: shipping #1880 claude-only left
  // codex measurably broken (its ケース7 reproduced the splice verbatim).
  codex: DEFAULT_COMPOSER_SPEC,

  // Marker tools whose input box has NOT been captured at the production
  // geometry, so `clearComposer` cannot observe them and must not blind-fire
  // `C-e`+`C-u` into a box nobody has measured (#1880).
  gemini: { ...DEFAULT_COMPOSER_SPEC, clearBeforeSend: false },
  copilot: { ...DEFAULT_COMPOSER_SPEC, clearBeforeSend: false },
  antigravity: { ...DEFAULT_COMPOSER_SPEC, clearBeforeSend: false },

  // vibe-local's IME mode makes the first Enter insert a newline, so the
  // initial submit is two presses (see VIBE_LOCAL_DOUBLE_ENTER_WAIT_MS).
  'vibe-local': { ...DEFAULT_COMPOSER_SPEC, clearBeforeSend: false, submitEnterCount: 2 },

  // opencode draws a bordered box with a gutter and no marker anywhere, and it
  // centres that box under the banner until the first turn is answered —
  // roughly 100 rows above the bottom of a 200-row pane. A twelve-row tail of a
  // first send therefore contains nothing but blank padding and the cwd footer,
  // which is why the read-back asks for the whole visible frame (#1906,
  // measured live on opencode 1.18.21). It runs in the alternate screen with no
  // scrollback, so the frame is all there is.
  opencode: {
    reader: 'opencode-box',
    verifyCaptureLines: OPENCODE_PANE_HEIGHT,
    clearBeforeSend: false,
    submitEnterCount: 1,
  },
};

/**
 * The composer description for a CLI tool.
 *
 * @param cliToolId - CLI tool identifier
 * @returns That tool's {@link ComposerSpec}; the claude-shaped default for an
 *   id outside `CLI_TOOL_IDS` (a JavaScript caller or a cast — the default's
 *   reader is the conservative one, since an unreadable composer classifies
 *   every send as submitted without evidence)
 */
export function resolveComposerSpec(cliToolId: CLIToolType): ComposerSpec {
  return COMPOSER_SPECS[cliToolId] ?? DEFAULT_COMPOSER_SPEC;
}
