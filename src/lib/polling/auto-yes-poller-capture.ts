/**
 * Auto-Yes poller: one tick's capture (Issue #2522) (Issue #3783: split out of
 * `auto-yes-poller.ts`, which re-exports the public names).
 *
 * Does not statically import `auto-yes-poller.ts` (no cycle outside the
 * baseline in `import-cycles-baseline-3482`). Via `cli-session`, opencode's
 * history feed reaches it back through a dynamic `import()`; that path predates
 * the split (the poller imported `cli-session` itself) and is no static cycle.
 *
 * @module lib/polling/auto-yes-poller-capture
 */

import type { CLIToolType } from '../cli-tools/types';
import { captureSessionOutput } from '../session/cli-session';
import { stripAnsi, stripBoxDrawing } from '../detection/cli-patterns';
import { FULL_CAPTURE_LINES } from '@/config/auto-yes-config';

/**
 * One tick's capture, in the two spellings this poller needs (Issue #2522).
 *
 * The poller has always cleaned its capture once and thrown the original away.
 * That is the right trade for everything it did with it — the stop-condition
 * delta, the thinking check, the dialog gate and the generic prompt parser all
 * want text with no ANSI and no box drawing — and it is exactly what made
 * Command Code's `AskUserQuestion` unreadable HERE while the status API
 * published it: that screen is anchored on a 200-column U+2500 rule row, and
 * `stripBoxDrawing` blanks precisely that row.
 *
 * So the original is kept instead of being re-derived. Not re-captured: a second
 * `capture-pane` is a second instant, and answering a dialog read off one frame
 * with keys aimed at another is the race `/prompt-response`'s `verifiedFrame`
 * already exists to close. And not "un-cleaned": `stripBoxDrawing` is lossy and
 * non-idempotent, so there is nothing to restore.
 */
export interface CapturedPollerFrame {
  /** The capture exactly as tmux returned it: ANSI and box drawing intact. */
  readonly raw: string;
  /** `stripBoxDrawing(stripAnsi(raw))` — the spelling every other step reads. */
  readonly clean: string;
}

/**
 * Capture tmux session output once, keeping both spellings (Issue #2522).
 *
 * @internal Exported for testing purposes only.
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type being polled
 * @param captureLines - Optional number of lines to capture
 * @param instanceId - Optional agent instance ID (Issue #896; defaults to primary session)
 * @returns The tick's raw capture and its cleaned form
 */
export async function capturePollerFrame(
  worktreeId: string,
  cliToolId: CLIToolType,
  captureLines?: number,
  instanceId?: string
): Promise<CapturedPollerFrame> {
  const lines = captureLines ?? FULL_CAPTURE_LINES;
  const output = await captureSessionOutput(worktreeId, cliToolId, lines, instanceId);
  return { raw: output, clean: stripBoxDrawing(stripAnsi(output)) };
}

/**
 * Capture tmux session output and strip ANSI escape codes.
 *
 * Kept as the cleaned half of {@link capturePollerFrame} so the many callers and
 * tests that only ever wanted that string are untouched; `pollAutoYes` takes the
 * pair. `stripBoxDrawing` still runs exactly once per capture either way.
 *
 * @internal Exported for testing purposes only.
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type being polled
 * @param captureLines - Optional number of lines to capture
 * @param instanceId - Optional agent instance ID (Issue #896; defaults to primary session)
 * @returns Cleaned output string (ANSI stripped)
 */
export async function captureAndCleanOutput(
  worktreeId: string,
  cliToolId: CLIToolType,
  captureLines?: number,
  instanceId?: string
): Promise<string> {
  return (await capturePollerFrame(worktreeId, cliToolId, captureLines, instanceId)).clean;
}
