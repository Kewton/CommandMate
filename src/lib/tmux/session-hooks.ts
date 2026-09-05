/**
 * Server side of Issue #2317's session-scoped hooks and geometry hand-back.
 *
 * Two jobs, both keyed off one session name:
 *
 *  - {@link ensureSessionHooks} reconciles the two OPT-IN `client-attached`
 *    hooks (Phase C's auto popup, Phase D's delegate-on-hand-attach) with what
 *    the environment asks for. Like #1623's key binding it CONVERGES: turning an
 *    option off removes the hook a previous run installed, rather than merely
 *    not installing it again.
 *  - {@link reconcileDelegatedGeometry} is the safety net the Issue asked a
 *    `client-detached` hook to be. tmux 3.5a does not fire that hook
 *    session-scoped (measured — see the table in `live-attach.ts`), so the
 *    restore runs from the status poll instead: every couple of seconds, for
 *    every session, "is this delegated while no human is looking at it?".
 *
 * Nothing here throws. All of it hangs off the status poll and off session
 * creation, and neither may be failed by a convenience feature.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  buildInstallAutoPopupHookArgs,
  buildInstallDelegateHookArgs,
  buildRemoveAutoPopupHookArgs,
  buildRemoveDelegateHookArgs,
  buildRestoreGeometryCommands,
  isAutoPopupEnabled,
  isCommandMateSession,
  isLiveAttachEligibleSession,
  isLiveAttachHookEnabled,
} from '../session/tmux-session-surface';
import {
  materializeAutoPopupScript,
  materializeLiveDelegateScript,
  materializeLiveRestoreScript,
} from './session-hook-scripts';
import { forgetGeometryDelegation, hasHumanClientAttached, isGeometryDelegated } from './geometry-delegation';
import { createLogger } from '../logger';

const execFileAsync = promisify(execFile);
const logger = createLogger('tmux-session-hooks');

/** tmux calls here are interactive-latency, not long-running. */
const TMUX_TIMEOUT = 5000;

/**
 * globalThis-backed for the reason every other memo in this feature is: under
 * `npm run dev` a module re-evaluation would otherwise re-issue `set-hook` for
 * every session on the next poll.
 */
declare global {
  // eslint-disable-next-line no-var
  var __cmEnsuredSessionHooks: Set<string> | undefined;
}

const ensured =
  globalThis.__cmEnsuredSessionHooks ?? (globalThis.__cmEnsuredSessionHooks = new Set<string>());

/**
 * Reconcile a session's opt-in `client-attached` hooks with the environment.
 *
 * Runs once per session per process; call it freely. Both hooks are removed when
 * their option is off, so `CM_READ_MODE_AUTO_POPUP=on` followed by a restart
 * without it leaves no hook behind.
 *
 * @param sessionName - Target session
 */
export async function ensureSessionHooks(sessionName: string): Promise<void> {
  if (!isCommandMateSession(sessionName)) return;
  if (ensured.has(sessionName)) return;
  ensured.add(sessionName);

  try {
    if (isLiveAttachHookEnabled() && isLiveAttachEligibleSession(sessionName)) {
      // The restore script rides along with the delegate one: a user whose
      // server is down needs the manual way back, and materializing it here is
      // the only moment we know the delegate path is in use at all.
      materializeLiveRestoreScript();
      const args = buildInstallDelegateHookArgs(sessionName, materializeLiveDelegateScript());
      if (args) await execFileAsync('tmux', args, { timeout: TMUX_TIMEOUT });
    } else {
      await execFileAsync('tmux', buildRemoveDelegateHookArgs(sessionName), {
        timeout: TMUX_TIMEOUT,
      });
    }

    if (isAutoPopupEnabled()) {
      const args = buildInstallAutoPopupHookArgs(sessionName, materializeAutoPopupScript());
      if (args) await execFileAsync('tmux', args, { timeout: TMUX_TIMEOUT });
    } else {
      await execFileAsync('tmux', buildRemoveAutoPopupHookArgs(sessionName), {
        timeout: TMUX_TIMEOUT,
      });
    }
  } catch (error: unknown) {
    logger.debug('session-hooks:reconcile-failed', {
      sessionName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Take a delegated session's geometry back when no human is attached.
 *
 * The Phase D safety net. Restores unconditionally once the two conditions hold,
 * because the sequence is idempotent — a session already at `manual` 200x1000
 * with no `@cm_delegated` is left byte-identical by it.
 *
 * Also self-healing for a flag left behind by a CLI that was killed: the flag
 * alone never keeps a window unpinned, because this runs whenever nobody is
 * looking.
 *
 * @param sessionName - Target session
 * @returns true when the geometry was handed back by this call
 */
export async function reconcileDelegatedGeometry(sessionName: string): Promise<boolean> {
  try {
    if (!(await isGeometryDelegated(sessionName))) return false;
    if (await hasHumanClientAttached(sessionName)) return false;

    for (const args of buildRestoreGeometryCommands(sessionName)) {
      await execFileAsync('tmux', args, { timeout: TMUX_TIMEOUT });
    }
    logger.info('session-hooks:geometry-restored', { sessionName });
    return true;
  } catch (error: unknown) {
    logger.debug('session-hooks:geometry-restore-failed', {
      sessionName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Forget a session's hook bookkeeping — call when it is known to be gone. */
export function forgetSessionHooks(sessionName: string): void {
  ensured.delete(sessionName);
  forgetGeometryDelegation(sessionName);
}
