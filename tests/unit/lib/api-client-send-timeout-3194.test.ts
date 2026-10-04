/**
 * The screen's send waits out an agent launch (Issue #3194).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { worktreeApi } from '@/lib/api-client';
import { API_MUTATION_TIMEOUT_MS, getSendTimeoutMs } from '@/config/api-timeout-config';
import {
  getSessionStartingMaxMs,
  getSessionStartingMaxMsAcrossTools,
} from '@/config/session-starting-config';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

function mockFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 201,
      redirected: false,
      url: 'http://localhost/api/worktrees/wt-1/send',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ id: 'm', timestamp: '2026-09-01T10:20:30.000Z' }),
    } as unknown as Response),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('[#3194] send timeout vs agent launch', () => {
  it('is longer than every tool launch wait', () => {
    for (const tool of CLI_TOOL_IDS) {
      expect(getSendTimeoutMs()).toBeGreaterThan(getSessionStartingMaxMs(tool));
    }
    expect(getSessionStartingMaxMsAcrossTools()).toBe(getSessionStartingMaxMs('claude'));
  });

  it('is applied to the send request, which stays a single attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await worktreeApi.sendMessage('wt-1', 'hi');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls.some(([, ms]) => ms === getSendTimeoutMs())).toBe(true);
    spy.mockRestore();
  });

  it('leaves other writes at the 30 s default (negative control)', async () => {
    vi.useFakeTimers();
    mockFetch();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await worktreeApi.killSession('wt-1').catch(() => undefined);
    expect(API_MUTATION_TIMEOUT_MS).toBe(30_000);
    expect(spy.mock.calls.some(([, ms]) => ms === getSendTimeoutMs())).toBe(false);
    expect(spy.mock.calls.some(([, ms]) => ms === API_MUTATION_TIMEOUT_MS)).toBe(true);
    spy.mockRestore();
  });
});
