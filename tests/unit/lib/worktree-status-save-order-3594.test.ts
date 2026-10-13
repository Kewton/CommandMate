/**
 * Saving a worktree status (Issue #3594, review follow-up).
 *
 *   - Saves of the SAME worktree are queued, so the last pick is the last
 *     PATCH (Ready picked, Done picked while Ready is in flight → Done last).
 *   - Saves of different worktrees do not wait for each other.
 *   - A fetch reply started before a successful save shows the saved status;
 *     one started after it shows the server's.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  __resetWorktreeStatusSaves,
  applySavedWorktreeStatus,
  applySavedWorktreeStatuses,
  currentWorktreeStatusGeneration,
  markWorktreeStatusSaved,
  saveWorktreeStatus,
} from '@/lib/worktree-status';

interface PendingPatch {
  url: string;
  status: unknown;
  resolve: (ok: boolean) => void;
}

/** A fetch whose PATCH replies only when the test says so. */
function controllableFetch() {
  const pending: PendingPatch[] = [];
  const fetchMock = vi.fn(
    (url: string, init?: RequestInit) =>
      new Promise((resolveFetch) => {
        const status = JSON.parse(String(init?.body)).status;
        pending.push({
          url,
          status,
          resolve: (ok) =>
            resolveFetch({ ok, status: ok ? 200 : 500, json: async () => ({ id: url.split('/').pop(), status }) }),
        });
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, pending };
}

/** Let queued promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => __resetWorktreeStatusSaves());
afterEach(() => {
  vi.unstubAllGlobals();
  __resetWorktreeStatusSaves();
});

describe('save order per worktree (Issue #3594)', () => {
  it('sends the later pick after the earlier one settles, so the last PATCH is the last pick', async () => {
    const { fetchMock, pending } = controllableFetch();
    const ready = saveWorktreeStatus('wt-1', 'ready');
    const done = saveWorktreeStatus('wt-1', 'done');
    await flush();
    // Done waits while Ready is in flight.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pending[0].status).toBe('ready');

    pending[0].resolve(true);
    await ready;
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pending[1].status).toBe('done');
    pending[1].resolve(true);
    await done;
  });

  it('still sends the later pick when the earlier one fails', async () => {
    const { fetchMock, pending } = controllableFetch();
    const ready = saveWorktreeStatus('wt-1', 'ready');
    const done = saveWorktreeStatus('wt-1', 'done');
    await flush();
    pending[0].resolve(false);
    await expect(ready).rejects.toThrow();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    pending[1].resolve(true);
    await expect(done).resolves.toMatchObject({ status: 'done' });
  });

  it('does not make another worktree wait (negative control)', async () => {
    const { fetchMock, pending } = controllableFetch();
    void saveWorktreeStatus('wt-1', 'ready');
    void saveWorktreeStatus('wt-2', 'done');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pending.map((p) => p.url)).toEqual(['/api/worktrees/wt-1', '/api/worktrees/wt-2']);
  });
});

describe('fetch replies vs. saves (Issue #3594)', () => {
  it('keeps a status saved after the fetch started', () => {
    const startedAt = currentWorktreeStatusGeneration();
    markWorktreeStatusSaved('wt-1', 'done');
    expect(applySavedWorktreeStatus({ id: 'wt-1', status: 'ready' }, startedAt).status).toBe('done');
  });

  it('shows the server value for a fetch started after the save (negative control)', () => {
    markWorktreeStatusSaved('wt-1', 'done');
    const startedAt = currentWorktreeStatusGeneration();
    const fetched = { id: 'wt-1', status: 'ready' as const };
    expect(applySavedWorktreeStatus(fetched, startedAt)).toBe(fetched);
  });

  it('leaves other worktrees and the array identity alone when nothing applies', () => {
    const startedAt = currentWorktreeStatusGeneration();
    markWorktreeStatusSaved('wt-1', 'done');
    const list = [{ id: 'wt-2', status: 'ready' as const }];
    expect(applySavedWorktreeStatuses(list, startedAt)).toBe(list);
    const both = applySavedWorktreeStatuses([{ id: 'wt-1', status: null }, ...list], startedAt);
    expect(both.map((w) => w.status)).toEqual(['done', 'ready']);
  });

  it('records only a save the server accepted', async () => {
    const { pending } = controllableFetch();
    const startedAt = currentWorktreeStatusGeneration();
    const save = saveWorktreeStatus('wt-1', 'done');
    await flush();
    pending[0].resolve(false);
    await expect(save).rejects.toThrow();
    expect(applySavedWorktreeStatus({ id: 'wt-1', status: 'ready' }, startedAt).status).toBe('ready');
  });
});
