/**
 * Turning "worktree + instance" into the three facts a relay needs (#2377).
 *
 * A ledger row stores two ids and nothing else, on purpose — an alias can be
 * renamed and a roster row deleted, and a relay must survive both. Everything
 * else a delivery needs (which CLI tool drives the session, what to call it in
 * the attribution header) is therefore resolved at the moment it is needed, from
 * the roster, with the id as the fallback for every field.
 *
 * Never throws. A relay whose roster cannot be read still delivers, attributed
 * to the instance id — which is worse to read and strictly better than not
 * delivering.
 *
 * @module lib/relay/relay-session-ref
 */

import type Database from 'better-sqlite3';
import { getAgentInstance } from '@/lib/db/agent-instances-db';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { resolveSessionTarget } from '@/lib/session/resolve-session-target';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { RelayEndpoint } from '@/lib/relay/types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('relay-session-ref');

/** A relay endpoint with everything a delivery needs resolved. */
export interface ResolvedRelaySession {
  worktreeId: string;
  instanceId: string;
  cliToolId: CLIToolType;
  /** The roster alias, or the instance id when the roster has nothing. */
  alias: string;
}

/** The tool assumed when neither the roster nor the worktree declares one. */
const FALLBACK_CLI_TOOL: CLIToolType = 'claude';

/**
 * Resolve one end of a relay.
 *
 * The tool comes from `resolveSessionTarget` — the same authority
 * `POST /api/worktrees/:id/send` uses, so a relay cannot address a session the
 * send route would address differently (#1629 is the record of what two
 * authorities on that cost) — falling back to the worktree's own tool and then
 * to claude.
 *
 * Issue #2491: that sentence was true of `resolveInstanceCliTool` when this
 * module was written and stopped being true when `send` moved to the shared
 * resolver. The two answer identically here — a relay never names a tool, and
 * with `requestedCliTool` absent both walk roster → primary anchor → worktree
 * default → claude — so this is the comment made true again, not a behaviour
 * change. `resolveSessionTarget` folds in the worktree-default and claude
 * stages this function used to spell out for itself; `FALLBACK_CLI_TOOL` stays
 * because the catch below still needs an answer when the roster cannot be read
 * at all.
 */
export function resolveRelaySession(
  db: Database.Database,
  endpoint: RelayEndpoint
): ResolvedRelaySession {
  let cliToolId: CLIToolType = FALLBACK_CLI_TOOL;
  let alias = endpoint.instanceId;

  try {
    cliToolId = resolveSessionTarget(db, endpoint.worktreeId, {
      instanceId: endpoint.instanceId,
    }).cliToolId;
    const rosterRow = getAgentInstance(db, endpoint.worktreeId, endpoint.instanceId);
    if (rosterRow?.alias) alias = rosterRow.alias;
  } catch (error) {
    logger.warn('relay-session-resolve-failed', {
      worktreeId: endpoint.worktreeId,
      instanceId: endpoint.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    worktreeId: endpoint.worktreeId,
    instanceId: endpoint.instanceId,
    cliToolId,
    alias,
  };
}

/** Whether this worktree exists at all. The one check a create must make. */
export function relayWorktreeExists(db: Database.Database, worktreeId: string): boolean {
  try {
    return getWorktreeById(db, worktreeId) !== null;
  } catch {
    return false;
  }
}
