/**
 * Copilot CLI's first-launch folder-trust dialog (Issue #1886).
 *
 * On an untrusted git repository copilot 1.0.80 draws "Confirm folder trust"
 * before anything else runs, inside a box, with the composer row removed. The
 * readiness check (`COPILOT_PROMPT_PATTERN`) matches nothing in that frame, so
 * `waitForReady` burned its whole 30-second window on every first launch and
 * then handed `sendMessage` a session still parked on the dialog.
 *
 * The frames here come from a live capture at production geometry (200 x 1000)
 * of `gh copilot` on a private tmux socket; see the fixture header. Two of the
 * assertions below are traps rather than features:
 *
 *  - the readiness check must run on the ANSI-stripped frame and NOT on a
 *    box-stripped one, because `stripBoxDrawing` turns `│ ❯ 1. Yes` into
 *    `❯ 1. Yes` and the dialog then reads as a ready prompt;
 *  - detection must match the `1. Yes` option ROW, not just the dialog, so a
 *    reordered list where option 1 is "Yes, and remember this folder" is
 *    refused. Answering that one writes `trustedFolders` into
 *    `~/.copilot/config.json`, a file shared by every checkout on the machine.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import {
  COPILOT_PROMPT_PATTERN,
  isCopilotFolderTrustDialog,
  stripAnsi,
  stripBoxDrawing,
} from '@/lib/detection/cli-patterns';
import {
  buildCopilotFolderTrustFrame,
  buildCopilotFolderTrustReorderedFrame,
  buildCopilotReadyFrame,
} from '@tests/fixtures/copilot-folder-trust-1080';

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

import { CopilotTool } from '@/lib/cli-tools/copilot';
import { hasSession, sendKeys, capturePane } from '@/lib/tmux/tmux';
import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';

const WORKTREE_ID = 'wt-copilot-trust';
const WORKTREE_PATH = '/repos/wt-copilot-trust';
const SESSION = 'mcbd-copilot-wt-copilot-trust';

const TRUST_FRAME = buildCopilotFolderTrustFrame();
const READY_FRAME = buildCopilotReadyFrame();
const REORDERED_FRAME = buildCopilotFolderTrustReorderedFrame();

let home: string;
let tool: CopilotTool;

/** Every `sendKeys` call that sent the trust answer, whatever the Enter flag. */
function trustAnswerCalls(): unknown[][] {
  return vi.mocked(sendKeys).mock.calls.filter((call) => call[1] === '1');
}

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

  // Keep the hook-settings writer off the operator's real ~/.copilot.
  home = mkdtempSync(join(tmpdir(), 'cmate-copilot-trust-'));
  process.env.COPILOT_HOME = home;
  delete process.env.CM_AGENT_HOOKS_INJECT;

  // `clearAllMocks` forgets calls but keeps implementations, so the defaults are
  // restated rather than relied on from the factory.
  vi.mocked(hasSession).mockResolvedValue(false);
  vi.mocked(sendKeys).mockResolvedValue(undefined);
  vi.mocked(capturePane).mockResolvedValue(READY_FRAME);

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
  delete process.env.COPILOT_HOME;
  removeTempDir(home);
});

describe('isCopilotFolderTrustDialog', () => {
  it('recognises the live 1.0.80 dialog', () => {
    expect(isCopilotFolderTrustDialog(TRUST_FRAME)).toBe(true);
  });

  it('does not fire on the ready composer the dialog leaves behind', () => {
    expect(isCopilotFolderTrustDialog(READY_FRAME)).toBe(false);
  });

  it('requires both anchors, so the heading alone is not enough', () => {
    const headingOnly = TRUST_FRAME.replace('Do you trust the files in this folder?', 'Reviewing this folder');

    expect(headingOnly).toContain('Confirm folder trust');
    expect(isCopilotFolderTrustDialog(headingOnly)).toBe(false);
  });

  it('does not fire on a response that merely quotes a numbered list', () => {
    const quoted = ['● Here is what I would pick:', '', '❯ 1. Yes', '  2. No', '', '❯'].join('\n');

    expect(isCopilotFolderTrustDialog(quoted)).toBe(false);
  });

  it('refuses a reordered list where option 1 is the remembering variant', () => {
    // The fail-safe: option 1 there writes trustedFolders into the machine-wide
    // ~/.copilot/config.json. Refusing the frame degrades the launch to the
    // pre-#1886 stall, which is the outcome we are allowed to have.
    expect(REORDERED_FRAME).toContain('Confirm folder trust');
    expect(REORDERED_FRAME).toContain('1. Yes, and remember this folder for future sessions');
    expect(isCopilotFolderTrustDialog(REORDERED_FRAME)).toBe(false);
  });
});

