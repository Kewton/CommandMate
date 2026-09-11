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
 * be growing the second authority back (DR2-008). The one exception is a
 * refusal, not a choice: an `--agent` that contradicts an unregistered
 * tool-named instance is reported exactly as the server reports it (Issue
 * #2487), because a copy that obeys it sends where the server would refuse to.
 */

import { getErrorMessage } from '../types';
import { isCliToolId } from '../config/cli-tool-ids';
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

/**
 * An explicit `--agent` that the instance's declaration contradicts: its roster
 * row, or — with no row — its own id when that id is a CLI tool id (the
 * primary-instance anchor, #868; Issue #2487).
 */
export interface SessionTargetConflict {
  instanceId: string;
  /** The tool the instance is declared as; for a primary-anchor conflict, the id itself. */
  rosterCliTool: string;
  requestedCliTool: string;
  /**
   * Set when the declaration is the primary-instance anchor rather than a
   * roster row. Mirrors the server's field of the same name, which
   * `resolve-target` sends; absent for a roster contradiction.
   */
  primaryAnchor?: true;
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
 * @returns The resolved target, with `conflict` set when `--agent` contradicts
 *   the roster or the primary-instance anchor
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
 *
 * The one thing borrowed from the server's chain is its refusal (Issue #2487):
 * with no roster row, an `--agent` that differs from a tool-named instance id
 * is the contradiction the server reports, and it is reported here with the
 * same `conflict`. It resolves nothing — without `--agent` that id still
 * resolves to nothing here — but taking the `--agent` would start an ad-hoc
 * session under another tool's primary id, which the server now refuses.
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
    if (requestedCliTool && isCliToolId(instanceId) && requestedCliTool !== instanceId) {
      return degraded(instanceId, {
        instanceId,
        rosterCliTool: instanceId,
        requestedCliTool,
        primaryAnchor: true,
      });
    }
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
 * The sentence shown when the instance's declaration and `--agent` disagree.
 * Names both declarations and the three ways out, because only the operator
 * knows which of the two is wrong. A primary-anchor conflict has no roster row
 * to re-register — `instances add --id <tool>` answers "already exists" — so its
 * third way out is another instance.
 */
export function describeSessionTargetConflict(conflict: SessionTargetConflict): string {
  if (conflict.primaryAnchor) {
    return (
      `instance '${conflict.instanceId}' is the primary instance of ${conflict.rosterCliTool}, `
      + `but --agent ${conflict.requestedCliTool} was given. `
      + `Drop --agent, pass --agent ${conflict.rosterCliTool}, or target a ${conflict.requestedCliTool} instance instead `
      + `(e.g. --instance ${conflict.requestedCliTool}).`
    );
  }
  return (
    `instance '${conflict.instanceId}' is registered as ${conflict.rosterCliTool}, `
    + `but --agent ${conflict.requestedCliTool} was given. `
    + `Drop --agent, pass --agent ${conflict.rosterCliTool}, or re-register the instance.`
  );
}
