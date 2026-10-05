/**
 * Per tool, whether the screen may end a turn the agent's hooks opened
 * (Issue #3337).
 *
 * The turn model lets three polls of a finished-looking frame close a turn as
 * `scraper_evidence` (#1930). For codex 0.160.0 that closed live turns: frames
 * of a running turn read `ready` (`tests/fixtures/codex-mid-turn-3337/`), and a
 * reply sent on that `ready` interrupted the turn. So codex's hook turns end at
 * the agent's own `Stop` — except on a frame that shows the turn was
 * interrupted, after which no `Stop` comes.
 *
 * Only codex is listed, because only codex is measured to need it. Reading
 * "this turn was abandoned" off a frame has to be complete to be safe — a form
 * the reader misses leaves the turn `running` until the 30-minute stale bound —
 * and Claude Code showed two forms in one afternoon (`⎿  Interrupted`, and an
 * Esc early in the turn that puts the prompt back in the composer with no marker
 * at all, `tests/fixtures/claude-interrupted-3337/`). A tool not listed keeps
 * the #1930 behaviour: the screen closes its turn, hooks or not.
 *
 * Read by `lib/session/hook-turn-hold`, for both `capture --json` and the
 * relay's readiness check.
 *
 * @module lib/detection/turn-abandoned
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { stripAnsi } from './ansi';
import { isCodexTurnInterruptedFrame } from './tools/codex/patterns';

/** A tool whose hook turns the screen does not end, and the frames it still may. */
interface HookTurnScreenPolicy {
  /**
   * Whether the frame shows a turn the agent abandoned without a `Stop` — the
   * one case the screen still ends the turn in.
   */
  showsAbandonedTurn: (lines: readonly string[]) => boolean;
}

/**
 * The tools whose hook turns end at the agent's `Stop` rather than at the
 * screen. Absent means "the screen may close it", as before #3337.
 */
const HOOK_TURN_SCREEN_POLICIES: Partial<Record<CLIToolType, HookTurnScreenPolicy>> = {
  // Measured on 0.160.0: mid-turn frames read `ready`; an Esc fires no `Stop`
  // and leaves `■ Conversation interrupted` above the composer.
  codex: { showsAbandonedTurn: isCodexTurnInterruptedFrame },
};

/**
 * Whether the screen may end a turn this tool's hooks opened.
 *
 * True for a tool with no policy, and for a listed tool whose frame shows an
 * abandoned turn.
 *
 * @param output - The pane as captured (ANSI is stripped here)
 */
export function screenMayCloseHookTurn(cliToolId: CLIToolType, output: string): boolean {
  const policy = HOOK_TURN_SCREEN_POLICIES[cliToolId];
  if (!policy) return true;
  return policy.showsAbandonedTurn(stripAnsi(output).split('\n'));
}
