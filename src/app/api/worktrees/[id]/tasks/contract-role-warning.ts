/**
 * What `POST /tasks` says about a contract going to a session of unknown origin (Issue #4132).
 *
 * A session this server did not start, or started before it restarted, has no evidence of
 * the role it runs under. The contract still goes out: the user chose a warning over a
 * refusal. So nothing here may stop it, and a question it cannot answer warns of nothing.
 *
 * "Running" is a session of that name in `list-sessions`, the one way this route reaches tmux
 * (`worktree-route-session-ownership-3290`). A tool's `isRunning` would bring every tool and
 * its tmux modules into this route for a warning. It is looser: a pane back at its shell counts.
 */
import type Database from 'better-sqlite3';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { createLogger } from '@/lib/logger';
import { getLaunchRoleEvidence, settingsGiveRole, type LaunchRoleTarget } from '@/lib/session/role-launch';
import { isSessionLaunchInFlight } from '@/lib/session/session-launch-flight';
import { DEFAULT_ENV_PROBE_DEPS, probeTmuxSessions } from '@/lib/verification/env-snapshot';

const logger = createLogger('api/tasks');

/** One line: `send --contract` prints it as it is. */
export const UNKNOWN_ROLE_WARNING =
  'This session was already running and this server has no record of its start, so it may not have the role its settings give. ' +
  'To apply the role, stop the session and send again; to refuse such a session, pass --role or --expect-role-fingerprint / --expect-no-role.';

/** The warning for a contract to this target, or null when there is nothing to say. */
export async function contractRoleWarning(
  db: Database.Database,
  target: LaunchRoleTarget,
  worktreePath: string
): Promise<string | null> {
  try {
    const sessionName = resolveSessionName(target.cliToolId, target.worktreeId, target.instanceId);
    // A launch on its way has no evidence yet, and its pane already reads as running.
    const originKnown = (): boolean => isSessionLaunchInFlight(sessionName) || getLaunchRoleEvidence(target) !== null;
    if (originKnown()) return null;
    const sessions = await probeTmuxSessions(DEFAULT_ENV_PROBE_DEPS);
    if (originKnown() || !sessions.entries.some((entry) => entry.key === sessionName)) return null;
    return (await settingsGiveRole(db, target, worktreePath)) ? UNKNOWN_ROLE_WARNING : null;
  } catch (error) {
    logger.warn('contract-role-warning-failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
