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
 * Re-instruction 3 (I3'' / I6' / I8) — each fact is held in one place:
 * - I3'' guards the order of saves within one tab: the wait (the PUT that is out and
 *   the last click held back) lives in module state, one per destination (the PUT
 *   URL), so leaving /sessions and coming back still waits for the earlier PUT.
 *   Another destination is never held back, and the module state is reset after
 *   every test (the reset is for tests only).
 * - I6' guards the "is the condition empty" judgement: it is the one in
 *   src/lib/sessions-filter.ts (whitespace-only branch pattern = no condition).
 * - I8 guards how the deleted-role notice is derived: from the current condition
 *   (and the saved default while it is what the page shows) against the roles that
 *   exist, every render — never a separate state that a save clears.
 * Out of scope: two tabs saving at once can still overwrite each other in the
 * order the server receives them; telling that apart needs a version on the
 * server (PR1's API), which this PR does not change.
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
  sendSerially,
  resetSessionsDefaultFilterSaveQueueForTests,
  type SessionsRolesReadiness,
} from '@/hooks/useSessionsDefaultFilter';
import fs from 'node:fs';
import path from 'node:path';

const EMPTY: SessionsFilterCondition = { branchPattern: '', roleIds: [], includeNoRole: false, includeAmbiguous: false };
const cond = (over: Partial<SessionsFilterCondition>): SessionsFilterCondition => ({ ...EMPTY, ...over });
const stored = (filter: SessionsFilterCondition) => ({ success: true, filter, configured: true });

interface Props {
  rolesReadiness: SessionsRolesReadiness;
  existingRoleIds: readonly string[] | null;
}

function setup(
  initial: Props = { rolesReadiness: 'ready', existingRoleIds: ['review', 'impl'] },
  reactStrictMode = false
) {
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
    { initialProps: initial, reactStrictMode }
  );
  return { ...hook, applied };
}

