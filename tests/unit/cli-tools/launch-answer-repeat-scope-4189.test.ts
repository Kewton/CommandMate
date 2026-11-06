/**
 * Issue #4189: a launch answer declined on every poll is one warn while the same
 * reason goes on in that wait — both the caller's own record (`*-answer-skipped`,
 * `claude-auto-default-nudge-key-skipped`) and the lock's
 * (`instance-input-answer-recheck-failed`). Each wait passes its `LaunchAnswerSkips`
 * as the lock's `repeatScope`; the auto-default nudge keeps one per wait as well.
 *
 * The real input lock: the mock below only makes every answer read the screen again
 * under it, and decides what that read says.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Step = 'fail' | 'changed' | 'through';
type LockFn = typeof import('@/lib/session/instance-input-lock').answerUnderInstanceInputLock;

const state = vi.hoisted(() => ({
  screen: '',
  /** What each answer's read under the lock says, in order; `fail` once it runs out. */
  plan: [] as Step[],
  /** The `repeatScope` of each answer, in order. */
  scopes: [] as unknown[],
  /** Called before each pane read with its 1-based count. */
  onRead: null as null | ((n: number) => void),
  reads: 0,
}));
const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ ...log, withContext: () => log }),
}));
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});
vi.mock('@/lib/cli-tools/copilot-executable', () => ({ resolveCopilotExecutable: vi.fn() }));
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
  capturePane: vi.fn(async () => {
    state.reads += 1;
    state.onRead?.(state.reads);
    return state.screen;
  }),
  killSession: vi.fn().mockResolvedValue(true),
  getSessionWorkingDirectory: vi.fn().mockResolvedValue('/path/to/wt'),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  exactTarget: (name: string) => `=${name}:`,
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
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
        if (step === 'fail') throw new Error('pane read failed');
        return step === 'through';
      },
      answer,
      options
    );
  }) as LockFn;
  return { ...actual, answerUnderInstanceInputLock: vi.fn(wrapped) };
});

import { answerClaudeAutoDefaultNudgeBeforeSend, answerClaudeAutoDefaultNudgeUntil, sendNudgeKey } from '@/lib/cli-tools/claude-auto-default-nudge';
import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import { clearStartupTrust, markStartupTrustPending } from '@/lib/cli-tools/antigravity-startup-trust';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { invalidateInstanceInput, resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { sendSpecialKeys } from '@/lib/tmux/tmux';
import { buildCopilotFolderTrustFrame } from '@tests/fixtures/copilot-folder-trust-1080';

const S = 'mcbd-tool-wt4189';
const RECHECK = 'instance-input-answer-recheck-failed';
const NUDGE = 'claude-auto-default-nudge-key-skipped';

const fixture = (rel: string): string => readFileSync(resolve(__dirname, '../../fixtures', rel), 'utf8');
const nudgeFrame = (name: string): string =>
  readFileSync(join(process.cwd(), 'tests/fixtures/claude-auto-default-nudge-4134', `${name}.txt`), 'utf8');

const warned = (event: string): unknown[][] => log.warn.mock.calls.filter((call) => call[0] === event);
const reasons = (event: string): string[] => warned(event).map((call) => (call[1] as { reason: string }).reason);
const lockWarns = (): number => warned(RECHECK).filter((call) => (call[1] as { sessionName: string }).sessionName === S).length;

type Waits = {
  waitForReady(session: string): Promise<void>;
  waitForPrompt(session: string, ...rest: unknown[]): Promise<unknown>;
};
const waits = (tool: unknown): Waits => tool as Waits;

/** Run a wait to its end, or to its refusal. */
async function run(wait: Promise<unknown>, ms: number): Promise<unknown> {
  const settled = wait.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}

/** Every answer of one wait carried the same, defined scope. */
function oneScope(scopes: unknown[]): object {
  expect(scopes.length).toBeGreaterThan(1);
  expect(scopes[0]).toBeTypeOf('object');
  for (const scope of scopes) expect(scope).toBe(scopes[0]);
  return scopes[0] as object;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetInstanceInputLocks();
  clearStartupTrust();
  state.plan = [];
  state.scopes = [];
  state.onRead = null;
  state.reads = 0;
  vi.mocked(sendSpecialKeys).mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
  resetInstanceInputLocks();
});

