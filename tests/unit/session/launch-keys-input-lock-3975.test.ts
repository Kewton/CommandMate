/**
 * Issue #3975: the keys a launch types itself — gemini's launch line and its
 * folder-trust Enter, Claude's launch line and its trust keys — take part in
 * the instance input lock (#3945 / #3952) as `exclusive` writers.
 *
 * Positive control: before #3975 the launch typed with no lock, so its Enter
 * went out while a send held the composer (in the middle of the send's body,
 * paste or Enter). Negative control: with no send in the way the launch
 * answers exactly as before — one Enter, and no second read of the screen.
 *
 * The send is stood in for by an owner of the lock (as in the other #3952
 * suites); tmux is mocked.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';

vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));

registerIsolatedAgentHooksDir('launch-keys-3975');

const events = vi.hoisted(() => ({ list: [] as string[] }));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn(async (_s: string, keys: string, enter?: boolean) => {
    events.list.push(keys === '' && enter === true ? 'enter' : 'launch-line');
  }),
  sendSpecialKey: vi.fn(async (_s: string, key: string) => {
    events.list.push(`special:${key}`);
  }),
  sendSpecialKeys: vi.fn(async (_s: string, keys: string[]) => {
    events.list.push(`special:${keys.join(',')}`);
  }),
  capturePane: vi.fn().mockResolvedValue(''),
  killSession: vi.fn().mockResolvedValue(true),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  getPaneCurrentCommand: vi.fn().mockResolvedValue('claude'),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  constants: { X_OK: 1 },
}));

vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, opts: unknown, cb?: unknown) => {
    if (typeof opts === 'function') cb = opts;
    const callback = cb as (err: Error | null, result: { stdout: string; stderr: string }) => void;
    callback(null, { stdout: cmd.includes('which claude') ? '/usr/local/bin/claude' : '', stderr: '' });
    return {};
  }),
}));

import { capturePane, createSession, sendKeys } from '@/lib/tmux/tmux';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { startClaudeSession, CLAUDE_INIT_POLL_INTERVAL, CLAUDE_POST_PROMPT_DELAY } from '@/lib/session/claude-session';
import {
  answerUnderInstanceInputLock,
  instanceInputLaunchReadMark,
  instanceInputReadMark,
  resetInstanceInputLocks,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';

const GEMINI_TRUST = readFileSync(resolve(__dirname, '../../fixtures/gemini-live-3776/trust-dialog.txt'), 'utf8');
const GEMINI_READY = '> Type your message or @path/to/file';
const CLAUDE_TRUST =
  'Quick safety check: Is this a project you created or one you trust?\n\n' +
  ' ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n Enter to confirm · Esc to cancel';
const CLAUDE_READY = '❯ ';

/** A send holding `session`'s composer until `release`. */
function holdSend(session: string): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const done = withInstanceInputLock(session, async () => {
    events.list.push('<send>');
    await gate;
    events.list.push('</send>');
  });
  return { release: () => release(), done };
}

function waitForReady(tool: GeminiTool, session: string): Promise<void> {
  return (tool as unknown as { waitForReady(s: string): Promise<void> }).waitForReady(session);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  events.list = [];
  resetInstanceInputLocks();
  vi.mocked(createSession).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  resetInstanceInputLocks();
});

