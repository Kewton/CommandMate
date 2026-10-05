/**
 * A codex 0.160.0 pane interrupted while a shell the turn started is still
 * running (Issue #3337).
 *
 * BUILT, not captured. The probe these fixtures were taken with has no provider
 * that answers, so codex never runs a command there. The orchestrator's live
 * check (isolated server, codex 0.160.0, hooks) pressed Esc during
 * `sleep 90 && ls` and read this order at the bottom of the pane:
 *
 *     ■ Conversation interrupted - use /feedback if something went wrong
 *       1 background terminal running · /ps to view · /stop to close
 *     › Ask Codex to do anything
 *
 * Built from `codex-0.160.0-interrupted-idle.txt`, every row of which is kept
 * byte for byte, with the background-terminal row written on row 994 — the row
 * the live status row (`Working (…)`) occupies in the captured mid-turn frames,
 * between the interruption on row 10 and the composer on row 996. The row's
 * text is the one reported; its attributes (dim) are a guess. The reader skips
 * blank rows either side of it, so its exact row does not decide the reading.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const INTERRUPTED_IDLE = join(
  process.cwd(),
  'tests/fixtures/codex-mid-turn-3337/codex-0.160.0-interrupted-idle.txt'
);

/** The row codex keeps while the turn's shell is alive. */
export const CODEX_BACKGROUND_TERMINAL_ROW_TEXT =
  '1 background terminal running · /ps to view · /stop to close';

/** Row the background-terminal row is written on (the live status row's row). */
const BACKGROUND_TERMINAL_ROW_INDEX = 994;

/** The built pane, raw (ANSI kept). */
export function buildCodexInterruptedBackgroundTerminalPane(): string {
  const lines = readFileSync(INTERRUPTED_IDLE, 'utf8').split('\n');
  if (lines[BACKGROUND_TERMINAL_ROW_INDEX].trim() !== '') {
    throw new Error('codex-0.160.0-interrupted-idle.txt changed: row 994 is not blank');
  }
  lines[BACKGROUND_TERMINAL_ROW_INDEX] = `  \u001b[2m${CODEX_BACKGROUND_TERMINAL_ROW_TEXT}\u001b[0m`;
  return lines.join('\n');
}