describe('the readiness check against the dialog frame', () => {
  it('does not match the boxed dialog — this is the 30-second stall', () => {
    expect(COPILOT_PROMPT_PATTERN.test(stripAnsi(TRUST_FRAME))).toBe(false);
  });

  it('DOES match once the box is stripped, which is why waitForReady must not strip it', () => {
    expect(COPILOT_PROMPT_PATTERN.test(stripBoxDrawing(stripAnsi(TRUST_FRAME)))).toBe(true);
  });

  it('matches the composer row of the frame that follows the answer', () => {
    expect(COPILOT_PROMPT_PATTERN.test(stripAnsi(READY_FRAME))).toBe(true);
  });
});

describe('waitForReady (startSession)', () => {
  it('answers the trust dialog with the session-only option and reaches the composer', async () => {
    vi.mocked(capturePane).mockResolvedValueOnce(TRUST_FRAME).mockResolvedValue(READY_FRAME);

    await runWithTimers(() => tool.startSession(WORKTREE_ID, WORKTREE_PATH));

    expect(sendKeys).toHaveBeenCalledWith(SESSION, '1', false);
    // A trailing Enter would land as an empty submit on the composer the
    // dismissal reveals; 1.0.80 confirms on the digit alone.
    expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '1', true);
    // Stops as soon as the composer is visible instead of polling the window out.
    expect(vi.mocked(capturePane).mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('drops the capture cache so the answered dialog stops reading as waiting', async () => {
    vi.mocked(capturePane).mockResolvedValueOnce(TRUST_FRAME).mockResolvedValue(READY_FRAME);

    await runWithTimers(() => tool.startSession(WORKTREE_ID, WORKTREE_PATH));

    expect(invalidateCache).toHaveBeenCalledWith(SESSION);
  });

  it('sends the answer at most once even if the dialog never clears', async () => {
    vi.mocked(capturePane).mockResolvedValue(TRUST_FRAME);

    await runWithTimers(() => tool.startSession(WORKTREE_ID, WORKTREE_PATH));

    expect(trustAnswerCalls()).toHaveLength(1);
  });

  it('sends nothing when the composer is up from the start', async () => {
    vi.mocked(capturePane).mockResolvedValue(READY_FRAME);

    await runWithTimers(() => tool.startSession(WORKTREE_ID, WORKTREE_PATH));

    expect(trustAnswerCalls()).toHaveLength(0);
  });

  it('sends nothing into a reordered dialog', async () => {
    vi.mocked(capturePane).mockResolvedValue(REORDERED_FRAME);

    await runWithTimers(() => tool.startSession(WORKTREE_ID, WORKTREE_PATH));

    expect(trustAnswerCalls()).toHaveLength(0);
  });
});

describe('waitForPrompt (sendMessage)', () => {
  it('answers the dialog instead of typing the message body into it', async () => {
    // `startSession` returns early for a session that already exists, so a pane
    // adopted from outside CommandMate arrives here still on the dialog. The
    // body's digits are option selections there: a message containing "2" would
    // pick "Yes, and remember this folder".
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValueOnce(TRUST_FRAME).mockResolvedValue(READY_FRAME);

    await runWithTimers(() => tool.sendMessage(WORKTREE_ID, 'compare option 2 with option 3'));

    expect(trustAnswerCalls()).toHaveLength(1);
    expect(sendMessageWithSubmitVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: SESSION,
        message: 'compare option 2 with option 3',
        cliToolId: 'copilot',
      })
    );
    // The body never reached the pane as raw keys while the dialog was up.
    expect(sendKeys).not.toHaveBeenCalledWith(SESSION, 'compare option 2 with option 3', true);
  });
});
