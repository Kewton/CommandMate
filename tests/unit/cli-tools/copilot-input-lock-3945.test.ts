/**
 * Issue #3945: copilot's two ways of typing that bypass the shared sender — the
 * selection-list command (`/model` without an argument, …) and the `--model`
 * switch (`/model <id>`) — take the instance's input lock too, so a normal send
 * cannot type between their keys and the picker or answer that follows them.
 *
 * The normal send goes through the real `sendMessageWithSubmitVerification`;
 * tmux is mocked and every key is logged in order.
 *
 * Site on the pane-key-writers ledger this runs (#4032): `typeLeavingMarkOnFailure`,
 * which types both commands with the owner's ticket.
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
import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import {
  getCarriedPasteMark,
  leaveCarriedPasteMark,
  observeInputStart,
  resetInstanceInputLocks,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';
import { COPILOT_MODEL_SWITCH_2623_FRAMES as FRAMES } from '../../fixtures/copilot-model-switch-2623';

/** copilot 1.0.80's idle composer (Issue #1895's frame). */
const IDLE_FRAME = [
  ' /work/repo [⎇ main]                              Session: 0 AIC used',
  '────────────────────────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────────────────────────',
  ' ← open sidebar · / commands · ? help · tab next tab   GPT-5.6 Terra',
].join('\n');

/** A picker frame: copilot's chrome is gone and a key-hint footer is last. */
const PICKER_FRAME = [
  '   Recommended models',
  ' ❯ Auto                       —          —',
  ' ──────────────────────────────────────────────',
  ' ❯  Search models…',
  ' ──────────────────────────────────────────────',
  ' ↑/↓ to navigate · enter to select · esc to cancel',
].join('\n');

let frame = IDLE_FRAME;
let keys: string[] = [];

