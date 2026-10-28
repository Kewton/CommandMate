/**
 * wait Command - resolving --instance per worktree (Issue #2376)
 * Issue #3964: split out of wait.ts.
 */

import { getErrorMessage } from '../types';
import type { WaitOptions } from '../types';
import type { ApiClient } from '../utils/api-client';
import { resolveInstanceTarget } from './instances';

/**
 * `options` with `--instance` resolved from a selector to an instance ID
 * (Issue #2376).
 *
 * `wait` polls `/current-output?instance=`, which matches instance IDs and
 * nothing else, so an alias that reached it would filter to no session and the
 * wait would report on the worktree default instead — the exact silent
 * wrong-session failure Issue #1638 catalogued for `--agent`.
 *
 * @param client - API client
 * @param worktreeId - Worktree the selector is resolved against
 * @param options - The options as given
 */
export async function resolveWaitInstance<T extends WaitOptions>(
  client: ApiClient,
  worktreeId: string,
  options: T,
): Promise<T> {
  if (!options.instance) return options;
  try {
    const target = await resolveInstanceTarget(client, worktreeId, options.instance, undefined);
    return { ...options, instance: target.instanceId ?? options.instance };
  } catch (error) {
    // Degrade to the pre-#2376 behaviour rather than failing the wait. An
    // instance ID needs no resolution to reach `/current-output?instance=` —
    // resolution exists here so that an ALIAS can — so a resolver that cannot
    // be reached costs alias support for this call and nothing else. Failing
    // instead would turn a reachable session into a non-zero exit for an
    // orchestrator that has been waiting on it correctly for two years.
    console.error(
      `Warning: could not resolve --instance '${options.instance}' `
      + `(${getErrorMessage(error)}); using it as an instance id.`
    );
    return options;
  }
}
