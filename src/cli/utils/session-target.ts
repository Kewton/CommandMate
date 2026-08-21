/**
 * Thin client for the server's session-target resolution (Issue #1925,
 * design §4 D5 決定 1 / §6.4).
 *
 * The CLI used to carry its own copy of the precedence rules. It was not the
 * same copy: the server resolves an unregistered instance id that happens to
 * name a CLI tool to that tool's primary instance (#868), and the CLI's copy had
 * no such stage — it fell through to `--agent`, or to nothing. So the same
 * `--instance codex` produced different tmux session names depending on which
 * side answered. The fix is not to make the copies agree (they cannot: the CLI
 * build sets `paths: {}` and cannot import the server resolver); it is to stop
 * having two answers. The server decides; this module asks.
 *
 * The old two-stage local resolution survives as one thing only: the
 * compatibility path for a daemon older than the endpoint, reported as
 * `resolvedBy: 'client-fallback'` with a warning on stderr. It is deliberately
 * NOT kept in step with the server — adding the primary-anchor stage to it would
 * be growing the second authority back (DR2-008).
 */

import { getErrorMessage } from '../types';
import type { ApiClient } from './api-client';
import { fetchAgentInstances } from './agent-instances';
import { serverResolvesSessionTargets } from './server-capabilities';
import type { AgentInstance } from '../types/api-responses';

/**
 * Which stage of the precedence chain produced the answer. Mirrors
 * SessionTargetResolvedBy in `src/lib/session/resolve-session-target.ts`; the
 * CLI keeps its own copy of API shapes (see api-responses.ts).
 */
export type SessionTargetResolvedBy =
  | 'explicit'
  | 'roster'
  | 'primary'
  | 'worktree-default'
  | 'fallback'
  | 'client-fallback';

/** An explicit `--agent` that the roster contradicts. */
export interface SessionTargetConflict {
  instanceId: string;
  rosterCliTool: string;
  requestedCliTool: string;
}

export interface CliSessionTarget {
  /**
   * The agent to address, or undefined when nothing declared one.
   *
   * Undefined only reaches a caller on the `client-fallback` path: the server
   * always answers with a concrete tool, and an old server keeps the behavior it
   * always had, which is to decide for itself when the CLI sends no `cliToolId`.
   */
  cliToolId: string | undefined;
  /** The instance addressed, echoed back so callers do not re-derive it. */
  instanceId: string | undefined;
  resolvedBy: SessionTargetResolvedBy;
  /** The contradiction, when there is one. Callers decide whether it is fatal. */
  conflict: SessionTargetConflict | null;
}

export interface ResolveSessionTargetOptions {
  instanceId?: string;
  /** The `--agent` / `--cli-tool` value, already validated as a known tool id. */
  requestedCliTool?: string;
}

/** Shape of GET /api/worktrees/:id/resolve-target. */
interface ResolveTargetResponse {
  cliToolId: string;
  instanceId: string;
  resolvedBy: SessionTargetResolvedBy;
  conflict: SessionTargetConflict | null;
}

/**
 * The one line of stderr a degraded resolution owes the operator (design §10.6
 * item 6). Printed once per resolution rather than once per process on purpose:
 * a command that resolves two targets against an old server degraded twice.
 */
function warnClientFallback(): void {
  console.error(
    'Warning: this CommandMate server is older than the CLI and cannot resolve agent instances; '
    + 'resolving locally (resolvedBy: client-fallback). Restart the server to pick up the current '
    + 'version: commandmate stop && commandmate start'
  );
}

/**
 * Resolve which agent and instance a command should address.
 *
 * @param client - API client aimed at the server
 * @param worktreeId - Worktree ID
 * @param options - `--instance` and `--agent` as the user gave them
 * @returns The resolved target, with `conflict` set when `--agent` contradicts the roster
 * @throws ApiError when the server's capabilities cannot be determined (auth
 *   failure, redirect, non-JSON body) — those are never treated as "old server"
 */
export async function resolveSessionTarget(
  client: ApiClient,
  worktreeId: string,
  options: ResolveSessionTargetOptions = {}
): Promise<CliSessionTarget> {
  if (await serverResolvesSessionTargets(client)) {
    return resolveViaServer(client, worktreeId, options);
  }
  warnClientFallback();
  return resolveLocally(client, worktreeId, options);
}

async function resolveViaServer(
  client: ApiClient,
  worktreeId: string,
  options: ResolveSessionTargetOptions
): Promise<CliSessionTarget> {
  const query = new URLSearchParams();
  if (options.instanceId) query.set('instance', options.instanceId);
  if (options.requestedCliTool) query.set('cliTool', options.requestedCliTool);
  const qs = query.toString();

  const response = await client.get<ResolveTargetResponse>(
    `/api/worktrees/${worktreeId}/resolve-target${qs ? `?${qs}` : ''}`
  );
  return {
    cliToolId: response.cliToolId,
    instanceId: response.instanceId,
    resolvedBy: response.resolvedBy,
    conflict: response.conflict ?? null,
  };
}

/**
 * Compatibility resolution for a server that predates the endpoint.
 *
 * Two stages, exactly as before: the roster entry, then `--agent`. No
 * primary-anchor stage and no worktree-default read — an old server applies
 * those itself when the CLI sends no `cliToolId`, and reimplementing them here
 * is how the second authority grew in the first place (DR2-008).
 */
async function resolveLocally(
  client: ApiClient,
  worktreeId: string,
  options: ResolveSessionTargetOptions
): Promise<CliSessionTarget> {
  const { instanceId, requestedCliTool } = options;
  const degraded = (
    cliToolId: string | undefined,
    conflict: SessionTargetConflict | null = null
  ): CliSessionTarget => ({
    cliToolId,
    instanceId,
    resolvedBy: 'client-fallback',
    conflict,
  });

  if (!instanceId) {
    return degraded(requestedCliTool);
  }

  let registered: AgentInstance | undefined;
  try {
    const instances = await fetchAgentInstances(client, worktreeId);
    registered = instances.find((inst) => inst.id === instanceId);
  } catch (error) {
    console.error(
      `Warning: could not read the agent-instance roster (${getErrorMessage(error)}); using --agent as given.`
    );
    return degraded(requestedCliTool);
  }

  if (!registered) {
    return degraded(requestedCliTool);
  }

  if (requestedCliTool && requestedCliTool !== registered.cliTool) {
    return degraded(registered.cliTool, {
      instanceId,
      rosterCliTool: registered.cliTool,
      requestedCliTool,
    });
  }

  return degraded(registered.cliTool);
}

/**
 * The sentence shown when the roster and `--agent` disagree. Names both
 * declarations and the three ways out, because only the operator knows which of
 * the two is wrong.
 */
export function describeSessionTargetConflict(conflict: SessionTargetConflict): string {
  return (
    `instance '${conflict.instanceId}' is registered as ${conflict.rosterCliTool}, `
    + `but --agent ${conflict.requestedCliTool} was given. `
    + `Drop --agent, pass --agent ${conflict.rosterCliTool}, or re-register the instance.`
  );
}
