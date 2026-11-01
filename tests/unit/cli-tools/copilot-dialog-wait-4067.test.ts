/**
 * Issue #4067 (part B): copilot's prompt wait gives up on a dialog after
 * {@link COPILOT_DIALOG_CONFIRM_MS} instead of waiting out its whole window
 * (15 s; `/model`'s 30 s) — and the picker and `/model`, which wait holding the
 * instance's input lock, release it as soon as they refuse.
 *
 * The shared sender is the real one; tmux is mocked and every key is logged.
 * The dialog is the live copilot 1.0.x permission capture
 * (`tests/unit/lib/detection/fixtures/copilot-live-1885/permission-dialog.txt`).
 *
 * Controls:
 * - positive (each fails before #4067, which waited out the window): the normal
 *   send, the picker and `/model` refuse a dialog as `prompt-waiting` within the
 *   confirmation time, and a second writer gets the lock by then;
 * - negative: a dialog read once and then gone (a frame mid-paint) does not
 *   refuse the send; a Working turn with `❯` drawn is still typed into, and
 *   `/model` waits through it to idle.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});

vi.mock('@/lib/cli-tools/copilot-executable', () => ({
  resolveCopilotExecutable: vi.fn(),
}));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn(),
  clearInputLine: vi.fn().mockResolvedValue(undefined),
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  exactTarget: (name: string) => `=${name}:`,
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { COPILOT_DIALOG_CONFIRM_MS, CopilotTool } from '@/lib/cli-tools/copilot';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { INPUT_RECHECK_PROMPT_WAITING_CODE } from '@/lib/session/send-attempt-types';
import { resetInstanceInputLocks, withInstanceInputLock } from '@/lib/session/instance-input-lock';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { COPILOT_MODEL_SWITCH_2623_FRAMES as COPILOT } from '@tests/fixtures/copilot-model-switch-2623';

const DIALOG = readFileSync(
  path.resolve(__dirname, '../lib/detection/fixtures/copilot-live-1885/permission-dialog.txt'),
  'utf8'
);

/** The tmux session name of `wt-1`'s primary copilot instance. */
const SESSION = 'mcbd-copilot-wt-1';

let keys: string[] = [];
let tool: CopilotTool;

/** Every capture answers from `frames` in turn; the last one repeats. */
function framesInTurn(...frames: string[]): void {
  let call = 0;
  vi.mocked(capturePane).mockImplementation((async () => frames[Math.min(call++, frames.length - 1)]) as never);
}

/** Run `work` to completion under fake timers: what it threw, and when it settled (ms from start). */
async function settle(work: Promise<void>): Promise<{ error: Error | undefined; elapsed: number }> {
  const startedAt = Date.now();
  let error: Error | undefined;
  let elapsed = -1;
  const done = work
    .catch((e: Error) => {
      error = e;
    })
    .finally(() => {
      elapsed = Date.now() - startedAt;
    });
  await vi.runAllTimersAsync();
  await done;
  return { error, elapsed };
}

/** When a second writer started now gets the instance's input lock (ms from now). */
function secondWriterAcquires(): Promise<number> {
  const startedAt = Date.now();
  return withInstanceInputLock(SESSION, async () => Date.now() - startedAt);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetInstanceInputLocks();
  keys = [];
  tool = new CopilotTool();
  (tool as unknown as Record<string, unknown>).requireSession = vi.fn(async () => undefined);
  vi.mocked(sendKeys).mockImplementation((async (_s: string, text: string) => {
    keys.push(`type:${text}`);
  }) as never);
  vi.mocked(sendSpecialKeys).mockImplementation((async (_s: string, k: string[]) => {
    keys.push(k.join('+'));
  }) as never);
});

afterEach(() => {
  vi.useRealTimers();
  resetInstanceInputLocks();
});

