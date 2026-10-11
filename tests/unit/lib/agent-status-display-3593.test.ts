/**
 * Issue #3593: the header's session field — which session is current, and the
 * order and amber count of the "N others" list.
 */

import { describe, it, expect } from 'vitest';
import {
  countWaitingInstances,
  orderOtherInstances,
  resolveCurrentInstanceId,
  type HeaderInstanceItem,
} from '@/lib/agent-status-display';
import type { BranchStatus } from '@/types/sidebar';

function mk(id: string, status: BranchStatus): HeaderInstanceItem<{ id: string }> {
  return { item: { id }, status, isActive: false };
}

describe('resolveCurrentInstanceId', () => {
  const roster = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('is the active instance when the roster holds it', () => {
    expect(resolveCurrentInstanceId(roster, 'b')).toBe('b');
  });

  it('falls back to the first instance for an unknown or missing id', () => {
    expect(resolveCurrentInstanceId(roster, 'zzz')).toBe('a');
    expect(resolveCurrentInstanceId(roster, undefined)).toBe('a');
  });

  it('is null for an empty roster', () => {
    expect(resolveCurrentInstanceId([], 'a')).toBeNull();
  });
});

describe('orderOtherInstances', () => {
  it('drops the current one and puts the waiting ones first, roster order otherwise', () => {
    const items = [
      mk('a', 'running'),
      mk('b', 'idle'),
      mk('c', 'waiting'),
      mk('d', 'ready'),
      mk('e', 'waiting'),
    ];
    const ordered = orderOtherInstances(items, (it) => it.id === 'b');
    expect(ordered.map((it) => it.item.id)).toEqual(['c', 'e', 'a', 'd']);
  });

  it('negative control: nothing waiting keeps the roster order', () => {
    const items = [mk('a', 'running'), mk('b', 'idle'), mk('c', 'ready')];
    expect(orderOtherInstances(items, (it) => it.id === 'a').map((it) => it.item.id)).toEqual(['b', 'c']);
  });
});

describe('countWaitingInstances', () => {
  it('counts only the sessions waiting for an answer', () => {
    expect(countWaitingInstances([mk('a', 'waiting'), mk('b', 'running'), mk('c', 'waiting')])).toBe(2);
    expect(countWaitingInstances([mk('a', 'running'), mk('b', 'idle')])).toBe(0);
  });
});
