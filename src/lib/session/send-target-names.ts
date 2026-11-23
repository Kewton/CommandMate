/**
 * What an entry opens its send ticket with (Issue #4534): the check that the
 * target is still the one it resolved, and the session names the detector
 * counts the send under.
 *
 * Each check is synchronous and reads what its entry read to resolve the
 * target (design §2.2): the send route and `/terminal` ask
 * `resolveSessionTargetStrict` about the RESOLVED pair (never the request's
 * options again), a relay delivery reads its requester again with
 * `tryResolveRelayDeliveryTarget`, a timer reads its own row. A worktree that
 * is gone is `worktree-gone` for all of them; a throw is read as `unreadable`
 * by the fence.
 *
 * The names come from `resolveSessionName` (or, for `/terminal`, the name the
 * route already holds from `cliTool.getSessionName`, design §2.3). A resolution
 * that throws throws here, before any ticket is opened — never a ticket with no
 * name (fail-closed).
 *
 * @module lib/session/send-target-names
 */

import type Database from 'better-sqlite3';
import { getWorktreeById } from '@/lib/db';
import { getAgentInstance } from '@/lib/db/agent-instances-db';
import { getTimerById } from '@/lib/db/timer-db';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { tryResolveRelayDeliveryTarget } from '@/lib/relay/relay-session-ref';
import type { RelayEndpoint } from '@/lib/relay/types';
import { resolveSessionTargetStrict } from './resolve-session-target';
import type { FenceRefusalReason, SendTicketInit } from './terminal-fence';

/** The target an entry resolved, as it resolved it. */
export interface ResolvedSendTarget {
  worktreeId: string;
  /** The request's instance (undefined for the primary); the ticket keeps the effective one. */
  instanceId?: string;
  cliToolId: CLIToolType;
  /** How the entry's resolution answered (`roster`, `explicit`, …), when it said. */
  resolvedBy?: string;
}

/** The session name the triple is served under now (#2866: a legacy alias while one is registered). */
export function sendTargetNames(cliToolId: CLIToolType, worktreeId: string, instanceId?: string): string[] {
  return [resolveSessionName(cliToolId, worktreeId, instanceId)];
}

/**
 * The send route's and `/terminal`'s ticket: the resolver the entry used, asked
 * about the resolved `(instance, tool)`.
 *
 * @param names - The names the route already holds (`/terminal`:
 *   `cliTool.getSessionName`); otherwise {@link sendTargetNames}
 */
export function routeSendTicketInit(
  db: Database.Database,
  target: ResolvedSendTarget,
  names?: readonly string[]
): SendTicketInit {
  const instanceId = target.instanceId ?? target.cliToolId;
  const resolvedBy = target.resolvedBy ?? null;
  return {
    target: { worktreeId: target.worktreeId, instanceId, cliToolId: target.cliToolId },
    resolvedBy,
    kind: 'resolved',
    names: names ?? sendTargetNames(target.cliToolId, target.worktreeId, target.instanceId),
    confirm: (): FenceRefusalReason | null => {
      if (!getWorktreeById(db, target.worktreeId)) return 'worktree-gone';
      const now = resolveSessionTargetStrict(db, target.worktreeId, { instanceId, requestedCliTool: target.cliToolId });
      if (!now.ok) return 'tool-changed';
      if (resolvedBy === 'roster' && now.target.resolvedBy !== 'roster') return 'target-gone';
      return null;
    },
  };
}

/**
 * A relay delivery's ticket: the requester read again the way the delivery
 * read it before its claim (`tryResolveRelayDeliveryTarget`).
 */
export function relaySendTicketInit(
  db: Database.Database,
  endpoint: RelayEndpoint,
  resolved: { cliToolId: CLIToolType; instanceId: string; resolvedBy: string | null }
): SendTicketInit {
  return {
    target: { worktreeId: endpoint.worktreeId, instanceId: resolved.instanceId, cliToolId: resolved.cliToolId },
    resolvedBy: resolved.resolvedBy,
    kind: 'resolved',
    names: sendTargetNames(resolved.cliToolId, endpoint.worktreeId, resolved.instanceId),
    confirm: (): FenceRefusalReason | null => {
      if (!getWorktreeById(db, endpoint.worktreeId)) return 'worktree-gone';
      const now = tryResolveRelayDeliveryTarget(db, endpoint);
      if (now === null) return 'target-gone';
      if (now.session.instanceId !== resolved.instanceId || now.session.cliToolId !== resolved.cliToolId) {
        return 'tool-changed';
      }
      if (resolved.resolvedBy === 'roster' && now.resolvedBy !== 'roster') return 'target-gone';
      return null;
    },
  };
}

/**
 * A timer's ticket: its own row (still `sending`), its worktree, and no roster
 * row giving its instance another tool. A timer resolves nothing (design v2 §2.3).
 */
export function timerSendTicketInit(
  db: Database.Database,
  timer: { id: string; worktreeId: string; instanceId: string; cliToolId: CLIToolType }
): SendTicketInit {
  return {
    target: { worktreeId: timer.worktreeId, instanceId: timer.instanceId, cliToolId: timer.cliToolId },
    resolvedBy: null,
    kind: 'timer',
    names: sendTargetNames(timer.cliToolId, timer.worktreeId, timer.instanceId),
    confirm: (): FenceRefusalReason | null => {
      if (!getWorktreeById(db, timer.worktreeId)) return 'worktree-gone';
      const row = getTimerById(db, timer.id);
      if (!row || row.status !== 'sending') return 'target-gone';
      const roster = getAgentInstance(db, timer.worktreeId, timer.instanceId);
      if (roster !== null && roster.cliTool !== timer.cliToolId) return 'tool-changed';
      return null;
    },
  };
}
