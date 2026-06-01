/**
 * Tests for useSplitMessages hook (Issue #744)
 *
 * Per-(worktreeId, cliToolId) message-history polling for the PC split layout.
 * Each split's HistoryPane uses one of these so split 0 (Claude) and split 1
 * (Codex) fetch their own /messages independently and display only their own
 * CLI's messages — simultaneously.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSplitMessages } from '@/hooks/useSplitMessages';

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

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: `msg-${Math.random()}`,
    worktreeId: 'w-1',
    role: 'user',
    content: 'hello',
    timestamp: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    messageType: 'normal',
    archived: false,
    ...overrides,
  };
}

describe('useSplitMessages (Issue #744)', () => {
  let mockFetch: ReturnType<
    typeof vi.fn<(input: string | URL | Request) => Promise<MockFetchResponse>>
  >;

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

  it('fetches /messages with its own cliToolId on mount', async () => {
    const seen: Array<{ cli: string | null }> = [];
    mockFetch.mockImplementation((input) => {
      const url = new URL(getUrlString(input), 'http://localhost');
      seen.push({ cli: url.searchParams.get('cliTool') });
      return okJson([makeMessage({ content: 'codex msg' })]);
    });

    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'codex' }),
    );

    await waitFor(() => expect(result.current.messages.length).toBe(1));
    expect(result.current.messages[0].content).toBe('codex msg');
    expect(seen.some((c) => c.cli === 'codex')).toBe(true);
  });

  it('builds the URL with cliTool, limit, and includeArchived params', async () => {
    let capturedUrl: URL | null = null;
    mockFetch.mockImplementation((input) => {
      capturedUrl = new URL(getUrlString(input), 'http://localhost');
      return okJson([]);
    });

    renderHook(() =>
      useSplitMessages({
        worktreeId: 'w-9',
        cliToolId: 'claude',
        limit: 150,
        includeArchived: true,
      }),
    );

    await waitFor(() => expect(capturedUrl).not.toBeNull());
    const url = capturedUrl as unknown as URL;
    expect(url.pathname).toBe('/api/worktrees/w-9/messages');
    expect(url.searchParams.get('cliTool')).toBe('claude');
    expect(url.searchParams.get('limit')).toBe('150');
    expect(url.searchParams.get('includeArchived')).toBe('true');
  });

  it('omits includeArchived when false', async () => {
    let capturedUrl: URL | null = null;
    mockFetch.mockImplementation((input) => {
      capturedUrl = new URL(getUrlString(input), 'http://localhost');
      return okJson([]);
    });

    renderHook(() =>
      useSplitMessages({
        worktreeId: 'w-1',
        cliToolId: 'claude',
        includeArchived: false,
      }),
    );

    await waitFor(() => expect(capturedUrl).not.toBeNull());
    const url = capturedUrl as unknown as URL;
    expect(url.searchParams.get('includeArchived')).toBeNull();
  });

  it('parses ISO timestamp strings into Date objects', async () => {
    mockFetch.mockImplementation(() =>
      okJson([makeMessage({ timestamp: '2024-05-01T12:00:00.000Z' })]),
    );
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.messages.length).toBe(1));
    expect(result.current.messages[0].timestamp).toBeInstanceOf(Date);
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
      return okJson([makeMessage({ content: 'codex final' })]);
    });

    const { result, rerender } = renderHook(
      ({ cli }: { cli: 'claude' | 'codex' }) =>
        useSplitMessages({ worktreeId: 'w-1', cliToolId: cli }),
      { initialProps: { cli: 'claude' as 'claude' | 'codex' } },
    );

    rerender({ cli: 'codex' });
    await waitFor(() =>
      expect(result.current.messages[0]?.content).toBe('codex final'),
    );

    // Stale claude resolves AFTER; it must be ignored.
    await act(async () => {
      resolveClaude?.({
        ok: true,
        json: async () => [makeMessage({ content: 'claude stale' })],
      });
      await Promise.resolve();
    });

    expect(result.current.messages[0]?.content).toBe('codex final');
  });

  it('does not fetch when enabled=false', async () => {
    mockFetch.mockImplementation(() => okJson([makeMessage()]));
    renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude', enabled: false }),
    );
    await Promise.resolve();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('pauses polling while the document is hidden', async () => {
    mockFetch.mockImplementation(() => okJson([makeMessage()]));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    vi.useFakeTimers();
    renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    // Advance well past the polling interval while hidden — no fetch should fire.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(mockFetch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('exposes refresh() that triggers an immediate fetch', async () => {
    mockFetch.mockImplementation(() =>
      okJson([makeMessage({ content: 'first' })]),
    );
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() =>
      expect(result.current.messages[0]?.content).toBe('first'),
    );
    mockFetch.mockClear();
    mockFetch.mockImplementation(() =>
      okJson([makeMessage({ content: 'second' })]),
    );
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.messages[0]?.content).toBe('second');
  });

  it('resets messages and re-fetches when (worktreeId, cliToolId) changes', async () => {
    mockFetch.mockImplementation((input) => {
      const url = new URL(getUrlString(input), 'http://localhost');
      const cli = url.searchParams.get('cliTool') ?? 'claude';
      return okJson([makeMessage({ content: `${cli} msg` })]);
    });
    const { result, rerender } = renderHook(
      ({ cli }: { cli: 'claude' | 'codex' }) =>
        useSplitMessages({ worktreeId: 'w-1', cliToolId: cli }),
      { initialProps: { cli: 'claude' as 'claude' | 'codex' } },
    );
    await waitFor(() =>
      expect(result.current.messages[0]?.content).toBe('claude msg'),
    );
    rerender({ cli: 'codex' });
    await waitFor(() =>
      expect(result.current.messages[0]?.content).toBe('codex msg'),
    );
  });
});
