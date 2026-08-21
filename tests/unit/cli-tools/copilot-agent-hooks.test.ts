/**
 * `CopilotTool.startSession` and the two lines Issue #1761 adds to it.
 *
 * Both are the kind of defect that leaves every other test green:
 *
 *  - **The generation fence.** Without `beginAgentSession()` the events of the
 *    copilot process that just died stay keyed under the same (worktree, tool,
 *    instance) triple as the one starting up, so the old process's last
 *    `user_prompt_submit` is read as the new one's and a session nobody has
 *    typed into publishes `running` (#1723). Nothing errors. The source's own
 *    unit tests pass. `docs/design/agent-event-source-interface.md` calls this
 *    the most likely defect in the whole phase, which is why it has a test of
 *    its own here rather than a comment in the implementation.
 *  - **The launch command.** `prepareAgentLaunch` is what puts the correlation
 *    keys into the agent's environment. Drop it and the settings file is still
 *    written, the hooks still fire, and every event lands on the primary
 *    instance of whatever worktree the `cwd` resolves to.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { getAgentEventGenerationStartedAt } from '@/lib/session/agent-event-state';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  // Matches COPILOT_PROMPT_PATTERN, so `waitForReady` returns on its first poll.
  capturePane: vi.fn().mockResolvedValue('> '),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

const WORKTREE_ID = 'wt-copilot-hooks';
const WORKTREE_PATH = '/repos/wt-copilot-hooks';

let home: string;
let tool: CopilotTool;

/**
 * Drive `startSession` past its fixed init sleep without waiting for it.
 *
 * The rejection is captured the moment the promise is created and re-thrown
 * afterwards. Attaching the handler later — i.e. `await`ing only once the
 * timers have run — lets a failing launch reject while nothing is listening,
 * and vitest reports that as an unhandled rejection: a non-zero exit code with
 * every test still reported green.
 */
async function startSession(instanceId?: string): Promise<void> {
  vi.useFakeTimers();
  try {
    let failure: unknown;
    const started = tool
      .startSession(WORKTREE_ID, WORKTREE_PATH, instanceId)
      .catch((error: unknown) => {
        failure = error;
      });
    await vi.advanceTimersByTimeAsync(60_000);
    await started;
    if (failure !== undefined) throw failure;
  } finally {
    vi.useRealTimers();
  }
}

/** The line `startSession` sent to the pane — `sendKeys(sessionName, command)`. */
async function sentCommand(): Promise<string> {
  const { sendKeys } = await import('@/lib/tmux/tmux');
  return String(vi.mocked(sendKeys).mock.calls.at(-1)?.[1]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  home = mkdtempSync(join(tmpdir(), 'cmate-copilot-start-'));
  process.env.COPILOT_HOME = home;
  delete process.env.CM_AGENT_HOOKS_INJECT;
  // Issue #1904 puts the receiving port on the launch line, so the line this
  // file asserts byte-for-byte would otherwise depend on the developer's own
  // `CM_PORT`.
  vi.stubEnv('CM_PORT', '3210');

  // The event state hangs off globalThis, so a generation left by an earlier
  // file in this worker would make the fence assertions pass for free.
  globalThis.__agentEventGenerationStartedAt?.clear();
  globalThis.__agentEventLast?.clear();

  // `clearAllMocks` forgets calls but keeps implementations, so a test that
  // made `createSession` reject would leave it rejecting for the rest of the
  // file. The defaults are restated here rather than relied on from the factory.
  const tmux = await import('@/lib/tmux/tmux');
  vi.mocked(tmux.hasSession).mockResolvedValue(false);
  vi.mocked(tmux.createSession).mockResolvedValue(undefined);
  vi.mocked(tmux.sendKeys).mockResolvedValue(undefined);
  vi.mocked(tmux.capturePane).mockResolvedValue('> ');

  const { execFile } = await import('child_process');
  vi.mocked(execFile).mockImplementation(
    (_command: string, _args: unknown, _options: unknown, callback?: unknown) => {
      (callback as (e: Error | null, o: string, s: string) => void)?.(null, 'ok', '');
      return {} as import('child_process').ChildProcess;
    }
  );

  tool = new CopilotTool();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.COPILOT_HOME;
  delete process.env.CM_AGENT_HOOKS_INJECT;
  removeTempDir(home);
});

describe('the generation fence', () => {
  it('is opened for the instance being created', async () => {
    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, 'copilot', 'copilot-2')).toBeNull();

    await startSession('copilot-2');

    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, 'copilot', 'copilot-2')).toBeGreaterThan(0);
  });

  it('is opened for the primary instance when none is named', async () => {
    await startSession();

    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, 'copilot', 'copilot')).toBeGreaterThan(0);
  });

  it('fences the instance that is starting and no other', async () => {
    await startSession('copilot-2');

    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, 'copilot', 'copilot')).toBeNull();
    expect(getAgentEventGenerationStartedAt('other-wt', 'copilot', 'copilot-2')).toBeNull();
  });

  it('is opened before the pane exists, so no live pane meets a stale fence', async () => {
    const { createSession } = await import('@/lib/tmux/tmux');
    let fenceAtPaneCreation: number | null = null;
    vi.mocked(createSession).mockImplementation(async () => {
      fenceAtPaneCreation = getAgentEventGenerationStartedAt(WORKTREE_ID, 'copilot', 'copilot');
    });

    await startSession();

    expect(fenceAtPaneCreation).toBeGreaterThan(0);
  });

  it('is opened even when the launch then fails', async () => {
    // Falling back to the screen scraper is always safe; trusting a dead
    // session's events is not. So the fence is outside the try.
    const { createSession } = await import('@/lib/tmux/tmux');
    vi.mocked(createSession).mockRejectedValue(new Error('tmux refused'));

    await expect(startSession()).rejects.toThrow(/Failed to start Copilot session/);

    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, 'copilot', 'copilot')).toBeGreaterThan(0);
  });

  it('is not opened when an existing session is reused', async () => {
    // The reuse path is the same generation by construction; fencing there
    // would discard a still-valid verdict on every reconnect.
    const { hasSession, createSession } = await import('@/lib/tmux/tmux');
    vi.mocked(hasSession).mockResolvedValue(true);

    await startSession();

    expect(vi.mocked(createSession)).not.toHaveBeenCalled();
    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, 'copilot', 'copilot')).toBeNull();
  });
});

describe('the launch command', () => {
  it('carries the correlation keys into the agent’s environment', async () => {
    await startSession('copilot-2');

    expect(await sentCommand()).toBe(
      `CM_AGENT_WORKTREE_ID='${WORKTREE_ID}' CM_AGENT_INSTANCE_ID='copilot-2' ` +
        `CM_HOOK_PORT='3210' gh copilot`
    );
  });

  it('writes copilot’s settings.json on the way', async () => {
    await startSession('copilot-2');

    expect(existsSync(join(home, 'settings.json'))).toBe(true);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  it('is byte-for-byte the pre-#1761 command when injection is switched off', async () => {
    process.env.CM_AGENT_HOOKS_INJECT = '0';

    await startSession('copilot-2');

    expect(await sentCommand()).toBe('gh copilot');
    expect(existsSync(join(home, 'settings.json'))).toBe(false);
  });

  it('still starts the session when the config cannot be written', async () => {
    // Injection is an enhancement to a session that has to start anyway.
    process.env.COPILOT_HOME = join(home, 'settings.json', 'nested');
    const { writeFileSync } = await import('fs');
    writeFileSync(join(home, 'settings.json'), 'not a directory');

    await startSession();

    expect(await sentCommand()).toBe('gh copilot');
  });
});