describe('[#3975] gemini: the trust Enter waits for a send holding the composer', () => {
  it('positive: no Enter while the send holds it; after the send the dialog is read again and answered', async () => {
    let trusted = false;
    vi.mocked(capturePane).mockImplementation(async () => (trusted ? GEMINI_READY : GEMINI_TRUST));
    const { sendSpecialKey } = await import('@/lib/tmux/tmux');
    vi.mocked(sendSpecialKey).mockImplementation(async (_s, key) => {
      events.list.push(`special:${key}`);
      trusted = true;
    });

    const held = holdSend('s');
    const done = waitForReady(new GeminiTool(), 's');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events.list).toEqual(['<send>']);

    const capturesBeforeRelease = vi.mocked(capturePane).mock.calls.length;
    held.release();
    await held.done;
    await vi.advanceTimersByTimeAsync(3_000);
    await done;

    expect(events.list).toEqual(['<send>', '</send>', 'special:Enter']);
    // Read again under the lock before the Enter (the send may have moved the screen).
    expect(vi.mocked(capturePane).mock.calls.length).toBeGreaterThan(capturesBeforeRelease);
  });

  it('positive: a dialog that the send\'s time took away gets no Enter', async () => {
    let gone = false;
    vi.mocked(capturePane).mockImplementation(async () => (gone ? GEMINI_READY : GEMINI_TRUST));

    const held = holdSend('s');
    const done = waitForReady(new GeminiTool(), 's');
    await vi.advanceTimersByTimeAsync(1_000);
    gone = true;
    held.release();
    await held.done;
    await vi.advanceTimersByTimeAsync(3_000);
    await done;

    expect(events.list).toEqual(['<send>', '</send>']);
  });

  it('negative: with no send in the way, one Enter and no second read', async () => {
    vi.mocked(capturePane).mockResolvedValueOnce(GEMINI_TRUST).mockResolvedValue(GEMINI_READY);
    const done = waitForReady(new GeminiTool(), 's');
    await vi.advanceTimersByTimeAsync(3_000);
    await done;

    expect(events.list).toEqual(['special:Enter']);
    // One read decided the Enter, the next found the prompt: nothing re-read.
    expect(vi.mocked(capturePane)).toHaveBeenCalledTimes(2);
  });
});

describe('[#3975] Claude: the launch line and the trust Enter wait for a send holding the composer', () => {
  it('positive: neither the launch line nor the trust Enter goes out inside a send', async () => {
    let trusted = false;
    vi.mocked(capturePane).mockImplementation(async () => (trusted ? CLAUDE_READY : CLAUDE_TRUST));
    vi.mocked(sendKeys).mockImplementation(async (_s, keys, enter) => {
      // `sanitizeSessionEnvironment`'s `unset CLAUDECODE` (session-key-sender,
      // not this Issue's to move) is left out of the order.
      if (keys === 'unset CLAUDECODE') return;
      if (keys === '' && enter === true) {
        events.list.push('enter');
        trusted = true;
      } else {
        events.list.push('launch-line');
      }
    });

    // A send that takes the new pane's composer right after it is created. (One
    // already in flight before is cut off by `beginAgentSession`'s
    // `invalidateInstanceInput`; this one comes after it.)
    let first: { release: () => void; done: Promise<void> } | null = null;
    vi.mocked(createSession).mockImplementation(async () => {
      first = holdSend('mcbd-claude-wt');
    });
    const started = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    await vi.advanceTimersByTimeAsync(500);
    expect(events.list).toEqual(['<send>']);
    first!.release();
    await first!.done;
    await vi.advanceTimersByTimeAsync(0);
    expect(events.list).toEqual(['<send>', '</send>', 'launch-line']);

    // Another send takes the composer before the first poll reads the dialog.
    const second = holdSend('mcbd-claude-wt');
    await vi.advanceTimersByTimeAsync(CLAUDE_INIT_POLL_INTERVAL * 3);
    expect(events.list).toEqual(['<send>', '</send>', 'launch-line', '<send>']);
    second.release();
    await second.done;
    await vi.advanceTimersByTimeAsync(CLAUDE_INIT_POLL_INTERVAL * 3 + CLAUDE_POST_PROMPT_DELAY);
    await expect(started).resolves.toBeUndefined();

    expect(events.list).toEqual(['<send>', '</send>', 'launch-line', '<send>', '</send>', 'enter']);
  });

  it('negative: with no send in the way the dialog gets its one Enter, unchanged', async () => {
    let trusted = false;
    vi.mocked(capturePane).mockImplementation(async () => (trusted ? CLAUDE_READY : CLAUDE_TRUST));
    vi.mocked(sendKeys).mockImplementation(async (_s, keys, enter) => {
      // `sanitizeSessionEnvironment`'s `unset CLAUDECODE` (session-key-sender,
      // not this Issue's to move) is left out of the order.
      if (keys === 'unset CLAUDECODE') return;
      if (keys === '' && enter === true) {
        events.list.push('enter');
        trusted = true;
      } else {
        events.list.push('launch-line');
      }
    });

    const started = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 3 + CLAUDE_POST_PROMPT_DELAY);
    await expect(started).resolves.toBeUndefined();

    expect(events.list).toEqual(['launch-line', 'enter']);
  });
});

