/**
 * Issue #3334 — the pane stops saying "Attaching…" when the session under its
 * name belongs to another CommandMate server.
 *
 * `/current-output` answers such a session with 409
 * `session_owned_by_other_server` and shows none of it (#2865). The hook
 * returned on every non-2xx, so `attaching` never left `true` and the pane read
 * "Attaching … session..." for as long as it was open. It now reads that 409 as
 * "not running" — the verdict the worktree routes and the sidebar give the same
 * session — and every other failure keeps the old behaviour.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  FOREIGN_SESSION_ERROR_CODE,
  useTerminalPanePolling,
} from '@/hooks/useTerminalPanePolling';

vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: () => ({
    status: 'connected' as const,
    connected: true,
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: () => () => {},
  }),
}));

const WORKTREE_ID = 'wt-3334';

function respondWith(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
    }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('[#3334] useTerminalPanePolling and a session another server owns', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the code the server sends', async () => {
    // The server's constant cannot be imported into a client bundle; it is
    // compared here instead, so the two cannot drift apart.
    const server = await import('@/lib/tmux/session-ownership');
    expect(FOREIGN_SESSION_ERROR_CODE).toBe(server.FOREIGN_SESSION_ERROR_CODE);
  });

  it('leaves "Attaching…" and reports not running on the ownership 409', async () => {
    const fetchMock = respondWith(409, {
      error: 'tmux session "mcbd-claude-wt-3334" belongs to another CommandMate server',
      code: FOREIGN_SESSION_ERROR_CODE,
      sessionName: 'mcbd-claude-wt-3334',
      sessionPath: '/elsewhere/wt-3334',
    });

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'claude' }),
    );
    expect(result.current.terminal.attaching).toBe(true);

    await waitFor(() => expect(result.current.terminal.attaching).toBe(false));
    expect(fetchMock).toHaveBeenCalled();
    expect(result.current.terminal.isRunning).toBe(false);
    expect(result.current.terminal.sessionStatus).toBe('idle');
    // Nothing of the other server's pane was shown — the 409 carries none.
    expect(result.current.terminal.output).toBe('');
  });

  it('keeps "Attaching…" on any other 409 (control)', async () => {
    const fetchMock = respondWith(409, { error: 'something else', code: 'PROMPT_WAITING' });

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'claude' }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Let the response be read before judging that nothing changed.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.terminal.attaching).toBe(true);
  });

  it('keeps "Attaching…" on a 500 (control)', async () => {
    const fetchMock = respondWith(500, { error: 'Failed to get current output' });

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'claude' }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.terminal.attaching).toBe(true);
  });
});