beforeEach(() => {
  getCalls.length = 0;
  putCalls.length = 0;
});
afterEach(() => {
  cleanup();
  resetSessionsDefaultFilterSaveQueueForTests();
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

  it('every role deleted (nothing else left): the deleted ids are kept so the list stays narrowed (I6), and the notice is still raised', async () => {
    const { result } = setup({ rolesReadiness: 'ready', existingRoleIds: [] });
    await act(async () => getCalls[0].resolve(stored(cond({ roleIds: ['gone'] }))));
    expect(result.current.current.roleIds).toEqual(['gone']);
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
      // I3': the second PUT waits for the first, so the older reply always comes first.
      expect(putCalls).toHaveLength(1);
      await act(async () => putCalls[0].d.resolve(stored(cond({ branchPattern: 'first' }))));
      expect(result.current.df.saved).toBe(false);
      await act(async () => putCalls[1].d.resolve(stored(cond({ branchPattern: 'second' }))));
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
      await act(async () => putCalls[0].d.reject(new ApiError('boom', 400)));
      expect(result.current.df.saveError).toBeNull();
      await act(async () => putCalls[1].d.resolve(stored(cond({ branchPattern: 'second' }))));
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

  describe("I3': saves are serial, so the server's last write is the default the page shows", () => {
    /** The server: writes a PUT's body when it handles it, and answers with what it wrote. */
    let serverValue: SessionsFilterCondition | null = null;
    const handled = new Set<number>();
    /** Handle every PUT that has reached the server, newest first (the reverse of the clicks). */
    async function serverHandlesNewestFirst() {
      for (;;) {
        const waiting = putCalls.map((c, i) => i).filter((i) => !handled.has(i));
        if (waiting.length === 0) return;
        for (const i of waiting.reverse()) {
          handled.add(i);
          serverValue = putCalls[i].body;
          await act(async () => putCalls[i].d.resolve(stored(putCalls[i].body)));
        }
      }
    }
    beforeEach(() => {
      serverValue = null;
      handled.clear();
    });

    it('A then B saved back to back, the server taking B first: server and page both end on B, and a fresh read gives B', async () => {
      const { result, unmount } = setup();
      await act(async () => getCalls[0].resolve({ success: true, filter: EMPTY, configured: false }));
      act(() => result.current.userSets(cond({ branchPattern: 'A' })));
      act(() => void result.current.df.saveAsDefault());
      act(() => result.current.userSets(cond({ branchPattern: 'B' })));
      act(() => void result.current.df.saveAsDefault());
      await serverHandlesNewestFirst();
      // What the page shows as the default is what the server holds, and it is B.
      expect(result.current.df.defaults).toEqual(serverValue);
      expect(serverValue).toEqual(cond({ branchPattern: 'B' }));
      expect(result.current.df.differs).toBe(false);
      expect(result.current.df.saving).toBe(false);
      expect(result.current.df.saved).toBe(true);
      // Reopen: the default read back from the server is B as well.
      unmount();
      const reopened = setup();
      await act(async () => getCalls[getCalls.length - 1].resolve(stored(serverValue!)));
      expect(reopened.result.current.current).toEqual(cond({ branchPattern: 'B' }));
      expect(reopened.result.current.df.differs).toBe(false);
    });

    it('A, B, C clicked while A is out: only the last one (C) waits, B is never sent', async () => {
      const { result } = setup();
      await act(async () => getCalls[0].resolve({ success: true, filter: EMPTY, configured: false }));
      for (const p of ['A', 'B', 'C']) {
        act(() => result.current.userSets(cond({ branchPattern: p })));
        act(() => void result.current.df.saveAsDefault());
      }
      await serverHandlesNewestFirst();
      expect(putCalls.map((c) => c.body.branchPattern)).toEqual(['A', 'C']);
      expect(serverValue?.branchPattern).toBe('C');
      expect(result.current.df.defaults?.branchPattern).toBe('C');
    });

    it('the first save fails while the next waits: the next is still sent, its result is shown', async () => {
      const { result } = setup();
      await act(async () => getCalls[0].resolve({ success: true, filter: EMPTY, configured: false }));
      act(() => result.current.userSets(cond({ branchPattern: 'A' })));
      act(() => void result.current.df.saveAsDefault());
      act(() => result.current.userSets(cond({ branchPattern: 'B' })));
      act(() => void result.current.df.saveAsDefault());
      await act(async () => putCalls[0].d.reject(new ApiError('boom', 500)));
      expect(putCalls).toHaveLength(2);
      expect(result.current.df.saveError).toBeNull();
      await act(async () => putCalls[1].d.resolve(stored(cond({ branchPattern: 'B' }))));
      expect(result.current.df.defaults?.branchPattern).toBe('B');
      expect(result.current.df.saveError).toBeNull();
      expect(result.current.df.saved).toBe(true);
    });
  });

  describe('I6: every chosen role deleted is not "no role chosen"', () => {
    it('roleIds all deleted and nothing else: the role condition stays (matches nothing), notice, no mark', async () => {
      const { result } = setup({ rolesReadiness: 'ready', existingRoleIds: ['review'] });
      await act(async () => getCalls[0].resolve(stored(cond({ roleIds: ['gone'] }))));
      expect(result.current.current).toEqual(cond({ roleIds: ['gone'] }));
      expect(result.current.df.droppedRoleIds).toEqual(['gone']);
      expect(result.current.df.defaults).toEqual(cond({ roleIds: ['gone'] }));
      expect(result.current.df.differs).toBe(false);
      // Clearing is a real difference from the default.
      act(() => result.current.userSets(EMPTY));
      expect(result.current.df.differs).toBe(true);
      act(() => result.current.df.resetToDefault());
      expect(result.current.current).toEqual(cond({ roleIds: ['gone'] }));
      expect(result.current.df.differs).toBe(false);
    });

    it('control: no role chosen from the start stays "no role condition"', async () => {
      const { result, applied } = setup({ rolesReadiness: 'ready', existingRoleIds: ['review'] });
      await act(async () => getCalls[0].resolve(stored(cond({ branchPattern: 'x' }))));
      expect(applied).toEqual([cond({ branchPattern: 'x' })]);
      expect(result.current.df.droppedRoleIds).toEqual([]);
    });

    it('control: a branch condition is left, so the deleted roles are just left out', async () => {
      const { result } = setup({ rolesReadiness: 'ready', existingRoleIds: [] });
      await act(async () => getCalls[0].resolve(stored(cond({ branchPattern: '^feature/', roleIds: ['gone'] }))));
      expect(result.current.current).toEqual(cond({ branchPattern: '^feature/' }));
      expect(result.current.df.droppedRoleIds).toEqual(['gone']);
    });
  });

  describe('I7: an older GET (StrictMode runs the effect twice) never overrides the newer one', () => {
    it('the first GET fails after the second applied: the default, "back to default" and the mark stay', async () => {
      const { result } = setup(undefined, true);
      expect(getCalls).toHaveLength(2);
      await act(async () => getCalls[1].resolve(stored(cond({ branchPattern: '^feature/' }))));
      expect(result.current.current.branchPattern).toBe('^feature/');
      await act(async () => getCalls[0].reject(new ApiError('Internal server error', 500)));
      expect(result.current.df.hasDefault).toBe(true);
      expect(result.current.df.defaults).toEqual(cond({ branchPattern: '^feature/' }));
      expect(result.current.df.differs).toBe(false);
      expect(result.current.current.branchPattern).toBe('^feature/');
    });

    it('the first GET succeeds late with an older value: ignored', async () => {
      const { result, applied } = setup(undefined, true);
      expect(getCalls).toHaveLength(2);
      await act(async () => getCalls[1].resolve(stored(cond({ branchPattern: '^feature/' }))));
      await act(async () => getCalls[0].resolve(stored(cond({ branchPattern: 'main' }))));
      expect(result.current.df.defaults).toEqual(cond({ branchPattern: '^feature/' }));
      expect(result.current.df.differs).toBe(false);
      expect(applied).toEqual([cond({ branchPattern: '^feature/' })]);
    });
  });

  describe("I3'': the save queue outlives the page — one per destination", () => {
    /** The server writes a PUT's body when it handles it; handles the newest first. */
    function makeServer() {
      const server = { value: null as SessionsFilterCondition | null };
      const handled = new Set<number>();
      const handleNewestFirst = async () => {
        for (;;) {
          const waiting = putCalls.map((_, i) => i).filter((i) => !handled.has(i));
          if (waiting.length === 0) return;
          for (const i of waiting.reverse()) {
            handled.add(i);
            server.value = putCalls[i].body;
            await act(async () => putCalls[i].d.resolve(stored(putCalls[i].body)));
          }
        }
      };
      return { server, handleNewestFirst };
    }

    it('A is out, the page is left and opened again, B is saved: B goes out after A answered; server and page end on B', async () => {
      const { server, handleNewestFirst } = makeServer();
      const first = setup();
      await act(async () => getCalls[0].resolve({ success: true, filter: EMPTY, configured: false }));
      act(() => first.result.current.userSets(cond({ branchPattern: 'A' })));
      act(() => void first.result.current.df.saveAsDefault());
      first.unmount();

      const second = setup();
      // The server has not handled A yet, so the read still says "nothing saved".
      await act(async () => getCalls[1].resolve({ success: true, filter: EMPTY, configured: false }));
      act(() => second.result.current.userSets(cond({ branchPattern: 'B' })));
      act(() => void second.result.current.df.saveAsDefault());
      await handleNewestFirst();

      expect(putCalls.map((c) => c.body.branchPattern)).toEqual(['A', 'B']);
      expect(second.result.current.df.defaults).toEqual(server.value);
      expect(server.value?.branchPattern).toBe('B');
      expect(second.result.current.df.saved).toBe(true);
    });

    it('control: a save to another destination is not held back', async () => {
      const a = deferred<string>();
      const sendA = vi.fn(() => a.promise);
      const sendOther = vi.fn(async () => 'other');
      const outA = sendSerially('/api/settings/sessions-filter', sendA);
      const other = await sendSerially('/api/settings/elsewhere', sendOther);
      expect(sendOther).toHaveBeenCalledTimes(1);
      expect(other).toEqual({ status: 'fulfilled', value: 'other' });
      a.resolve('a');
      expect(await outA).toEqual({ status: 'fulfilled', value: 'a' });
    });

    it('control: the same destination waits; a click held back is replaced by a later one', async () => {
      const a = deferred<string>();
      const sends: string[] = [];
      const send = (v: string) => () => {
        sends.push(v);
        return v === 'a' ? a.promise : Promise.resolve(v);
      };
      const outA = sendSerially('/k', send('a'));
      const outB = sendSerially('/k', send('b'));
      const outC = sendSerially('/k', send('c'));
      expect(sends).toEqual(['a']);
      a.resolve('a');
      expect(await outA).toEqual({ status: 'fulfilled', value: 'a' });
      expect(await outB).toEqual({ status: 'superseded' });
      expect(await outC).toEqual({ status: 'fulfilled', value: 'c' });
      expect(sends).toEqual(['a', 'c']);
    });

    it('control: the reset empties the queue — a PUT left out does not hold the next one', async () => {
      const never = deferred<string>();
      void sendSerially('/k', () => never.promise);
      resetSessionsDefaultFilterSaveQueueForTests();
      const next = vi.fn(async () => 'next');
      expect(await sendSerially('/k', next)).toEqual({ status: 'fulfilled', value: 'next' });
    });

    it('the reset is called from tests only (no production file uses it)', () => {
      const root = path.resolve(__dirname, '../../../src');
      const users: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.(ts|tsx)$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('resetSessionsDefaultFilterSaveQueueForTests')) {
            users.push(path.relative(root, full));
          }
        }
      };
      walk(root);
      // Only where it is defined.
      expect(users).toEqual([path.join('hooks', 'useSessionsDefaultFilter.ts')]);
    });
  });

  describe("I6': one judgement of an empty condition (sessions-filter's, whitespace trimmed)", () => {
    it('whitespace-only branch pattern and every role deleted: the deleted ids are kept (0 rows), notice, no mark', async () => {
      const { result } = setup({ rolesReadiness: 'ready', existingRoleIds: [] });
      await act(async () => getCalls[0].resolve(stored(cond({ branchPattern: '  ', roleIds: ['gone'] }))));
      expect(result.current.current).toEqual(cond({ branchPattern: '  ', roleIds: ['gone'] }));
      expect(result.current.df.droppedRoleIds).toEqual(['gone']);
      expect(result.current.df.differs).toBe(false);
    });
  });

  describe('I8: the deleted-role notice is derived, not a separate state', () => {
    it('a default whose roles are all deleted, saved again unchanged: the notice stays', async () => {
      const { result } = setup({ rolesReadiness: 'ready', existingRoleIds: ['review'] });
      await act(async () => getCalls[0].resolve(stored(cond({ roleIds: ['gone'] }))));
      expect(result.current.df.droppedRoleIds).toEqual(['gone']);
      act(() => void result.current.df.saveAsDefault());
      expect(putCalls[0].body).toEqual(cond({ roleIds: ['gone'] }));
      await act(async () => putCalls[0].d.resolve(stored(putCalls[0].body)));
      expect(result.current.df.saved).toBe(true);
      expect(result.current.current).toEqual(cond({ roleIds: ['gone'] }));
      expect(result.current.df.droppedRoleIds).toEqual(['gone']);
    });

    it('control: choosing an existing role instead takes the deleted id out of the condition, and the notice goes', async () => {
      const { result } = setup({ rolesReadiness: 'ready', existingRoleIds: ['review'] });
      await act(async () => getCalls[0].resolve(stored(cond({ roleIds: ['gone'] }))));
      act(() => result.current.userSets(cond({ roleIds: ['review'] })));
      expect(result.current.df.droppedRoleIds).toEqual([]);
      // Back to the default: the notice comes back with it.
      act(() => result.current.df.resetToDefault());
      expect(result.current.df.droppedRoleIds).toEqual(['gone']);
    });
  });
});
