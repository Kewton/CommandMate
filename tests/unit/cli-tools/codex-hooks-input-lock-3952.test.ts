/**
 * Issue #3952: codex's hooks-screen answer (`answerCodexHooksScreen`, reached
 * from `waitForPrompt` and the launch's `waitForReady`) is a writer of the
 * session's input.
 *
 * - Not inherited — `sendMessage` from the terminal route, or the launch — the
 *   key waits for a send that holds the composer and is typed only if the hooks
 *   screen is still the one on the pane after it.
 * - Inherited — `sendMessage` under `sendUserMessage`'s lock — it joins that
 *   lock: no wait, no second read.
 *
 * Site on the pane-key-writers ledger this runs (#4032): `sendCodexHooksScreenKey`,
 * the keys `answerCodexHooksScreen` types under the lock.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
  getSessionWorkingDirectory: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/cli-tools/validation', () => ({ validateSessionName: vi.fn() }));

import { CodexTool } from '@/lib/cli-tools/codex';
import { capturePane, getSessionWorkingDirectory, sendKeys, sendSpecialKey } from '@/lib/tmux/tmux';
import { resetInstanceInputLocks, withInstanceInputLock } from '@/lib/session/instance-input-lock';
import { CODEX_HOOKS_REVIEW_PANE, CODEX_READY_PANE } from '../../fixtures/codex-hooks-review-0148';

const SESSION = 'mcbd-codex-wt-3952';

let frame = CODEX_HOOKS_REVIEW_PANE;
let events: string[] = [];

function waitForPrompt(tool: CodexTool): Promise<void> {
  return (tool as unknown as { waitForPrompt(s: string): Promise<void> }).waitForPrompt(SESSION);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetInstanceInputLocks();
  frame = CODEX_HOOKS_REVIEW_PANE;
  events = [];
  vi.mocked(capturePane).mockImplementation((async () => frame) as never);
  vi.mocked(getSessionWorkingDirectory).mockResolvedValue('/nonexistent/wt-3952');
  // Any key the review screen takes moves it on to the ready composer.
  vi.mocked(sendKeys).mockImplementation((async (_s: string, key: string) => {
    events.push(`key:${key}`);
    frame = CODEX_READY_PANE;
  }) as never);
  vi.mocked(sendSpecialKey).mockImplementation((async (_s: string, key: string) => {
    events.push(`key:${key}`);
    frame = CODEX_READY_PANE;
  }) as never);
});

afterEach(() => {
  vi.useRealTimers();
  resetInstanceInputLocks();
});

function holdSend(): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const done = withInstanceInputLock(SESSION, async () => {
    events.push('<send>');
    await new Promise<void>((resolve) => (release = resolve));
  });
  return { release: () => release(), done };
}

describe('codex hooks-screen answer and the input lock (Issue #3952)', () => {
  it('not inherited: waits for a send in progress, then answers the screen still up (through `sendCodexHooksScreenKey`)', async () => {
    const held = holdSend();
    const waiting = waitForPrompt(new CodexTool());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events).toEqual(['<send>']);
    held.release();
    await held.done;
    await vi.runAllTimersAsync();
    await waiting;
    expect(events).toHaveLength(2);
    expect(events[0]).toBe('<send>');
    expect(events[1]).toMatch(/^key:/);
  });

  it('positive: the hooks screen is gone once the send is over — no key is typed', async () => {
    const held = holdSend();
    const waiting = waitForPrompt(new CodexTool());
    await vi.advanceTimersByTimeAsync(3_000);
    frame = CODEX_READY_PANE; // answered by a person while the send held the composer
    held.release();
    await held.done;
    await vi.runAllTimersAsync();
    await waiting;
    expect(events).toEqual(['<send>']);
  });

  it('inherited: inside a send that holds the lock it joins — no wait, no second read', async () => {
    const tool = new CodexTool();
    await withInstanceInputLock(SESSION, async () => {
      const waiting = waitForPrompt(tool);
      await vi.runAllTimersAsync();
      await waiting;
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/^key:/);
    // One read that saw the review screen, one that saw the composer.
    expect(capturePane).toHaveBeenCalledTimes(2);
  });

  it('negative: nothing holds the composer — answered at once, no second read', async () => {
    const waiting = waitForPrompt(new CodexTool());
    await vi.runAllTimersAsync();
    await waiting;
    expect(events).toHaveLength(1);
    expect(capturePane).toHaveBeenCalledTimes(2);
  });
});
