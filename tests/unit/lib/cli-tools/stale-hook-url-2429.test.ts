/**
 * An adopted pane whose hooks are addressed to a dead server says so
 * (Issue #2429, 副).
 *
 * ## What it is about
 *
 * `CM_HOOK_URL` is written onto the launch line by the server that starts the
 * agent, and it is the whole correlation channel: it names the port every
 * lifecycle event is posted to. A tmux session outlives the server that made
 * it, so a pane started by a server on :3010 and later adopted by one on :3000
 * — `reconcileExistingSession` repairs the window geometry and nothing else —
 * keeps posting to :3010. Measured 2026-09-08: every `commandmate wait` on that
 * session held for #1975's full 60 s and completed `basis=scraper_ready` with
 * `Its hooks are not answering`, and nothing on any surface said why.
 *
 * ## What is pinned
 *
 * The reading (a real launch line, ANSI intact, and the newest of two when a
 * pane carries both), the comparison, and the two properties the Issue's
 * acceptance names: it warns **once**, and it does **not** kill the session.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const capturePane = vi.fn();
const reconcileSessionGeometry = vi.fn().mockResolvedValue(false);
vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: (...args: unknown[]) => capturePane(...args),
  reconcileSessionGeometry: (...args: unknown[]) => reconcileSessionGeometry(...args),
  getSessionWorkingDirectory: vi.fn(),
  sendSpecialKey: vi.fn(),
}));

const getServerPort = vi.fn(() => 3000);
// Partial: `logger` reads `getLogConfig` from the same module, and a total mock
// would turn every log line in the code under test into a thrown error.
vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env')>()),
  getServerPort: () => getServerPort(),
}));

const notifyStaleHookUrlPush = vi.fn().mockResolvedValue(undefined);
const notifySessionStartFailurePush = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/push/failure-push-notifier', () => ({
  notifyStaleHookUrlPush: (...args: unknown[]) => notifyStaleHookUrlPush(...args),
  notifySessionStartFailurePush: (...args: unknown[]) => notifySessionStartFailurePush(...args),
}));

import {
  BaseCLITool,
  hookUrlPort,
  readLaunchLineHookUrl,
} from '@/lib/cli-tools/base';
import {
  reportStaleHookUrl,
  resetStaleHookUrlReportsForTest,
} from '@/lib/cli-tools/start-availability';
import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * The pane of the session the Issue was reported from, shortened.
 *
 * Verbatim from the report — single-quoted assignments, `CM_PORT` beside the
 * URL, the executable last — because the reader is a scrollback and not a
 * parser, and a hand-tidied line would not prove it reads the real one.
 */
const ADOPTED_PANE = [
  '$ ',
  "CM_HOOK_URL='http://127.0.0.1:3010/api/hooks/agent-event?tool=command-code&worktreeId=rag-document&instanceId=command-code' CM_PORT='3010' 'commandcode' --trust --skip-onboarding --no-auto-update",
  '# Command Code v1.49.0',
  '❯ Ask your question...',
].join('\n');

/** The same pane after #2070 relaunched the tool: the old line, then the new. */
const RELAUNCHED_PANE = [
  ADOPTED_PANE,
  "CM_HOOK_URL='http://127.0.0.1:3000/api/hooks/agent-event?tool=command-code&worktreeId=rag-document&instanceId=command-code' CM_PORT='3000' 'commandcode'",
].join('\n');

/**
 * The shape of every tool's `launchSession`, reduced to the branch that matters.
 *
 * The reuse branch calls `reconcileExistingSession` and returns; the create
 * branch does not. That call is the adopt marker, so a stub that skipped it
 * would be testing a path production never takes.
 */
class TestTool extends BaseCLITool {
  readonly id: CLIToolType = 'command-code';
  readonly name = 'Command Code CLI';
  readonly command = 'commandcode';
  /** False to take the create branch instead of the reuse branch. */
  adopts = true;
  /** Set by a test that wants the launch to throw. */
  launchError: Error | null = null;

  async isRunning(): Promise<boolean> {
    return true;
  }
  protected async launchSession(worktreeId: string, _path: string, instanceId?: string): Promise<void> {
    if (this.adopts) await this.reconcileExistingSession(this.getSessionName(worktreeId, instanceId));
    if (this.launchError) throw this.launchError;
  }
  async sendMessage(): Promise<void> {}
  async killSession(): Promise<void> {
    killed = true;
  }
}

let killed = false;

/** Let `reportStaleHookUrl`'s `await import()` and its `.then` settle. */
async function settleNotification(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  killed = false;
  getServerPort.mockReturnValue(3000);
  capturePane.mockResolvedValue(ADOPTED_PANE);
  resetStaleHookUrlReportsForTest();
});

