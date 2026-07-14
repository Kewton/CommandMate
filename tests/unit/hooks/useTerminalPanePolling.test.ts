/**
 * Tests for useTerminalPanePolling hook (Issue #728, R3-005)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';

type MockFetchResponse = {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
};

const okJson = (data: unknown): Promise<MockFetchResponse> =>
  Promise.resolve({ ok: true, json: async () => data });

function getUrlString(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe('useTerminalPanePolling', () => {
  let mockFetch: ReturnType<typeof vi.fn<(input: string | URL | Request) => Promise<MockFetchResponse>>>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches /current-output for its own cliToolId on mount', async () => {
    mockFetch.mockImplementation((input) => {
      const url = new URL(getUrlString(input), 'http://localhost');
      expect(url.searchParams.get('cliTool')).toBe('codex');
      return okJson({ isRunning: true, fullOutput: 'codex output', thinking: false });
    });
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'codex' }),
    );
    await waitFor(() => expect(result.current.terminal.output).toBe('codex output'));
    expect(result.current.terminal.isRunning).toBe(true);
    expect(result.current.terminal.attaching).toBe(false);
    // At least one call was made.
    expect(mockFetch).toHaveBeenCalled();
  });

  it('starts with attaching=true and flips to false after the first response', async () => {
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: false, fullOutput: '', thinking: false }),
    );
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    expect(result.current.terminal.attaching).toBe(true);
    await waitFor(() => expect(result.current.terminal.attaching).toBe(false));
  });

  it('drops stale responses when cliToolId changes mid-flight', async () => {
    let resolveClaude: ((res: MockFetchResponse) => void) | undefined;
    const claudePromise = new Promise<MockFetchResponse>((res) => {
      resolveClaude = res;
    });
    mockFetch.mockImplementation((input) => {
      const url = new URL(getUrlString(input), 'http://localhost');
      const cli = url.searchParams.get('cliTool');
      if (cli === 'claude') return claudePromise;
      return okJson({ isRunning: true, fullOutput: 'codex final', thinking: false });
    });

    const { result, rerender } = renderHook(
      ({ cli }: { cli: 'claude' | 'codex' }) =>
        useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: cli }),
      { initialProps: { cli: 'claude' as 'claude' | 'codex' } },
    );

    // Swap to codex before claude resolves.
    rerender({ cli: 'codex' });
    await waitFor(() => expect(result.current.terminal.output).toBe('codex final'));

    // Stale claude resolves AFTER. Should be ignored.
    await act(async () => {
      resolveClaude?.({
        ok: true,
        json: async () => ({ isRunning: true, fullOutput: 'claude stale', thinking: true }),
      });
      await Promise.resolve();
    });

    expect(result.current.terminal.output).toBe('codex final');
    expect(result.current.terminal.isThinking).toBe(false);
  });

  it('updates prompt state when isPromptWaiting=true and clears it on the next idle response', async () => {
    let phase: 'wait' | 'idle' = 'wait';
    mockFetch.mockImplementation(() => {
      if (phase === 'wait') {
        return okJson({
          isRunning: true,
          fullOutput: '',
          thinking: false,
          isPromptWaiting: true,
          promptData: { type: 'yes_no', question: 'Continue?' },
        });
      }
      return okJson({ isRunning: true, fullOutput: 'done', thinking: false });
    });
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.prompt.visible).toBe(true));
    phase = 'idle';
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.prompt.visible).toBe(false));
  });

  it('exposes refresh() that triggers an immediate fetch', async () => {
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: false, fullOutput: 'first', thinking: false }),
    );
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.terminal.output).toBe('first'));
    mockFetch.mockClear();
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: false, fullOutput: 'second', thinking: false }),
    );
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.terminal.output).toBe('second');
  });

  it('requires consecutive unclassified snapshots and resets when a prompt is found', async () => {
    mockFetch.mockImplementation(() => okJson({
      isRunning: true,
      fullOutput: 'unknown TUI',
      isUnclassifiedActive: true,
    }));
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );

    await waitFor(() => expect(result.current.terminal.attaching).toBe(false));
    expect(result.current.terminal.isUnclassifiedActive).toBe(false);

    await new Promise(resolve => setTimeout(resolve, 550));
    await act(async () => result.current.refresh());
    expect(result.current.terminal.isUnclassifiedActive).toBe(true);

    mockFetch.mockImplementation(() => okJson({
      isRunning: true,
      fullOutput: 'permission prompt',
      isUnclassifiedActive: true,
      isPromptWaiting: true,
      promptData: { type: 'yes_no', question: 'Continue?' },
    }));
    await act(async () => result.current.refresh());
    expect(result.current.terminal.isUnclassifiedActive).toBe(false);
    expect(result.current.prompt.visible).toBe(true);
  });

  it('does not fetch when enabled=false', async () => {
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: false, fullOutput: 'never', thinking: false }),
    );
    renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude', enabled: false }),
    );
    // Yield a microtask so any synchronous fetch would land.
    await Promise.resolve();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Issue #842: kill / natural-termination must clear residual output.
  it('clears output when the session stops (isRunning:false + empty content)', async () => {
    let phase: 'running' | 'stopped' = 'running';
    mockFetch.mockImplementation(() => {
      if (phase === 'running') {
        return okJson({ isRunning: true, fullOutput: 'live output', thinking: false });
      }
      // Mirrors current-output route's stopped response: no fullOutput / realtimeSnippet.
      return okJson({ isRunning: false, content: '', thinking: false });
    });
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.terminal.output).toBe('live output'));
    phase = 'stopped';
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.terminal.output).toBe(''));
    expect(result.current.terminal.isRunning).toBe(false);
  });

  // Issue #842: a running session that keeps returning content must NOT flicker to empty.
  it('keeps output across polls while the session stays running (no flicker)', async () => {
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, fullOutput: 'steady output', thinking: false }),
    );
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.terminal.output).toBe('steady output'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.terminal.output).toBe('steady output');
    expect(result.current.terminal.isRunning).toBe(true);
  });

  it('resets output/attaching/prompt when (worktreeId, cliToolId) changes', async () => {
    mockFetch.mockImplementation((input) => {
      const url = new URL(getUrlString(input), 'http://localhost');
      const cli = url.searchParams.get('cliTool') ?? 'claude';
      return okJson({
        isRunning: true,
        fullOutput: `${cli} output`,
        thinking: false,
      });
    });
    const { result, rerender } = renderHook(
      ({ cli }: { cli: 'claude' | 'codex' }) =>
        useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: cli }),
      { initialProps: { cli: 'claude' as 'claude' | 'codex' } },
    );
    await waitFor(() => expect(result.current.terminal.output).toBe('claude output'));

    rerender({ cli: 'codex' });
    // Between rerender and first codex fetch, the hook clears output and sets attaching=true.
    // Then within waitFor the new fetch resolves.
    await waitFor(() => expect(result.current.terminal.output).toBe('codex output'));
    expect(result.current.terminal.attaching).toBe(false);
  });
});
