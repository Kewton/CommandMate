/**
 * When Auto-Yes state is released, decided in one table (Issue #3184).
 *
 * Auto-Yes lives per worktree x instance with its own expiry, independent of
 * the session it answers for. Every path that ends that relationship — a killed
 * session (#3182), a removed instance, a deleted worktree, the orphan sweep,
 * a poller giving up on errors, server shutdown — used to decide for itself
 * what to do with the state, and one of them (instance removal) decided
 * nothing at all, leaving a grant that silently approved the next session to
 * claim the id. {@link AUTO_YES_LIFECYCLE} is the decision; each path calls
 * {@link releaseAutoYes} (or its two halves) with the event it is.
 *
 * ## disable vs delete
 *
 * - `disable` keeps the entry with `enabled: false` (and the `stopReason`), for
 *   an instance that still exists — the UI can say why Auto-Yes went off.
 * - `delete` drops the entry, for an instance or worktree that no longer
 *   exists. Kept, it would never be swept: the orphan sweep works per worktree.
 *
 * ## Not in the table
 *
 * Manual disable, expiry and the stop pattern are Auto-Yes's own conditions,
 * not lifecycle events, and stay in `auto-yes-state` / the auto-yes route. A
 * worktree ID rename MOVES the state (`worktree-session-reconcile`) rather than
 * releasing it. The "starting" record (#3179) is cleared by kill-session beside
 * this call, not by it: it has its own token rules (#3195).
 *
 * ## Imports go through the auto-yes-manager barrel
 *
 * The cleanup modules' tests mock `@/lib/polling/auto-yes-manager`, and so must
 * this module's imports resolve to it. That barrel re-exports the poller, so
 * `auto-yes-poller` must NOT import this module (it would be a cycle); its
 * consecutive-errors path applies the same row directly, and
 * `tests/unit/lib/auto-yes-lifecycle-3184.test.ts` holds the two equal.
 *
 * @module lib/auto-yes-lifecycle
 */

import type { CLIToolType } from './cli-tools/types';
import type { AutoYesStopReason } from '@/config/auto-yes-config';
import {
  buildCompositeKey,
  deleteAutoYesState,
  deleteAutoYesStateByWorktree,
  disableAutoYes,
  extractCliToolId,
  extractInstanceId,
  extractWorktreeId,
  getAutoYesStateCompositeKeys,
  getCompositeKeysByWorktree,
  stopAllAutoYesPolling,
  stopAutoYesPolling,
  stopAutoYesPollingByWorktree,
} from './polling/auto-yes-manager';

/** The events that end an Auto-Yes grant. */
export type AutoYesLifecycleEvent =
  | 'session-killed'
  | 'instance-removed'
  | 'worktree-deleted'
  | 'orphan-swept'
  | 'consecutive-errors'
  | 'server-shutdown';

/** What one event does to the state and the poller. */
export interface AutoYesLifecycleRule {
  /** `none`: the state is left alone (server shutdown: the process takes it). */
  state: 'disable' | 'delete' | 'none';
  /** Recorded with `disable`. Absent = the same as a manual disable. */
  stopReason?: AutoYesStopReason;
  /** Every event stops the poller; spelled out so the table reads whole. */
  poller: 'stop';
}

/**
 * The table (design §8.2).
 *
 * `session-killed` is #3182's decision as #3188 shipped it: disable with no
 * reason (no new reason was added), for the instance only. `server-shutdown`
 * deliberately does not persist anything: the state lives in memory, and a
 * restarted server starting with every grant off is the safe side.
 */
export const AUTO_YES_LIFECYCLE: Readonly<Record<AutoYesLifecycleEvent, AutoYesLifecycleRule>> = {
  'session-killed': { state: 'disable', poller: 'stop' },
  'instance-removed': { state: 'delete', poller: 'stop' },
  'worktree-deleted': { state: 'delete', poller: 'stop' },
  'orphan-swept': { state: 'delete', poller: 'stop' },
  'consecutive-errors': { state: 'disable', stopReason: 'consecutive_errors', poller: 'stop' },
  'server-shutdown': { state: 'none', poller: 'stop' },
};

/** Whose Auto-Yes an event releases. */
export type AutoYesLifecycleTarget =
  | { scope: 'instance'; worktreeId: string; cliToolId: CLIToolType; instanceId?: string }
  | { scope: 'worktree'; worktreeId: string }
  | { scope: 'key'; compositeKey: string }
  | { scope: 'all' };

/**
 * Stop the pollers the event's target names (the poller half of the table).
 * Separate from {@link applyAutoYesStateRule} so a caller that reports the two
 * failures apart (`session-cleanup`) can keep doing so.
 */
export function stopAutoYesPollersFor(
  event: AutoYesLifecycleEvent,
  target: AutoYesLifecycleTarget,
): void {
  if (AUTO_YES_LIFECYCLE[event].poller !== 'stop') return;
  switch (target.scope) {
    case 'instance':
      stopAutoYesPolling(buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId));
      return;
    case 'worktree':
      stopAutoYesPollingByWorktree(target.worktreeId);
      return;
    case 'key':
      stopAutoYesPolling(target.compositeKey);
      return;
    case 'all':
      stopAllAutoYesPolling();
      return;
  }
}

function disableKey(compositeKey: string, stopReason: AutoYesStopReason | undefined): void {
  const cliToolId = extractCliToolId(compositeKey);
  if (!cliToolId) return;
  disableAutoYes(
    extractWorktreeId(compositeKey),
    cliToolId,
    stopReason,
    extractInstanceId(compositeKey) ?? undefined,
  );
}

/** Apply the event's state rule to its target (the state half of the table). */
export function applyAutoYesStateRule(
  event: AutoYesLifecycleEvent,
  target: AutoYesLifecycleTarget,
): void {
  const rule = AUTO_YES_LIFECYCLE[event];
  if (rule.state === 'none') return;

  switch (target.scope) {
    case 'instance':
      if (rule.state === 'disable') {
        disableAutoYes(target.worktreeId, target.cliToolId, rule.stopReason, target.instanceId);
      } else {
        deleteAutoYesState(buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId));
      }
      return;
    case 'worktree':
      if (rule.state === 'disable') {
        getCompositeKeysByWorktree(target.worktreeId).forEach((key) => disableKey(key, rule.stopReason));
      } else {
        deleteAutoYesStateByWorktree(target.worktreeId);
      }
      return;
    case 'key':
      if (rule.state === 'disable') {
        disableKey(target.compositeKey, rule.stopReason);
      } else {
        deleteAutoYesState(target.compositeKey);
      }
      return;
    case 'all':
      getAutoYesStateCompositeKeys().forEach((key) =>
        rule.state === 'disable' ? disableKey(key, rule.stopReason) : deleteAutoYesState(key),
      );
      return;
  }
}

/**
 * Release Auto-Yes for an event: stop the pollers first, then apply the state
 * rule — the order `session-cleanup` has kept since #404. Both halves are
 * synchronous, so no poll can run between them.
 */
export function releaseAutoYes(event: AutoYesLifecycleEvent, target: AutoYesLifecycleTarget): void {
  stopAutoYesPollersFor(event, target);
  applyAutoYesStateRule(event, target);
}
