/**
 * useWorktreesCache: hidden mount starts no timer; a reply from before hidden
 * does not overwrite the read made on coming back (Issue #4190).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWorktreesCache } from '@/hooks/useWorktreesCache';

vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: () => ({
    status: 'disconnected' as const,
    connected: false,
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: () => () => {},
  }),
}));

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

const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;

function reply(ids: string[]): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: 'http://localhost/api/worktrees',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ worktrees: ids.map((id) => ({ id, name: id })), repositories: [] }),
  } as unknown as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  setVisibility('visible');
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  restoreVisibility();
});

describe('useWorktreesCache hidden (Issue #4190)', () => {
  it('starts no poll timer when enabled while hidden; refreshes once on visible', async () => {
    setVisibility('hidden');
    mockFetch.mockResolvedValue(reply(['a']));
    renderHook(() => useWorktreesCache());
    await tick(200_000);
    const hiddenCalls = mockFetch.mock.calls.length;
    expect(hiddenCalls).toBe(1); // the initial load only, no interval

    await switchTo('visible');
    expect(mockFetch.mock.calls.length).toBe(hiddenCalls + 1);
  });

  it('control: a visible mount keeps polling', async () => {
    mockFetch.mockResolvedValue(reply(['a']));
    renderHook(() => useWorktreesCache());
    await tick(200_000);
    expect(mockFetch.mock.calls.length).toBeGreaterThan(2);
  });

  it('does not let a reply from before hidden overwrite the one after coming back', async () => {
    let releaseOld: (r: Response) => void = () => {};
    mockFetch.mockImplementationOnce(() => new Promise<Response>((res) => { releaseOld = res; }));
    mockFetch.mockResolvedValue(reply(['new']));
    const { result } = renderHook(() => useWorktreesCache());
    await tick(0);

    await switchTo('hidden');
    await switchTo('visible'); // asks again; answers 'new'
    expect(result.current.worktrees.map((w) => w.id)).toEqual(['new']);

    await act(async () => {
      releaseOld(reply(['old']));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.worktrees.map((w) => w.id)).toEqual(['new']);
  });
});
