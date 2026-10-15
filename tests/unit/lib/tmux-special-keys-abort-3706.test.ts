/**
 * `sendSpecialKeys` asks its caller between two keys (Issue #3706).
 *
 * The real tmux module, with only `child_process.execFile` — the tmux call
 * itself — stubbed. The delay between keys is where Auto-Yes's grant can be
 * withdrawn mid-answer; `shouldContinue` returning false there must stop the
 * keys not yet sent, and the stop must not be dressed up as a transport error.
 * Without the option, nothing about the send changes.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'child_process';
import { sendSpecialKeys, SpecialKeysAbortedError } from '@/lib/tmux/tmux';

/** The key of each `tmux send-keys` call, in order. */
function keysSent(): string[] {
  return vi.mocked(execFile).mock.calls.map((call) => {
    const args = call[1] as string[];
    return args[args.length - 1];
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(execFile).mockReset();
  vi.mocked(execFile).mockImplementation(((
    _cmd: string,
    _args: string[],
    _opts: unknown,
    callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    callback(null, { stdout: '', stderr: '' });
  }) as unknown as typeof execFile);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('[#3706] sendSpecialKeys with shouldContinue', () => {
  it('stops before the next key when shouldContinue says no', async () => {
    let current = true;
    const sending = sendSpecialKeys('cm-wt-3706-claude', ['Down', 'Down', 'Enter'], {
      shouldContinue: () => current,
    });
    const settled = sending.then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(keysSent()).toEqual(['Down']);

    current = false;
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await settled;

    expect(keysSent()).toEqual(['Down']);
    expect(error).toBeInstanceOf(SpecialKeysAbortedError);
    expect((error as SpecialKeysAbortedError).keysSent).toBe(1);
    expect((error as Error).message).not.toMatch(/Failed to send special keys/);
  });

  it('negative: shouldContinue that stays true sends every key', async () => {
    const sending = sendSpecialKeys('cm-wt-3706-claude', ['Down', 'Down', 'Enter'], {
      shouldContinue: () => true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await sending;
    expect(keysSent()).toEqual(['Down', 'Down', 'Enter']);
  });

  it('negative: without the option every key is sent, as before', async () => {
    const sending = sendSpecialKeys('cm-wt-3706-claude', ['Up', 'Enter']);
    await vi.advanceTimersByTimeAsync(1_000);
    await sending;
    expect(keysSent()).toEqual(['Up', 'Enter']);
  });

  it('negative: a transport failure is still the wrapped error', async () => {
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (error: Error | null) => void,
    ) => {
      callback(new Error('no server running'));
    }) as unknown as typeof execFile);

    await expect(
      sendSpecialKeys('cm-wt-3706-claude', ['Enter'], { shouldContinue: () => true }),
    ).rejects.toThrow(/Failed to send special keys to tmux session: no server running/);
  });
});
