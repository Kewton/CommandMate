/**
 * The one place tool / instance resolution happens (Issue #1925, design §4 D5).
 *
 * Before this module the answer to "which CLI tool and which instance does this
 * request target?" had four implementations (design §3 P4): the server-side
 * `resolveInstanceCliTool`, the CLI's own two-stage copy, `kill-session`'s
 * inline expression and `capture`'s `resolvePaneCliTool`. They disagreed —
 * `kill-session` let an explicit `?cliTool` override the roster and never
 * reported the contradiction, and the CLI copy had no primary-anchor stage — so
 * the same (worktree, instance, tool) triple resolved differently depending on
 * which door the request came through. The tool id is part of the tmux session
 * name, so disagreeing means starting or reading the wrong agent under a
 * session name that claims otherwise.
 *
 * Precedence (design §4 D5 決定 2, matching the #1629 implementation):
 *
 *   instanceId omitted -> the explicit request, or the worktree default.
 *                         The roster is not consulted at all (DR3-020).
 *   instanceId given   -> roster entry
 *                      -> explicit request (only for an instance the roster
 *                         does not know: the ad-hoc `send --instance <new-id>`)
 *                      -> instanceId when it is itself a CLI tool id (the
 *                         primary-instance anchor, #868)
 *                      -> worktree default
 *                      -> DEFAULT_SESSION_CLI_TOOL
 *
 * The roster outranks the explicit request because it is the user-maintained
 * declaration of what a named instance is; a contradiction is reported rather
 * than silently resolved. Callers decide what to do with it: routes with a side
 * effect answer 400, read-only routes answer 200 and surface the conflict in
 * the payload (design §4 D5 / DR3-015).
 */

import type Database from 'better-sqlite3';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { getAgentInstance } from '@/lib/db/agent-instances-db';
import { isCliToolType, type CLIToolType } from '@/lib/cli-tools/types';

/**
 * Last-resort CLI tool when nothing else in the precedence chain has an answer.
 *
 * Design §4 D5 決定 4 names this module as the single place the default agent
 * may be named as a literal: every other copy of it scattered through the
 * resolution paths is a duplicated default that this function exists to absorb.
 * Reaching it is a warning, not a normal outcome — see `resolvedBy: 'fallback'`.
 */
export const DEFAULT_SESSION_CLI_TOOL: CLIToolType = 'claude';

/**
 * Which stage of the precedence chain produced the answer.
 *
 * Surfaced to the operator (design §7) rather than kept internal: 'fallback'
 * means the worktree has no CLI tool of its own, which is the shape of the
 * #1909 bug, and 'client-fallback' means the CLI resolved locally against a
 * server too old to have the resolve endpoint (design §4 D5 決定 1). Both are
 * degradations worth seeing.
 */
export type SessionTargetResolvedBy =
  | 'explicit'
  | 'roster'
  | 'primary'
  | 'worktree-default'
  | 'fallback'
  | 'client-fallback';

/** An explicit request that contradicts the roster (design §4 D5 決定 2). */
export interface SessionTargetConflict {
  instanceId: string;
  rosterCliTool: CLIToolType;
  requestedCliTool: CLIToolType;
}

/** Machine-readable reason code for a contradiction, shared by every route. */
export const INSTANCE_TOOL_CONFLICT = 'instance_tool_conflict';

/** A resolved send/read target: which agent, in which instance. */
export interface SessionTarget {
  cliToolId: CLIToolType;
  /** Effective instance. The primary instance is `instanceId === cliToolId` (#868). */
  instanceId: string;
  resolvedBy: SessionTargetResolvedBy;
  /**
   * Present only when the caller named a tool the roster contradicts. Read-only
   * routes resolve anyway (roster wins) and carry this so the contradiction is
   * visible instead of silently corrected (DR3-015).
   */
  conflict?: SessionTargetConflict;
}

export interface ResolveSessionTargetOptions {
  /** Targeted agent instance, if the caller named one. */
  instanceId?: string;
  /** CLI tool the caller named explicitly (`--agent` / `?cliTool` / `body.cliToolId`). */
  requestedCliTool?: CLIToolType;
}

/**
 * Resolve the CLI tool and instance a request targets.
 *
 * Always returns a target: a contradiction is reported through `conflict`
 * rather than by failing, because the two classes of caller need different
 * outcomes from the same facts. Use {@link resolveSessionTargetStrict} for the
 * routes that must refuse instead.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID (already canonicalized and validated)
 * @param options - Targeting signals carried by the request
 * @returns The resolved target, with `conflict` set when the request contradicts the roster
 */
