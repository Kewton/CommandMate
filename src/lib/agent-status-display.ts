/**
 * Agent-instance status display helpers (Issue #1078).
 *
 * Pure logic for the worktree desktop header's per-agent status row. The row
 * unifies the status visual on `<StatusDot>` and collapses idle noise:
 * - active or actively-working instances render as a labelled pill,
 * - idle / ready instances collapse to an icon-only dot (label via tooltip),
 * - when there are more labelled pills than fit, the excess collapse into a
 *   "+N" overflow menu so a working session never gets buried.
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
 * An instance renders as a labelled pill when it is the active tab or is
 * actively working; otherwise it collapses to an icon-only dot.
 */
export function isLabeledInstance<T>(it: HeaderInstanceItem<T>): boolean {
  return it.isActive || isWorkingStatus(it.status);
}

/** Where a classified instance is rendered in the header row. */
export type HeaderInstanceSlot = 'pill' | 'dot' | 'overflow';

export interface ClassifiedHeaderInstance<T> extends HeaderInstanceItem<T> {
  slot: HeaderInstanceSlot;
}

/**
 * Classify each instance into pill / dot / overflow, preserving the original
 * roster order for the visible items.
 *
 * - `dot`: idle / ready instances — always visible (dots are narrow).
 * - `pill`: labelled instances (active or working). At most `maxPills` stay
 *   visible; the active tab is kept preferentially, then roster order.
 * - `overflow`: labelled instances beyond `maxPills` — surfaced via the "+N" menu.
 *
 * @param items     instances in roster order
 * @param maxPills  max labelled pills to keep inline (<=0 collapses all pills)
 */
export function classifyHeaderInstances<T>(
  items: HeaderInstanceItem<T>[],
  maxPills: number,
): ClassifiedHeaderInstance<T>[] {
  const labeledIndices = items
    .map((it, index) => ({ it, index }))
    .filter(({ it }) => isLabeledInstance(it));

  const pillKeep = new Set<number>();
  if (maxPills > 0 && labeledIndices.length > 0) {
    const ranked = [...labeledIndices].sort(
      (a, b) => Number(b.it.isActive) - Number(a.it.isActive) || a.index - b.index,
    );
    ranked.slice(0, maxPills).forEach(({ index }) => pillKeep.add(index));
  }

  return items.map((it, index) => {
    if (!isLabeledInstance(it)) {
      return { ...it, slot: 'dot' as const };
    }
    return { ...it, slot: pillKeep.has(index) ? ('pill' as const) : ('overflow' as const) };
  });
}
