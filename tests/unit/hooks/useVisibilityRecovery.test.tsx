/**
 * Unit tests for useVisibilityRecovery (Issue #923).
 *
 * Verifies the page-visibility background recovery extracted from
 * useWorktreeDetailController (Issue #246, #266):
 *  - visible + no error  -> lightweight parallel re-fetch, then setError(null)
 *  - visible + error     -> full recovery via handleRetry only
 *  - hidden              -> no-op
 *  - rapid re-fire       -> throttled (RECOVERY_THROTTLE_MS = 5000ms)
 *  - unmount             -> listener removed
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVisibilityRecovery } from '@/hooks/useVisibilityRecovery';
import type { Worktree } from '@/types/models';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

async function fireVisibilityChange() {
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    // Flush the async handler's Promise.all + finally.
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeParams(overrides: Partial<Parameters<typeof useVisibilityRecovery>[0]> = {}) {
  return {
    error: null as string | null,
    handleRetry: vi.fn(),
    fetchWorktree: vi.fn<() => Promise<Worktree | null>>().mockResolvedValue(null),
    fetchMessages: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    fetchCurrentOutput: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    setError: vi.fn(),
    ...overrides,
  };
}

describe('useVisibilityRecovery (Issue #923)', () => {
  beforeEach(() => {
    setVisibility('visible');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('visible + no error: parallel re-fetch then setError(null)', async () => {
    const params = makeParams();
    renderHook(() => useVisibilityRecovery(params));

    await fireVisibilityChange();

    expect(params.fetchWorktree).toHaveBeenCalledTimes(1);
    expect(params.fetchMessages).toHaveBeenCalledTimes(1);
    expect(params.fetchCurrentOutput).toHaveBeenCalledTimes(1);
    expect(params.setError).toHaveBeenCalledWith(null);
    expect(params.handleRetry).not.toHaveBeenCalled();
  });

  it('visible + error: full recovery via handleRetry only', async () => {
    const params = makeParams({ error: 'boom' });
    renderHook(() => useVisibilityRecovery(params));

    await fireVisibilityChange();

    expect(params.handleRetry).toHaveBeenCalledTimes(1);
    expect(params.fetchWorktree).not.toHaveBeenCalled();
    expect(params.fetchMessages).not.toHaveBeenCalled();
    expect(params.fetchCurrentOutput).not.toHaveBeenCalled();
  });

  it('hidden: no-op', async () => {
    setVisibility('hidden');
    const params = makeParams();
    renderHook(() => useVisibilityRecovery(params));

    await fireVisibilityChange();

    expect(params.fetchWorktree).not.toHaveBeenCalled();
    expect(params.handleRetry).not.toHaveBeenCalled();
    expect(params.setError).not.toHaveBeenCalled();
  });

  it('throttles a rapid second fire within RECOVERY_THROTTLE_MS', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const params = makeParams();
    renderHook(() => useVisibilityRecovery(params));

    // First fire at t=10000 runs.
    nowSpy.mockReturnValue(10000);
    await fireVisibilityChange();
    expect(params.fetchWorktree).toHaveBeenCalledTimes(1);

    // Second fire at t=12000 (2000ms < 5000ms) is throttled.
    nowSpy.mockReturnValue(12000);
    await fireVisibilityChange();
    expect(params.fetchWorktree).toHaveBeenCalledTimes(1);

    // Third fire at t=16000 (6000ms > 5000ms) runs again.
    nowSpy.mockReturnValue(16000);
    await fireVisibilityChange();
    expect(params.fetchWorktree).toHaveBeenCalledTimes(2);
  });

  it('removes the listener on unmount', async () => {
    const params = makeParams();
    const { unmount } = renderHook(() => useVisibilityRecovery(params));

    unmount();
    await fireVisibilityChange();

    expect(params.fetchWorktree).not.toHaveBeenCalled();
  });
});
