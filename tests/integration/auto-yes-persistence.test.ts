/**
 * Integration tests for auto-yes state persistence across module reloads
 *
 * Issue #153: Auto-Yes UI state inconsistency
 *
 * This test verifies that auto-yes state persists when the module is
 * reloaded (simulating Next.js hot reload or worker restart).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Import types to leverage globalThis declarations from auto-yes-manager.ts
// The module already declares global types for __autoYesStates and __autoYesPollerStates

describe('Auto-Yes State Persistence (Issue #153)', () => {
  beforeEach(() => {
    // Clear globalThis state before each test
    delete globalThis.__autoYesStates;
    delete globalThis.__autoYesPollerStates;
    // Reset module cache to simulate fresh module load
    vi.resetModules();
  });

  afterEach(() => {
    // Cleanup
    vi.resetModules();
  });

  test('should persist auto-yes state after module reload', async () => {
    // 1. Initial module load - set state
    const { setAutoYesEnabled, getAutoYesState, clearAllAutoYesStates, clearAllPollerStates } =
      await import('@/lib/auto-yes-manager');

    // Clear any existing state
    clearAllAutoYesStates();
    clearAllPollerStates();

    // Set auto-yes enabled for a worktree
    setAutoYesEnabled('test-worktree-reload', true);

    // Verify state is set
    const stateBeforeReload = getAutoYesState('test-worktree-reload');
    expect(stateBeforeReload?.enabled).toBe(true);

    // 2. Simulate module reload
    vi.resetModules();

    // 3. Reimport the module
    const { getAutoYesState: getAutoYesStateAfter } =
      await import('@/lib/auto-yes-manager');

    // 4. Verify state persists after reload
    const stateAfterReload = getAutoYesStateAfter('test-worktree-reload');
    expect(stateAfterReload?.enabled).toBe(true);
  });

  test('should persist poller state after module reload', async () => {
    // 1. Initial module load
    const {
      setAutoYesEnabled,
      startAutoYesPolling,
      getActivePollerCount,
      clearAllAutoYesStates,
      clearAllPollerStates,
      stopAllAutoYesPolling,
    } = await import('@/lib/auto-yes-manager');

    // Clear any existing state
    clearAllAutoYesStates();
    clearAllPollerStates();

    // Enable auto-yes and start polling
    setAutoYesEnabled('test-poller-reload', true);
    const result = startAutoYesPolling('test-poller-reload', 'claude');
    expect(result.started).toBe(true);
    expect(getActivePollerCount()).toBe(1);

    // 2. Simulate module reload
    vi.resetModules();

    // 3. Reimport the module
    const { getActivePollerCount: getActivePollerCountAfter, stopAllAutoYesPolling: stopAllAfter } =
      await import('@/lib/auto-yes-manager');

    // 4. Verify poller state persists
    expect(getActivePollerCountAfter()).toBe(1);

    // Cleanup
    stopAllAfter();
  });

  test('should use same globalThis Map instance across module reloads', async () => {
    // 1. Initial module load
    const { setAutoYesEnabled, clearAllAutoYesStates, clearAllPollerStates } =
      await import('@/lib/auto-yes-manager');

    // Clear any existing state
    clearAllAutoYesStates();
    clearAllPollerStates();

    // Set state and capture globalThis reference
    setAutoYesEnabled('test-reference', true);
    const mapRefBefore = globalThis.__autoYesStates;
    expect(mapRefBefore).toBeInstanceOf(Map);

    // 2. Simulate module reload
    vi.resetModules();

    // 3. Reimport and access state
    await import('@/lib/auto-yes-manager');

    // 4. Verify same Map instance is used
    const mapRefAfter = globalThis.__autoYesStates;
    expect(mapRefAfter).toBe(mapRefBefore);
  });

  test('should correctly clear state after module reload', async () => {
    // 1. Initial module load - set state
    const { setAutoYesEnabled, clearAllAutoYesStates, clearAllPollerStates } =
      await import('@/lib/auto-yes-manager');

    clearAllAutoYesStates();
    clearAllPollerStates();

    setAutoYesEnabled('test-clear-reload', true);
    expect(globalThis.__autoYesStates?.has('test-clear-reload')).toBe(true);

    // 2. Simulate module reload
    vi.resetModules();

    // 3. Reimport and clear
    const { clearAllAutoYesStates: clearAfter, getAutoYesState: getAfter } =
      await import('@/lib/auto-yes-manager');

    clearAfter();

    // 4. Verify state is cleared
    expect(getAfter('test-clear-reload')).toBeNull();
    expect(globalThis.__autoYesStates?.size).toBe(0);
  });

  test('should initialize globalThis Maps on first module load', async () => {
    // Ensure globalThis is clean
    expect(globalThis.__autoYesStates).toBeUndefined();
    expect(globalThis.__autoYesPollerStates).toBeUndefined();

    // Import module
    await import('@/lib/auto-yes-manager');

    // Verify Maps are initialized
    expect(globalThis.__autoYesStates).toBeInstanceOf(Map);
    expect(globalThis.__autoYesPollerStates).toBeInstanceOf(Map);
  });

  // Issue #225 [Stage 3 SF-004]: Custom duration persistence across module reload
  test('should persist 3-hour duration in-memory state after module reload', async () => {
    // 1. Initial module load - set state with custom 3-hour duration
    const { setAutoYesEnabled, getAutoYesState, clearAllAutoYesStates, clearAllPollerStates } =
      await import('@/lib/auto-yes-manager');

    // Clear any existing state
    clearAllAutoYesStates();
    clearAllPollerStates();

    // Set auto-yes enabled with 3-hour duration (10800000ms)
    const stateBeforeReload = setAutoYesEnabled('test-duration-reload', true, 10800000);
    expect(stateBeforeReload.enabled).toBe(true);
    const expectedExpiresAt = stateBeforeReload.expiresAt;

    // Verify expiresAt reflects 3-hour duration (not default 1-hour)
    expect(expectedExpiresAt - stateBeforeReload.enabledAt).toBe(10800000);

    // 2. Simulate module reload
    vi.resetModules();

    // 3. Reimport the module
    const { getAutoYesState: getAutoYesStateAfter } =
      await import('@/lib/auto-yes-manager');

    // 4. Verify state persists with correct expiresAt after reload
    const stateAfterReload = getAutoYesStateAfter('test-duration-reload');
    expect(stateAfterReload?.enabled).toBe(true);
    expect(stateAfterReload?.expiresAt).toBe(expectedExpiresAt);
  });
});
