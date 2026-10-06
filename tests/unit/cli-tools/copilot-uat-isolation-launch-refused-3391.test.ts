/**
 * Issue #3391: a copilot launch refused under `CM_UAT_ISOLATION=1` leaves no
 * tmux session behind — the same rule #3360 set for codex and antigravity.
 *
 * copilot's launch plan used to be built AFTER the tmux session was created;
 * now that it can throw `UatIsolationLaunchRefusedError`, a refusal at that
 * point would leave an empty pane that `isRunning()` reports as a started
 * copilot.
 *
 * tmux is a fake whose `hasSession` answers from what `createSession` made, so
 * `isRunning()` reads back the session the tool really created.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));

const sessions = new Set<string>();
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(async (name: string) => sessions.has(name)),
  createSession: vi.fn(async ({ sessionName }: { sessionName: string }) => {
    sessions.add(sessionName);
  }),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/validation', () => ({ validateSessionName: vi.fn() }));
vi.mock('@/lib/cli-tools/copilot-executable', () => ({
  resolveCopilotExecutable: vi.fn(async () => ({ path: '/usr/local/bin/copilot', source: 'path', version: '1.0.80' })),
}));

import { mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { UAT_ISOLATION_ENV_VAR } from '@/config/uat-isolation';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { createSession, sendKeys } from '@/lib/tmux/tmux';

const WORKTREE_ID = 'wt-uat-3391';
const WORKTREE_PATH = '/tmp/wt-uat-3391';
const MANAGED_ENV = [UAT_ISOLATION_ENV_VAR, 'COPILOT_HOME', 'CM_AGENT_HOOKS_INJECT', 'CM_PORT'] as const;

let saved: Record<string, string | undefined>;
let copilotHome: string;

beforeEach(() => {
  vi.clearAllMocks();
  sessions.clear();
  saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  // An empty copilot home: no shared settings.json exists, which isolation refuses.
  copilotHome = mkdtempSync(join(tmpdir(), 'uat-3391-copilot-'));
  process.env.COPILOT_HOME = copilotHome;
  process.env.CM_PORT = '4321';
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  removeTempDir(copilotHome);
});

describe('copilot: a launch refused under CM_UAT_ISOLATION=1 (Issue #3391)', () => {
  it('creates no tmux session and writes nothing, so isRunning() stays false', async () => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';
    const tool = new CopilotTool();

    await expect(tool.startSession(WORKTREE_ID, WORKTREE_PATH)).rejects.toThrow(/refusing to start copilot/);

    expect(vi.mocked(createSession)).not.toHaveBeenCalled();
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(await tool.isRunning(WORKTREE_ID)).toBe(false);
    expect(readdirSync(copilotHome)).toEqual([]);
  });

  it('negative control: unset, the session is created, settings.json written and copilot launched', async () => {
    const tool = new CopilotTool();
    // Stop right after the launch line is typed: the launch is what is asserted,
    // not the readiness poll that follows it.
    vi.mocked(sendKeys).mockRejectedValueOnce(new Error('stop after launch'));

    await expect(tool.startSession(WORKTREE_ID, WORKTREE_PATH)).rejects.toThrow(/stop after launch/);

    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendKeys)).toHaveBeenCalled();
    expect(await tool.isRunning(WORKTREE_ID)).toBe(true);
    expect(readdirSync(copilotHome)).toContain('settings.json');
  });
});
