/**
 * Issue #3981, PR review P3-1 / P3-2: what a caller gets when it meets another
 * request's launch of the same session.
 *
 * - P3-1 (a bound): a join or a wait-out ends at the launch's own start budget
 *   (`getSessionStartingMaxMs`, from when the launch began) with a
 *   `SESSION_STARTING` error — read as not-sent — instead of hanging for as
 *   long as the launch does. Negative: a launch that finishes inside the budget
 *   is joined and waited out as before.
 * - P3-2 (a model): a start that asks for a model the launch in progress is not
 *   starting with is refused with nothing typed, and the launch is not run a
 *   second time. Negative: the same model, or no model, joins.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_LAUNCH_MODEL_MISMATCH_CODE,
  SessionLaunchWaitTimeoutError,
  isSessionLaunchInFlight,
  isSessionLaunchModelMismatchError,
  resetSessionLaunchFlightsForTest,
  runSessionLaunch,
  settleSessionLaunch,
} from '@/lib/session/session-launch-flight';
import { getSessionStartingMaxMs } from '@/config/session-starting-config';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { SESSION_STARTING_CODE } from '@/lib/session/session-start-error';

const SESSION = 'mcbd-claude-wt3981-bounds';

/** A launch that returns only when told to. */
function gatedLaunch(): { launch: () => Promise<void>; finish: () => void; calls: () => number } {
  let finish!: () => void;
  let calls = 0;
  const gate = new Promise<void>((r) => (finish = r));
  return {
    launch: () => {
      calls += 1;
      return gate;
    },
    finish: () => finish(),
    calls: () => calls,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSessionLaunchFlightsForTest();
});

afterEach(() => {
  resetSessionLaunchFlightsForTest();
  vi.useRealTimers();
});

describe('[#3981 P3-1] a wait for another request’s launch is bounded by its start budget', () => {
  const budget = getSessionStartingMaxMs('claude');

  it('positive: a join gives up at the budget with SESSION_STARTING (not-sent); the launch is left running', async () => {
    const a = gatedLaunch();
    void runSessionLaunch(SESSION, 'Claude Code', a.launch, { cliToolId: 'claude' });
    const joined = runSessionLaunch(SESSION, 'Claude Code', a.launch, { cliToolId: 'claude' }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(budget - 1);
    let settled = false;
    void joined.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = await joined;
    expect(error).toBeInstanceOf(SessionLaunchWaitTimeoutError);
    expect((error as { code: string }).code).toBe(SESSION_STARTING_CODE);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'session-starting' });
    expect(a.calls()).toBe(1);
    expect(isSessionLaunchInFlight(SESSION)).toBe(true);
    a.finish();
  });

  it('positive: a wait-out (settle) gives up at the budget too, counted from when the launch began', async () => {
    const a = gatedLaunch();
    void runSessionLaunch(SESSION, 'Claude Code', a.launch, { cliToolId: 'claude' });
    await vi.advanceTimersByTimeAsync(budget - 1_000);
    const settled = settleSessionLaunch(SESSION, 'Claude Code').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled).toBeInstanceOf(SessionLaunchWaitTimeoutError);

    // Past the budget, a newcomer is answered at once.
    const late = settleSessionLaunch(SESSION, 'Claude Code').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(await late).toBeInstanceOf(SessionLaunchWaitTimeoutError);
    a.finish();
  });

  it('negative: a launch that finishes inside the budget is joined and waited out as before', async () => {
    const a = gatedLaunch();
    const first = runSessionLaunch(SESSION, 'Claude Code', a.launch, { cliToolId: 'claude' });
    const joined = runSessionLaunch(SESSION, 'Claude Code', a.launch, { cliToolId: 'claude' });
    const settled = settleSessionLaunch(SESSION, 'Claude Code');
    await vi.advanceTimersByTimeAsync(budget - 1_000);
    a.finish();
    await expect(first).resolves.toBeUndefined();
    await expect(joined).resolves.toBeUndefined();
    await expect(settled).resolves.toBe(true);
    expect(a.calls()).toBe(1);
    expect(isSessionLaunchInFlight(SESSION)).toBe(false);
  });

  it('negative: a joined launch’s own failure still reaches the joiner, before the budget', async () => {
    let fail!: (e: Error) => void;
    const first = runSessionLaunch(SESSION, 'Claude Code', () => new Promise<void>((_r, j) => (fail = j)), { cliToolId: 'claude' });
    const joined = runSessionLaunch(SESSION, 'Claude Code', async () => undefined, { cliToolId: 'claude' });
    fail(new Error('launch failed'));
    await expect(first).rejects.toThrow('launch failed');
    await expect(joined).rejects.toThrow('launch failed');
  });
});

