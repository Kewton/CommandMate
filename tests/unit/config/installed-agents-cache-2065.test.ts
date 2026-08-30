/**
 * The cached installed-tools probe (Issue #2065; the rule comes from #1913).
 *
 * `getAllToolsInfo()` runs one child process per CLI tool. The rule this cache
 * exists to keep is "never `await isInstalled()` on a hot path", and the way a
 * cache silently stops keeping it is by being bypassed under concurrency or by
 * never expiring. Both are asserted here; the value it returns is the least
 * interesting thing about it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllToolsInfo: vi.fn(),
}));

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getAllToolsInfo: mocks.getAllToolsInfo }),
  },
}));

import {
  clearInstalledAgentsCache,
  getInstalledAgentIds,
  INSTALLED_AGENTS_CACHE_TTL_MS,
} from '@/config/installed-agents-cache';

const TOOLS = [
  { id: 'claude', name: 'Claude', command: 'claude', installed: true },
  { id: 'codex', name: 'Codex', command: 'codex', installed: false },
  { id: 'gemini', name: 'Gemini', command: 'gemini', installed: true },
];

describe('installed-agents cache (Issue #2065 / #1913)', () => {
  beforeEach(() => {
    clearInstalledAgentsCache();
    mocks.getAllToolsInfo.mockReset();
    mocks.getAllToolsInfo.mockResolvedValue(TOOLS);
  });

  afterEach(() => {
    clearInstalledAgentsCache();
  });

  it('returns only the installed ids', async () => {
    await expect(getInstalledAgentIds()).resolves.toEqual(['claude', 'gemini']);
  });

  it('probes once for repeated calls inside the TTL', async () => {
    await getInstalledAgentIds();
    await getInstalledAgentIds();
    await getInstalledAgentIds();
    expect(mocks.getAllToolsInfo).toHaveBeenCalledTimes(1);
  });

  it('shares ONE probe between concurrent callers', async () => {
    // The bypass a plain TTL cache has: nothing is cached yet, so N callers each
    // start their own fan-out of child processes.
    await Promise.all([
      getInstalledAgentIds(),
      getInstalledAgentIds(),
      getInstalledAgentIds(),
    ]);
    expect(mocks.getAllToolsInfo).toHaveBeenCalledTimes(1);
  });

  it('re-probes once the TTL has passed, so a fresh install shows up', async () => {
    const t0 = Date.now();
    await getInstalledAgentIds(t0);
    await getInstalledAgentIds(t0 + INSTALLED_AGENTS_CACHE_TTL_MS + 1);
    expect(mocks.getAllToolsInfo).toHaveBeenCalledTimes(2);
  });

  it('answers [] rather than throwing when the probe fails', async () => {
    mocks.getAllToolsInfo.mockRejectedValue(new Error('spawn ENOENT'));
    await expect(getInstalledAgentIds()).resolves.toEqual([]);
  });

  it('does not retry a failed probe on every call', async () => {
    mocks.getAllToolsInfo.mockRejectedValue(new Error('spawn ENOENT'));
    await getInstalledAgentIds();
    await getInstalledAgentIds();
    expect(mocks.getAllToolsInfo).toHaveBeenCalledTimes(1);
  });

  it('clearInstalledAgentsCache() forces the next call to probe', async () => {
    await getInstalledAgentIds();
    clearInstalledAgentsCache();
    await getInstalledAgentIds();
    expect(mocks.getAllToolsInfo).toHaveBeenCalledTimes(2);
  });
});
