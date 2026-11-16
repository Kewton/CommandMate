import { describe, it, expect } from 'vitest';
import { evaluateSessionsFilter, type SessionsRoleSource } from '@/lib/sessions-filter';

const wt = (id: string, name: string, ids: string[]) =>
  ({ id, name, gitStatus: { currentBranch: name }, selectedAgents: ids }) as never;

const list = [
  wt('a', 'feature/1-a', ['claude', 'codex']),
  wt('b', 'feature/2-b', ['claude', 'codex']),
  wt('c', 'main', ['claude']),
  wt('d', 'feature/4-d', ['claude']),
];

const source: SessionsRoleSource = {
  roleByWorktree: {
    a: {
      claude: { kind: 'role', roleId: 'impl', roleName: '実装担当', basis: 'launched' },
      codex: { kind: 'role', roleId: 'review', roleName: 'レビュー担当', basis: 'setting' },
    },
    b: { claude: { kind: 'none' }, codex: { kind: 'ambiguous' } },
    c: { claude: { kind: 'role', roleId: 'review', roleName: 'レビュー担当', basis: 'launched' } },
    // d: not reported on (e.g. created after the roles were read)
  },
};

const shown = (r: ReturnType<typeof evaluateSessionsFilter>) =>
  [...r.verdicts].filter(([, v]) => v.show).map(([id, v]) => `${id}:${v.instanceIds.join(',')}`);

describe('[#4389] evaluateSessionsFilter role condition', () => {
  it('keeps only worktrees with an instance of the chosen role, and only those instances', () => {
    const r = evaluateSessionsFilter(list, { role: { roleIds: ['review'] } }, undefined, source);
    expect(shown(r)).toEqual(['a:codex', 'c:claude']);
    expect(r.roleFiltered).toBe(true);
    expect(r.roleError).toBeNull();
    expect(r.activeCount).toBe(1);
  });

  it('several roles match any of them (roster order kept)', () => {
    const r = evaluateSessionsFilter(list, { role: { roleIds: ['review', 'impl'] } }, undefined, source);
    expect(shown(r)).toEqual(['a:claude,codex', 'c:claude']);
  });

  it('"no role" matches kind none only, not ambiguous', () => {
    const r = evaluateSessionsFilter(list, { role: { includeNoRole: true } }, undefined, source);
    expect(shown(r)).toEqual(['b:claude']);
  });

  it('"cannot tell" matches kind ambiguous only, not none', () => {
    const r = evaluateSessionsFilter(list, { role: { includeAmbiguous: true } }, undefined, source);
    expect(shown(r)).toEqual(['b:codex']);
  });

  it('an instance the server did not report on matches nothing', () => {
    const r = evaluateSessionsFilter(
      list,
      { role: { roleIds: ['impl', 'review'], includeNoRole: true, includeAmbiguous: true } },
      undefined,
      source
    );
    expect(r.verdicts.get('d')).toEqual({ show: false, instanceIds: [] });
  });

  it('no match hides every worktree', () => {
    const r = evaluateSessionsFilter(list, { role: { roleIds: ['nobody'] } }, undefined, source);
    expect(shown(r)).toEqual([]);
    expect(r.roleFiltered).toBe(true);
  });

  it('AND with the branch pattern; both counted', () => {
    const r = evaluateSessionsFilter(
      list,
      { branchPattern: '^feature/', role: { roleIds: ['review'] } },
      undefined,
      source
    );
    expect(shown(r)).toEqual(['a:codex']);
    expect(r.activeCount).toBe(2);
  });

  it('rolesUnavailable: the role condition is dropped and reported, not all or nothing silently', () => {
    const r = evaluateSessionsFilter(
      list,
      { role: { roleIds: ['review'] } },
      undefined,
      { roleByWorktree: {}, rolesUnavailable: true }
    );
    expect(r.roleError).toBe('roles_unavailable');
    expect(r.roleFiltered).toBe(false);
    expect(r.activeCount).toBe(0);
    expect(shown(r)).toEqual(['a:claude,codex', 'b:claude,codex', 'c:claude', 'd:claude']);
  });

  it('roles not read yet counts as unavailable when a role is chosen', () => {
    const r = evaluateSessionsFilter(list, { role: { roleIds: ['review'] } });
    expect(r.roleError).toBe('roles_unavailable');
    expect(r.roleFiltered).toBe(false);
  });

  it('control: nothing selected filters nothing and matches the result without roles', () => {
    const withEmpty = evaluateSessionsFilter(
      list,
      { branchPattern: '^feature/', role: { roleIds: [], includeNoRole: false, includeAmbiguous: false } },
      undefined,
      source
    );
    const without = evaluateSessionsFilter(list, { branchPattern: '^feature/' });
    expect([...withEmpty.verdicts]).toEqual([...without.verdicts]);
    expect(withEmpty.activeCount).toBe(1);
    expect(withEmpty.roleFiltered).toBe(false);
    expect(withEmpty.roleError).toBeNull();
  });
});
