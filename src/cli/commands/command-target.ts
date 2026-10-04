/**
 * Resolution of the `--instance` / `--agent` pair into the tool and instance a
 * command addresses (Issue #3224).
 *
 * Lives beside, not inside, `./instances` so that a test which replaces
 * `resolveInstanceTarget` on that module is still seen by every caller here.
 */

import type { ApiClient } from '../utils/api-client';
import { resolveInstanceTarget } from './instances';
import type { InstanceConflictMode, ResolvedInstanceTarget } from './instances';

export interface CommandTarget {
  /** The roster target, or null when no selector was given */
  target: ResolvedInstanceTarget | null;
  /** The tool the instance is registered under, else the `--agent` value */
  agent: string | undefined;
  /** The RESOLVED instance id, never the string the user typed */
  instanceId: string | undefined;
}

/**
 * @param selector - Falsy means "no instance": nothing is requested of the server
 * @param mode - Passed on only when given, so the call shape stays as it was
 */
export async function resolveCommandTarget(
  client: ApiClient,
  worktreeId: string,
  selector: string | undefined,
  requestedAgent: string | undefined,
  mode?: InstanceConflictMode
): Promise<CommandTarget> {
  const target = selector
    ? mode === undefined
      ? await resolveInstanceTarget(client, worktreeId, selector, requestedAgent)
      : await resolveInstanceTarget(client, worktreeId, selector, requestedAgent, mode)
    : null;
  const agent = target ? target.cliToolId : requestedAgent;
  const instanceId = target?.instanceId;
  return { target, agent, instanceId };
}
