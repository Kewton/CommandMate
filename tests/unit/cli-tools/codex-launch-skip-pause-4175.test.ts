/**
 * Issue #4175 (1): a launch answer the input lock declined used to `continue`
 * past the poll's pause, so a lock that declines at once spent all 30 of
 * `waitForReady`'s polls in no time. Each skip now waits the poll's own interval;
 * an answer that went out still waits only its settle, never both.
 *
 * Fake timers and mocks only; no codex runs.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LockArgs = [string, number, () => Promise<boolean>, () => Promise<unknown>];
const state = vi.hoisted(() => ({
  screen: '',
  calls: 0,
  lock: null as null | ((...args: LockArgs) => Promise<unknown>),
}));
const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ ...log, withContext: () => log }),
}));
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
  capturePane: vi.fn(async () => state.screen),
  killSession: vi.fn().mockResolvedValue(true),
  getSessionWorkingDirectory: vi.fn().mockResolvedValue('/path/to/wt'),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  exactTarget: (name: string) => `=${name}:`,
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/session/instance-input-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/instance-input-lock')>()),
  // Declines at once, as `recheck-failed` / `session-replaced` / `input-lock-lost` do.
  answerUnderInstanceInputLock: vi.fn(async (...args: LockArgs) => {
    state.calls += 1;
    return state.lock ? state.lock(...args) : { answered: false, reason: 'recheck-failed' };
  }),
}));

import { CodexTool } from '@/lib/cli-tools/codex';
import { CODEX_UPDATE_DIALOG_ENV_VAR } from '@/config/codex-update-dialog-config';
import { CODEX_DIALOG_SETTLE_MS } from '@/config/cli-tool-timing-config';
import { sendKeys } from '@/lib/tmux/tmux';

const fixture = (rel: string): string => readFileSync(resolve(__dirname, '../../fixtures', rel), 'utf8');
const SESSION = 'mcbd-tool-wt4175';
const POLL_MS = 1000;
const POLLS = 30;

type Waits = { waitForReady(session: string, options?: { trustHooks: boolean }): Promise<void> };

/** Start a launch wait and report whether, and when, it has ended. */
function startLaunch(): { done: () => boolean; endedAt: () => number | null } {
  let endedAt: number | null = null;
  void (new CodexTool() as unknown as Waits)
    .waitForReady(SESSION, { trustHooks: false })
    .finally(() => {
      endedAt = Date.now();
    });
  return { done: () => endedAt !== null, endedAt: () => endedAt };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.clearAllMocks();
  vi.stubEnv(CODEX_UPDATE_DIALOG_ENV_VAR, undefined as unknown as string);
  state.calls = 0;
  state.lock = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('a lock that declines every launch answer at once', () => {
  /** Decline the digit's pass, so the Enter branch is the one that keeps declining. */
  const passFirst = (): void => {
    state.lock = async (_s, _m, _still, answer) =>
      state.calls === 1 ? { answered: true, value: await answer() } : { answered: false, reason: 'recheck-failed' };
  };

  it.each([
    ['the update offer', () => { state.screen = fixture('codex-dialogs-0166/update.txt'); }],
    ['the press-enter notice', () => { state.screen = 'Something changed\n\nPress enter to continue\n'; }],
    ['the trust digit', () => { state.screen = fixture('codex-dialogs-0166/trust.txt'); }],
    ['the trust Enter', () => { state.screen = fixture('codex-dialogs-0166/trust.txt'); passFirst(); }],
  ])('%s: one poll per second, and the window still ends at its 30 polls', async (_name, arrange) => {
    arrange();
    const launch = startLaunch();

    await vi.advanceTimersByTimeAsync(0);
    expect(launch.done()).toBe(false); // positive control: before #4175 all 30 went here
    expect(state.calls).toBeLessThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(10 * POLL_MS);
    expect(launch.done()).toBe(false);
    expect(state.calls).toBeLessThanOrEqual(12);

    await vi.advanceTimersByTimeAsync((POLLS + 2) * POLL_MS);
    expect(launch.done()).toBe(true);
    // Bounded: no more polls than the window, and it ends no later than it.
    expect(state.calls).toBeLessThanOrEqual(POLLS);
    expect(launch.endedAt()).toBeGreaterThanOrEqual((POLLS - 2) * POLL_MS);
    expect(launch.endedAt()).toBeLessThanOrEqual(POLLS * POLL_MS + CODEX_DIALOG_SETTLE_MS);
    // As before the window's end is a log and a normal return; the send's own wait refuses.
    expect(log.info.mock.calls.some((call) => call[0] === 'codex-prompt-detection')).toBe(true);
  });
});

describe('unchanged', () => {
  it('a ready prompt returns at the first poll, with no answer', async () => {
    state.screen = fixture('codex-dialogs-0166/ready.txt');
    const launch = startLaunch();
    await vi.advanceTimersByTimeAsync(0);
    expect(launch.done()).toBe(true);
    expect(state.calls).toBe(0);
  });

  it('an answer that went out waits its settle only, not the skip pause on top', async () => {
    state.screen = fixture('codex-dialogs-0166/trust.txt');
    state.lock = async (_s, _m, _still, answer) => {
      const value = await answer();
      state.screen = fixture('codex-dialogs-0166/ready.txt');
      return { answered: true, value };
    };
    const launch = startLaunch();
    await vi.advanceTimersByTimeAsync(CODEX_DIALOG_SETTLE_MS);
    expect(launch.done()).toBe(true);
    expect(launch.endedAt()).toBe(CODEX_DIALOG_SETTLE_MS);
    expect(sendKeys).toHaveBeenCalledWith(SESSION, '1', false);
  });

  it('a skip then an answer: the answer goes out one poll later', async () => {
    state.screen = fixture('codex-dialogs-0166/trust.txt');
    state.lock = async (_s, _m, _still, answer) => {
      if (state.calls === 1) return { answered: false, reason: 'recheck-failed' };
      const value = await answer();
      state.screen = fixture('codex-dialogs-0166/ready.txt');
      return { answered: true, value };
    };
    const launch = startLaunch();
    await vi.advanceTimersByTimeAsync(POLL_MS + CODEX_DIALOG_SETTLE_MS);
    expect(launch.done()).toBe(true);
    expect(launch.endedAt()).toBe(POLL_MS + CODEX_DIALOG_SETTLE_MS);
    expect(state.calls).toBe(2);
  });
});
