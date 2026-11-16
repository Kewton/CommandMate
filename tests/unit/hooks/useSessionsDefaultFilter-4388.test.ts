/**
 * useSessionsDefaultFilter (Issue #4388): the invariants of applying and saving the
 * /sessions default condition. Replies are held back (deferred) so their order is
 * chosen by the test.
 *
 * Positive control: every case is red before #4388 (the hook did not exist; the page
 * never read the default), and useSessionsDefaultFilter-4388-mutant.test.ts shows each
 * guard of I1–I3 is what keeps its case green. Negative control: with nothing saved or a failed read the
 * page's condition is left alone (I4), which is how the page behaved before.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { SessionsFilterCondition } from '@/types/sessions-default-filter';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const getCalls: Array<Deferred<unknown>> = [];
const putCalls: Array<{ body: SessionsFilterCondition; d: Deferred<unknown> }> = [];

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    sessionsApi: {
      ...actual.sessionsApi,
      getDefaultFilter: vi.fn(() => {
        const d = deferred<unknown>();
        getCalls.push(d);
        return d.promise;
      }),
      putDefaultFilter: vi.fn((body: SessionsFilterCondition) => {
        const d = deferred<unknown>();
        putCalls.push({ body, d });
        return d.promise;
      }),
    },
  };
});

vi.mock('@/lib/sessions-default-filter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sessions-default-filter')>();
  return { ...actual, differsFromDefault: vi.fn(actual.differsFromDefault) };
});

import { ApiError } from '@/lib/api-client';
import { differsFromDefault } from '@/lib/sessions-default-filter';
import {
  useSessionsDefaultFilter,
  type SessionsRolesReadiness,
} from '@/hooks/useSessionsDefaultFilter';

const EMPTY: SessionsFilterCondition = { branchPattern: '', roleIds: [], includeNoRole: false, includeAmbiguous: false };
const cond = (over: Partial<SessionsFilterCondition>): SessionsFilterCondition => ({ ...EMPTY, ...over });
const stored = (filter: SessionsFilterCondition) => ({ success: true, filter, configured: true });

interface Props {
  rolesReadiness: SessionsRolesReadiness;
  existingRoleIds: readonly string[] | null;
}

function setup(initial: Props = { rolesReadiness: 'ready', existingRoleIds: ['review', 'impl'] }) {
  const applied: SessionsFilterCondition[] = [];
  const hook = renderHook(
    (props: Props) => {
      const [current, setCurrent] = useState<SessionsFilterCondition>(EMPTY);
      const df = useSessionsDefaultFilter({
        current,
        existingRoleIds: props.existingRoleIds,
        rolesReadiness: props.rolesReadiness,
        apply: (c) => {
          applied.push(c);
          setCurrent(c);
        },
      });
      const userSets = (c: SessionsFilterCondition) => {
        df.noteUserChange();
        setCurrent(c);
      };
      return { current, df, userSets };
    },
    { initialProps: initial }
  );
  return { ...hook, applied };
}

beforeEach(() => {
  getCalls.length = 0;
  putCalls.length = 0;
});
afterEach(() => {
  cleanup();
});

describe('[#4388] useSessionsDefaultFilter', () => {
  it('applies the saved default when the page opens', async () => {
    const { result } = setup();
    await act(async () => getCalls[0].resolve(stored(cond({ branchPattern: '^feature/', roleIds: ['review'] }))));
    expect(result.current.current).toEqual(cond({ branchPattern: '^feature/', roleIds: ['review'] }));
    expect(result.current.df.differs).toBe(false);
    expect(result.current.df.droppedRoleIds).toEqual([]);
  });

  it('a deleted role is dropped and reported; the rest of the condition stays (not widened to everything)', async () => {
    const { result } = setup({ rolesReadiness: 'ready', existingRoleIds: ['impl'] });
    await act(async () =>
      getCalls[0].resolve(stored(cond({ branchPattern: 'x', roleIds: ['gone', 'impl'], includeNoRole: true })))
    );
    expect(result.current.current).toEqual(cond({ branchPattern: 'x', roleIds: ['impl'], includeNoRole: true }));
    expect(result.current.df.droppedRoleIds).toEqual(['gone']);
    // Applied default minus the deleted role IS the default now: no mark.
    expect(result.current.df.differs).toBe(false);
  });

  it('every role deleted: roleIds becomes [] and the notice is still raised', async () => {
    const { result } = setup({ rolesReadiness: 'ready', existingRoleIds: [] });
    await act(async () => getCalls[0].resolve(stored(cond({ roleIds: ['gone'] }))));
    expect(result.current.current.roleIds).toEqual([]);
    expect(result.current.df.droppedRoleIds).toEqual(['gone']);
  });

  describe('I1: a user change before the default arrives is not overwritten', () => {
    it('reverse order: user changes, then the default arrives late', async () => {
      const { result, applied } = setup();
      act(() => result.current.userSets(cond({ branchPattern: 'mine' })));
      await act(async () => getCalls[0].resolve(stored(cond({ branchPattern: 'default' }))));
      expect(result.current.current.branchPattern).toBe('mine');
      expect(applied).toEqual([]);
      // The default is still known: the mark and "back to default" work.
      expect(result.current.df.hasDefault).toBe(true);
      expect(result.current.df.differs).toBe(true);
    });

    it('control: in order (default first, then the user) the user change wins as well', async () => {
      const { result } = setup();
      await act(async () => getCalls[0].resolve(stored(cond({ branchPattern: 'default' }))));
      act(() => result.current.userSets(cond({ branchPattern: 'mine' })));
      expect(result.current.current.branchPattern).toBe('mine');
    });

    it('user changes while the role list is still loading: the late apply is skipped', async () => {
      const { result, rerender, applied } = setup({ rolesReadiness: 'loading', existingRoleIds: null });
      await act(async () => getCalls[0].resolve(stored(cond({ branchPattern: 'default' }))));
      act(() => result.current.userSets(cond({ branchPattern: 'mine' })));
      rerender({ rolesReadiness: 'ready', existingRoleIds: ['review'] });
      expect(result.current.current.branchPattern).toBe('mine');
      expect(applied).toEqual([]);
    });
  });

  describe('I2: applied once, after the role list settles; unreadable roles are not "deleted"', () => {
    it('waits for the role list, then applies exactly once', async () => {
      const { result, rerender, applied } = setup({ rolesReadiness: 'loading', existingRoleIds: null });
      await act(async () => getCalls[0].resolve(stored(cond({ roleIds: ['review'] }))));
      expect(applied).toEqual([]);
      rerender({ rolesReadiness: 'ready', existingRoleIds: ['review'] });
      expect(applied).toHaveLength(1);
      // Later role reloads do not apply again.
      rerender({ rolesReadiness: 'ready', existingRoleIds: ['review', 'impl'] });
      rerender({ rolesReadiness: 'ready', existingRoleIds: [] });
      expect(applied).toHaveLength(1);
      expect(result.current.current.roleIds).toEqual(['review']);
    });

    it('roles unavailable: stored roles are kept and nothing is reported as deleted', async () => {
      const { result } = setup({ rolesReadiness: 'unavailable', existingRoleIds: null });
      await act(async () => getCalls[0].resolve(stored(cond({ roleIds: ['review', 'gone'] }))));
      expect(result.current.current.roleIds).toEqual(['review', 'gone']);
      expect(result.current.df.droppedRoleIds).toEqual([]);
      expect(result.current.df.differs).toBe(false);
    });

    it('roles unavailable even though a (stale) list is passed: still not judged', async () => {
      const { result } = setup({ rolesReadiness: 'unavailable', existingRoleIds: [] });
      await act(async () => getCalls[0].resolve(stored(cond({ roleIds: ['review'] }))));
      expect(result.current.current.roleIds).toEqual(['review']);
      expect(result.current.df.droppedRoleIds).toEqual([]);
    });
  });

  describe('I3: saving', () => {
    it('a 400 shows the reason and changes neither the condition nor the default', async () => {
      const { result } = setup();
      await act(async () => getCalls[0].resolve(stored(cond({ branchPattern: 'default' }))));
      act(() => result.current.userSets(cond({ branchPattern: '(' })));
      act(() => void result.current.df.saveAsDefault());
      expect(putCalls[0].body).toEqual(cond({ branchPattern: '(' }));
      await act(async () =>
        putCalls[0].d.reject(new ApiError('"branchPattern" is not a valid regular expression', 400))
      );
      expect(result.current.df.saveError).toEqual({
        kind: 'invalid',
        detail: '"branchPattern" is not a valid regular expression',
      });
      expect(result.current.current.branchPattern).toBe('(');
      expect(result.current.df.defaults).toEqual(cond({ branchPattern: 'default' }));
      expect(result.current.df.saved).toBe(false);
      expect(result.current.df.saving).toBe(false);
    });

    it('a network failure is a generic error and changes nothing', async () => {
      const { result } = setup();
      await act(async () => getCalls[0].resolve(stored(cond({ branchPattern: 'default' }))));
      act(() => result.current.userSets(cond({ branchPattern: 'next' })));
      act(() => void result.current.df.saveAsDefault());
      await act(async () => putCalls[0].d.reject(new ApiError('Failed to fetch', 0)));
      expect(result.current.df.saveError).toEqual({ kind: 'failed' });
      expect(result.current.current.branchPattern).toBe('next');
      expect(result.current.df.defaults?.branchPattern).toBe('default');
      expect(result.current.df.differs).toBe(true);
    });

    it('success makes the saved condition the default (no mark)', async () => {
      const { result } = setup();
      await act(async () => getCalls[0].resolve({ success: true, filter: EMPTY, configured: false }));
      act(() => result.current.userSets(cond({ branchPattern: 'next' })));
      expect(result.current.df.differs).toBe(true);
      act(() => void result.current.df.saveAsDefault());
      await act(async () => putCalls[0].d.resolve(stored(cond({ branchPattern: 'next' }))));
      expect(result.current.df.saved).toBe(true);
      expect(result.current.df.defaults).toEqual(cond({ branchPattern: 'next' }));
      expect(result.current.df.differs).toBe(false);
    });

    it('overlapping saves: only the latest request is adopted (older success arriving last is ignored)', async () => {
      const { result } = setup();
      await act(async () => getCalls[0].resolve({ success: true, filter: EMPTY, configured: false }));
      act(() => result.current.userSets(cond({ branchPattern: 'first' })));
      act(() => void result.current.df.saveAsDefault());
      act(() => result.current.userSets(cond({ branchPattern: 'second' })));
      act(() => void result.current.df.saveAsDefault());
      await act(async () => putCalls[1].d.resolve(stored(cond({ branchPattern: 'second' }))));
      await act(async () => putCalls[0].d.resolve(stored(cond({ branchPattern: 'first' }))));
      expect(result.current.df.defaults?.branchPattern).toBe('second');
      expect(result.current.df.saved).toBe(true);
    });

    it('overlapping saves: an older failure arriving last does not show an error', async () => {
      const { result } = setup();
      await act(async () => getCalls[0].resolve({ success: true, filter: EMPTY, configured: false }));
      act(() => result.current.userSets(cond({ branchPattern: 'first' })));
      act(() => void result.current.df.saveAsDefault());
      act(() => result.current.userSets(cond({ branchPattern: 'second' })));
      act(() => void result.current.df.saveAsDefault());
      await act(async () => putCalls[1].d.resolve(stored(cond({ branchPattern: 'second' }))));
      await act(async () => putCalls[0].d.reject(new ApiError('boom', 400)));
      expect(result.current.df.saveError).toBeNull();
      expect(result.current.df.defaults?.branchPattern).toBe('second');
    });

    it('a save before the initial read returns: the late read neither replaces the default nor the condition', async () => {
      const { result, applied } = setup();
      act(() => void result.current.df.saveAsDefault());
      await act(async () => putCalls[0].d.resolve(stored(EMPTY)));
      await act(async () => getCalls[0].resolve(stored(cond({ branchPattern: 'old' }))));
      expect(applied).toEqual([]);
      expect(result.current.df.defaults).toEqual(EMPTY);
      expect(result.current.current).toEqual(EMPTY);
    });
  });

  describe('I4: nothing saved / read failed leaves the page as it is', () => {
    it('nothing saved: no apply, no mark, nothing to go back to', async () => {
      const { result, applied } = setup();
      await act(async () => getCalls[0].resolve({ success: true, filter: EMPTY, configured: false }));
      expect(applied).toEqual([]);
      expect(result.current.current).toEqual(EMPTY);
      expect(result.current.df.hasDefault).toBe(false);
      expect(result.current.df.differs).toBe(false);
      act(() => result.current.df.resetToDefault());
      expect(applied).toEqual([]);
    });

    it('the read failed: same as nothing saved', async () => {
      const { result, applied } = setup();
      await act(async () => getCalls[0].reject(new ApiError('Internal server error', 500)));
      expect(applied).toEqual([]);
      expect(result.current.current).toEqual(EMPTY);
      expect(result.current.df.hasDefault).toBe(false);
      expect(result.current.df.differs).toBe(false);
    });
  });

  it('I5: the mark is exactly differsFromDefault(current, default)', async () => {
    const spy = vi.mocked(differsFromDefault);
    const { result } = setup();
    await act(async () => getCalls[0].resolve(stored(cond({ roleIds: ['review', 'impl'] }))));
    // Role order alone is not a difference (the library's rule, not re-made here).
    act(() => result.current.userSets(cond({ roleIds: ['impl', 'review'] })));
    expect(result.current.df.differs).toBe(false);
    // Whatever it answers is the mark, even for an identical condition.
    const original = spy.getMockImplementation();
    spy.mockImplementation(() => true);
    try {
      act(() => result.current.userSets(cond({ roleIds: ['review', 'impl'] })));
      expect(result.current.df.differs).toBe(true);
      expect(spy).toHaveBeenLastCalledWith(cond({ roleIds: ['review', 'impl'] }), cond({ roleIds: ['review', 'impl'] }));
    } finally {
      if (original) spy.mockImplementation(original);
    }
  });

  it('back to default re-applies it (deleted roles dropped again) after a user change', async () => {
    const { result } = setup({ rolesReadiness: 'ready', existingRoleIds: ['impl'] });
    await act(async () => getCalls[0].resolve(stored(cond({ branchPattern: 'd', roleIds: ['impl', 'gone'] }))));
    act(() => result.current.userSets(cond({ branchPattern: 'other' })));
    expect(result.current.df.differs).toBe(true);
    act(() => result.current.df.resetToDefault());
    expect(result.current.current).toEqual(cond({ branchPattern: 'd', roleIds: ['impl'] }));
    expect(result.current.df.droppedRoleIds).toEqual(['gone']);
    expect(result.current.df.differs).toBe(false);
  });

  it('a later failed role re-read does not make the applied default look different', async () => {
    const { result, rerender } = setup({ rolesReadiness: 'ready', existingRoleIds: ['impl'] });
    await act(async () => getCalls[0].resolve(stored(cond({ roleIds: ['impl', 'gone'] }))));
    rerender({ rolesReadiness: 'unavailable', existingRoleIds: null });
    await waitFor(() => expect(result.current.df.differs).toBe(false));
  });
});

