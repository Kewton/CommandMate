/**
 * useSessionsRoles (Issue #4389): reads `GET /api/roles` and `GET /api/sessions/roles` once
 * each (never per worktree), and turns a failed instance-role read into `rolesUnavailable`.
 * Only the latest request of each read is adopted: a late reply (failure or older success)
 * does not overwrite a newer success. Positive control: the out-of-order cases are red with
 * the earlier hook that only checked `mounted`.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';
import { useSessionsRoles } from '@/hooks/useSessionsRoles';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('[#4389] useSessionsRoles', () => {
  it('reads the role list and every instance role once', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === '/api/roles') return json(200, { success: true, roles: [{ id: 'review', name: 'Review' }] });
      if (url === '/api/sessions/roles') {
        return json(200, { success: true, roleByWorktree: { wt: { claude: { kind: 'none' } } } });
      }
      return json(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useSessionsRoles({ poll: false }));
    await waitFor(() => expect(result.current.source).not.toBeNull());
    await waitFor(() => expect(result.current.roles).not.toBeNull());
    expect(result.current.roles?.map((r) => r.id)).toEqual(['review']);
    expect(result.current.source).toEqual({
      roleByWorktree: { wt: { claude: { kind: 'none' } } },
      rolesUnavailable: false,
    });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u === '/api/sessions/roles')).toHaveLength(1);
    expect(urls.some((u) => /\/api\/worktrees\/[^/]+\/instances\/roles/.test(u))).toBe(false);
  });

  it('passes rolesUnavailable through', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) =>
      String(input) === '/api/sessions/roles'
        ? json(200, { success: true, roleByWorktree: {}, rolesUnavailable: true })
        : json(200, { success: true, roles: [] })));
    const { result } = renderHook(() => useSessionsRoles({ poll: false }));
    await waitFor(() => expect(result.current.source?.rolesUnavailable).toBe(true));
  });

  it('a failed read becomes rolesUnavailable, not an empty "no roles" map', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: 'boom' })));
    const { result } = renderHook(() => useSessionsRoles({ poll: false }));
    await waitFor(() => expect(result.current.source).toEqual({ roleByWorktree: {}, rolesUnavailable: true }));
    await waitFor(() => expect(result.current.roles).toBeNull());
  });

  describe('out-of-order replies', () => {
    type Pending = { url: string; resolve: (r: Response) => void; reject: (e: unknown) => void };
    let pending: Pending[];
    const take = (url: string, index: number) => pending.filter((p) => p.url === url)[index];

    function installDeferredFetch() {
      pending = [];
      vi.stubGlobal('fetch', vi.fn((input: unknown) =>
        new Promise<Response>((resolve, reject) => pending.push({ url: String(input), resolve, reject }))));
    }

    const ok = (map: Record<string, unknown>) => json(200, { success: true, roleByWorktree: map });
    const newer = { wt: { codex: { kind: 'role', roleId: 'review', roleName: 'Review', basis: 'launched' } } };
    const older = { wt: { codex: { kind: 'none' } } };

    async function mountThenReload() {
      installDeferredFetch();
      const hook = renderHook(() => useSessionsRoles({ poll: false }));
      await waitFor(() => expect(pending).toHaveLength(2)); // A: roles + sessions/roles
      act(() => hook.result.current.reload());
      await waitFor(() => expect(pending).toHaveLength(4)); // B
      return hook;
    }

    it('instance roles: the newer success stays when the older request fails afterwards', async () => {
      const { result } = await mountThenReload();
      await act(async () => take('/api/sessions/roles', 1).resolve(ok(newer)));
      await waitFor(() => expect(result.current.source?.roleByWorktree).toEqual(newer));
      await act(async () => take('/api/sessions/roles', 0).resolve(json(400, { error: 'late' })));
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(result.current.source).toEqual({ roleByWorktree: newer, rolesUnavailable: false });
    });

    it('instance roles: an older success arriving last does not roll back', async () => {
      const { result } = await mountThenReload();
      await act(async () => take('/api/sessions/roles', 1).resolve(ok(newer)));
      await waitFor(() => expect(result.current.source?.roleByWorktree).toEqual(newer));
      await act(async () => take('/api/sessions/roles', 0).resolve(ok(older)));
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(result.current.source?.roleByWorktree).toEqual(newer);
    });

    it('role list: a late failure or older list does not overwrite the newer list', async () => {
      const { result } = await mountThenReload();
      await act(async () => take('/api/roles', 1).resolve(json(200, { success: true, roles: [{ id: 'new', name: 'New' }] })));
      await waitFor(() => expect(result.current.roles?.map((r) => r.id)).toEqual(['new']));
      await act(async () => take('/api/roles', 0).resolve(json(400, { error: 'late' })));
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(result.current.roles?.map((r) => r.id)).toEqual(['new']);
    });

    it('role list: an older success arriving last does not roll back', async () => {
      const { result } = await mountThenReload();
      await act(async () => take('/api/roles', 1).resolve(json(200, { success: true, roles: [{ id: 'new', name: 'New' }] })));
      await waitFor(() => expect(result.current.roles?.map((r) => r.id)).toEqual(['new']));
      await act(async () => take('/api/roles', 0).resolve(json(200, { success: true, roles: [{ id: 'old', name: 'Old' }] })));
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(result.current.roles?.map((r) => r.id)).toEqual(['new']);
    });

    it('control: in-order replies adopt the latest', async () => {
      const { result } = await mountThenReload();
      await act(async () => take('/api/sessions/roles', 0).resolve(ok(older)));
      await act(async () => take('/api/sessions/roles', 1).resolve(ok(newer)));
      await waitFor(() => expect(result.current.source?.roleByWorktree).toEqual(newer));
    });
  });
});
