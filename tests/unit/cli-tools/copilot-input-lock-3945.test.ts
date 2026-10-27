/**
 * Issue #3945: copilot's two ways of typing that bypass the shared sender — the
 * selection-list command (`/model` without an argument, …) and the `--model`
 * switch (`/model <id>`) — take the instance's input lock too, so a normal send
 * cannot type between their keys and the picker or answer that follows them.
 *
 * The normal send goes through the real `sendMessageWithSubmitVerification`;
 * tmux is mocked and every key is logged in order.
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

import { CopilotTool } from '@/lib/cli-tools/copilot';
import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import {
  getCarriedPasteMark,
  leaveCarriedPasteMark,
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
});
