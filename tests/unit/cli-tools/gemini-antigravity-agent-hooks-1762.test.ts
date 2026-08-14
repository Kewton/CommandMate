/**
 * What `startSession` now does for gemini and antigravity (Issue #1762).
 *
 * Three things, and all three are invisible to the source-level tests:
 *
 *  1. **The generation fence.** `beginAgentSession` on the creation path, before
 *     the pane exists, and even when the launch then fails. Forgetting it is the
 *     defect Epic #1720 names as the most likely one to ship: every unit test
 *     stays green and the symptom is a brand-new session reporting `running`
 *     because it inherited the *previous* process's last event under the same
 *     (worktree, tool, instance) key.
 *  2. **The config write**, into `<worktree>/.gemini/settings.json` for gemini
 *     and `~/.gemini/config/hooks.json` for agy.
 *  3. **The launch command**, which is where the instance correlation lives for
 *     both tools.
 *
 * Everything runs under a temporary `HOME` (`os.homedir()` reads `$HOME` on
 * POSIX), because agy's config is a single global file and a suite that wrote
 * the real one would edit the developer's own agent configuration.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { getAgentEventGenerationStartedAt } from '@/lib/session/agent-event-state';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

const GEMINI_READY = '>\n';
const AGY_READY = '? for shortcuts';

const dirs: string[] = [];
let home: string;
let worktree: string;

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** Drive a `startSession` that polls, without waiting for real time. */
async function runStart(start: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    const promise = start();
    await vi.advanceTimersByTimeAsync(40_000);
    await promise;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(async () => {
  home = makeTempDir('cmate-1762-start-home-');
  worktree = makeTempDir('cmate-1762-start-wt-');
  vi.stubEnv('HOME', home);
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  vi.clearAllMocks();
  // `clearAllMocks` clears calls, not implementations, so a `mockResolvedValue`
  // from an earlier test would leak into the next one — which for `hasSession`
  // means every later session silently takes the reuse path.
  const { createSession, hasSession, sendKeys } = await import('@/lib/tmux/tmux');
  vi.mocked(hasSession).mockResolvedValue(false);
  vi.mocked(createSession).mockResolvedValue(undefined);
  vi.mocked(sendKeys).mockResolvedValue(undefined);
  // The event state hangs off globalThis, so a generation left by an earlier
  // file in this worker would make the fence assertions pass for free.
  globalThis.__agentEventGenerationStartedAt?.clear();
  globalThis.__agentEventLast?.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('GeminiTool.startSession', () => {
  let tool: GeminiTool;

  beforeEach(async () => {
    tool = new GeminiTool();
    vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
    const { capturePane } = await import('@/lib/tmux/tmux');
    vi.mocked(capturePane).mockResolvedValue(GEMINI_READY);
  });

  it('opens a generation for the instance it is creating', async () => {
    // Mutation 5: delete `beginAgentSession` from gemini.ts and this goes red.
    expect(getAgentEventGenerationStartedAt('wt-g', 'gemini', 'gemini')).toBeNull();

    await runStart(() => tool.startSession('wt-g', worktree));

    expect(getAgentEventGenerationStartedAt('wt-g', 'gemini', 'gemini')).not.toBeNull();
  });

  it('fences the named instance and leaves its sibling alone', async () => {
    await runStart(() => tool.startSession('wt-g', worktree, 'gemini-2'));

    expect(getAgentEventGenerationStartedAt('wt-g', 'gemini', 'gemini-2')).not.toBeNull();
    expect(getAgentEventGenerationStartedAt('wt-g', 'gemini', 'gemini')).toBeNull();
  });

  it('does NOT fence on the reuse path', async () => {
    // A `startSession` that finds a healthy pane and returns is the same
    // generation; fencing there would discard a still-valid verdict on every
    // reconnect.
    const { hasSession } = await import('@/lib/tmux/tmux');
    vi.mocked(hasSession).mockResolvedValue(true);

    await tool.startSession('wt-g', worktree);

    expect(getAgentEventGenerationStartedAt('wt-g', 'gemini', 'gemini')).toBeNull();
  });

  it('fences even when the launch fails', async () => {
    // Falling back to the screen scraper is always safe; trusting a dead
    // session's events is not.
    const { createSession } = await import('@/lib/tmux/tmux');
    vi.mocked(createSession).mockRejectedValueOnce(new Error('tmux gone'));

    await expect(tool.startSession('wt-g', worktree)).rejects.toThrow(/Failed to start Gemini/);

    expect(getAgentEventGenerationStartedAt('wt-g', 'gemini', 'gemini')).not.toBeNull();
  });

  it('writes the worktree’s settings.json and launches with the correlation URL', async () => {
    const { sendKeys } = await import('@/lib/tmux/tmux');

    await runStart(() => tool.startSession('wt-g', worktree, 'gemini-2'));

    const settingsPath = join(worktree, '.gemini', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    expect(readFileSync(settingsPath, 'utf8')).toContain(`--worktree-id 'wt-g'`);

    const command = vi.mocked(sendKeys).mock.calls[0][1];
    expect(command).toContain('tool=gemini&worktreeId=wt-g&instanceId=gemini-2');
    expect(command.endsWith(` 'gemini'`)).toBe(true);
  });

  it('starts anyway when the settings file cannot be written', async () => {
    const { sendKeys } = await import('@/lib/tmux/tmux');

    // A worktree path that does not exist and cannot be created.
    await runStart(() => tool.startSession('wt-g', join(worktree, 'missing', 'deeper')));

    expect(sendKeys).toHaveBeenCalled();
  });

  it('launches the bare command under CM_AGENT_HOOKS_INJECT=0', async () => {
    vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
    const { sendKeys } = await import('@/lib/tmux/tmux');

    await runStart(() => tool.startSession('wt-g', worktree));

    expect(sendKeys).toHaveBeenCalledWith('mcbd-gemini-wt-g', 'gemini', true);
    expect(existsSync(join(worktree, '.gemini', 'settings.json'))).toBe(false);
    // The fence is not part of the rollback: it costs nothing and protects the
    // scraper path too.
    expect(getAgentEventGenerationStartedAt('wt-g', 'gemini', 'gemini')).not.toBeNull();
  });
});

describe('AntigravityTool.startSession', () => {
  let tool: AntigravityTool;

  beforeEach(async () => {
    tool = new AntigravityTool();
    vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
    const { capturePane } = await import('@/lib/tmux/tmux');
    vi.mocked(capturePane).mockResolvedValue(AGY_READY);
  });

  it('opens a generation for the instance it is creating', async () => {
    // Mutation 5, the antigravity half.
    expect(getAgentEventGenerationStartedAt('wt-a', 'antigravity', 'antigravity')).toBeNull();

    await runStart(() => tool.startSession('wt-a', worktree));

    expect(getAgentEventGenerationStartedAt('wt-a', 'antigravity', 'antigravity')).not.toBeNull();
  });

  it('does NOT fence on the reuse path', async () => {
    const { hasSession } = await import('@/lib/tmux/tmux');
    vi.mocked(hasSession).mockResolvedValue(true);

    await tool.startSession('wt-a', worktree);

    expect(getAgentEventGenerationStartedAt('wt-a', 'antigravity', 'antigravity')).toBeNull();
  });

  it('fences even when the launch fails', async () => {
    const { createSession } = await import('@/lib/tmux/tmux');
    vi.mocked(createSession).mockRejectedValueOnce(new Error('tmux gone'));

    await expect(tool.startSession('wt-a', worktree)).rejects.toThrow(/Failed to start Antigravity/);

    expect(getAgentEventGenerationStartedAt('wt-a', 'antigravity', 'antigravity')).not.toBeNull();
  });

  it('writes the global hooks.json and launches with the correlation URL', async () => {
    const { sendKeys } = await import('@/lib/tmux/tmux');

    await runStart(() => tool.startSession('wt-a', worktree, 'antigravity-2'));

    const hooksPath = join(home, '.gemini', 'config', 'hooks.json');
    expect(existsSync(hooksPath)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(hooksPath, 'utf8')))).toEqual(['commandmate']);

    const command = vi.mocked(sendKeys).mock.calls[0][1];
    // The only channel agy has: its payload carries no cwd and its config file
    // is shared by every worktree on the machine.
    expect(command).toContain('tool=antigravity&worktreeId=wt-a&instanceId=antigravity-2');
    expect(command.endsWith(` 'agy'`)).toBe(true);
  });

  it('keeps --model after the executable so the env prefix stays in front', async () => {
    const { sendKeys } = await import('@/lib/tmux/tmux');

    await runStart(() =>
      tool.startSession('wt-a', worktree, undefined, "model'; rm -rf ~ #")
    );

    const command = vi.mocked(sendKeys).mock.calls[0][1];
    expect(command.startsWith('CM_HOOK_URL=')).toBe(true);
    // Issue #989's escaping is unchanged by the prefix.
    expect(command.endsWith(`'agy' --model 'model'\\''; rm -rf ~ #'`)).toBe(true);
  });

  it('launches the bare command under CM_AGENT_HOOKS_INJECT=0', async () => {
    vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
    const { sendKeys } = await import('@/lib/tmux/tmux');

    await runStart(() => tool.startSession('wt-a', worktree, undefined, 'Gemini 3.1 Pro (High)'));

    expect(sendKeys).toHaveBeenCalledWith(
      'mcbd-antigravity-wt-a',
      "agy --model 'Gemini 3.1 Pro (High)'",
      true
    );
    expect(existsSync(join(home, '.gemini', 'config', 'hooks.json'))).toBe(false);
  });
});
