/**
 * Unit tests for clear-composer/route.ts (Issue #1879).
 *
 * The endpoint the [Clear] button posts to. It exists separately from
 * `special-keys` because `C-u` is not a navigation key and — more to the point —
 * clearing is not a key send: #1878 §5-1 measured that one `C-u` clears nothing
 * with the cursor at column 0 and one row of a multi-row composer otherwise, so
 * the server loops and reads the frame back (`clearComposer`).
 *
 * Its validation must be no weaker than the endpoint it sits beside, so the
 * cases below mirror `special-keys-route.test.ts` layer for layer.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/cli-tools/types', () => ({
  isCliToolType: vi.fn((value: string) => ['claude', 'codex', 'gemini'].includes(value)),
  isValidInstanceId: vi.fn((value: string) => /^[A-Za-z0-9._-]{1,64}$/.test(value)),
}));

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: vi.fn((id: string) => ({
        getSessionName: vi.fn((worktreeId: string, instanceId?: string) =>
          `mcbd-${instanceId ?? id}-${worktreeId}`),
      })),
    })),
  },
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn() }));
vi.mock('@/lib/tmux/tmux', () => ({ hasSession: vi.fn() }));
vi.mock('@/lib/session/composer-clear', () => ({ clearComposer: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/api/worktrees/[id]/clear-composer/route';
import { getWorktreeById } from '@/lib/db';
import { hasSession } from '@/lib/tmux/tmux';
import { clearComposer } from '@/lib/session/composer-clear';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/worktrees/wt-1/clear-composer', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const defaultParams = { params: Promise.resolve({ id: 'wt-1' }) };

describe('POST /api/worktrees/[id]/clear-composer (Issue #1879)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorktreeById).mockReturnValue(
      { id: 'wt-1', name: 'test', path: '/path' } as ReturnType<typeof getWorktreeById>,
    );
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(clearComposer).mockResolvedValue({
      cleared: true, passes: 1, state: 'empty', remainingText: '',
    });
  });

  it('clears the composer of the primary instance', async () => {
    const res = await POST(createRequest({ cliToolId: 'claude' }), defaultParams);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      cleared: true,
      passes: 1,
      composerState: 'empty',
      remainingText: '',
    });
    expect(clearComposer).toHaveBeenCalledWith('mcbd-claude-wt-1', 'claude');
  });

  it('targets the requested agent instance', async () => {
    await POST(createRequest({ cliToolId: 'claude', instanceId: 'claude-2' }), defaultParams);
    expect(clearComposer).toHaveBeenCalledWith('mcbd-claude-2-wt-1', 'claude');
  });

  it('pushes a fresh frame so the bar disappears without waiting for the poll', async () => {
    await POST(createRequest({ cliToolId: 'claude' }), defaultParams);
    expect(broadcastTerminalSnapshotAfterInteraction).toHaveBeenCalledWith('wt-1', 'claude', undefined);
  });

  it('reports honestly when the composer could not be emptied', async () => {
    // A truthful failure is the point: the caller must not be told the box is
    // empty when the loop hit its cap with text still in it.
    vi.mocked(clearComposer).mockResolvedValue({
      cleared: false, passes: 12, state: 'content', remainingText: 'echo PREFILLED',
    });

    const res = await POST(createRequest({ cliToolId: 'claude' }), defaultParams);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      cleared: false,
      composerState: 'content',
      remainingText: 'echo PREFILLED',
    });
  });

  it('rejects malformed JSON', async () => {
    const res = await POST(createRequest('{invalid json'), defaultParams);
    expect(res.status).toBe(400);
    expect(clearComposer).not.toHaveBeenCalled();
  });

  const REJECTED_BODIES: ReadonlyArray<readonly [string, unknown]> = [
    ['missing cliToolId', {}],
    ['unknown cliToolId', { cliToolId: 'notatool' }],
    ['non-string cliToolId', { cliToolId: 123 }],
  ];

  it.each(REJECTED_BODIES)('rejects a request with %s', async (_label, body) => {
    const res = await POST(createRequest(body), defaultParams);
    expect(res.status).toBe(400);
    expect(clearComposer).not.toHaveBeenCalled();
  });

  it('rejects an instanceId that is not a valid id', async () => {
    // It is embedded in the tmux session name, exactly as in special-keys.
    const res = await POST(
      createRequest({ cliToolId: 'claude', instanceId: '../../etc/passwd' }),
      defaultParams,
    );
    expect(res.status).toBe(400);
    expect(clearComposer).not.toHaveBeenCalled();
  });

  it('404s for an unknown worktree', async () => {
    vi.mocked(getWorktreeById).mockReturnValue(null as ReturnType<typeof getWorktreeById>);
    const res = await POST(createRequest({ cliToolId: 'claude' }), defaultParams);
    expect(res.status).toBe(404);
    expect(clearComposer).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist', async () => {
    vi.mocked(hasSession).mockResolvedValue(false);
    const res = await POST(createRequest({ cliToolId: 'claude' }), defaultParams);
    expect(res.status).toBe(404);
    expect(clearComposer).not.toHaveBeenCalled();
  });

  it('returns a fixed-string 500 without leaking internals', async () => {
    vi.mocked(clearComposer).mockRejectedValue(new Error('tmux exploded at /Users/secret/path'));
    const res = await POST(createRequest({ cliToolId: 'claude' }), defaultParams);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Failed to clear the composer' });
  });
});