describe('copilot: a dialog during the prompt wait (Issue #4067)', () => {
  it('control: the fixture is a dialog to the re-check, with no composer', () => {
    expect(detectSessionStatus(DIALOG, 'copilot').hasActivePrompt).toBe(true);
    expect(DIALOG).not.toMatch(/^❯(?:\s|$)/m);
    expect(COPILOT_DIALOG_CONFIRM_MS).toBeLessThan(15_000);
  });

  it('positive: the normal send refuses within the confirmation time — prompt-waiting, nothing typed', async () => {
    framesInTurn(DIALOG);
    const { error, elapsed } = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-waiting' });
    expect(elapsed).toBeLessThanOrEqual(COPILOT_DIALOG_CONFIRM_MS);
  });

  it('positive: the dialog closes as it is re-read — still prompt-waiting, with the re-check code', async () => {
    let call = 0;
    vi.mocked(capturePane).mockImplementation((async () => {
      call++;
      // The waits' reads see the dialog; the re-read after them sees it gone.
      return call <= 5 ? DIALOG : COPILOT.BOOT_LOADING();
    }) as never);
    const { error } = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-waiting' });
    expect((error as { cause?: { code?: unknown } }).cause?.code).toBe(INPUT_RECHECK_PROMPT_WAITING_CODE);
  });

  it('negative: a dialog read once, then the composer — typed as before', async () => {
    framesInTurn(DIALOG, COPILOT.BOOT_IDLE());
    const { error } = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(error).toBeUndefined();
    expect(keys).toEqual(['type:hello', 'Enter']);
  });

  it('negative: a dialog that flickers (dialog, loading, dialog …) is not confirmed — prompt-not-ready at the window', async () => {
    let call = 0;
    vi.mocked(capturePane).mockImplementation((async () => (call++ % 2 === 0 ? DIALOG : COPILOT.BOOT_LOADING())) as never);
    const { error, elapsed } = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    // The re-read after the window lands on a dialog frame or a loading one:
    // either way nothing was typed and the window was not cut short.
    expect(classifySendFailure(error).state).toBe('not-sent');
    expect(elapsed).toBeGreaterThanOrEqual(15_000);
  });

  it('negative: a Working turn with `❯` drawn — typed as before', async () => {
    framesInTurn(COPILOT.WORKING_SWITCHED_SILENTLY());
    const { error } = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(error).toBeUndefined();
    expect(keys).toEqual(['type:hello', 'Enter']);
  });

  it('positive: a selection-list command refuses within the confirmation time and releases the lock', async () => {
    framesInTurn(DIALOG);
    const command = tool.sendMessage('wt-1', '/model');
    await vi.advanceTimersByTimeAsync(10);
    const acquired = secondWriterAcquires();
    const { error, elapsed } = await settle(command);
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-waiting' });
    expect(elapsed).toBeLessThanOrEqual(COPILOT_DIALOG_CONFIRM_MS);
    expect(await acquired).toBeLessThanOrEqual(COPILOT_DIALOG_CONFIRM_MS);
  });

  it('positive: sendModelCommand refuses within the confirmation time, keeps the code, and releases the lock', async () => {
    framesInTurn(DIALOG);
    const command = tool.sendModelCommand('wt-1', 'gpt-5-mini');
    await vi.advanceTimersByTimeAsync(10);
    const acquired = secondWriterAcquires();
    const { error, elapsed } = await settle(command);
    expect(keys).toEqual([]);
    expect((error as { code?: unknown }).code).toBe(INPUT_RECHECK_PROMPT_WAITING_CODE);
    expect(elapsed).toBeLessThanOrEqual(COPILOT_DIALOG_CONFIRM_MS);
    expect(await acquired).toBeLessThanOrEqual(COPILOT_DIALOG_CONFIRM_MS);
  });

  it('negative: sendModelCommand waits through a Working turn (`❯` drawn) to idle — not refused as a dialog', async () => {
    let call = 0;
    vi.mocked(capturePane).mockImplementation((async () => {
      call++;
      // ~5 s of Working, then idle (the switch's answer is not this test's).
      return call <= 10 ? COPILOT.WORKING_SWITCHED_SILENTLY() : COPILOT.BOOT_IDLE();
    }) as never);
    const { error } = await settle(tool.sendModelCommand('wt-1', 'gpt-5-mini'));
    expect(keys[0]).toBe('type:/model gpt-5-mini');
    expect((error as { code?: unknown } | undefined)?.code).not.toBe(INPUT_RECHECK_PROMPT_WAITING_CODE);
  });
});
