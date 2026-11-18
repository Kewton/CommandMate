/**
 * useSessionsRoles `rolesStatus` (Issue #4388): the default filter must tell "the role
 * list is not read yet" and "it could not be read" from "this role was deleted", so the
 * hook reports `loading` → `ok` / `error`. Positive control: red before #4388 (no field).
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

describe('[#4388] useSessionsRoles rolesStatus', () => {
  it('loading until the role list is read, then ok', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      if (String(input) === '/api/roles') {
        await gate;
        return json(200, { success: true, roles: [] });
      }
      return json(200, { success: true, roleByWorktree: {} });
    }));
    const { result } = renderHook(() => useSessionsRoles({ poll: false }));
    expect(result.current.rolesStatus).toBe('loading');
    release();
    await waitFor(() => expect(result.current.rolesStatus).toBe('ok'));
    expect(result.current.roles).toEqual([]);
  });

  it('a failed read is error (roles stays null), not an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(500, { error: 'boom' })));
    const { result } = renderHook(() => useSessionsRoles({ poll: false }));
    await waitFor(() => expect(result.current.rolesStatus).toBe('error'));
    expect(result.current.roles).toBeNull();
  });
});
