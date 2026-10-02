/**
 * Whether a session's agent has exited back to the shell (Issue #3093).
 *
 * A start timeout is answered "the process is still running, so this is a slow
 * start" — but the timeout alone cannot tell a slow agent from one that quit
 * during startup (a trust dialog answered with exit) and left the pane at the
 * shell it was launched from. The pane can: its bottom row is then a shell
 * prompt.
 *
 * Read through the sanctioned capture gateway (`captureSessionOutputFresh`,
 * Issue #1922 §4 D4 — a route does not reach tmux directly) and judged with
 * `findShellPromptTail`, the one definition of "this pane is a bare shell" the
 * #2070 relaunch already uses. The narrower of the two liveness questions on
 * purpose: a dialog the agent drew before quitting is still in the scrollback,
 * and the wider `judgeToolLiveness` would let its `❯` veto the exit.
 *
 * Kept beside the route because the send route is its only reader.
 *
 * @module app/api/worktrees/[id]/send/pane-shell
 */

import { captureSessionOutputFresh } from '@/lib/session/cli-session';
import { stripAnsi } from '@/lib/detection/ansi';
import { findShellPromptTail } from '@/lib/detection/tool-liveness';
import type { ICLITool } from '@/lib/cli-tools/types';

/** Only the bottom of the pane decides; a screen's worth is plenty. */
const PANE_SHELL_CAPTURE_LINES = 50;

/**
 * True when the pane's bottom row reads as a shell prompt; false when it does
 * not, or when the pane could not be read (the caller's old wording stands).
 *
 * @param cliTool - Tool whose session timed out
 * @param worktreeId - Worktree the session belongs to
 * @param instanceId - Agent instance (defaults to the primary)
 */
export async function isPaneBackAtShell(
  cliTool: ICLITool,
  worktreeId: string,
  instanceId?: string
): Promise<boolean> {
  try {
    const output = await captureSessionOutputFresh(
      worktreeId,
      cliTool.id,
      PANE_SHELL_CAPTURE_LINES,
      instanceId
    );
    return findShellPromptTail(stripAnsi(output), cliTool.livenessSpec()) !== null;
  } catch {
    return false;
  }
}
