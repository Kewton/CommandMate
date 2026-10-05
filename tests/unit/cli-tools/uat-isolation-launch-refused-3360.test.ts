/**
 * Issue #3360: a launch refused under `CM_UAT_ISOLATION=1` leaves no tmux
 * session behind.
 *
 * codex's and antigravity's launch plans throw `UatIsolationLaunchRefusedError`
 * when the shared hooks file cannot be used as it is. The plan used to be built
 * AFTER the tmux session was created, so a refusal left an empty pane that
 * `isRunning()` reported as a started agent — and the next send with a model
 * was refused as "already running" (send/route.ts).
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
vi.mock('@/lib/cli-tools/validation', () => ({ validateSessionName: vi.fn() }));
vi.mock('child_process', () => ({
  exec: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '      --no-daemon\n', stderr: '' })),
}));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return { ...actual, promisify: () => vi.fn().mockResolvedValue(undefined) };
});

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { UAT_ISOLATION_ENV_VAR } from '@/config/uat-isolation';
import { CodexTool } from '@/lib/cli-tools/codex';
import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import { createSession, sendKeys } from '@/lib/tmux/tmux';
import { resetCodexNoDaemonSupportCacheForTests } from '@/lib/hooks/sources/codex/hooks-config';

const WORKTREE_ID = 'wt-uat-3360';
const WORKTREE_PATH = '/tmp/wt-uat-3360';
const MANAGED_ENV = [UAT_ISOLATION_ENV_VAR, 'CODEX_HOME', 'HOME', 'CM_AGENT_HOOKS_INJECT', 'CM_PORT'] as const;

let saved: Record<string, string | undefined>;
let scratch: string;

beforeEach(() => {
  vi.clearAllMocks();
  sessions.clear();
  resetCodexNoDaemonSupportCacheForTests();
  saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  // Empty homes: no shared hooks file exists, which isolation refuses.
  scratch = mkdtempSync(join(tmpdir(), 'uat-launch-refused-'));
  process.env.CODEX_HOME = join(scratch, 'codex-home');
  process.env.HOME = join(scratch, 'home');
  process.env.CM_PORT = '4321';
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  removeTempDir(scratch);
});

const TOOLS = [
  { name: 'codex', make: () => new CodexTool() },
  { name: 'antigravity', make: () => new AntigravityTool() },
] as const;

describe.each(TOOLS)('$name: a launch refused under CM_UAT_ISOLATION=1', ({ name, make }) => {
  it('creates no tmux session, so isRunning() stays false', async () => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';
    const tool = make();

    await expect(tool.startSession(WORKTREE_ID, WORKTREE_PATH)).rejects.toThrow(
      new RegExp(`refusing to start ${name}`)
    );

    expect(vi.mocked(createSession)).not.toHaveBeenCalled();
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(await tool.isRunning(WORKTREE_ID)).toBe(false);
  });

  it('negative control: unset, the session is created and the agent launched', async () => {
    const tool = make();
    // Stop right after the launch line is typed: the launch is what is asserted,
    // not the readiness poll that follows it.
    vi.mocked(sendKeys).mockRejectedValueOnce(new Error('stop after launch'));

    await expect(tool.startSession(WORKTREE_ID, WORKTREE_PATH)).rejects.toThrow(/stop after launch/);

    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendKeys)).toHaveBeenCalled();
    expect(await tool.isRunning(WORKTREE_ID)).toBe(true);
  });
});
