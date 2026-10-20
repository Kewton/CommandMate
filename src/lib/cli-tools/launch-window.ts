/**
 * Whether a launch is still answering its own startup confirmation
 * (review of Issue #3776).
 *
 * gemini's launch confirms its folder-trust dialog itself, once, inside its
 * ~30 s readiness wait (`GeminiTool.waitForReady`); while that wait runs the
 * Auto-Yes poller must leave the dialog to it, or the two answer it twice. A
 * dialog still on the screen after the wait — the Enter did not land, or
 * gemini drew the dialog late (an auto-update, a slow start) — has nobody else
 * to answer it, so the poller may again, when the cursor is on the safe row.
 *
 * The window closing is not the end of the launch's answer (Issue #3790): an
 * answered dialog stays drawn, cursor on the safe row, until the agent redraws
 * (gemini's restart line takes about 2 s), and a window that closed in between —
 * the wait ran out on its last attempts — would hand it to the poller as an
 * unanswered one. So the launch also records the key it pressed
 * ({@link recordLaunchDialogPress}), and the poller leaves the dialog alone for
 * {@link LAUNCH_DIALOG_PRESS_SETTLE_MS} after it, window or not. Past that, a
 * dialog still on screen is one the key did not reach, and the poller may answer
 * it as before.
 *
 * Copilot's folder-trust dialog has the same window since Issue #3790: its launch
 * confirms with a `1` and the poller answered `1` + Enter beside it (measured on
 * 1.0.91: the second `1` + Enter is submitted as a user message).
 *
 * Counted, as agy's window is (`antigravity-startup-trust`, Issue #3770): a
 * relaunch racing another must not have the earlier one's end close the later
 * one's window. Keyed by tmux session name; reached through `globalThis`
 * because the launch and the poller may be bundled separately under
 * `next dev` (Issue #1736).
 *
 * @module lib/cli-tools/launch-window
 */

import { getOrInitGlobal } from '../global-state';

declare global {
  // eslint-disable-next-line no-var
  var __launchWindows: Map<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __launchDialogPresses: Map<string, number> | undefined;
}

/**
 * How long after the launch pressed its key the dialog stays the launch's
 * (Issue #3790). Measured on gemini 0.64.0: the restart line is drawn within
 * 100 ms of the key and the dialog is gone within about 2 s; a dialog still
 * drawn 30 s later is one the key did not reach.
 */
export const LAUNCH_DIALOG_PRESS_SETTLE_MS = 30_000;

/** sessionName -> how many launch windows are open. */
const openLaunchWindows = getOrInitGlobal('__launchWindows', () => new Map<string, number>());

/** sessionName -> when the launch last pressed the key of its startup confirmation. */
const launchDialogPresses = getOrInitGlobal('__launchDialogPresses', () => new Map<string, number>());

/**
 * The launch window opened: the launch answers its startup confirmation in it.
 * A key an earlier launch of the session pressed is forgotten: the dialog this
 * launch draws is a new one.
 */
export function beginLaunchWindow(sessionName: string): void {
  openLaunchWindows.set(sessionName, (openLaunchWindows.get(sessionName) ?? 0) + 1);
  launchDialogPresses.delete(sessionName);
}

/** The launch window closed, however it ended. */
export function endLaunchWindow(sessionName: string): void {
  const open = openLaunchWindows.get(sessionName) ?? 0;
  if (open <= 1) openLaunchWindows.delete(sessionName);
  else openLaunchWindows.set(sessionName, open - 1);
}

/**
 * @returns True while a launch window is open. A session this process never
 *   launched (a server restart, another launcher) has none open.
 */
export function isLaunchWindowOpen(sessionName: string): boolean {
  return openLaunchWindows.has(sessionName);
}

/** The launch pressed the key that confirms its startup confirmation (Issue #3790). */
export function recordLaunchDialogPress(sessionName: string, at: number = Date.now()): void {
  launchDialogPresses.set(sessionName, at);
}

/**
 * @returns True within {@link LAUNCH_DIALOG_PRESS_SETTLE_MS} of the launch's
 *   key (Issue #3790): the dialog on screen may be the one it answered, not yet
 *   redrawn, whether or not the window is still open.
 */
export function isLaunchDialogPressSettling(sessionName: string, now: number = Date.now()): boolean {
  const at = launchDialogPresses.get(sessionName);
  return at !== undefined && now - at < LAUNCH_DIALOG_PRESS_SETTLE_MS;
}

/** Close every window and forget every press. Test seam. */
export function clearLaunchWindows(): void {
  openLaunchWindows.clear();
  launchDialogPresses.clear();
}