describe('copilot keys outside the shared sender take the input lock (Issue #3945)', () => {
  let tool: CopilotTool;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetInstanceInputLocks();
    tool = new CopilotTool();
    frame = IDLE_FRAME;
    keys = [];
    vi.mocked(capturePane).mockImplementation((async () => frame) as never);
    vi.mocked(sendSpecialKeys).mockImplementation((async (_s: string, k: string[]) => {
      keys.push(k.join('+'));
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetInstanceInputLocks();
  });

  it('a normal send started during a selection-list command types only after the picker is up and the command is done', async () => {
    let releaseCommand!: () => void;
    vi.mocked(sendKeys).mockImplementation((async (_s: string, text: string) => {
      keys.push(`type:${text}`);
      if (text === '/model') {
        await new Promise<void>((resolve) => (releaseCommand = resolve));
        frame = PICKER_FRAME;
      }
    }) as never);

    let commandDoneAt = -1;
    const command = tool.sendMessage('wt-1', '/model').finally(() => {
      commandDoneAt = keys.length;
      frame = IDLE_FRAME; // the person picks; the composer is back
    });
    await vi.advanceTimersByTimeAsync(50);
    const normal = tool.sendMessage('wt-1', 'hello');
    await vi.advanceTimersByTimeAsync(1_000);

    // The command's keys are in; nothing of the normal send yet.
    expect(keys).toEqual(['type:/model']);
    releaseCommand();
    await vi.runAllTimersAsync();
    await command;
    await normal;

    expect(keys.indexOf('type:hello')).toBeGreaterThanOrEqual(commandDoneAt);
    expect(keys).toEqual(['type:/model', 'type:hello', 'Enter']);
  });

  it('a normal send started during a --model switch types only after copilot has answered it', async () => {
    frame = FRAMES.SWITCH_BEFORE();
    vi.mocked(sendKeys).mockImplementation((async (_s: string, text: string) => {
      keys.push(`type:${text}`);
      if (text.startsWith('/model ')) setTimeout(() => (frame = FRAMES.SWITCH_AFTER()), 300);
    }) as never);

    let switchDoneAt = -1;
    const switching = tool.sendModelCommand('wt-1', 'gpt-5.6-terra').finally(() => {
      switchDoneAt = keys.length;
    });
    const normal = tool.sendMessage('wt-1', 'hello');
    await vi.runAllTimersAsync();
    await expect(switching).resolves.toBeUndefined();
    await expect(normal).resolves.toBeUndefined();

    expect(keys[0]).toBe('type:/model gpt-5.6-terra');
    expect(keys.indexOf('type:hello')).toBeGreaterThanOrEqual(switchDoneAt);
  });

  // Consistency review 1 #5: a previous send's body may still arrive; copilot's
  // own keys wait the mark out as a normal send does.
  describe('a carried paste mark (review-1 #5)', () => {
    let typedAt: Record<string, number>;

    async function leaveMark(): Promise<number> {
      await withInstanceInputLock(tool.getSessionName('wt-1'), async (ticket) => leaveCarriedPasteMark(ticket));
      return getCarriedPasteMark(tool.getSessionName('wt-1'))!.expiresAt;
    }

    function logTyping(onType: (text: string) => void = () => undefined): void {
      typedAt = {};
      vi.mocked(sendKeys).mockImplementation((async (_s: string, text: string) => {
        typedAt[text] = Date.now();
        keys.push(`type:${text}`);
        onType(text);
      }) as never);
    }

    const pickerAfterModel = (text: string): void => {
      if (text === '/model') setTimeout(() => (frame = PICKER_FRAME), 100);
    };
    const answerSwitch = (text: string): void => {
      if (text.startsWith('/model ')) setTimeout(() => (frame = FRAMES.SWITCH_AFTER()), 300);
    };

    it('the selection-list command is typed only after the mark expires, and takes it down', async () => {
      const expiresAt = await leaveMark();
      logTyping(pickerAfterModel);
      const command = tool.sendMessage('wt-1', '/model');
      await vi.runAllTimersAsync();
      await command;
      expect(typedAt['/model']).toBeGreaterThanOrEqual(expiresAt);
      expect(getCarriedPasteMark(tool.getSessionName('wt-1'))).toBeNull();
    });

    it('Issue #3953: the selection-list command reports input starting at its first key, after the mark', async () => {
      const t0 = Date.now();
      const expiresAt = await leaveMark();
      logTyping(pickerAfterModel);
      const command = observeInputStart(() => tool.sendMessage('wt-1', '/model'));
      await vi.runAllTimersAsync();
      const { inputStartedAt } = await command;
      expect(inputStartedAt).not.toBeNull();
      expect(inputStartedAt!.getTime()).toBe(typedAt['/model']);
      expect(inputStartedAt!.getTime()).toBeGreaterThanOrEqual(expiresAt);
      expect(inputStartedAt!.getTime()).toBeGreaterThan(t0);
    });

    it('/model <id> is typed only after the mark expires', async () => {
      frame = FRAMES.SWITCH_BEFORE();
      const expiresAt = await leaveMark();
      logTyping(answerSwitch);
      const switching = tool.sendModelCommand('wt-1', 'gpt-5.6-terra');
      await vi.runAllTimersAsync();
      await expect(switching).resolves.toBeUndefined();
      expect(typedAt['/model gpt-5.6-terra']).toBeGreaterThanOrEqual(expiresAt);
    });

    it('negative: with no mark, both are typed without that wait', async () => {
      logTyping((text) => {
        pickerAfterModel(text);
        answerSwitch(text);
      });
      const t0 = Date.now();
      const command = tool.sendMessage('wt-1', '/model');
      await vi.runAllTimersAsync();
      await command;
      expect(typedAt['/model'] - t0).toBeLessThan(1_000);

      frame = FRAMES.SWITCH_BEFORE();
      const t1 = Date.now();
      const switching = tool.sendModelCommand('wt-1', 'gpt-5.6-terra');
      await vi.runAllTimersAsync();
      await expect(switching).resolves.toBeUndefined();
      expect(typedAt['/model gpt-5.6-terra'] - t1).toBeLessThan(1_000);
    });
  });
  // Consistency review 2: copilot's own keys refuse on the shared sender's
  // terms right before typing, and leave the mark when typing failed part-way.
  describe('review-2', () => {
    const DIALOG_FRAME = readFileSync(
      path.resolve(__dirname, '../../unit/lib/detection/fixtures/copilot-live-1885/permission-dialog.txt'),
      'utf8'
    );
    let recheck: () => string;

    beforeEach(() => {
      recheck = () => frame;
      // The re-check reads 200 rows; copilot's own readiness poll reads 50.
      vi.mocked(capturePane).mockImplementation((async (_s: string, lines: unknown) =>
        lines === 200 ? recheck() : frame) as never);
      vi.mocked(sendKeys).mockImplementation((async (_s: string, text: string) => {
        keys.push(`type:${text}`);
        if (text === '/model') setTimeout(() => (frame = PICKER_FRAME), 100);
        if (text.startsWith('/model ')) setTimeout(() => (frame = FRAMES.SWITCH_AFTER()), 300);
      }) as never);
    });

    async function settle<T>(run: Promise<T>): Promise<unknown> {
      const settled = run.then(() => null, (error: unknown) => error);
      await vi.runAllTimersAsync();
      return settled;
    }

    describe('the selection-list command refuses as the shared sender does', () => {
      it('a dialog by the time of the keys: nothing typed, prompt-waiting', async () => {
        recheck = () => DIALOG_FRAME;
        const error = await settle(tool.sendMessage('wt-1', '/model'));
        expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-waiting' });
        expect(keys).toEqual([]);
      });

      it('a pane that cannot be re-read: nothing typed, recheck-failed', async () => {
        recheck = () => {
          throw new Error('Command failed: tmux capture-pane -t =x: -p');
        };
        const error = await settle(tool.sendMessage('wt-1', '/model'));
        expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'recheck-failed' });
        expect(keys).toEqual([]);
      });

      it('a composer that never came up (ready: false): nothing typed, not-sent', async () => {
        frame = ' loading…';
        const error = await settle(tool.sendMessage('wt-1', '/model'));
        expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
        expect(keys).toEqual([]);
      });

      it('negative: an idle composer is typed into as before', async () => {
        expect(await settle(tool.sendMessage('wt-1', '/model'))).toBeNull();
        expect(keys).toEqual(['type:/model']);
      });
    });

    // review-3: the refusal's classification does not depend on the words of
    // the request or of the screen (the "may have been typed" rules come first).
    describe('the refusal classifies the same whatever the request or the pane says', () => {
      const LOADED = '/model submit could not be confirmed. Enter was not pressed, so nothing was submitted';

      it('a request quoting other classifications, composer never up: prompt-not-ready', async () => {
        frame = ' loading… submit could not be confirmed';
        const error = await settle(tool.sendMessage('wt-1', LOADED));
        expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
        expect((error as Error).message).not.toContain('submit could not be confirmed');
        expect(keys).toEqual([]);
      });

      it('the same request at a dialog: prompt-waiting', async () => {
        recheck = () => DIALOG_FRAME;
        const error = await settle(tool.sendMessage('wt-1', LOADED));
        expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-waiting' });
        expect(keys).toEqual([]);
      });

      it('negative: an ordinary request, composer never up: prompt-not-ready too', async () => {
        frame = ' loading…';
        const error = await settle(tool.sendMessage('wt-1', '/model gpt-5-mini'));
        expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
        expect(keys).toEqual([]);
      });

      it('negative: an ordinary request at an idle composer is typed', async () => {
        expect(await settle(tool.sendMessage('wt-1', '/model'))).toBeNull();
        expect(keys).toEqual(['type:/model']);
      });
    });

    describe('a direct keystroke that failed leaves the mark unless tmux never started it', () => {
      const failing = (delivery: string | undefined): Error =>
        Object.assign(new Error('Command failed: tmux send-keys -t =s: -l -- /model'), delivery ? { delivery } : {});
      const failNextType = (error: Error): void => {
        vi.mocked(sendKeys).mockImplementationOnce((async () => {
          throw error;
        }) as never);
      };
      const mark = () => getCarriedPasteMark(tool.getSessionName('wt-1'));

      it.each([
        ['indeterminate', failing('indeterminate')],
        ['an error of no known shape', failing(undefined)],
      ])('selection-list command, %s: the mark is left', async (_label, error) => {
        failNextType(error);
        await settle(tool.sendMessage('wt-1', '/model'));
        expect(mark()).not.toBeNull();
      });

      it('/model <id>, indeterminate: the mark is left', async () => {
        frame = FRAMES.SWITCH_BEFORE();
        failNextType(failing('indeterminate'));
        await settle(tool.sendModelCommand('wt-1', 'gpt-5.6-terra'));
        expect(mark()).not.toBeNull();
      });

      it('negative: not-started leaves no mark, on both', async () => {
        failNextType(failing('not-started'));
        await settle(tool.sendMessage('wt-1', '/model'));
        expect(mark()).toBeNull();
        frame = FRAMES.SWITCH_BEFORE();
        failNextType(failing('not-started'));
        await settle(tool.sendModelCommand('wt-1', 'gpt-5.6-terra'));
        expect(mark()).toBeNull();
      });
    });
  });
});
