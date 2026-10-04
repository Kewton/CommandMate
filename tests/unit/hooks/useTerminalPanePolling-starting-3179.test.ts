/**
 * Issue #3179 — the pane hook carries `startingSince` from the push and the
 * poll, and reads its absence (an older server) as "not starting".
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import type { TerminalSnapshotEvent } from '@/lib/realtime/types';

const realtimeMock = vi.hoisted(() => {
  const listeners: Array<(e: unknown) => void> = [];
  const api = {
    status: 'connected' as const,
    connected: true,
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: (l: (e: unknown) => void) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
  return {
    listeners,
    emit: (event: unknown) => {
      for (const l of [...listeners]) l(event);
    },
    useRealtime: () => api,
  };
});
vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: realtimeMock.useRealtime,
}));

const WORKTREE_ID = 'w-3179';

function snapshot(version: number, overrides: Partial<TerminalSnapshotEvent> = {}): TerminalSnapshotEvent {
  return {
    type: 'terminal_snapshot',
    worktreeId: WORKTREE_ID,
    cliToolId: 'antigravity',
    instanceId: 'antigravity',
    output: `frame-${version}`,
    isRunning: true,
    sessionStatus: 'running',
    thinking: false,
    isPromptWaiting: false,
    promptData: null,
    isSelectionListActive: false,
    isPagerActive: false,
    isUnclassifiedActive: false,
    version,
    ...overrides,
  };
}

describe('[#3179] useTerminalPanePolling carries startingSince', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('from the push', () => {
    beforeEach(() => {
      realtimeMock.listeners.length = 0;
      global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    });

    it('starts null, follows the push up and back down, and reads absence as null', async () => {
      const { result } = renderHook(() =>
        useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'antigravity' }),
      );
      expect(result.current.terminal.startingSince).toBeNull();

      act(() => realtimeMock.emit(snapshot(1, { startingSince: 42 })));
      await waitFor(() => expect(result.current.terminal.startingSince).toBe(42));

      act(() => realtimeMock.emit(snapshot(2, { startingSince: null })));
      await waitFor(() => expect(result.current.terminal.startingSince).toBeNull());

      act(() => realtimeMock.emit(snapshot(3, { startingSince: 77 })));
      await waitFor(() => expect(result.current.terminal.startingSince).toBe(77));
      const legacy = { ...snapshot(4) } as Record<string, unknown>;
      delete legacy.startingSince;
      act(() => realtimeMock.emit(legacy));
      await waitFor(() => expect(result.current.terminal.output).toBe('frame-4'));
      expect(result.current.terminal.startingSince).toBeNull();
    });
  });

  describe('from the poll', () => {
    beforeEach(() => {
      realtimeMock.listeners.length = 0;
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    });

    it('applies the poll payload\'s startingSince', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            isRunning: true,
            cliToolId: 'antigravity',
            sessionStatus: 'running',
            fullOutput: 'launch',
            startingSince: 1234,
          }),
        }),
      ) as unknown as typeof fetch;

      const { result } = renderHook(() =>
        useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'antigravity' }),
      );
      await waitFor(() => expect(result.current.terminal.startingSince).toBe(1234));
    });
  });
});
