/**
 * The fixed order of the brief (Issue #4223, design §2.3・§2.4).
 *
 * A total order: `(rank, source S1〜S9, time newest first, id)`. The time a row was
 * read is never a key, so the same state gives the same order however the sources
 * answered.
 *
 * @module lib/brief/rank
 */

import type { BriefItem } from './model';

export function compareBriefItems(a: BriefItem, b: BriefItem): number {
  if (a.entry.rank !== b.entry.rank) return a.entry.rank - b.entry.rank;
  if (a.sourceIndex !== b.sourceIndex) return a.sourceIndex - b.sourceIndex;
  const at = a.sortAt ?? Number.NEGATIVE_INFINITY;
  const bt = b.sortAt ?? Number.NEGATIVE_INFINITY;
  if (at !== bt) return bt > at ? 1 : -1;
  if (a.entry.id !== b.entry.id) return a.entry.id < b.entry.id ? -1 : 1;
  return 0;
}

export function rankBriefItems(items: readonly BriefItem[]): BriefItem[] {
  return [...items].sort(compareBriefItems);
}
