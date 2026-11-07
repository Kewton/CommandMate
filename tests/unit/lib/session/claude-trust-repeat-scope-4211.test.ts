/**
 * Issue #4211: the Claude folder-trust dialog's launch answer passes its wait's
 * record (`LaunchAnswerSkips`) to the input lock as `repeatScope`, as the nudge and
 * the other tools do since #4175 / #4189. A key declined on every poll is one warn
 * while the same reason goes on — `trust-dialog-key-skipped` and the lock's
 * `instance-input-answer-recheck-failed` both. A key that went out, a change of
 * reason, another start, and a session made again each make the next decline a warn.
 *
 * The real input lock: the mock below only makes every answer read the screen again
 * under it, and decides what that read says (the form of
 * `tests/unit/cli-tools/launch-answer-repeat-scope-4189.test.ts`).
 *
 * @vitest-environment node
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';

/** `remake`: the session is made again while the answer reads the screen again, and the read fails. */
type Step = 'fail' | 'changed' | 'through' | 'remake';
type LockFn = typeof import('@/lib/session/instance-input-lock').answerUnderInstanceInputLock;

const state = vi.hoisted(() => ({
  /** What each answer's read under the lock says, in order; `fail` once it runs out. */
  plan: [] as Step[],
  /** The `repeatScope` of each answer, in order. */
  scopes: [] as unknown[],
  /** Called before each pane read with its 1-based count. */
  onRead: null as null | ((n: number) => void),
  reads: 0,
}));
const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return { ...actual, createLogger: () => ({ ...log, withContext: () => log }) };
});

vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));

registerIsolatedAgentHooksDir('claude-trust-4211');

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKeys: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  getPaneCurrentCommand: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  constants: { X_OK: 1 },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn((cmd: string, opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    callback(null, { stdout: cmd.includes('which claude') ? '/usr/local/bin/claude' : '', stderr: '' });
    return {};
  }),
}));

vi.mock('@/lib/session/instance-input-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/instance-input-lock')>();
  const wrapped = (async (sessionName, _readMark, _stillApplies, answer, options) => {
    state.scopes.push(options?.repeatScope);
    const step = state.plan.shift() ?? 'fail';
    // A read mark no current one equals: the lock reads the screen again.
    return actual.answerUnderInstanceInputLock(
      sessionName,
      -1,
      async () => {
        if (step === 'remake') {
          actual.invalidateInstanceInput(sessionName);
          throw new Error('old pane gone');
        }
        if (step === 'fail') throw new Error('pane read failed');
        return step === 'through';
      },
      answer,
      options
    );
  }) as LockFn;
  return { ...actual, answerUnderInstanceInputLock: vi.fn(wrapped) };
});

import { CLAUDE_INIT_TIMEOUT, startClaudeSession } from '@/lib/session/claude-session';
import { capturePane, createSession, getPaneCurrentCommand, hasSession, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { invalidateInstanceInput, resetInstanceInputLocks } from '@/lib/session/instance-input-lock';

const S = 'mcbd-claude-wt';
const TRUST = 'trust-dialog-key-skipped';
const RECHECK = 'instance-input-answer-recheck-failed';

const FIXTURES = join(__dirname, '../../../fixtures');
const CURSOR_ON_NO = readFileSync(join(FIXTURES, 'claude-trust-dialog-3078/allowlist-default-no-2-1-287.txt'), 'utf-8');
const CURSOR_ON_YES = CURSOR_ON_NO.replace(' ❯ No, exit', '   No, exit').replace(
  '   Yes, I trust this folder',
  ' ❯ Yes, I trust this folder'
);

const NO_READABLE_CURSOR = '   No, exit\n   Yes, I trust this folder';

const warned = (event: string): unknown[][] => log.warn.mock.calls.filter((call) => call[0] === event);
const reasons = (event: string): string[] => warned(event).map((call) => (call[1] as { reason: string }).reason);
const lockWarns = (): number => warned(RECHECK).filter((call) => (call[1] as { sessionName: string }).sessionName === S).length;

/** Every answer of one wait carried the same, defined scope. */
function oneScope(scopes: unknown[]): object {
  expect(scopes.length).toBeGreaterThan(1);
  expect(scopes[0]).toBeTypeOf('object');
  for (const scope of scopes) expect(scope).toBe(scopes[0]);
  return scopes[0] as object;
}

/** Run a start to the end of its budget. */
async function runOut(): Promise<void> {
  const settled = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(CLAUDE_INIT_TIMEOUT + 10_000);
  await settled;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetInstanceInputLocks();
  state.plan = [];
  state.scopes = [];
  state.onRead = null;
  state.reads = 0;
  vi.mocked(hasSession).mockResolvedValue(false);
  vi.mocked(createSession).mockResolvedValue();
  vi.mocked(sendKeys).mockResolvedValue();
  vi.mocked(sendSpecialKeys).mockResolvedValue();
  vi.mocked(getPaneCurrentCommand).mockResolvedValue('2.1.287');
  vi.mocked(capturePane).mockImplementation(async () => {
    state.reads += 1;
    state.onRead?.(state.reads);
    return CURSOR_ON_NO;
  });
});

