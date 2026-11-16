import { describe, it, expect } from 'vitest';
import {
  applySessionsDefaultFilter,
  differsFromDefault,
  parseStoredSessionsFilter,
  validateSessionsFilter,
} from '@/lib/sessions-default-filter';
import type { SessionsFilterCondition } from '@/types/sessions-default-filter';

const base: SessionsFilterCondition = {
  branchPattern: 'feat',
  roleIds: ['a', 'b', 'c'],
  includeNoRole: true,
  includeAmbiguous: false,
};

describe('applySessionsDefaultFilter', () => {
  it('keeps everything and reports no drop when all roles exist', () => {
    const r = applySessionsDefaultFilter(base, ['a', 'b', 'c', 'z']);
    expect(r.condition).toEqual(base);
    expect(r.droppedRoles).toBe(false);
    expect(r.droppedRoleIds).toEqual([]);
  });

  it('removes deleted roles, keeps the rest, and flags it', () => {
    const r = applySessionsDefaultFilter(base, ['a', 'c']);
    expect(r.condition.roleIds).toEqual(['a', 'c']);
    expect(r.droppedRoles).toBe(true);
    expect(r.droppedRoleIds).toEqual(['b']);
    expect(r.condition.branchPattern).toBe('feat');
    expect(r.condition.includeNoRole).toBe(true);
  });

  it('does not throw when every role is deleted; flags it and keeps other fields', () => {
    const r = applySessionsDefaultFilter(base, []);
    expect(r.condition.roleIds).toEqual([]);
    expect(r.droppedRoles).toBe(true);
    expect(r.condition.includeNoRole).toBe(true);
  });

  it('does not mutate the stored condition', () => {
    const copy = structuredClone(base);
    applySessionsDefaultFilter(base, []);
    expect(base).toEqual(copy);
  });

  it('control: a stored condition with no roles never reports a drop', () => {
    expect(applySessionsDefaultFilter({ ...base, roleIds: [] }, []).droppedRoles).toBe(false);
  });
});

describe('differsFromDefault', () => {
  it('is false for the same condition regardless of role order', () => {
    expect(differsFromDefault({ ...base, roleIds: ['c', 'a', 'b'] }, base)).toBe(false);
  });

  it('control: a naive JSON comparison would call a reordered list different', () => {
    const reordered = { ...base, roleIds: ['c', 'a', 'b'] };
    expect(JSON.stringify(reordered) !== JSON.stringify(base)).toBe(true);
    expect(differsFromDefault(reordered, base)).toBe(false);
  });

  it.each([
    ['branchPattern', { branchPattern: 'fix' }],
    ['includeNoRole', { includeNoRole: false }],
    ['includeAmbiguous', { includeAmbiguous: true }],
    ['roleIds (subset)', { roleIds: ['a', 'b'] }],
    ['roleIds (other)', { roleIds: ['a', 'b', 'x'] }],
  ])('is true when %s differs', (_n, patch) => {
    expect(differsFromDefault({ ...base, ...patch }, base)).toBe(true);
  });

  it('compares against the empty condition when no default is saved', () => {
    const empty = { branchPattern: '', roleIds: [], includeNoRole: false, includeAmbiguous: false };
    expect(differsFromDefault(empty, null)).toBe(false);
    expect(differsFromDefault(base, null)).toBe(true);
  });
});

describe('validateSessionsFilter / parseStoredSessionsFilter', () => {
  it('accepts a valid condition', () => {
    expect(validateSessionsFilter(base)).toEqual({ ok: true, value: base });
  });
  it('rejects a bad regex and an over-long pattern', () => {
    expect(validateSessionsFilter({ ...base, branchPattern: '[' }).ok).toBe(false);
    expect(validateSessionsFilter({ ...base, branchPattern: 'x'.repeat(201) }).ok).toBe(false);
  });
  it('reads malformed stored JSON as nothing stored', () => {
    expect(parseStoredSessionsFilter(null)).toBeNull();
    expect(parseStoredSessionsFilter('{oops')).toBeNull();
    expect(parseStoredSessionsFilter('{"branchPattern":1}')).toBeNull();
    expect(parseStoredSessionsFilter(JSON.stringify(base))).toEqual(base);
  });
});
