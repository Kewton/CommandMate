import { describe, it, expect } from 'vitest';
import { evaluateSessionsFilter, SESSIONS_BRANCH_PATTERN_MAX_LENGTH } from '@/lib/sessions-filter';

const wt = (id: string, name: string, current?: string, ids: string[] = ['claude']) =>
  ({
    id,
    name,
    gitStatus: current ? { currentBranch: current } : undefined,
    selectedAgents: ids,
  }) as never;

const list = [
  wt('a', 'feature/42-x', 'feature/42-x', ['claude', 'codex']),
  wt('b', 'main', 'main'),
  wt('c', 'wt-renamed', 'feature/99-y'),
];

describe('[#4386] evaluateSessionsFilter', () => {
  it('matches name and keeps roster order', () => {
    const r = evaluateSessionsFilter(list, { branchPattern: '^feature/' });
    expect(r.verdicts.get('a')).toEqual({ show: true, instanceIds: ['claude', 'codex'] });
    expect(r.verdicts.get('b')?.show).toBe(false);
    expect(r.activeCount).toBe(1);
    expect(r.error).toBeNull();
  });
  it('matches on currentBranch only', () => {
    expect(evaluateSessionsFilter(list, { branchPattern: '^feature/' }).verdicts.get('c')?.show).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(evaluateSessionsFilter(list, { branchPattern: '^FEATURE/' }).verdicts.get('a')?.show).toBe(true);
  });
  it('invalid regex keeps all and reports error', () => {
    const r = evaluateSessionsFilter(list, { branchPattern: '(' });
    expect(r.error).toBe('invalid_regex');
    expect(r.activeCount).toBe(0);
    expect([...r.verdicts.values()].every((v) => v.show)).toBe(true);
  });
  it('too long pattern is rejected', () => {
    const r = evaluateSessionsFilter(list, { branchPattern: 'a'.repeat(SESSIONS_BRANCH_PATTERN_MAX_LENGTH + 1) });
    expect(r.error).toBe('too_long');
    expect(r.activeCount).toBe(0);
  });
  it('empty / blank shows all without error', () => {
    for (const p of ['', '   ', undefined]) {
      const r = evaluateSessionsFilter(list, { branchPattern: p });
      expect(r.error).toBeNull();
      expect(r.activeCount).toBe(0);
      expect([...r.verdicts.values()].every((v) => v.show)).toBe(true);
    }
  });
  it('treats nested quantifiers (a+)+$ as invalid and keeps all', () => {
    const r = evaluateSessionsFilter(list, { branchPattern: '(a+)+$' });
    expect(r.error).toBe('unsafe_regex');
    expect(r.activeCount).toBe(0);
    expect([...r.verdicts.values()].every((v) => v.show)).toBe(true);
  });
  it('uses the injected roster resolver', () => {
    const r = evaluateSessionsFilter(list, { branchPattern: 'main' }, () => ['x', 'y']);
    expect(r.verdicts.get('b')?.instanceIds).toEqual(['x', 'y']);
    expect(r.verdicts.get('a')?.instanceIds).toEqual([]);
  });
});