describe('[#3981 P3-2] a start does not join a launch that is starting another model', () => {
  it('positive: another model is refused at once, nothing launched twice', async () => {
    const a = gatedLaunch();
    void runSessionLaunch(SESSION, 'Claude Code', a.launch, { cliToolId: 'claude', model: 'sonnet' });
    const error = await runSessionLaunch(SESSION, 'Claude Code', a.launch, { cliToolId: 'claude', model: 'opus' }).catch(
      (e: unknown) => e
    );
    expect(isSessionLaunchModelMismatchError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(SESSION_LAUNCH_MODEL_MISMATCH_CODE);
    expect((error as Error).message).toMatch(/model 'sonnet', not 'opus'/);
    expect((error as Error).message).toMatch(/nothing was typed/);
    expect(a.calls()).toBe(1);
    a.finish();
  });

  it('positive: a model asked of a launch on the tool’s default is refused too', async () => {
    const a = gatedLaunch();
    void runSessionLaunch(SESSION, 'Claude Code', a.launch, { cliToolId: 'claude' });
    const error = await runSessionLaunch(SESSION, 'Claude Code', a.launch, { cliToolId: 'claude', model: 'opus' }).catch(
      (e: unknown) => e
    );
    expect(isSessionLaunchModelMismatchError(error)).toBe(true);
    expect((error as Error).message).toMatch(/its default model, not 'opus'/);
    a.finish();
  });

  it('negative: the same model, or no model, joins', async () => {
    const a = gatedLaunch();
    const first = runSessionLaunch(SESSION, 'Claude Code', a.launch, { cliToolId: 'claude', model: 'opus' });
    const same = runSessionLaunch(SESSION, 'Claude Code', a.launch, { cliToolId: 'claude', model: 'opus' });
    const none = runSessionLaunch(SESSION, 'Claude Code', a.launch, { cliToolId: 'claude' });
    a.finish();
    await expect(Promise.all([first, same, none])).resolves.toEqual([undefined, undefined, undefined]);
    expect(a.calls()).toBe(1);
  });
});

describe('[#3981 P3-2] BaseCLITool.startSession hands the launch its model', () => {
  it('positive: antigravity started with one model, then asked for another while launching → refused, launched once', async () => {
    const { AntigravityTool } = await import('@/lib/cli-tools/antigravity');
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const launchSession = vi
      .spyOn(AntigravityTool.prototype as unknown as { launchSession: () => Promise<void> }, 'launchSession')
      .mockImplementation(() => gate);
    const tool = new AntigravityTool();
    const first = tool.startSession('wt3981m', '/path/to/wt3981m', undefined, 'model-a');
    const second = await tool.startSession('wt3981m', '/path/to/wt3981m', undefined, 'model-b').catch((e: unknown) => e);
    expect(isSessionLaunchModelMismatchError(second)).toBe(true);
    const third = tool.startSession('wt3981m', '/path/to/wt3981m', undefined, 'model-a');
    finish();
    await first;
    await third;
    expect(launchSession).toHaveBeenCalledTimes(1);
    launchSession.mockRestore();
  });
});
