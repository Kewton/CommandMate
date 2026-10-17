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
}

/** sessionName -> how many launch windows are open. */
const openLaunchWindows = getOrInitGlobal('__launchWindows', () => new Map<string, number>());

/** The launch window opened: the launch answers its startup confirmation in it. */
export function beginLaunchWindow(sessionName: string): void {
  openLaunchWindows.set(sessionName, (openLaunchWindows.get(sessionName) ?? 0) + 1);
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

/** Close every window. Test seam. */
export function clearLaunchWindows(): void {
  openLaunchWindows.clear();
}
