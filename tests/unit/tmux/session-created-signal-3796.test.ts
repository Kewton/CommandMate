/**
 * Issue #3796: `createSession` reports the session it created, and only one it
 * created, to whoever waits for that name (the Auto-Yes poller's session wait).
 * tmux itself is stood in for (`execFile`), so nothing reaches a tmux server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { createSession } from '@/lib/tmux/tmux';
import {
  clearTmuxSessionCreatedListeners,
  countTmuxSessionCreatedListeners,
  notifyTmuxSessionCreated,
  onTmuxSessionCreated,
} from '@/lib/tmux/session-created-signal';

type Callback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

function execFileAnswers(fail: (args: string[]) => boolean): void {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as Callback;
    const argv = args[1] as string[];
    if (fail(argv)) callback(new Error('tmux failed'), { stdout: '', stderr: '' });
    else callback(null, { stdout: '', stderr: '' });
    return {} as ReturnType<typeof execFile>;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTmuxSessionCreatedListeners();
});

afterEach(() => {
  clearTmuxSessionCreatedListeners();
});

describe('[#3796] createSession reports the session it created', () => {
  it('positive: the listener for that name is called once, then dropped', async () => {
    execFileAnswers(() => false);
    const listener = vi.fn();
    onTmuxSessionCreated('cm-3796', listener);

    await createSession('cm-3796', '/tmp');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(countTmuxSessionCreatedListeners()).toBe(0);

    await createSession('cm-3796', '/tmp');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('negative: a creation that failed calls nobody, and the listener stays', async () => {
    execFileAnswers((argv) => argv[0] === 'new-session');
    const listener = vi.fn();
    onTmuxSessionCreated('cm-3796', listener);

    await expect(createSession('cm-3796', '/tmp')).rejects.toThrow('Failed to create tmux session');
    expect(listener).not.toHaveBeenCalled();
    expect(countTmuxSessionCreatedListeners()).toBe(1);
  });

  it('negative: another name is not called; unsubscribing stops the call', async () => {
    execFileAnswers(() => false);
    const other = vi.fn();
    const gone = vi.fn();
    onTmuxSessionCreated('cm-other', other);
    const unsubscribe = onTmuxSessionCreated('cm-3796', gone);
    unsubscribe();
    unsubscribe();

    await createSession('cm-3796', '/tmp');
    expect(other).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
    expect(countTmuxSessionCreatedListeners()).toBe(1);
  });

  it('a listener that throws neither fails the creation nor stops the others', async () => {
    execFileAnswers(() => false);
    const after = vi.fn();
    onTmuxSessionCreated('cm-3796', () => {
      throw new Error('listener failed');
    });
    onTmuxSessionCreated('cm-3796', after);

    await expect(createSession('cm-3796', '/tmp')).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
    notifyTmuxSessionCreated('cm-3796');
    expect(after).toHaveBeenCalledTimes(1);
  });
});
