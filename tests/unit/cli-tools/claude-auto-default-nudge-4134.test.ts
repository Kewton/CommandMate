/**
 * Issue #4134: Claude Code's "Make auto mode your default permission mode?" sat
 * in front of the composer until the 60-second start budget ran out. The launch
 * answers No: it writes only `hasSeenAutoDefaultNudge`, where Yes would rewrite
 * the operator's `permissions.defaultMode` (measured on 2.1.318).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKeys: vi.fn(),
}));
vi.mock('@/lib/session/claude-session', () => ({
  isClaudeInstalled: vi.fn(),
  isClaudeRunning: vi.fn(),
  startClaudeSession: vi.fn(),
  sendMessageToClaude: vi.fn(),
  stopClaudeSession: vi.fn(),
}));

import { answerClaudeAutoDefaultNudgeUntil, sendNudgeKey } from '@/lib/cli-tools/claude-auto-default-nudge';
import { instanceInputLaunchReadMark, withInstanceInputLock } from '@/lib/session/instance-input-lock';
import { ClaudeTool } from '@/lib/cli-tools/claude';
import { startClaudeSession } from '@/lib/session/claude-session';
import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';

const frame = (name: string): string =>
  readFileSync(join(process.cwd(), 'tests/fixtures/claude-auto-default-nudge-4134', `${name}.txt`), 'utf8');
const COMPOSER = ['─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏸ manual mode on · ? for shortcuts'].join('\n');

/** A start that ends when `end()` is called, as a real one ends on seeing the prompt. */
function pendingStart(): { promise: Promise<void>; end: () => void } {
  let end: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    end = resolve;
  });
  return { promise, end };
}

describe('answerClaudeAutoDefaultNudgeUntil', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(sendKeys).mockResolvedValue();
    vi.mocked(sendSpecialKeys).mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves to No, reads the screen again, and only then presses Enter', async () => {
    const start = pendingStart();
    let current = 'cursor-yes';
    vi.mocked(capturePane).mockImplementation(async () => (current === 'composer' ? COMPOSER : frame(current)));
    vi.mocked(sendSpecialKeys).mockImplementation(async () => {
      current = 'cursor-no';
    });
    vi.mocked(sendKeys).mockImplementation(async () => {
      current = 'composer';
      start.end();
    });

    const watching = answerClaudeAutoDefaultNudgeUntil('mcbd-claude-x', start.promise);
    await vi.advanceTimersByTimeAsync(5000);
    await watching;

    expect(vi.mocked(sendSpecialKeys).mock.calls).toEqual([['mcbd-claude-x', ['Down']]]);
    expect(vi.mocked(sendKeys).mock.calls).toEqual([['mcbd-claude-x', '', true]]);
  });

  it('never confirms a cursor that stays on Yes, and stops pressing', async () => {
    const start = pendingStart();
    vi.mocked(capturePane).mockResolvedValue(frame('cursor-yes'));

    const watching = answerClaudeAutoDefaultNudgeUntil('mcbd-claude-x', start.promise);
    await vi.advanceTimersByTimeAsync(60000);
    start.end();
    await watching;

    expect(sendKeys).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys).mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('types nothing on a pane without the dialog', async () => {
    const start = pendingStart();
    vi.mocked(capturePane).mockResolvedValue(COMPOSER);

    const watching = answerClaudeAutoDefaultNudgeUntil('mcbd-claude-x', start.promise);
    await vi.advanceTimersByTimeAsync(3000);
    start.end();
    await watching;

    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('keeps watching past a capture that throws: the session may not exist yet', async () => {
    const start = pendingStart();
    vi.mocked(capturePane).mockRejectedValueOnce(new Error('no session')).mockResolvedValue(COMPOSER);

    const watching = answerClaudeAutoDefaultNudgeUntil('mcbd-claude-x', start.promise);
    await vi.advanceTimersByTimeAsync(2000);
    start.end();
    await watching;

    expect(vi.mocked(capturePane).mock.calls.length).toBeGreaterThan(1);
  });

  it('does not read the pane at all for a start that is already over', async () => {
    const watching = answerClaudeAutoDefaultNudgeUntil('mcbd-claude-x', Promise.resolve());
    await vi.advanceTimersByTimeAsync(5000);
    await watching;
    expect(capturePane).not.toHaveBeenCalled();
  });

  it('a start that fails stops the watch, and is not swallowed by it', async () => {
    const watching = answerClaudeAutoDefaultNudgeUntil('mcbd-claude-x', Promise.reject(new Error('boom')));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(watching).resolves.toBeUndefined();
  });
});

describe('sendNudgeKey, as a writer of the input lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendKeys).mockResolvedValue();
    vi.mocked(sendSpecialKeys).mockResolvedValue();
  });

  it('waits for a send that holds the composer, then reads again: the dialog is gone and nothing is typed', async () => {
    vi.mocked(capturePane).mockResolvedValue(COMPOSER);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const send = withInstanceInputLock('mcbd-claude-lock', async () => {
      entered();
      await held;
    });
    await inside;
    const answer = sendNudgeKey('mcbd-claude-lock', instanceInputLaunchReadMark(), 'Enter');
    expect(sendKeys).not.toHaveBeenCalled();
    release();
    await send;
    expect(await answer).toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('types the key when nothing came between the read and the lock', async () => {
    vi.mocked(capturePane).mockResolvedValue(frame('cursor-yes'));
    expect(await sendNudgeKey('mcbd-claude-lock-2', instanceInputLaunchReadMark(), 'Down')).toBe(true);
    expect(vi.mocked(sendSpecialKeys).mock.calls).toEqual([['mcbd-claude-lock-2', ['Down']]]);
  });
});

describe('ClaudeTool launch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes a failed start on to its caller', async () => {
    vi.mocked(startClaudeSession).mockRejectedValue(new Error('start failed'));
    const launch = (new ClaudeTool() as unknown as {
      launchSession(id: string, path: string): Promise<void>;
    }).launchSession('wt-4134', '/tmp/x');
    await expect(launch).rejects.toThrow('start failed');
  });

  it('returns when the start returns', async () => {
    vi.mocked(startClaudeSession).mockResolvedValue();
    await (new ClaudeTool() as unknown as {
      launchSession(id: string, path: string): Promise<void>;
    }).launchSession('wt-4134', '/tmp/x');
    expect(startClaudeSession).toHaveBeenCalledTimes(1);
  });
});
