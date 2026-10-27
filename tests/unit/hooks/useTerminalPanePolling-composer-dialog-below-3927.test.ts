/**
 * Issue #3927: the browser's own composer reading drops a codex composer that
 * a dialog has opened below — on both delivery paths.
 *
 * `useTerminalPanePolling` derives `composerText` from the frame (#1879), so
 * the published `composerText` being right is not enough: the hook read the
 * same frame with `extractComposerText` and put the old composer's text on the
 * unsent bar. Set up as `useTerminalPanePolling-composer-1879.test.ts`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import {
  CODEX_DIALOG_BELOW_FRAME,
  CODEX_LIVE_COMPOSER_FRAME,
  OLD_COMPOSER_TEXT,
} from '@tests/fixtures/codex-dialog-below-3927';

const realtimeMock = vi.hoisted(() => {
  const listeners: Array<(e: unknown) => void> = [];
  const api = {
    status: 'disconnected' as const,
    connected: false,
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
    emit: (event: unknown) => { for (const l of [...listeners]) l(event); },
    useRealtime: () => api,
  };
});
vi.mock('@/hooks/useRealtimeConnection', () => ({ useRealtime: realtimeMock.useRealtime }));

const CLAUDE_FIXTURES = path.resolve(__dirname, '../lib/detection/fixtures/claude-live-1879');

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

function serve(mockFetch: ReturnType<typeof vi.fn>, cliToolId: string, fullOutput: string) {
  mockFetch.mockImplementation(() => okJson({ isRunning: true, cliToolId, fullOutput }));
}

describe('useTerminalPanePolling composer text with a dialog below (Issue #3927)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('positive: a polled codex frame with a dialog below the old composer publishes no text', async () => {
    serve(mockFetch, 'codex', CODEX_DIALOG_BELOW_FRAME);

    const { result } = renderHook(() => useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'codex' }));

    await waitFor(() => expect(result.current.terminal.output).toBe(CODEX_DIALOG_BELOW_FRAME));
    expect(result.current.terminal.composerText).toBe('');
  });

  it('positive: a pushed terminal_snapshot of that frame takes the bar\'s text away too', async () => {
    serve(mockFetch, 'codex', CODEX_LIVE_COMPOSER_FRAME);

    const { result } = renderHook(() => useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'codex' }));
    await waitFor(() => expect(result.current.terminal.composerText).toBe(OLD_COMPOSER_TEXT));

    act(() => {
      realtimeMock.emit({
        type: 'terminal_snapshot',
        worktreeId: 'w-1',
        cliToolId: 'codex',
        instanceId: 'codex',
        output: CODEX_DIALOG_BELOW_FRAME,
        isRunning: true,
        thinking: false,
        isPromptWaiting: false,
        isSelectionListActive: false,
        isPagerActive: false,
        isUnclassifiedActive: false,
        version: 1,
      });
    });

    await waitFor(() => expect(result.current.terminal.composerText).toBe(''));
  });

  it('negative: the live codex composer keeps its text', async () => {
    serve(mockFetch, 'codex', CODEX_LIVE_COMPOSER_FRAME);

    const { result } = renderHook(() => useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'codex' }));

    await waitFor(() => expect(result.current.terminal.composerText).toBe(OLD_COMPOSER_TEXT));
  });

  it('negative: a claude composer keeps its text', async () => {
    serve(mockFetch, 'claude', fs.readFileSync(path.join(CLAUDE_FIXTURES, 'composer-residual-plain.txt'), 'utf-8'));

    const { result } = renderHook(() => useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }));

    await waitFor(() => expect(result.current.terminal.composerText).toBe('echo PREFILLED'));
  });
});
