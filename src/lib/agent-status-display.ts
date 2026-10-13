/**
 * Agent-instance status display helpers (Issue #1078).
 *
 * Pure logic for the worktree desktop header's agent-instance row. Before
 * #3593 the row drew labelled pills, idle dots and a "+N" overflow menu.
 *
 * Issue #3593: the header no longer draws pills and dots. It shows the current
 * session and lists the others ({@link resolveCurrentInstanceId},
 * {@link orderOtherInstances}, {@link countWaitingInstances}). The pill / dot /
 * overflow classification (classifyHeaderInstances) was removed in #3620.
 */

import type { BranchStatus } from '@/types/sidebar';

/** Statuses that represent an instance actively doing (or awaiting) work. */
export function isWorkingStatus(status: BranchStatus): boolean {
  return status === 'running' || status === 'generating' || status === 'waiting';
}

/** One instance plus the display facts the layout needs. */
export interface HeaderInstanceItem<T> {
  item: T;
  status: BranchStatus;
  isActive: boolean;
}

/**
 * Issue #3593: the header's session field is [current session][N others ▾][+].
 *
 * The current session is the one the selected split shows — the worktree
 * screen keeps `activeInstanceId` equal to it on PC. An id the roster does not
 * hold (not reported yet, or a caller that passes none) falls back to the
 * first instance, so the field always names one session when there is any.
 *
 * @returns the current instance's id, or null for an empty roster
 */
export function resolveCurrentInstanceId<T extends { id: string }>(
  instances: readonly T[],
  activeInstanceId: string | undefined,
): string | null {
  if (instances.length === 0) return null;
  if (activeInstanceId && instances.some((inst) => inst.id === activeInstanceId)) {
    return activeInstanceId;
  }
  return instances[0].id;
}

/**
 * Issue #3593: the "N others" list — every instance but the current one, the
 * ones waiting for an answer (`waiting`, the amber prompt) first, then roster
 * order. Stable, so two waiting instances keep their roster order.
 */
export function orderOtherInstances<T>(
  items: readonly HeaderInstanceItem<T>[],
  isCurrent: (item: T) => boolean,
): HeaderInstanceItem<T>[] {
  return items
    .map((it, index) => ({ it, index }))
    .filter(({ it }) => !isCurrent(it.item))
    .sort(
      (a, b) =>
        Number(b.it.status === 'waiting') - Number(a.it.status === 'waiting') || a.index - b.index,
    )
    .map(({ it }) => it);
}

/** Issue #3593: how many of `items` wait for an answer (the trigger's amber count). */
export function countWaitingInstances(items: readonly { status: BranchStatus }[]): number {
  return items.filter((it) => it.status === 'waiting').length;
}
