/**
 * Which waiting agent instance a sidebar click should land on (Issue #4001).
 *
 * A worktree row says "Approve / Reject" when ANY of its instances waits, but
 * opening the worktree used to restore the saved selection — so a waiting
 * Command Code hidden behind "6 more" stayed hidden while Claude was shown.
 * Needs attention and the branch rows now open `/worktrees/<id>?instance=<id>`
 * for the instance that waits, through the existing `?instance=` route
 * (`useWorktreeDetailController`): the phone makes it visible and selects it,
 * the PC focuses the split that shows it or places it in the selected split.
 *
 * The pick is deliberately conservative. Whenever it cannot name one instance
 * it returns null and the plain `/worktrees/<id>` URL is used, i.e. the saved
 * selection is restored exactly as before.
 */

import type { Worktree } from '@/types/models';
import { agentInstancesFromSelectedAgents, type AgentInstance } from '@/lib/cli-tools/types';
import { getClientDefaultSelectedAgents } from '@/config/default-agents';
import { deriveWorktreeWaitingDetail } from '@/types/sidebar';
import { buildSessionRowHref } from '@/lib/sidebar-utils';

/**
 * The roster the worktree screen shows, in its order: explicit
 * `agentInstances`, else one primary per `selectedAgents` (the same source
 * `toBranchItem` reads). Sorted by `order`, ties keeping the array order.
 */
function rosterOf(worktree: Worktree): AgentInstance[] {
  const roster =
    worktree.agentInstances && worktree.agentInstances.length > 0
      ? worktree.agentInstances
      : agentInstancesFromSelectedAgents(worktree.selectedAgents ?? getClientDefaultSelectedAgents());
  return roster
    .map((instance, index) => ({ instance, index }))
    .sort((a, b) => (a.instance.order ?? 0) - (b.instance.order ?? 0) || a.index - b.index)
    .map(({ instance }) => instance);
}

/**
 * Pick the waiting instance to open (Issue #4001).
 *
 * Candidates are the roster's instances that wait right now — an instance
 * outside the roster cannot be selected by `?instance=`, so it never is one.
 * Among them:
 *  1. those whose `waitingKind` is the kind the row stands for (the
 *     worktree-level fold `deriveWorktreeWaitingDetail` gives — the kind behind
 *     the row's dot and label); when none matches, every candidate stays;
 *  2. the one with the oldest `waitingSince`;
 *  3. an equal `waitingSince` goes by roster order; one without it ranks after
 *     those with it.
 *
 * @returns The instance id, or null — nothing waits in the roster, no
 *   per-instance payload, or no remaining candidate carries `waitingSince` —
 *   in which case the caller opens the worktree without `?instance=`.
 */
export function pickWaitingInstanceId(worktree: Worktree): string | null {
  const byInstance = worktree.sessionStatusByInstance;
  if (!byInstance) return null;

  const waiting = rosterOf(worktree).flatMap((instance, index) => {
    const entry = byInstance[instance.id];
    return entry?.isWaitingForResponse ? [{ id: instance.id, index, entry }] : [];
  });
  if (waiting.length === 0) return null;

  const { waitingKind } = deriveWorktreeWaitingDetail(worktree);
  const sameKind = waitingKind ? waiting.filter((c) => c.entry.waitingKind === waitingKind) : [];
  const pool = sameKind.length > 0 ? sameKind : waiting;

  const dated = pool.flatMap((c) => {
    const since = c.entry.waitingSince;
    return typeof since === 'number' && Number.isFinite(since) ? [{ ...c, since }] : [];
  });
  if (dated.length === 0) return null;

  dated.sort((a, b) => a.since - b.since || a.index - b.index);
  return dated[0].id;
}

/**
 * The URL a sidebar click opens (Issue #4001): with `?instance=` for the
 * {@link pickWaitingInstanceId} pick, else the bare worktree URL.
 */
export function buildWorktreeOpenHref(worktree: Worktree): string {
  const instanceId = pickWaitingInstanceId(worktree);
  return instanceId === null
    ? `/worktrees/${worktree.id}`
    : buildSessionRowHref({ worktreeId: worktree.id, instanceId });
}
