/**
 * How old an open item with no condition to close it is (Issue #4221, design §8.2).
 * The list, the prompts of #4226 and the screen of #4227 read this one function.
 * Age warns; it never deletes.
 *
 * @module lib/mem/staleness
 */

import type { MemCloseWhen, MemKind, MemState } from '@/types/mem';

const DAY = 24 * 60 * 60 * 1000;

export const MEM_STALE_AFTER_MS: Readonly<Record<MemKind, number>> = {
  now: 1 * DAY,
  next: 7 * DAY,
  waiting: 7 * DAY,
  external: 14 * DAY,
  note: 30 * DAY,
  decision: 14 * DAY,
};

export function memItemStaleness(
  item: { kind: MemKind; state: MemState; closeWhen: MemCloseWhen | null; updatedAt: number },
  now: number = Date.now()
): 'fresh' | 'stale' {
  if (item.state === 'closed' || item.state === 'promoted') return 'fresh';
  const manual =
    item.kind === 'decision' ||
    item.closeWhen === null ||
    item.closeWhen.type === 'manual' ||
    item.closeWhen.type === 'replaced';
  if (!manual) return 'fresh';
  return now - item.updatedAt > MEM_STALE_AFTER_MS[item.kind] ? 'stale' : 'fresh';
}
