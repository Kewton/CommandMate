/**
 * Frames that say the agent will not report the end of its turn (Issue #3337).
 *
 * The turn model lets the screen close a turn only where the agent's own `Stop`
 * cannot be relied on. On a hooks source that is when the `Stop` is known not to
 * come, and an interrupted turn is the one such case a frame can show: the
 * agent drops the turn without firing the hook. This module answers "does this
 * frame show that" per tool, so the session layer can ask without naming one.
 *
 * A tool with no reader answers false — the screen then never closes its turn
 * while hooks speak for it, and the `stale` bound is the only one left.
 *
 * @module lib/detection/turn-abandoned
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { stripAnsi } from './ansi';
import { isClaudeTurnInterruptedFrame } from './tools/claude/patterns';
import { isCodexTurnInterruptedFrame } from './tools/codex/patterns';

/**
 * Per tool, the reading of an abandoned turn. Each one is measured: neither
 * codex 0.160.0 nor Claude Code 2.1.289 fires a `Stop` after Esc
 * (`tests/fixtures/codex-mid-turn-3337/`, `tests/fixtures/claude-interrupted-3337/`).
 * Claude's `Notification(idle_prompt)` did not arrive in two and a half minutes
 * after the interruption either, so without a reader its turn stayed `running`
 * until the stale bound.
 */
const ABANDONED_TURN_READERS: Partial<Record<CLIToolType, (lines: string[]) => boolean>> = {
  codex: isCodexTurnInterruptedFrame,
  claude: isClaudeTurnInterruptedFrame,
};

/**
 * Whether the captured frame shows a turn the agent abandoned without a `Stop`.
 *
 * @param output - The pane as captured (ANSI is stripped here)
 */
export function frameShowsAbandonedTurn(cliToolId: CLIToolType, output: string): boolean {
  const reader = ABANDONED_TURN_READERS[cliToolId];
  if (!reader) return false;
  return reader(stripAnsi(output).split('\n'));
}
