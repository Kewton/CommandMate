/**
 * Issue #3952: copilot's automatic keys and the instance input lock.
 *
 * - `sendModelCommand` reads the pane once more right before `/model <id>`
 *   (`recheckComposerBeforeInput`): "idle, so no dialog" was true of the frame
 *   that was read, not of the moment the keys go out. Three controls: a dialog
 *   by then (nothing typed, `prompt-waiting`), an unreadable pane (nothing
 *   typed, `recheck-failed`), the same idle composer (typed).
 * - The folder-trust answer in the readiness wait is a writer: outside a send's
 *   lock (the launch, a plain `sendMessage`) it waits for a send in progress
 *   and is typed only if the dialog is still there; inside the selection-list
 *   branch's lock it joins it.
 *
 * tmux is mocked and every key is logged in order.
 *
 * Site on the pane-key-writers ledger this runs (#4032): `answerFolderTrustDialog`,
 * the folder-trust answer of the readiness wait.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import {
  INPUT_RECHECK_FAILED_CODE,
  INPUT_RECHECK_PROMPT_WAITING_CODE,
} from '@/lib/session/send-attempt-types';
import { capturePane, sendKeys } from '@/lib/tmux/tmux';
import { resetInstanceInputLocks, withInstanceInputLock } from '@/lib/session/instance-input-lock';
import { COPILOT_MODEL_SWITCH_2623_FRAMES as FRAMES } from '../../fixtures/copilot-model-switch-2623';
import { buildCopilotFolderTrustFrame, buildCopilotReadyFrame } from '@tests/fixtures/copilot-folder-trust-1080';

const DIALOG_FRAME = readFileSync(
  path.resolve(__dirname, '../../unit/lib/detection/fixtures/copilot-live-1885/permission-dialog.txt'),
  'utf8'
);
const TRUST_FRAME = buildCopilotFolderTrustFrame();
const READY_FRAME = buildCopilotReadyFrame();

let frame = '';
let recheck: () => string;
let keys: string[] = [];

/** Run until every timer has fired; the settled value or the error. */
async function settle<T>(run: Promise<T>): Promise<unknown> {
  const settled = run.then(() => null, (error: unknown) => error);
  await vi.runAllTimersAsync();
  return settled;
}

describe('copilot automatic keys and the input lock (Issue #3952)', () => {
  let tool: CopilotTool;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetInstanceInputLocks();
    tool = new CopilotTool();
    keys = [];
    frame = FRAMES.SWITCH_BEFORE();
    recheck = () => frame;
    // The re-check reads 200 rows; copilot's own polls read 50.
    vi.mocked(capturePane).mockImplementation((async (_s: string, lines: unknown) =>
      lines === 200 ? recheck() : frame) as never);
    vi.mocked(sendKeys).mockImplementation((async (_s: string, text: string) => {
      keys.push(`type:${text}`);
      if (text.startsWith('/model ')) setTimeout(() => (frame = FRAMES.SWITCH_AFTER()), 300);
      if (text === '1' && frame === TRUST_FRAME) frame = READY_FRAME;
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetInstanceInputLocks();
  });

  describe('sendModelCommand re-reads the pane right before /model', () => {
    it('positive: a dialog by the time of the keys — nothing typed, prompt-waiting by code', async () => {
      recheck = () => DIALOG_FRAME;
      const error = await settle(tool.sendModelCommand('wt-1', 'gpt-5.6-terra'));
      expect(keys).toEqual([]);
      expect(error).toMatchObject({ code: INPUT_RECHECK_PROMPT_WAITING_CODE });
      expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-waiting' });
    });

    it('positive: the pane cannot be read by then — nothing typed, recheck-failed by code', async () => {
      recheck = () => {
        throw new Error('Command failed: tmux capture-pane -t =x: -p');
      };
      const error = await settle(tool.sendModelCommand('wt-1', 'gpt-5.6-terra'));
      expect(keys).toEqual([]);
      expect(error).toMatchObject({ code: INPUT_RECHECK_FAILED_CODE });
      expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'recheck-failed' });
    });

    it('negative: the same idle composer — /model is typed as before', async () => {
      expect(await settle(tool.sendModelCommand('wt-1', 'gpt-5.6-terra'))).toBeNull();
      expect(keys).toEqual(['type:/model gpt-5.6-terra']);
    });

    it('negative: a refused model keeps no re-check code (model-switch-failed upstream)', async () => {
      frame = FRAMES.UNSUPPORTED_BEFORE();
      vi.mocked(sendKeys).mockImplementation((async (_s: string, text: string) => {
        keys.push(`type:${text}`);
        if (text.startsWith('/model ')) setTimeout(() => (frame = FRAMES.UNSUPPORTED_AFTER()), 300);
      }) as never);
      const error = await settle(tool.sendModelCommand('wt-1', 'claude-opus-4.6'));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('copilot refused it');
      expect((error as { code?: unknown }).code).toBeUndefined();
    });
  });

  describe('the folder-trust answer in the readiness wait', () => {
    const SESSION = 'mcbd-copilot-wt-1';

    it('not inherited (a plain readiness wait): waits for a send in progress, then answers the dialog still up (through `answerFolderTrustDialog`)', async () => {
      frame = TRUST_FRAME;
      let release!: () => void;
      const send = withInstanceInputLock(SESSION, async () => {
        keys.push('<send>');
        await new Promise<void>((resolve) => (release = resolve));
      });
      const waiting = (tool as unknown as {
        waitForPrompt(s: string, t?: number): Promise<{ ready: boolean }>;
      }).waitForPrompt(SESSION, 10_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(keys).toEqual(['<send>']);
      release();
      await send;
      await vi.runAllTimersAsync();
      await expect(waiting).resolves.toMatchObject({ ready: true });
      expect(keys).toEqual(['<send>', 'type:1']);
    });

    it('positive: the dialog is gone once the send is over — no digit is typed', async () => {
      frame = TRUST_FRAME;
      let release!: () => void;
      const send = withInstanceInputLock(SESSION, async () => {
        keys.push('<send>');
        await new Promise<void>((resolve) => (release = resolve));
      });
      const waiting = (tool as unknown as {
        waitForPrompt(s: string, t?: number): Promise<{ ready: boolean }>;
      }).waitForPrompt(SESSION, 10_000);
      await vi.advanceTimersByTimeAsync(2_000);
      frame = READY_FRAME; // a person answered it while the send held the composer
      release();
      await send;
      await vi.runAllTimersAsync();
      await expect(waiting).resolves.toMatchObject({ ready: true });
      expect(keys).toEqual(['<send>']);
    });

    it('inherited: inside the selection-list branch’s lock the answer joins it (no deadlock, typed in order)', async () => {
      frame = TRUST_FRAME;
      vi.mocked(sendKeys).mockImplementation((async (_s: string, text: string) => {
        keys.push(`type:${text}`);
        if (text === '1' && frame === TRUST_FRAME) frame = READY_FRAME;
        if (text === '/model') setTimeout(() => (frame = FRAMES.SWITCH_AFTER()), 100);
      }) as never);
      expect(await settle(tool.sendMessage('wt-1', '/model'))).toBeNull();
      expect(keys).toEqual(['type:1', 'type:/model']);
    });
  });
});
