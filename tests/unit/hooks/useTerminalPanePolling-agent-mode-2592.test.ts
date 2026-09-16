/**
 * Issue #2592: the pane hook publishes the agent's permission mode, from BOTH
 * delivery paths.
 *
 * `agentMode` is derived on the client from the frame each path already carries,
 * not read off a payload field — the arrangement #1879 chose for `composerText`,
 * for the reason #2240 wrote down for `sessionStatus`. The WebSocket
 * `terminal_snapshot` event ships the frame plus a fixed set of flags, and while
 * push is healthy the HTTP poll is throttled to 15 s; a field carried by only
 * one path is therefore blank for up to that whole window on a pane whose first
 * frame arrives by the other one. The acceptance criterion "`agentMode` が
 * `/current-output` と `terminal_snapshot` の両方に載る" is what the push tests
 * below check, from the consumer's side: after a push and nothing else, the pane
 * knows the mode.
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

const FIXTURES = path.resolve(__dirname, '../../fixtures/agent-mode-2592');
const frame = (name: string): string =>
  fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf-8');

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

/** One `terminal_snapshot`, shaped as the server broadcasts it. */
const snapshot = (output: string, version: number) => ({
  type: 'terminal_snapshot',
  worktreeId: 'w-1',
  cliToolId: 'claude',
  instanceId: 'claude',
  output,
  isRunning: true,
  sessionStatus: 'ready',
  thinking: false,
  isPromptWaiting: false,
  isSelectionListActive: false,
  isPagerActive: false,
  isDismissablePanelActive: false,
  isUnclassifiedActive: false,
  version,
});

describe('[#2592] the HTTP poll path', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('publishes the mode read off a polled frame', async () => {
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, cliToolId: 'claude', fullOutput: frame('claude-plan') }),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );

    await waitFor(() => expect(result.current.terminal.agentMode).toBe('plan'));
  });

  it('starts at `unknown` before any frame has landed', () => {
    mockFetch.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );

    expect(result.current.terminal.agentMode).toBe('unknown');
  });

  it('publishes `unknown` for a tool with no mode cycle, whatever the frame says', async () => {
    // opencode's `BTab` switches AGENTS. A mode chip there would name a thing
    // the key does not do.
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, cliToolId: 'opencode', fullOutput: frame('claude-plan') }),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'opencode' }),
    );

    await waitFor(() => expect(result.current.terminal.isRunning).toBe(true));
    expect(result.current.terminal.agentMode).toBe('unknown');
  });

  it('publishes `unknown` for a tool sitting in a base mode it draws nothing for', async () => {
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, cliToolId: 'codex', fullOutput: frame('codex-default') }),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'codex' }),
    );

    await waitFor(() => expect(result.current.terminal.isRunning).toBe(true));
    expect(result.current.terminal.agentMode).toBe('unknown');
  });
});

describe('[#2592] the WebSocket push path carries it too', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('resolves the mode from a push, with no poll having carried it', async () => {
    // The poll answers a frame in `auto`; the push then delivers `plan`. If the
    // mode came off a payload field the push does not have, the pane would still
    // say `auto` here — for up to a whole fallback-poll interval.
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, cliToolId: 'claude', fullOutput: frame('claude-auto') }),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.terminal.agentMode).toBe('auto'));

    act(() => { realtimeMock.emit(snapshot(frame('claude-plan'), 1)); });

    await waitFor(() => expect(result.current.terminal.agentMode).toBe('plan'));
  });

  it('follows a whole cycle pressed from somewhere else entirely', async () => {
    // Nothing here presses a button. The operator is in `commandmate attach`, or
    // the agent changed its own mode — and the pane has to follow, which is the
    // reason the mode is READ every frame instead of counted per press.
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, cliToolId: 'claude', fullOutput: frame('claude-auto') }),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.terminal.agentMode).toBe('auto'));

    const cycle = ['claude-manual', 'claude-accept-edits', 'claude-plan', 'claude-auto'] as const;
    let version = 1;
    for (const [index, name] of cycle.entries()) {
      const v = version++;
      act(() => { realtimeMock.emit(snapshot(frame(name), v)); });
      const expected = ['manual', 'accept-edits', 'plan', 'auto'][index];
      await waitFor(() => expect(result.current.terminal.agentMode).toBe(expected));
    }
  });

  it('drops the mode when the session stops', async () => {
    // The pane a killed agent leaves behind still shows the last footer it drew.
    // Reporting it would let the chip outlive the agent it describes.
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, cliToolId: 'claude', fullOutput: frame('claude-plan') }),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.terminal.agentMode).toBe('plan'));

    act(() => {
      realtimeMock.emit({
        type: 'session_status_changed',
        worktreeId: 'w-1',
        isRunning: false,
        cliTool: 'claude',
        instance: 'claude',
      });
    });

    await waitFor(() => expect(result.current.terminal.agentMode).toBe('unknown'));
  });
});
