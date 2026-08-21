/**
 * Issue #1879: the pane hook publishes the composer text, from BOTH delivery
 * paths.
 *
 * `composerText` is derived on the client from the frame each path already
 * carries, not read off a payload field. That is what makes the two paths equal:
 * the WebSocket `terminal_snapshot` event ships the frame plus a fixed set of
 * flags, and while push is healthy the HTTP poll is throttled to 15 s — so a
 * field-based implementation would leave the bar on screen for up to that whole
 * window after a Clear. Both cases are asserted here against the same live
 * fixtures the extraction suite uses.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';

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

const FIXTURES = path.resolve(__dirname, '../lib/detection/fixtures/claude-live-1879');
const frame = (name: string): string =>
  fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf-8');

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

describe('useTerminalPanePolling composer text (Issue #1879)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes the residual text from a polled frame', async () => {
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, cliToolId: 'claude', fullOutput: frame('composer-residual-plain') }),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );

    await waitFor(() => expect(result.current.terminal.composerText).toBe('echo PREFILLED'));
  });

  it('publishes nothing for a frame whose composer holds only a dim ghost', async () => {
    // The frame the user sees as `❯ Try "how do I log an error?"`. Rendering it
    // would put a Clear button next to text no `C-u` can remove.
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, cliToolId: 'claude', fullOutput: frame('composer-ghost-suggestion') }),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );

    await waitFor(() => expect(result.current.terminal.isRunning).toBe(true));
    expect(result.current.terminal.composerText).toBe('');
  });

  it('publishes nothing for an empty composer', async () => {
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, cliToolId: 'claude', fullOutput: frame('composer-empty') }),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );

    await waitFor(() => expect(result.current.terminal.isRunning).toBe(true));
    expect(result.current.terminal.composerText).toBe('');
  });

  it('publishes it from a WebSocket terminal_snapshot too, not only from the poll', async () => {
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, cliToolId: 'claude', fullOutput: frame('composer-empty') }),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.terminal.isRunning).toBe(true));
    expect(result.current.terminal.composerText).toBe('');

    act(() => {
      realtimeMock.emit({
        type: 'terminal_snapshot',
        worktreeId: 'w-1',
        cliToolId: 'claude',
        instanceId: 'claude',
        output: frame('composer-residual-multiline'),
        isRunning: true,
        thinking: false,
        isPromptWaiting: false,
        isSelectionListActive: false,
        isPagerActive: false,
        isUnclassifiedActive: false,
        version: 1,
      });
    });

    await waitFor(() =>
      expect(result.current.terminal.composerText).toBe('RESIDLINE1\nRESIDLINE2'),
    );
  });

  it('clears the composer text when the session stops', async () => {
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, cliToolId: 'claude', fullOutput: frame('composer-residual-plain') }),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.terminal.composerText).toBe('echo PREFILLED'));

    act(() => {
      realtimeMock.emit({
        type: 'session_status_changed',
        worktreeId: 'w-1',
        isRunning: false,
        cliTool: 'claude',
        instance: 'claude',
      });
    });

    await waitFor(() => expect(result.current.terminal.composerText).toBe(''));
  });

  it('publishes nothing for a non-claude pane, whatever its frame looks like', async () => {
    // codex draws its own idle placeholder; nothing here may present it as the
    // user's unsent text.
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, cliToolId: 'codex', fullOutput: frame('composer-residual-plain') }),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'codex' }),
    );

    await waitFor(() => expect(result.current.terminal.isRunning).toBe(true));
    expect(result.current.terminal.composerText).toBe('');
  });
});
