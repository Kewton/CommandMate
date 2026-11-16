/**
 * useSessionsRoles (Issue #4389): reads `GET /api/roles` and `GET /api/sessions/roles` once
 * each (never per worktree), and turns a failed instance-role read into `rolesUnavailable`.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
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
});
