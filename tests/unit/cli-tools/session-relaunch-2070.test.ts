/**
 * Issue #2070 — the reuse branch of `launchSession` relaunches a dead tool.
 *
 * `startSession` short-circuits on `hasSession`, so a tmux session that outlived
 * its agent — codex's "1. Update now" replaces codex with `npm install` and
 * exits, `Ctrl+C` twice quits it, a crash does the same — was never relaunched.
 * The next `send` then died in `waitForPrompt` with `kill-session` by hand as
 * the only recovery, which is the defect this Issue was filed for.
 *
 * The two directions are asserted separately, and the ALIVE direction is the
 * one that matters most: re-sending a launch command into a live pane types
 * `codex` into the agent's composer.
 *
 * The recovery is reached from `sendMessage`, not from `isRunning` — see
 * `BaseCLITool.relaunchIfToolExited` for the three callers that read `isRunning`
 * as "does the pane exist?" and would break if it were narrowed.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn(),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  // Issue #2070: the relaunch asks the PANE where it is, not the database.
  getSessionWorkingDirectory: vi.fn().mockResolvedValue('/tmp/wt'),
}));

vi.mock('@/lib/session/agent-session-lifecycle', () => ({
  beginAgentSession: vi.fn(),
  buildAgentLaunchCommandLine: vi.fn().mockReturnValue('codex'),
}));

vi.mock('@/lib/cli-tools/validation', () => ({ validateSessionName: vi.fn() }));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

// BaseCLITool.isInstalled() uses promisify(exec); resolve it so it is true.
vi.mock('child_process', () => ({ exec: vi.fn() }));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return { ...actual, promisify: () => vi.fn().mockResolvedValue(undefined) };
});

import { CodexTool } from '@/lib/cli-tools/codex';
import { hasSession, createSession, sendKeys, capturePane } from '@/lib/tmux/tmux';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { beginAgentSession } from '@/lib/session/agent-session-lifecycle';
import { LIVENESS_CONFIRM_DELAY_MS } from '@/config/cli-tool-timing-config';

const FIXTURES = path.join(process.cwd(), 'tests/fixtures/tool-liveness-2070');
const frame = (name: string): string =>
  fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf-8');

const READY = frame('codex-ready-01491');
const EXITED = frame('codex-exited-01491');

const WORKTREE_ID = 'wt-2070';
const SESSION = 'mcbd-codex-wt-2070';

/**
 * Runs `startSession` with timers faked, so the two confirmation reads and the
 * launch polling do not spend real seconds.
 *
 * `waitForReady` polls up to 30 times with a 1 s sleep between; the fixture
 * makes the first poll succeed, so only the confirm delay has to be advanced.
 */
async function startWithFakeTimers(tool: CodexTool): Promise<void> {
  vi.useFakeTimers();
  try {
    const started = tool.startSession(WORKTREE_ID, '/tmp/wt');
    // The confirm delay, then codex's own CODEX_INIT_WAIT_MS (3 s) and one poll.
    await vi.advanceTimersByTimeAsync(LIVENESS_CONFIRM_DELAY_MS + 6_000);
    await started;
  } finally {
    vi.useRealTimers();
  }
}

describe('[#2070] CodexTool.launchSession reuse branch', () => {
  let tool: CodexTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new CodexTool();
    vi.mocked(hasSession).mockResolvedValue(true);
  });

  it('leaves a LIVE session alone — no launch command, no session fence', async () => {
    vi.mocked(capturePane).mockResolvedValue(READY);

    await tool.startSession(WORKTREE_ID, '/tmp/wt');

    expect(createSession).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
    // Fencing a live session would discard the running process's own events.
    expect(beginAgentSession).not.toHaveBeenCalled();
  });

  it('re-sends the launch command into the SAME pane when the tool has exited', async () => {
    // Two exited readings (the probe and its confirmation), then the pane codex
    // paints once the re-sent launch line runs.
    vi.mocked(capturePane)
      .mockResolvedValueOnce(EXITED)
      .mockResolvedValueOnce(EXITED)
      .mockResolvedValue(READY);

    await startWithFakeTimers(tool);

    // The pane is reused, not recreated: the transcript of the process that
    // died in it is the operator's evidence of what happened.
    expect(createSession).not.toHaveBeenCalled();
    expect(sendKeys).toHaveBeenCalledWith(SESSION, 'codex', true);
    // A new process under the same (worktree, tool, instance) key — the dead
    // one's structured events must not be read as this one's (#1760/#1723).
    expect(beginAgentSession).toHaveBeenCalledTimes(1);
  });

  it('requires TWO readings before relaunching, so a booting pane is safe', async () => {
    // The measured hazard: between `createSession` and the launch line landing,
    // a pane legitimately shows nothing but a shell prompt. A concurrent
    // `startSession` reading that once would type `codex` into the agent that
    // is about to paint over it.
    vi.mocked(capturePane).mockResolvedValueOnce(EXITED).mockResolvedValue(READY);

    await startWithFakeTimers(tool);

    expect(sendKeys).not.toHaveBeenCalled();
    expect(beginAgentSession).not.toHaveBeenCalled();
  });
});

describe('[#2070] CodexTool.sendMessage self-heals', () => {
  let tool: CodexTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new CodexTool();
    vi.mocked(hasSession).mockResolvedValue(true);
  });

  it('relaunches, then sends, when the pane has fallen back to the shell', async () => {
    // The reported symptom: `has-session` says yes, so the send route never
    // starts anything, and `waitForPrompt` then times out with `kill-session` by
    // hand as the only recovery.
    // The pane shows the shell until the re-sent launch line runs — which is
    // what makes this a model of the real sequence rather than a fixed script.
    vi.mocked(capturePane).mockImplementation(async () =>
      vi.mocked(sendKeys).mock.calls.length > 0 ? READY : EXITED
    );

    vi.useFakeTimers();
    try {
      const sending = tool.sendMessage(WORKTREE_ID, 'hello');
      await vi.advanceTimersByTimeAsync(LIVENESS_CONFIRM_DELAY_MS + 6_000);
      await sending;
    } finally {
      vi.useRealTimers();
    }

    expect(sendKeys).toHaveBeenCalledWith(SESSION, 'codex', true);
    expect(sendMessageWithSubmitVerification).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: SESSION, message: 'hello' })
    );
  });

  it('does not relaunch a live session — one capture, no launch command', async () => {
    vi.mocked(capturePane).mockResolvedValue(READY);

    await tool.sendMessage(WORKTREE_ID, 'hello');

    // One for the liveness filter, one for codex's own `waitForPrompt`. The
    // happy path must not pay the confirmation delay.
    expect(vi.mocked(capturePane).mock.calls).toHaveLength(2);
    expect(sendKeys).not.toHaveBeenCalled();
    expect(beginAgentSession).not.toHaveBeenCalled();
    expect(sendMessageWithSubmitVerification).toHaveBeenCalled();
  });

  it('leaves `isRunning` meaning "the pane exists", which three callers rely on', async () => {
    // `POST .../terminal` (404s the view), `POST .../kill-session` and
    // `killWorktreeSession` (both skip a target whose `isRunning` is false, so
    // Stop would do nothing and repository cleanup would leak the session) all
    // read this as "does the pane exist?". Narrowing it here would break the
    // three of them, so the recovery hangs off the send instead.
    vi.mocked(capturePane).mockResolvedValue(EXITED);

    expect(await tool.isRunning(WORKTREE_ID)).toBe(true);
    expect(capturePane).not.toHaveBeenCalled();
  });
});