describe('[#2429] reading CM_HOOK_URL off a pane', () => {
  it('reads the launch line the report captured', () => {
    expect(readLaunchLineHookUrl(ADOPTED_PANE)).toBe(
      'http://127.0.0.1:3010/api/hooks/agent-event?tool=command-code&worktreeId=rag-document&instanceId=command-code',
    );
  });

  it('takes the NEWEST assignment when a relaunch left two', () => {
    // Taking the first would report a mismatch this server had already fixed.
    expect(hookUrlPort(readLaunchLineHookUrl(RELAUNCHED_PANE) ?? '')).toBe(3000);
  });

  it('reads through the pane colouring', () => {
    const coloured = `\x1b[38;5;60m${ADOPTED_PANE}\x1b[39m`;
    expect(hookUrlPort(readLaunchLineHookUrl(coloured) ?? '')).toBe(3010);
  });

  it('accepts the double-quoted and bare spellings too', () => {
    expect(readLaunchLineHookUrl('CM_HOOK_URL="http://127.0.0.1:9/x" agy')).toBe(
      'http://127.0.0.1:9/x',
    );
    expect(readLaunchLineHookUrl('CM_HOOK_URL=http://127.0.0.1:8/x agy')).toBe(
      'http://127.0.0.1:8/x',
    );
  });

  it('answers null for a pane that carries no assignment', () => {
    // claude and opencode keep their endpoint out of the launch line entirely,
    // so this is the ordinary answer for them and must not warn.
    expect(readLaunchLineHookUrl('$ claude --settings /tmp/s.json\n❯ ')).toBeNull();
  });

  it('fills in the scheme default rather than calling a portless URL unreadable', () => {
    expect(hookUrlPort('http://127.0.0.1/api/hooks/agent-event')).toBe(80);
    expect(hookUrlPort('https://example.test/api/hooks/agent-event')).toBe(443);
    expect(hookUrlPort('not a url')).toBeNull();
  });
});

describe('[#2429] the warning a start raises', () => {
  it('reports the port mismatch once, and does not kill the session', async () => {
    const tool = new TestTool();

    await tool.startSession('rag-document', '/tmp/rag-document');
    await settleNotification();

    expect(notifyStaleHookUrlPush).toHaveBeenCalledTimes(1);
    expect(notifyStaleHookUrlPush).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'rag-document',
        cliToolId: 'command-code',
        toolName: 'Command Code CLI',
        sessionPort: 3010,
        serverPort: 3000,
      }),
    );
    // The whole point of warning instead of repairing: the adopted session may
    // be mid-turn.
    expect(killed).toBe(false);

    await tool.startSession('rag-document', '/tmp/rag-document');
    await settleNotification();

    expect(notifyStaleHookUrlPush).toHaveBeenCalledTimes(1);
  });

  it('does not read the pane at all when the launch CREATED the session', async () => {
    // The line this server just typed is the answer, so asking tmux for it
    // would put a full-scrollback capture in front of every session start.
    const tool = new TestTool();
    tool.adopts = false;

    await tool.startSession('wt-created', '/tmp/wt-created');
    await settleNotification();

    expect(capturePane).not.toHaveBeenCalled();
    expect(notifyStaleHookUrlPush).not.toHaveBeenCalled();
  });

  it('says nothing when the launch line names this server', async () => {
    capturePane.mockResolvedValue(RELAUNCHED_PANE);

    await new TestTool().startSession('wt-matching', '/tmp/wt-matching');
    await settleNotification();

    expect(notifyStaleHookUrlPush).not.toHaveBeenCalled();
  });

  it('says nothing when the pane carries no hook URL', async () => {
    capturePane.mockResolvedValue('$ claude\n❯ ');

    await new TestTool().startSession('wt-no-url', '/tmp/wt-no-url');
    await settleNotification();

    expect(notifyStaleHookUrlPush).not.toHaveBeenCalled();
  });

  it('never fails a start because the pane could not be captured', async () => {
    capturePane.mockRejectedValue(new Error("can't find pane"));

    await expect(
      new TestTool().startSession('wt-capture-fails', '/tmp/wt-capture-fails'),
    ).resolves.toBeUndefined();
    expect(notifyStaleHookUrlPush).not.toHaveBeenCalled();
  });

  it('does not probe a launch that threw — the failure was already reported', async () => {
    const tool = new TestTool();
    tool.launchError = new Error('Failed to start Command Code session');

    await expect(tool.startSession('wt-threw', '/tmp/wt-threw')).rejects.toThrow(
      'Failed to start Command Code session',
    );
    await settleNotification();

    expect(capturePane).not.toHaveBeenCalled();
    expect(notifyStaleHookUrlPush).not.toHaveBeenCalled();
    expect(notifySessionStartFailurePush).toHaveBeenCalledTimes(1);

    // And the mark it left is not inherited by the next start: that launch
    // adopts on its own account or it does not.
    tool.launchError = null;
    tool.adopts = false;
    await tool.startSession('wt-threw', '/tmp/wt-threw');
    await settleNotification();

    expect(capturePane).not.toHaveBeenCalled();
  });
});

describe('[#2429] reportStaleHookUrl reports each mismatch once', () => {
  const REPORT = {
    worktreeId: 'rag-document',
    cliToolId: 'command-code' as const,
    instanceId: 'command-code',
    toolName: 'Command Code CLI',
    sessionPort: 3010,
    serverPort: 3000,
  };

  /** One report, settled — the shape a start actually produces. */
  async function report(overrides: Partial<typeof REPORT> = {}): Promise<void> {
    reportStaleHookUrl({ ...REPORT, ...overrides });
    await settleNotification();
  }

  it('drops the repeat of a mismatch it has already told', async () => {
    await report();
    await report();

    expect(notifyStaleHookUrlPush).toHaveBeenCalledTimes(1);
  });

  it('tells a DIFFERENT mismatch, and each instance separately', async () => {
    // Keyed on the facts rather than on the session, so a pane that moves to a
    // third server — or the one it was pointing at coming back — is a different
    // sentence and gets said.
    await report();
    await report({ sessionPort: 3011 });
    await report({ instanceId: 'command-code-2' });

    expect(notifyStaleHookUrlPush).toHaveBeenCalledTimes(3);
  });
});