describe('[#3975] an answer read before a launch key reads the screen again', () => {
  it('positive: a `respond` that read the dialog before the launch\'s Enter is not typed after it', async () => {
    const readMark = instanceInputReadMark();
    // The launch's Enter, as an exclusive writer, between the answer's read and its keys.
    await answerUnderInstanceInputLock('s', instanceInputLaunchReadMark(), async () => true, async () => {
      events.list.push('launch-enter');
    }, { mode: 'exclusive' });
    const stillApplies = vi.fn(async () => false);
    const outcome = await answerUnderInstanceInputLock('s', readMark, stillApplies, async () => {
      events.list.push('respond');
    });

    expect(outcome).toEqual({ answered: false, reason: 'target-changed' });
    expect(stillApplies).toHaveBeenCalledTimes(1);
    expect(events.list).toEqual(['launch-enter']);
  });

  it('negative: an exclusive key with nothing since its read is typed without a second read', async () => {
    const stillApplies = vi.fn(async () => true);
    const outcome = await answerUnderInstanceInputLock('s', instanceInputLaunchReadMark(), stillApplies, async () => {
      events.list.push('launch-enter');
    }, { mode: 'exclusive' });

    expect(outcome).toEqual({ answered: true, value: undefined });
    expect(stillApplies).not.toHaveBeenCalled();
  });
});

describe('[#3975 review P2-1] a launch key reads again after a shared answer finished since its read', () => {
  it('positive: launch reads → a `respond` (shared) starts and finishes → launch enters: read again, key not sent', async () => {
    const launchMark = instanceInputLaunchReadMark();
    // A `respond` to the same dialog, typed and done before the launch asks for the lock.
    const respond = await answerUnderInstanceInputLock('s', instanceInputReadMark(), async () => true, async () => {
      events.list.push('respond');
    });
    expect(respond).toEqual({ answered: true, value: undefined });

    // The dialog the launch read is gone: before the fix it was not read again.
    const stillApplies = vi.fn(async () => false);
    const outcome = await answerUnderInstanceInputLock('s', launchMark, stillApplies, async () => {
      events.list.push('launch-enter');
    }, { mode: 'exclusive' });

    expect(stillApplies).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ answered: false, reason: 'target-changed' });
    expect(events.list).toEqual(['respond']);
  });

  it('positive: the launch key still goes out when the screen read again still calls for it', async () => {
    const launchMark = instanceInputLaunchReadMark();
    await answerUnderInstanceInputLock('s', instanceInputReadMark(), async () => true, async () => {
      events.list.push('respond');
    });
    const stillApplies = vi.fn(async () => true);
    const outcome = await answerUnderInstanceInputLock('s', launchMark, stillApplies, async () => {
      events.list.push('launch-enter');
    }, { mode: 'exclusive' });

    expect(stillApplies).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ answered: true, value: undefined });
    expect(events.list).toEqual(['respond', 'launch-enter']);
  });

  it('negative: with nothing between the launch\'s read and its entry, nothing is read again', async () => {
    // A shared answer that finished before the launch's read does not count.
    await answerUnderInstanceInputLock('s', instanceInputReadMark(), async () => true, async () => {
      events.list.push('respond');
    });
    const launchMark = instanceInputLaunchReadMark();
    const stillApplies = vi.fn(async () => true);
    const outcome = await answerUnderInstanceInputLock('s', launchMark, stillApplies, async () => {
      events.list.push('launch-enter');
    }, { mode: 'exclusive' });

    expect(stillApplies).not.toHaveBeenCalled();
    expect(outcome).toEqual({ answered: true, value: undefined });
  });

  it('negative: shared answers keep their #3952 behaviour — one finished since a shared read is not a re-read', async () => {
    const readMark = instanceInputReadMark();
    await answerUnderInstanceInputLock('s', instanceInputReadMark(), async () => true, async () => {
      events.list.push('respond-1');
    });
    const stillApplies = vi.fn(async () => true);
    const outcome = await answerUnderInstanceInputLock('s', readMark, stillApplies, async () => {
      events.list.push('respond-2');
    });

    expect(stillApplies).not.toHaveBeenCalled();
    expect(outcome).toEqual({ answered: true, value: undefined });
  });
});