describe('claude auto-default nudge', () => {
  const beforeSend = (): Promise<unknown> => run(answerClaudeAutoDefaultNudgeBeforeSend(S), 15_000);

  it('a send: the same reason on every read is one warn, its own and the lock\'s', async () => {
    state.screen = nudgeFrame('cursor-yes');
    await beforeSend();
    expect(state.scopes.length).toBeGreaterThan(2);
    oneScope(state.scopes);
    expect(reasons(NUDGE)).toEqual(['recheck-failed']);
    expect(lockWarns()).toBe(1);
  });

  it('another send is another wait: its first decline is a warn', async () => {
    state.screen = nudgeFrame('cursor-yes');
    await beforeSend();
    const first = oneScope(state.scopes);
    state.scopes = [];
    await beforeSend();
    expect(oneScope(state.scopes)).not.toBe(first);
    expect(reasons(NUDGE)).toEqual(['recheck-failed', 'recheck-failed']);
    expect(lockWarns()).toBe(2);
  });

  it('a change of reason is a warn, and so is the old reason after it', async () => {
    state.screen = nudgeFrame('cursor-yes');
    state.plan = ['fail', 'fail', 'changed', 'changed', 'fail', 'fail'];
    await beforeSend();
    expect(reasons(NUDGE)).toEqual(['recheck-failed', 'target-changed', 'recheck-failed']);
    expect(lockWarns()).toBe(2); // target-changed is the lock's info, and ends its streak
  });

  it('a key that went out ends the streak: the next decline is a warn', async () => {
    let end: () => void = () => undefined;
    const start = new Promise<void>((r) => {
      end = r;
    });
    state.screen = nudgeFrame('cursor-yes');
    state.plan = ['fail', 'fail', 'through', 'fail', 'fail'];
    const watching = answerClaudeAutoDefaultNudgeUntil(S, start);
    await vi.advanceTimersByTimeAsync(3_000); // 6 polls
    end();
    await watching;
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
    oneScope(state.scopes);
    expect(reasons(NUDGE)).toEqual(['recheck-failed', 'recheck-failed']);
    expect(lockWarns()).toBe(2);
  });

  it('a session made again: the lock warns again in the same wait, a new launch warns its own again', async () => {
    state.screen = nudgeFrame('cursor-yes');
    state.onRead = (n) => {
      if (n === 5) invalidateInstanceInput(S);
    };
    await beforeSend();
    expect(lockWarns()).toBe(2);

    let end: () => void = () => undefined;
    const start = new Promise<void>((r) => {
      end = r;
    });
    state.onRead = null;
    invalidateInstanceInput(S);
    const watching = answerClaudeAutoDefaultNudgeUntil(S, start);
    await vi.advanceTimersByTimeAsync(3_000);
    end();
    await watching;
    expect(reasons(NUDGE)).toEqual(['recheck-failed', 'recheck-failed']);
    expect(lockWarns()).toBe(3);
  });

  it('a key tmux refused on every read is one warn', async () => {
    state.screen = nudgeFrame('cursor-yes');
    state.plan = Array.from({ length: 20 }, () => 'through' as const);
    vi.mocked(sendSpecialKeys).mockRejectedValue(new Error('tmux: no server'));
    await beforeSend();
    expect(reasons(NUDGE)).toEqual(['send-failed']);
  });

  it('control: a key with no wait\'s record warns every time, its own and the lock\'s, as before', async () => {
    state.screen = nudgeFrame('cursor-yes');
    await expect(sendNudgeKey(S, -1, 'Down')).resolves.toBe(false);
    await expect(sendNudgeKey(S, -1, 'Down')).resolves.toBe(false);
    expect(state.scopes).toEqual([undefined, undefined]);
    expect(reasons(NUDGE)).toEqual(['recheck-failed', 'recheck-failed']);
    expect(lockWarns()).toBe(2);
  });
});

describe('the launch waits pass their record to the lock', () => {
  it('gemini: one lock warn per wait', async () => {
    state.screen = fixture('gemini-live-3776/trust-dialog.txt');
    await run(waits(new GeminiTool()).waitForReady(S), 120_000);
    const first = oneScope(state.scopes);
    expect(lockWarns()).toBe(1);
    expect(warned('gemini-trust-answer-skipped')).toHaveLength(1);
    state.scopes = [];
    await run(waits(new GeminiTool()).waitForReady(S), 120_000);
    expect(oneScope(state.scopes)).not.toBe(first);
    expect(lockWarns()).toBe(2);
  });

  it('copilot launch and send: one lock warn per wait', async () => {
    state.screen = buildCopilotFolderTrustFrame();
    await run(waits(new CopilotTool()).waitForReady(S), 120_000);
    const first = oneScope(state.scopes);
    expect(lockWarns()).toBe(1);
    state.scopes = [];
    await run(waits(new CopilotTool()).waitForPrompt(S, 10_000), 16_000);
    expect(oneScope(state.scopes)).not.toBe(first);
    expect(lockWarns()).toBe(2);
  });

  it('agy launch: one lock warn per wait', async () => {
    state.screen = fixture('antigravity-live-2364/trust-dialog.txt');
    await run(waits(new AntigravityTool()).waitForReady(S), 200_000);
    oneScope(state.scopes);
    expect(lockWarns()).toBe(1);
    expect(warned('antigravity-trust-answer-skipped')).toHaveLength(1);
  });

  it('agy owed Enter at a send: one lock warn per wait', async () => {
    state.screen = fixture('antigravity-live-2364/trust-dialog.txt');
    markStartupTrustPending(S);
    await run(waits(new AntigravityTool()).waitForPrompt(S), 200_000);
    oneScope(state.scopes);
    expect(lockWarns()).toBe(1);
  });

  it('a session made again within the wait: its first decline is a lock warn', async () => {
    state.screen = fixture('gemini-live-3776/trust-dialog.txt');
    state.onRead = (n) => {
      if (n === 4) invalidateInstanceInput(S);
    };
    await run(waits(new GeminiTool()).waitForReady(S), 120_000);
    expect(lockWarns()).toBe(2);
  });
});
