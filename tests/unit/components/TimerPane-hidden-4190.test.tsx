/**
 * TimerPane: hidden mount starts no timers; stale replies are not adopted (Issue #4190).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import React from 'react';
import { TimerPane } from '@/components/worktree/TimerPane';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';

const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
}
async function switchTo(state: DocumentVisibilityState): Promise<void> {
  setVisibility(state);
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
  });
}
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
function restoreVisibility(): void {
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
  else delete (document as unknown as Record<string, unknown>).hidden;
}

const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ timers: [], hasMore: false }) });
  vi.stubGlobal('fetch', fetchMock);
  setVisibility('visible');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  restoreVisibility();
});

const mount = () => render(<ConfirmProvider><TimerPane worktreeId="wt-1" /></ConfirmProvider>);

describe('TimerPane hidden (Issue #4190)', () => {
  it('asks nothing when mounted hidden, reads once and resumes on visible', async () => {
    setVisibility('hidden');
    mount();
    await tick(30_000);
    expect(fetchMock).not.toHaveBeenCalled();

    await switchTo('visible');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const after = fetchMock.mock.calls.length;
    await tick(30_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(after);
  });

  it('control: a visible mount fetches immediately and polls', async () => {
    mount();
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(30_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('a reply from before hidden does not overwrite the one after coming back', async () => {
    let releaseOld: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((res) => { releaseOld = res; }));
    const timer = (id: string) => ({
      id, cliToolId: 'claude', instanceId: 'claude', message: `msg-${id}`, delayMs: 1,
      scheduledSendTime: 9_999_999_999_999, status: 'pending', createdAt: 1, sentAt: null, error: null,
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ timers: [timer('new')], hasMore: false }) });
    const { container } = mount();
    await tick(0);
    await switchTo('hidden');
    await switchTo('visible');
    expect(container.textContent).toContain('msg-new');

    await act(async () => {
      releaseOld({ ok: true, json: async () => ({ timers: [timer('old')], hasMore: false }) });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.textContent).toContain('msg-new');
    expect(container.textContent).not.toContain('msg-old');
  });
});