afterEach(() => {
  vi.useRealTimers();
  resetInstanceInputLocks();
});

describe('[#4211] the trust dialog passes its wait\'s record to the lock', () => {
  it('the same reason on every poll is one warn, its own and the lock\'s', async () => {
    // Positive: without a repeatScope the lock warned at every decline.
    await runOut();
    expect(state.scopes.length).toBeGreaterThan(5);
    oneScope(state.scopes);
    expect(reasons(TRUST)).toEqual(['recheck-failed']);
    expect(lockWarns()).toBe(1);
  });

  it('Enter: the same reason on every due poll is one warn, its own and the lock\'s', async () => {
    vi.mocked(capturePane).mockResolvedValue(CURSOR_ON_YES);
    await runOut();
    oneScope(state.scopes);
    expect(reasons(TRUST)).toEqual(['recheck-failed']);
    expect(lockWarns()).toBe(1);
  });

  it('a key that went out ends the streak: the next decline is a warn', async () => {
    // Positive: the old record (`lastSkip`) outlived the key that went out.
    state.plan = ['fail', 'fail', 'through', 'fail', 'fail'];
    await runOut();
    oneScope(state.scopes);
    expect(sendSpecialKeys).toHaveBeenCalled();
    expect(reasons(TRUST).slice(0, 2)).toEqual(['recheck-failed', 'recheck-failed']);
    expect(lockWarns()).toBeGreaterThanOrEqual(2);
  });

  it('a change of reason is a warn, and so is the old reason after it', async () => {
    state.plan = ['fail', 'fail', 'changed', 'changed', 'fail', 'fail'];
    await runOut();
    expect(reasons(TRUST)).toEqual(['recheck-failed', 'target-changed', 'recheck-failed']);
    expect(lockWarns()).toBe(2); // target-changed is the lock's info, and ends its streak
  });

  it('another start is another wait: its first decline is a warn', async () => {
    await runOut();
    const first = oneScope(state.scopes);
    state.scopes = [];
    await runOut();
    expect(oneScope(state.scopes)).not.toBe(first);
    expect(reasons(TRUST)).toEqual(['recheck-failed', 'recheck-failed']);
    expect(lockWarns()).toBe(2);
  });

  it('a session made again within the wait: the first decline after it is a warn, its own and the lock\'s', async () => {
    // Positive: the own record did not compare lives.
    state.onRead = (n) => {
      if (n === 4) invalidateInstanceInput(S);
    };
    await runOut();
    expect(reasons(TRUST)).toEqual(['recheck-failed', 'recheck-failed']);
    expect(lockWarns()).toBe(2);
  });

  it('an answer of the old life, ended after the session was made again, leaves the new life its first warn', async () => {
    // Positive: the life is taken before the answer's await, not after it.
    state.plan = ['remake'];
    await runOut();
    expect(reasons(TRUST)).toEqual(['recheck-failed', 'recheck-failed']);
    expect(state.scopes.length).toBeGreaterThan(2);
  });

  it('cursor-unreadable: a session made again during the screen check leaves the new life its first warn', async () => {
    // Positive (review 4211 P2): the decline judged on the old screen was recorded under
    // the life read after `paneCommandIsAgent`'s await — the new one — and held back the
    // new session's first cursor-unreadable.
    vi.mocked(capturePane).mockResolvedValue(NO_READABLE_CURSOR);
    let checks = 0;
    vi.mocked(getPaneCurrentCommand).mockImplementation(async () => {
      checks += 1;
      if (checks === 1) invalidateInstanceInput(S);
      return '2.1.287';
    });
    await runOut();
    expect(checks).toBeGreaterThan(0);
    // The old life's decline, the new life's first, then its repeats: one record kept.
    expect(reasons(TRUST)).toEqual(['cursor-unreadable', 'cursor-unreadable']);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('control: cursor-unreadable on every poll, no new session, stays one warn', async () => {
    vi.mocked(capturePane).mockResolvedValue(NO_READABLE_CURSOR);
    await runOut();
    expect(reasons(TRUST)).toEqual(['cursor-unreadable']);
    expect(state.scopes).toEqual([]);
  });

  it('control: a dialog whose keys go out warns nothing', async () => {
    vi.mocked(capturePane).mockResolvedValue(CURSOR_ON_YES);
    state.plan = Array.from({ length: 200 }, () => 'through' as const);
    await runOut();
    expect(warned(TRUST)).toEqual([]);
    expect(lockWarns()).toBe(0);
  });
});
