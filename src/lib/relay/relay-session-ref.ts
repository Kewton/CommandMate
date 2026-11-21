/**
 * Turning "worktree + instance" into the three facts a relay needs (#2377).
 *
 * A ledger row stores two ids and nothing else, on purpose — an alias can be
 * renamed and a roster row deleted, and a relay must survive both. Everything
 * else a delivery needs (which CLI tool drives the session, what to call it in
 * the attribution header) is therefore resolved at the moment it is needed, from
 * the roster, with the id as the fallback for every field.
 *
 * Never throws. {@link resolveRelaySession} is the display reading: a roster
 * that cannot be read still gives an alias (the instance id) and a tool (claude).
 * A delivery uses {@link tryResolveRelaySession} instead, which answers null
 * there (and for the shared resolver's last-resort guess), and holds rather than
 * type into a guessed tool (Issue #4498).
 *
 * @module lib/relay/relay-session-ref
 */

import type Database from 'better-sqlite3';
import { getAgentInstance } from '@/lib/db/agent-instances-db';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { resolveSessionTarget, type SessionTargetResolvedBy } from '@/lib/session/resolve-session-target';
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

/** {@link tryResolveRelayDeliveryTarget}'s answer: the session, and which stage named its tool. */
export interface RelayDeliveryTarget {
  session: ResolvedRelaySession;
  resolvedBy: SessionTargetResolvedBy;
}

/**
 * {@link resolveRelaySession} for a delivery (Issue #4498): the same resolution, or
 * null when it would be a guess — never the display fallback.
 *
 * `resolveRelaySession` answers claude when the read fails, which is right for an
 * alias in a system line and wrong for the session a reply is typed into: the
 * guessed tool would decide both rule 0 and the send, and a claude pane under the
 * same instance id would take a reply owed to codex. Null too for the shared
 * resolver's own last resort (`resolvedBy: 'fallback'`: the worktree declares no
 * usable tool, so claude is assumed) — a guess all the same (r1). A delivery that
 * gets null holds the payload and tries again on the next pump.
 *
 * `resolvedBy` lets the delivery tell a registered instance whose roster row went
 * away (`roster` before, `worktree-default` now) from an ad-hoc id that was never
 * on the roster and resolves to the worktree's default by design.
 */
export function tryResolveRelayDeliveryTarget(
  db: Database.Database,
  endpoint: RelayEndpoint
): RelayDeliveryTarget | null {
  try {
    const { cliToolId, resolvedBy } = resolveSessionTarget(db, endpoint.worktreeId, {
      instanceId: endpoint.instanceId,
    });
    if (resolvedBy === 'fallback') {
      logger.warn('relay-session-resolve-fallback', {
        worktreeId: endpoint.worktreeId,
        instanceId: endpoint.instanceId,
        strict: true,
      });
      return null;
    }
    const rosterRow = getAgentInstance(db, endpoint.worktreeId, endpoint.instanceId);
    return {
      session: {
        worktreeId: endpoint.worktreeId,
        instanceId: endpoint.instanceId,
        cliToolId,
        alias: rosterRow?.alias ? rosterRow.alias : endpoint.instanceId,
      },
      resolvedBy,
    };
  } catch (error) {
    logger.warn('relay-session-resolve-failed', {
      worktreeId: endpoint.worktreeId,
      instanceId: endpoint.instanceId,
      strict: true,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** {@link tryResolveRelayDeliveryTarget}'s session alone (null when it is null). */
export function tryResolveRelaySession(
  db: Database.Database,
  endpoint: RelayEndpoint
): ResolvedRelaySession | null {
  return tryResolveRelayDeliveryTarget(db, endpoint)?.session ?? null;
}

/**
 * The tool that drives one end of a relay, for rule 0 (Issue #4496); null when it
 * cannot be read.
 *
 * Unlike {@link resolveRelaySession} this takes the tool the request asked for
 * (`requestedCliTool`, `send --agent`): a roster row and a tool-named id still win
 * over it (the roster is the authority, and a contradiction is the send's strict
 * 400 to answer), but an ad-hoc id is the tool that will actually be typed into,
 * not the worktree's default. And it never falls back: a caller judging a policy
 * must refuse what it cannot read (fail-closed), where a delivery may guess.
 */
export function resolveRelayEndpointTool(
  db: Database.Database,
  endpoint: RelayEndpoint,
  requestedCliTool?: CLIToolType
): CLIToolType | null {
  try {
    return resolveSessionTarget(db, endpoint.worktreeId, {
      instanceId: endpoint.instanceId,
      requestedCliTool,
    }).cliToolId;
  } catch (error) {
    logger.warn('relay-endpoint-tool-unreadable', {
      worktreeId: endpoint.worktreeId,
      instanceId: endpoint.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Whether this worktree exists at all. The one check a create must make. */
export function relayWorktreeExists(db: Database.Database, worktreeId: string): boolean {
  try {
    return getWorktreeById(db, worktreeId) !== null;
  } catch {
    return false;
  }
}
