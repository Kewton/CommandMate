/**
 * Tests for agent-status-display (Issue #1078).
 */

import { describe, it, expect } from 'vitest';
import {
  isWorkingStatus,
  isLabeledInstance,
  classifyHeaderInstances,
  type HeaderInstanceItem,
} from '@/lib/agent-status-display';
import type { BranchStatus } from '@/types/sidebar';

function mk(id: string, status: BranchStatus, isActive = false): HeaderInstanceItem<string> {
  return { item: id, status, isActive };
}

describe('isWorkingStatus', () => {
  it('treats running / generating / waiting as working', () => {
    expect(isWorkingStatus('running')).toBe(true);
    expect(isWorkingStatus('generating')).toBe(true);
    expect(isWorkingStatus('waiting')).toBe(true);
  });

  it('treats idle / ready as not working', () => {
    expect(isWorkingStatus('idle')).toBe(false);
    expect(isWorkingStatus('ready')).toBe(false);
  });
});

describe('isLabeledInstance', () => {
  it('labels the active instance even when idle', () => {
    expect(isLabeledInstance(mk('a', 'idle', true))).toBe(true);
  });

  it('labels working instances', () => {
    expect(isLabeledInstance(mk('a', 'running'))).toBe(true);
    expect(isLabeledInstance(mk('a', 'waiting'))).toBe(true);
  });

  it('collapses idle / ready non-active instances', () => {
    expect(isLabeledInstance(mk('a', 'idle'))).toBe(false);
    expect(isLabeledInstance(mk('a', 'ready'))).toBe(false);
  });
});

describe('classifyHeaderInstances', () => {
  const MAX = 4;

  it('running 1 + idle 5: the running one is a pill, all idle are dots, no overflow', () => {
    const items = [
      mk('claude', 'running'),
      mk('codex', 'idle'),
      mk('gemini', 'idle'),
      mk('cursor', 'idle'),
      mk('aider', 'idle'),
      mk('qwen', 'idle'),
    ];
    const out = classifyHeaderInstances(items, MAX);
    expect(out.find((o) => o.item === 'claude')?.slot).toBe('pill');
    expect(out.filter((o) => o.slot === 'dot').map((o) => o.item)).toEqual([
      'codex',
      'gemini',
      'cursor',
      'aider',
      'qwen',
    ]);
    expect(out.some((o) => o.slot === 'overflow')).toBe(false);
  });

  it('all idle: every instance is an icon-only dot, no pills, no overflow', () => {
    const items = [mk('a', 'idle'), mk('b', 'idle'), mk('c', 'idle')];
    const out = classifyHeaderInstances(items, MAX);
    expect(out.every((o) => o.slot === 'dot')).toBe(true);
  });

  it('6 all working: keeps maxPills pills and overflows the rest', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => mk(id, 'running'));
    const out = classifyHeaderInstances(items, MAX);
    expect(out.filter((o) => o.slot === 'pill')).toHaveLength(MAX);
    expect(out.filter((o) => o.slot === 'overflow')).toHaveLength(2);
    expect(out.some((o) => o.slot === 'dot')).toBe(false);
  });

  it('keeps the active instance visible even when it would otherwise overflow', () => {
    // 5 working + an active (idle) instance last; maxPills=2. Active must win a pill slot.
    const items = [
      mk('a', 'running'),
      mk('b', 'running'),
      mk('c', 'running'),
      mk('d', 'running'),
      mk('active', 'idle', true),
    ];
    const out = classifyHeaderInstances(items, 2);
    const active = out.find((o) => o.item === 'active');
    expect(active?.slot).toBe('pill');
    expect(out.filter((o) => o.slot === 'pill')).toHaveLength(2);
    expect(out.filter((o) => o.slot === 'overflow')).toHaveLength(3);
  });

  it('preserves roster order for visible pills and dots', () => {
    const items = [mk('a', 'running'), mk('b', 'idle'), mk('c', 'running')];
    const out = classifyHeaderInstances(items, MAX);
    expect(out.map((o) => o.item)).toEqual(['a', 'b', 'c']);
  });

  it('does not overflow when total labelled pills are within maxPills', () => {
    const items = [mk('a', 'running'), mk('b', 'waiting')];
    const out = classifyHeaderInstances(items, MAX);
    expect(out.some((o) => o.slot === 'overflow')).toBe(false);
  });
});
