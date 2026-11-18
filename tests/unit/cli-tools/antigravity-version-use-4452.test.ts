/**
 * Issue #4452: a launch or a send to antigravity is "using antigravity", after
 * which its version may be read (the agents version list, the catalog). Nothing
 * here runs agy: tmux is mocked and the launch is refused at the install check.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/logger', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { createLogger: () => ({ ...log, withContext: () => log }) };
});

import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import {
  hasAntigravityBeenUsed,
  mayProbeToolVersion,
  resetAntigravityUseForTest,
} from '@/lib/tool-policy/version-probe-gate';

/** Reaches the protected launch, with agy reported as not installed. */
class NotInstalledAntigravity extends AntigravityTool {
  override async isInstalled(): Promise<boolean> {
    return false;
  }
  launch(worktreeId: string, worktreePath: string): Promise<void> {
    return this.launchSession(worktreeId, worktreePath);
  }
}

beforeEach(() => resetAntigravityUseForTest());
afterEach(() => resetAntigravityUseForTest());

describe('[#4452] antigravity use marks its version as readable', () => {
  it('4452: nothing is marked before antigravity is used', () => {
    expect(hasAntigravityBeenUsed()).toBe(false);
    expect(mayProbeToolVersion('antigravity', {})).toBe(false);
  });

  it('4452: a launch marks the use (even one refused at the install check)', async () => {
    await expect(new NotInstalledAntigravity().launch('wt-4452', '/nonexistent-4452')).rejects.toThrow();
    expect(hasAntigravityBeenUsed()).toBe(true);
    expect(mayProbeToolVersion('antigravity', {})).toBe(true);
  });

  it('4452: a send marks the use', async () => {
    await expect(new AntigravityTool().sendMessage('wt-4452', 'hello')).rejects.toThrow(/does not exist/);
    expect(hasAntigravityBeenUsed()).toBe(true);
  });

  it('4452: the declaration allows the probe without a use; other tools are never gated', () => {
    expect(mayProbeToolVersion('antigravity', { CM_ANTIGRAVITY_USAGE: 'api-key' })).toBe(true);
    expect(mayProbeToolVersion('antigravity', { CM_ANTIGRAVITY_USAGE: 'enterprise' })).toBe(true);
    expect(mayProbeToolVersion('antigravity', { CM_ANTIGRAVITY_USAGE: 'personal' })).toBe(false);
    for (const tool of ['claude', 'codex', 'opencode', 'opencode-v2', 'copilot', 'gemini', 'command-code']) {
      expect(mayProbeToolVersion(tool, {})).toBe(true);
    }
  });
});
