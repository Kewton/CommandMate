/**
 * Issue #3790: copilot's launch answers its folder-trust dialog inside a launch
 * window (`cli-tools/launch-window`), as gemini's does (#3776), and records the
 * `1` it pressed, so the Auto-Yes poller leaves the dialog to it instead of
 * answering `1` + Enter beside it.
 *
 * Positive control: before #3790 copilot's launch opened no window and
 * recorded no key.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { buildCopilotFolderTrustFrame, buildCopilotReadyFrame } from '@tests/fixtures/copilot-folder-trust-1080';
import {
  clearLaunchWindows,
  isLaunchDialogPressSettling,
  isLaunchWindowOpen,
} from '@/lib/cli-tools/launch-window';

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
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

// Issue #1907: `startSession` now refuses to launch without a copilot that
// answered `--version`, and that probe walks the real PATH. Stubbed so these
// frames are what the tests turn on, not whether the runner has copilot.
vi.mock('@/lib/cli-tools/copilot-executable', () => ({
  resolveCopilotExecutable: vi.fn(),
}));

import { CopilotTool } from '@/lib/cli-tools/copilot';
import { resolveCopilotExecutable } from '@/lib/cli-tools/copilot-executable';
import { hasSession, sendKeys, capturePane } from '@/lib/tmux/tmux';

const WORKTREE_ID = 'wt-copilot-trust';
const WORKTREE_PATH = '/repos/wt-copilot-trust';
const SESSION = 'mcbd-copilot-wt-copilot-trust';

const TRUST_FRAME = buildCopilotFolderTrustFrame();
const READY_FRAME = buildCopilotReadyFrame();

let home: string;
let tool: CopilotTool;

/**
 * Run one of the polling loops to completion under fake timers.
 *
 * The rejection handler is attached the moment the promise is created: adding
 * it only after the timers have run lets a failure reject while nothing is
 * listening, which vitest reports as an unhandled rejection — a non-zero exit
 * with every test still green.
 */
async function runWithTimers(start: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    let failure: unknown;
    const running = start().catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(90_000);
    await running;
    if (failure !== undefined) throw failure;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearLaunchWindows();

  // Keep the hook-settings writer off the operator's real ~/.copilot.
  home = mkdtempSync(join(tmpdir(), 'cmate-copilot-trust-'));
  process.env.COPILOT_HOME = home;
  delete process.env.CM_AGENT_HOOKS_INJECT;

  // `clearAllMocks` forgets calls but keeps implementations, so the defaults are
  // restated rather than relied on from the factory.
  vi.mocked(hasSession).mockResolvedValue(false);
  vi.mocked(sendKeys).mockResolvedValue(undefined);
  vi.mocked(capturePane).mockResolvedValue(READY_FRAME);
  vi.mocked(resolveCopilotExecutable).mockResolvedValue({
    path: '/usr/local/bin/copilot',
    version: '1.0.80',
    source: 'path',
  });

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
  clearLaunchWindows();
  delete process.env.COPILOT_HOME;
  removeTempDir(home);
});

describe('[#3790] copilot launch window', () => {
  it('is open when the launch answers the dialog, records the `1`, and closes once the launch returns', async () => {
    let openAtAnswer: boolean | null = null;
    let answered = false;
    vi.mocked(sendKeys).mockImplementation(async (_session: string, keys: string) => {
      if (keys === '1') {
        openAtAnswer = isLaunchWindowOpen(SESSION);
        answered = true;
      }
    });
    vi.mocked(capturePane).mockImplementation(async () => (answered ? READY_FRAME : TRUST_FRAME));

    await runWithTimers(() => tool.startSession(WORKTREE_ID, WORKTREE_PATH));

    expect(openAtAnswer).toBe(true);
    expect(isLaunchWindowOpen(SESSION)).toBe(false);
    expect(isLaunchDialogPressSettling(SESSION)).toBe(true);
  });

  it('negative control: no dialog, no recorded key; the window still closes', async () => {
    vi.mocked(capturePane).mockResolvedValue(READY_FRAME);

    await runWithTimers(() => tool.startSession(WORKTREE_ID, WORKTREE_PATH));

    expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '1', false);
    expect(isLaunchWindowOpen(SESSION)).toBe(false);
    expect(isLaunchDialogPressSettling(SESSION)).toBe(false);
  });

  it('closes when the launch fails', async () => {
    vi.mocked(capturePane).mockRejectedValue(new Error('capture failed'));
    vi.mocked(sendKeys).mockRejectedValueOnce(new Error('send failed'));

    await expect(runWithTimers(() => tool.startSession(WORKTREE_ID, WORKTREE_PATH))).rejects.toThrow();
    expect(isLaunchWindowOpen(SESSION)).toBe(false);
  });
});
