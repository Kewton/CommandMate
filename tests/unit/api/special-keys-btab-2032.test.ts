/**
 * Issue #2032: `POST /api/worktrees/[id]/special-keys` with `["BTab"]`.
 *
 * Before the fix the route validated `BTab` against `NAVIGATION_KEY_VALUES` (pass),
 * then `sendSpecialKeys()` rejected it against `ALLOWED_SPECIAL_KEYS` and threw, so
 * the caller got 500 for a key the endpoint advertises as supported.
 *
 * This suite deliberately uses the REAL `isAllowedSpecialKey` (partial mock via
 * `importOriginal`) — stubbing it, as tests/unit/special-keys-route.test.ts does,
 * is exactly what hid the divergence.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/cli-tools/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cli-tools/types')>();
  return { ...actual };
});

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: vi.fn((id: string) => ({
        getSessionName: vi.fn((worktreeId: string) => `mcbd-${id}-${worktreeId}`),
      })),
    })),
  },
}));

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => ({})),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(() => ({ id: 'wt-1', path: '/tmp/wt-1', branch: 'main' })),
}));

vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));

// Partial mock: only the two functions that would touch a real tmux server are
// replaced. `isAllowedSpecialKey` stays real so the route's validation is the
// production one.
vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  return {
    ...actual,
    hasSession: vi.fn().mockResolvedValue(true),
    sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
    sendSpecialKeysAndInvalidate: vi.fn().mockResolvedValue(undefined),
  };
});

import { POST } from '@/app/api/worktrees/[id]/special-keys/route';
import { sendSpecialKeysAndInvalidate, isAllowedSpecialKey } from '@/lib/tmux/tmux';

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/worktrees/wt-1/special-keys', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const params = Promise.resolve({ id: 'wt-1' });

describe('POST /api/worktrees/[id]/special-keys — BTab (Issue #2032)', () => {
  beforeEach(() => {
    vi.mocked(sendSpecialKeysAndInvalidate).mockClear();
  });

  it('answers 200 and forwards BTab to the tmux transport', async () => {
    const res = await POST(createRequest({ cliToolId: 'claude', keys: ['BTab'] }), { params });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(sendSpecialKeysAndInvalidate).toHaveBeenCalledWith('mcbd-claude-wt-1', ['BTab']);
  });

  it('forwards BTab inside a mixed sequence', async () => {
    const res = await POST(
      createRequest({ cliToolId: 'claude', keys: ['Tab', 'BTab', 'Enter'] }),
      { params }
    );

    expect(res.status).toBe(200);
    expect(sendSpecialKeysAndInvalidate).toHaveBeenCalledWith(
      'mcbd-claude-wt-1',
      ['Tab', 'BTab', 'Enter']
    );
  });

  it('validates BTab with the production guard, not a test stub', () => {
    expect(isAllowedSpecialKey('BTab')).toBe(true);
  });
});

describe('special-keys divergence between the API vocabulary and the tmux allow-list (Issue #2032)', () => {
  afterEach(() => {
    vi.doUnmock('@/types/terminal-keys');
    vi.resetModules();
  });

  it('answers 400 (caller must pick another key), never 500, and never reaches the transport', async () => {
    // Simulate the drift this issue was about: the published vocabulary gains a key
    // that `sendSpecialKeys()` cannot deliver. 400 is the right status because the
    // only actionable outcome for the caller is "send a different key" — a 500 would
    // both mislabel it as a server outage and invite a retry that can never succeed.
    // In a green build this branch is unreachable: the subset invariant is pinned by
    // tests/unit/tmux/special-keys-allowlist-2032.test.ts.
    vi.resetModules();
    const realKeys = await import('@/types/terminal-keys');
    vi.doMock('@/types/terminal-keys', () => ({
      NAVIGATION_KEY_VALUES: [...realKeys.NAVIGATION_KEY_VALUES, 'F1'],
    }));

    const { POST: divergedPOST } = await import('@/app/api/worktrees/[id]/special-keys/route');
    const tmux = await import('@/lib/tmux/tmux');

    const res = await divergedPOST(createRequest({ cliToolId: 'claude', keys: ['F1'] }), {
      params: Promise.resolve({ id: 'wt-1' }),
    });

    // Positive control: the phantom key really is in the vocabulary now, so the 400
    // comes from the transport check and not from the vocabulary check.
    const { NAVIGATION_KEY_VALUES } = await import('@/types/terminal-keys');
    expect(NAVIGATION_KEY_VALUES as readonly string[]).toContain('F1');

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(tmux.sendSpecialKeysAndInvalidate).not.toHaveBeenCalled();
  });
});
