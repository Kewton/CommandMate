/**
 * Giving up on a dialog in a tool's own prompt wait — the wait before the
 * input lock (Issue #4067 for copilot, Issue #4084 for opencode and
 * vibe-local).
 *
 * A dialog waits for a person, so the wait does not sit out its whole window
 * (15 s) behind it. But a frame caught mid-paint can read as a dialog once, so
 * one read is not enough: the dialog has to be seen on
 * {@link PROMPT_WAIT_DIALOG_CONFIRM_READS} reads in a row spanning
 * {@link PROMPT_WAIT_DIALOG_CONFIRM_MS}. A read without a dialog, or a capture
 * that failed, starts the run again.
 *
 * What counts as a dialog is each tool's own test (copilot excludes its
 * folder-trust dialog and a drawn composer; opencode counts `waiting` without
 * `hasActivePrompt`; nobody counts a Working frame). This module only counts.
 *
 * Only the wait's screen reading is confirmed this way. The prompt guard at
 * the service entry (which also reads the hooks' structured record) and the
 * re-check under the input lock still decide on one read.
 *
 * @module lib/cli-tools/prompt-wait-dialog
 */

import { INPUT_RECHECK_PROMPT_WAITING_CODE } from '@/lib/session/send-attempt-types';

/** How long a dialog has to stay up before a prompt wait gives up on it. */
export const PROMPT_WAIT_DIALOG_CONFIRM_MS = 2000;

/** On how many reads in a row (both thresholds must hold). */
export const PROMPT_WAIT_DIALOG_CONFIRM_READS = 2;

/** The current run of reads that showed a dialog. */
export interface DialogConfirmation {
  /**
   * Count one successful read.
   *
   * @param isDialog - Whether the tool's own test reads this frame as a dialog
   * @param now - When the read returned (epoch ms)
   * @returns true when the dialog is confirmed: the wait gives up now, without
   *   reading the pane again
   */
  observe(isDialog: boolean, now?: number): boolean;
  /** A capture failed: not a dialog read, the run starts again. */
  reset(): void;
  /** Reads in the current run. */
  readonly reads: number;
}

/** A fresh, empty run. */
export function createDialogConfirmation(): DialogConfirmation {
  let since: number | null = null;
  let reads = 0;
  return {
    observe(isDialog: boolean, now: number = Date.now()): boolean {
      if (!isDialog) {
        since = null;
        reads = 0;
        return false;
      }
      since ??= now;
      reads++;
      return reads >= PROMPT_WAIT_DIALOG_CONFIRM_READS && now - since >= PROMPT_WAIT_DIALOG_CONFIRM_MS;
    },
    reset(): void {
      since = null;
      reads = 0;
    },
    get reads(): number {
      return reads;
    },
  };
}

/**
 * Run `read` (a capture), but stop waiting for it at `deadline` (Issue #4084):
 * a capture that is still running then (tmux's own time-out is 5 s) does not
 * stretch the wait past its window, and the frame it returns late is not used.
 *
 * @returns what `read` returned, or `null` when the deadline came first
 * @throws what `read` threw, when it threw before the deadline
 */
export async function readBeforeDeadline<T>(read: () => Promise<T>, deadline: number): Promise<T | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reading = read();
  // A late failure is nobody's to handle once the deadline has answered.
  reading.catch(() => undefined);
  try {
    return await Promise.race([
      reading,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The `prompt-waiting` refusal of a dialog a prompt wait confirmed (Issue
 * #4084), worded and coded as the re-check under the input lock words it
 * (`recheckComposerBeforeInput`), which is what `classifySendFailure` and the
 * send service read. Nothing has been typed. Refused on the wait's own reads,
 * without reading the pane once more.
 *
 * The wording must not say "prompt not ready": the classifier matches that
 * first.
 */
export function confirmedDialogRefusal(sessionName: string, label: string): Error {
  return Object.assign(
    new Error(
      `A prompt dialog stayed open in session ${sessionName} for ${PROMPT_WAIT_DIALOG_CONFIRM_MS}ms ` +
        `while the ${label} input prompt was awaited (re-checked under the input lock); nothing was typed (Issue #4084).`
    ),
    { code: INPUT_RECHECK_PROMPT_WAITING_CODE }
  );
}