export function resolveSessionTarget(
  db: Database.Database,
  worktreeId: string,
  options: ResolveSessionTargetOptions = {}
): SessionTarget {
  const { instanceId, requestedCliTool } = options;

  // DR3-020: without an instanceId there is nothing to look up, and reading the
  // roster here would let an unrelated instance's tool leak into a request that
  // never named one.
  if (!instanceId) {
    if (requestedCliTool) {
      return {
        cliToolId: requestedCliTool,
        instanceId: requestedCliTool,
        resolvedBy: 'explicit',
      };
    }
    return worktreeDefaultTarget(db, worktreeId, undefined);
  }

  const registered = getAgentInstance(db, worktreeId, instanceId);
  if (registered && isCliToolType(registered.cliTool)) {
    const target: SessionTarget = {
      cliToolId: registered.cliTool,
      instanceId,
      resolvedBy: 'roster',
    };
    if (requestedCliTool && requestedCliTool !== registered.cliTool) {
      target.conflict = {
        instanceId,
        rosterCliTool: registered.cliTool,
        requestedCliTool,
      };
    }
    return target;
  }

  // The roster does not know this instance (the ad-hoc `send --instance <new-id>`
  // flow), so an explicit tool is the only declaration there is.
  if (requestedCliTool) {
    return { cliToolId: requestedCliTool, instanceId, resolvedBy: 'explicit' };
  }

  // #868: an instance id that names a CLI tool *is* that tool's primary
  // instance, which holds without a roster row.
  if (isCliToolType(instanceId)) {
    return { cliToolId: instanceId, instanceId, resolvedBy: 'primary' };
  }

  return worktreeDefaultTarget(db, worktreeId, instanceId);
}

/**
 * The tail of the chain: the worktree's own CLI tool, then the last-resort
 * default. Split out so both entry points into it read the same.
 */
function worktreeDefaultTarget(
  db: Database.Database,
  worktreeId: string,
  instanceId: string | undefined
): SessionTarget {
  const worktree = getWorktreeById(db, worktreeId);
  const worktreeCliTool = worktree?.cliToolId;
  if (worktreeCliTool && isCliToolType(worktreeCliTool)) {
    return {
      cliToolId: worktreeCliTool,
      instanceId: instanceId ?? worktreeCliTool,
      resolvedBy: 'worktree-default',
    };
  }
  return {
    cliToolId: DEFAULT_SESSION_CLI_TOOL,
    instanceId: instanceId ?? DEFAULT_SESSION_CLI_TOOL,
    resolvedBy: 'fallback',
  };
}

/** Failure shape for the routes that refuse a contradicted request. */
export interface SessionTargetConflictError {
  ok: false;
  error: typeof INSTANCE_TOOL_CONFLICT;
  conflict: SessionTargetConflict;
}

export type StrictSessionTargetResult =
  | { ok: true; target: SessionTarget }
  | SessionTargetConflictError;

/**
 * {@link resolveSessionTarget} for routes with a side effect (design §4 D5 決定 3
 * / DR3-015): `send`, `respond`, `interrupt`, `kill-session`, `terminal`,
 * `special-keys` and `auto-yes` POST answer 400 rather than guess which of the
 * two contradicting declarations the operator meant.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID (already canonicalized and validated)
 * @param options - Targeting signals carried by the request
 * @returns The resolved target, or the conflict to answer 400 with
 */
export function resolveSessionTargetStrict(
  db: Database.Database,
  worktreeId: string,
  options: ResolveSessionTargetOptions = {}
): StrictSessionTargetResult {
  const target = resolveSessionTarget(db, worktreeId, options);
  if (target.conflict) {
    return { ok: false, error: INSTANCE_TOOL_CONFLICT, conflict: target.conflict };
  }
  return { ok: true, target };
}

/**
 * The sentence shown to a human when the roster and the request disagree.
 * Names both declarations and the three ways out, because the operator has to
 * pick which one is wrong.
 */
export function describeSessionTargetConflict(conflict: SessionTargetConflict): string {
  return (
    `Agent instance '${conflict.instanceId}' is registered as ${conflict.rosterCliTool}, `
    + `but ${conflict.requestedCliTool} was requested. `
    + `Omit the agent, pass ${conflict.rosterCliTool}, or update the instance's roster entry.`
  );
}
