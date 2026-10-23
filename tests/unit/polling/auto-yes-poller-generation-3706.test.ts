/**
 * Auto-Yes ticks act only for the generation they started under (Issue #3706).
 *
 * A tick takes its poller state, its grant and its session epoch at the top and
 * compares them — by identity, never by re-reading the key — after every wait:
 * the capture, the ownership check, the Enter fallback's fresh capture, the
 * sender's guard read and the delays between its keys, and when it re-arms its
 * timer. Each wait here is held open with a deferred promise while the state
 * moves, then released.
 *
 * Driven through the real poller and the real `sendPromptAnswer`; only the ends
 * are stubbed: the capture, the ownership check and the tmux module. The tmux
 * double sends keys one at a time and asks `shouldContinue` between them, as
 * `sendSpecialKeys` does (`tests/unit/lib/tmux-special-keys-abort-3706.test.ts`
 * holds the real one to that).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { TUI_TEXT_INPUT_WAIT_MS } from '@/config/cli-tool-timing-config';

/** A promise the test resolves by hand. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// --- capture ---------------------------------------------------------------
let pane = '';
let captureGate: Deferred<void> | null = null;
let freshGate: Deferred<void> | null = null;
const captureSessionOutput = vi.fn(async () => {
  if (captureGate) await captureGate.promise;
  return pane;
});
const captureSessionOutputFresh = vi.fn(async () => {
  if (freshGate) await freshGate.promise;
  return pane;
});
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: () => captureSessionOutput(),
  captureSessionOutputFresh: () => captureSessionOutputFresh(),
  getSessionPresence: vi.fn(async () => 'present'),
}));

// --- ownership ---------------------------------------------------------------
let ownershipGate: Deferred<void> | null = null;
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: async () => {
    if (ownershipGate) await ownershipGate.promise;
    return { verdict: 'owned', sessionPath: null };
  },
}));

// --- tmux ---------------------------------------------------------------------
/** Every key that reached the pane, in order. */
let keysSent: string[] = [];
/** Held open while the sender's guard reads the pane. */
let guardReadGate: Deferred<void> | null = null;
const sendSpecialKeys = vi.fn(
  async (_session: string, keys: string[], options?: { shouldContinue?: () => boolean }) => {
    for (let i = 0; i < keys.length; i++) {
      keysSent.push(keys[i]);
      if (i < keys.length - 1) {
        if (options?.shouldContinue && !options.shouldContinue()) {
          const stop = new Error('stopped');
          stop.name = 'SpecialKeysAbortedError';
          throw stop;
        }
      }
    }
  },
);
const sendKeys = vi.fn(async (_session: string, keys: string, enter = true) => {
  keysSent.push(enter ? `${keys}<Enter>` : keys);
});
vi.mock('@/lib/tmux/tmux', () => ({
  sendSpecialKeys: (s: string, k: string[], o?: { shouldContinue?: () => boolean }) => sendSpecialKeys(s, k, o),
  sendKeys: (s: string, k: string, e?: boolean) => sendKeys(s, k, e),
  capturePane: async () => {
    if (guardReadGate) await guardReadGate.promise;
    return pane;
  },
}));

// --- the rest ---------------------------------------------------------------
let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
const recordAnsweredPrompt = vi.fn();
vi.mock('@/lib/db/chat-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/chat-db')>();
  return {
    ...actual,
    recordAnsweredPrompt: (...args: Parameters<typeof actual.recordAnsweredPrompt>) => {
      recordAnsweredPrompt(...args);
      return actual.recordAnsweredPrompt(...args);
    },
  };
});
const startResponsePolling = vi.fn();
vi.mock('@/lib/polling/response-poller', () => ({
  startPolling: (...a: unknown[]) => startResponsePolling(...a),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
const taskEvents = vi.fn();
vi.mock('@/lib/tasks/task-transition-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks/task-transition-service')>();
  return {
    ...actual,
    applyEventToActiveTask: (...args: Parameters<typeof actual.applyEventToActiveTask>) => {
      taskEvents(args[4]);
      return actual.applyEventToActiveTask(...args);
    },
  };
});
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (id: string) => ({
        name: id,
        getSessionName: (worktreeId: string, instanceId?: string) => `cm-${worktreeId}-${instanceId ?? id}`,
      }),
    }),
  },
}));

import {
  clearAllPollerStates,
  isPollerActive,
  startAutoYesPolling,
  stopAutoYesPolling,
  stopAllAutoYesPolling,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import {
  clearAllAutoYesStates,
  disableAutoYes,
  getAutoYesState,
  setAutoYesEnabled,
  POLLING_INTERVAL_MS,
} from '@/lib/auto-yes-state';
import {
  AUTO_YES_ENTER_FALLBACK_ENV_VAR,
  beginEnterFallbackSession,
  clearEnterFallbacks,
  getLastEnterFallback,
} from '@/lib/polling/auto-yes-enter-fallback';
import { createMessage, getMessageById } from '@/lib/db/chat-db';
import { getLastPolicySuppression, clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { decidePromptPush } from '@/lib/push/prompt-push-gate';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-3706';
const KEY = `${WT}:claude`;
const ONE_HOUR = 3_600_000 as const;
const SESSION = `cm-${WT}-claude`;

/** The cursor on the default: the answer is one Enter. */
const PROMPT_ON_DEFAULT = 'Select an option:\n❯ 1. Yes\n  2. No';
/** A y/n prompt: the answer is typed, then — after a wait — submitted with Enter. */
const PROMPT_TYPED = 'Do you want to proceed? (y/n)';
/** A numbered list under a cursor that claude's dialog rules decline (#3397). */
const CLAUDE_UNRECOGNISED_LIST = [
  '⏺ Pick one',
  '',
  '❯ 1. On-premises deployment',
  '  2. Cloud-managed platform',
  '  3. Kubernetes',
  '',
  '  Which one?',
].join('\n');

/** Let every pending promise job run (no timer moves). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

/** The poller state under the key, as the module keeps it (globalThis, #153). */
async function pollerStateOf(key: string): Promise<AutoYesPollerState | undefined> {
  return globalThis.__autoYesPollerStates?.get(key);
}

function enable(stopPattern?: string): void {
  setAutoYesEnabled(WT, 'claude', true, ONE_HOUR, stopPattern);
  startAutoYesPolling(WT, 'claude');
}

/** What the disable route does: the grant off, then the poller stopped. */
function disable(): void {
  disableAutoYes(WT, 'claude');
  stopAutoYesPolling(KEY);
}

/** Run the first tick up to whatever gate the test has closed. */
async function firstTick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
  await settle();
}

const originalEnv = process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR];
const originalGateEnv = process.env.CM_AUTOYES_DIALOG_GATE;

/**
 * Issue #3822: claude's dialog gate refuses a `(y/n)` its rules do not vouch
 * for, so the typed-answer path these tests stop part-way (`y`, a wait, Enter)
 * is reached on claude only under the kill switch's `legacy`. What is pinned
 * is the stop, not the gate (`auto-yes-generic-yes-no-3822.test.ts`).
 */
function showTypedPrompt(): void {
  pane = PROMPT_TYPED;
  process.env.CM_AUTOYES_DIALOG_GATE = 'claude=legacy';
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(WT, WT, `/repo/${WT}`, '/repo', 'repo', Date.now());
  vi.clearAllMocks();
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearEnterFallbacks();
  pane = PROMPT_ON_DEFAULT;
  captureGate = null;
  freshGate = null;
  ownershipGate = null;
  guardReadGate = null;
  keysSent = [];
  delete process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR];
});

afterEach(() => {
  stopAllAutoYesPolling();
  clearAllAutoYesStates();
  clearEnterFallbacks();
  db.close();
  vi.useRealTimers();
  if (originalEnv === undefined) delete process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR];
  else process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR] = originalEnv;
  if (originalGateEnv === undefined) delete process.env.CM_AUTOYES_DIALOG_GATE;
  else process.env.CM_AUTOYES_DIALOG_GATE = originalGateEnv;
});

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

describe('[#3706] a stop during a wait: no input not yet issued is started', () => {
  it('stopped during the capture: no answer, no timer', async () => {
    captureGate = deferred();
    enable();
    await firstTick();
    expect(captureSessionOutput).toHaveBeenCalledTimes(1);

    disable();
    captureGate.resolve();
    await settle();

    expect(keysSent).toEqual([]);
    expect(recordAnsweredPrompt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stopped during the ownership check: no answer', async () => {
    ownershipGate = deferred();
    enable();
    await firstTick();

    disable();
    ownershipGate.resolve();
    await settle();

    expect(keysSent).toEqual([]);
    expect(recordAnsweredPrompt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stopped during the sender's guard read: no key", async () => {
    guardReadGate = deferred();
    enable();
    await firstTick();

    disable();
    guardReadGate.resolve();
    await settle();

    expect(keysSent).toEqual([]);
    expect(recordAnsweredPrompt).not.toHaveBeenCalled();
  });

  it('stopped between the typed answer and its Enter: the Enter is not sent', async () => {
    showTypedPrompt();
    enable();
    await firstTick(); // the sender now waits TUI_TEXT_INPUT_WAIT_MS before the Enter
    expect(keysSent).toEqual(['y']);

    disable();
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();

    expect(keysSent).toEqual(['y']);
    expect(recordAnsweredPrompt).not.toHaveBeenCalled();
    expect(startResponsePolling).not.toHaveBeenCalled();
  });

  it("stopped during the Enter fallback's fresh capture: no Enter", async () => {
    process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR] = 'claude=enabled';
    pane = CLAUDE_UNRECOGNISED_LIST;
    enable();
    await firstTick(); // seen once: the candidate
    freshGate = deferred();
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    await settle();
    expect(captureSessionOutputFresh).toHaveBeenCalledTimes(1);

    disable();
    freshGate.resolve();
    await settle();

    expect(keysSent).toEqual([]);
    expect(recordAnsweredPrompt).not.toHaveBeenCalled();
  });

  it('negative: the current generation answers with the same keys as before', async () => {
    enable();
    await firstTick();
    expect(keysSent).toEqual(['Enter']);
    expect(sendSpecialKeys.mock.calls.map(([session, keys]) => [session, keys])).toEqual([[SESSION, ['Enter']]]);
    expect(recordAnsweredPrompt).toHaveBeenCalledTimes(1);
    expect(startResponsePolling).toHaveBeenCalledTimes(1);

    keysSent = [];
    showTypedPrompt();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(keysSent.slice(0, 2)).toEqual(['y', '<Enter>']);
  });

  it('negative: the Enter fallback still sends its one Enter', async () => {
    process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR] = 'claude=enabled';
    pane = CLAUDE_UNRECOGNISED_LIST;
    enable();
    await firstTick();
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    await settle();
    expect(keysSent).toEqual(['Enter']);
    expect(recordAnsweredPrompt).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Re-enable
// ---------------------------------------------------------------------------

describe('[#3706] disable → enable during a tick: the old tick leaves the new state alone', () => {
  it('does not answer, nor arm a second timer over the new poller', async () => {
    captureGate = deferred();
    enable();
    await firstTick();

    disable();
    enable();
    const fresh = await pollerStateOf(KEY);
    const freshTimer = fresh?.timerId;
    expect(vi.getTimerCount()).toBe(1);

    showTypedPrompt();
    const oldGate = captureGate;
    captureGate = null;
    oldGate.resolve();
    await settle();

    expect(keysSent).toEqual([]);
    expect((await pollerStateOf(KEY))?.timerId).toBe(freshTimer);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not apply the new grant's stop pattern to its own capture", async () => {
    pane = 'idle';
    enable();
    await firstTick(); // the old poller's stop-check baseline is now set
    captureGate = deferred();
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    await settle();

    disable();
    enable('Yes');
    pane = `idle\n${PROMPT_ON_DEFAULT}`;
    const oldGate = captureGate;
    captureGate = deferred();
    oldGate.resolve();
    await settle();

    const grant = getAutoYesState(WT, 'claude');
    expect(grant?.enabled).toBe(true);
    expect(grant?.stopReason).toBeUndefined();
    expect((await pollerStateOf(KEY))?.stopCheckBaselineLength).toBe(-1);
  });

  it("does not count its failure against the new poller's errors", async () => {
    captureGate = deferred();
    enable();
    await firstTick();

    disable();
    enable();
    const oldGate = captureGate;
    captureGate = deferred();
    oldGate.reject(new Error('capture failed'));
    await settle();

    expect((await pollerStateOf(KEY))?.consecutiveErrors).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('negative: the new generation runs one timer, and a second start is idempotent', async () => {
    enable();
    expect(startAutoYesPolling(WT, 'claude')).toEqual({ started: true, reason: 'already_running' });
    expect(vi.getTimerCount()).toBe(1);

    pane = 'idle';
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS * 5);
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    expect(isPollerActive(KEY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Grant and session
// ---------------------------------------------------------------------------

describe('[#3706] the grant expiring or the session being relaunched during a wait', () => {
  it('the grant expires during the ownership check: no answer', async () => {
    ownershipGate = deferred();
    enable();
    await firstTick();

    vi.setSystemTime(Date.now() + ONE_HOUR);
    ownershipGate.resolve();
    await settle();

    expect(keysSent).toEqual([]);
    expect(recordAnsweredPrompt).not.toHaveBeenCalled();
  });

  it('the session is relaunched during the ownership check: no answer, the chain goes on', async () => {
    ownershipGate = deferred();
    enable();
    await firstTick();

    beginEnterFallbackSession(WT, 'claude');
    const gate = ownershipGate;
    ownershipGate = null;
    gate.resolve();
    await settle();
    expect(keysSent).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    // The next tick reads the new session's screen and answers it.
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    await settle();
    expect(keysSent).toEqual(['Enter']);
  });

  it('negative: a valid grant and a relaunch before the tick still answer', async () => {
    enable();
    beginEnterFallbackSession(WT, 'claude');
    ownershipGate = deferred();
    await firstTick();
    vi.setSystemTime(Date.now() + ONE_HOUR / 2);
    ownershipGate.resolve();
    await settle();
    expect(keysSent).toEqual(['Enter']);
  });

  it('negative: waiting for the session is kept', async () => {
    const { getSessionPresence } = await import('@/lib/session/cli-session');
    vi.mocked(getSessionPresence).mockResolvedValue('absent');
    captureSessionOutput.mockRejectedValueOnce(new Error('session does not exist'));
    enable();
    await firstTick();
    expect(vi.getTimerCount()).toBe(1);
    expect((await pollerStateOf(KEY))?.consecutiveErrors).toBe(0);
    vi.mocked(getSessionPresence).mockResolvedValue('present');
  });
});

// ---------------------------------------------------------------------------
// Sent
// ---------------------------------------------------------------------------

describe('[#3706] an answer already sent', () => {
  it("its follow-up does not write the successor's state or start a second chain", async () => {
    enable();
    const { getActivePollerCount } = await import('@/lib/auto-yes-poller');
    sendSpecialKeys.mockImplementationOnce(async (_s, keys) => {
      keysSent.push(...keys);
      // The keys are out; the grant is withdrawn and given again before the
      // poller hears back.
      disable();
      enable();
    });
    await firstTick();

    expect(keysSent).toEqual(['Enter']);
    // The audit records what the agent received.
    expect(recordAnsweredPrompt).toHaveBeenCalledTimes(1);
    const successor = await pollerStateOf(KEY);
    expect(successor?.lastAnsweredPromptKey).toBeNull();
    expect(successor?.lastServerResponseTimestamp).toBeNull();
    expect(getActivePollerCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a send stopped part-way is not recorded as an answer, nor as an error', async () => {
    showTypedPrompt();
    enable();
    await firstTick();
    // A renewal under the same poller: the old tick's grant is gone.
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();

    expect(keysSent).toEqual(['y']);
    expect(recordAnsweredPrompt).not.toHaveBeenCalled();
    expect((await pollerStateOf(KEY))?.consecutiveErrors).toBe(0);
    expect((await pollerStateOf(KEY))?.lastAnsweredPromptKey).toBeNull();
    // The chain survives the renewal.
    expect(vi.getTimerCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Re-instruction 1 (Codex review P2 x 3)
// ---------------------------------------------------------------------------

/** A pending prompt row as the response poller saves it for `PROMPT_ON_DEFAULT`. */
function savePendingPrompt(at: number): string {
  return createMessage(db, {
    worktreeId: WT,
    role: 'assistant',
    content: 'Select an option:',
    messageType: 'prompt',
    promptData: {
      type: 'multiple_choice',
      question: 'Select an option:',
      options: [
        { number: 1, label: 'Yes', isDefault: true },
        { number: 2, label: 'No', isDefault: false },
      ],
      status: 'pending',
    },
    timestamp: new Date(at),
    cliToolId: 'claude',
    instanceId: 'claude',
  }).id;
}

function promptStatus(id: string): unknown {
  return (getMessageById(db, id)?.promptData as { status?: string } | undefined)?.status;
}

describe('[#3706] P2-1: a session relaunched while the answer was being sent', () => {
  it("keeps the audit but leaves the new session's prompt row, the dedup key and the task alone", async () => {
    const oldRow = savePendingPrompt(Date.now() - 1_000);
    let newRow = '';
    enable();
    sendSpecialKeys.mockImplementationOnce(async (_s, keys) => {
      keysSent.push(...keys);
      // The CLI is relaunched with the poller kept, and the new process shows
      // the same question, which the response poller saves as pending.
      beginEnterFallbackSession(WT, 'claude');
      newRow = savePendingPrompt(Date.now() + 1);
    });
    await firstTick();

    expect(keysSent).toEqual(['Enter']);
    expect(recordAnsweredPrompt).toHaveBeenCalledTimes(1);
    expect(promptStatus(oldRow)).toBe('answered');
    expect(promptStatus(newRow)).toBe('pending');
    expect((await pollerStateOf(KEY))?.lastAnsweredPromptKey).toBeNull();
    expect(taskEvents).not.toHaveBeenCalledWith('prompt_answered_auto');

    // The new process's question is answered on the next tick, not held off by
    // the old answer's dedup key.
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    await settle();
    expect(keysSent).toEqual(['Enter', 'Enter']);
  });

  it('negative: in the same session the pending row is answered and the dedup key is kept', async () => {
    const row = savePendingPrompt(Date.now() - 1_000);
    enable();
    await firstTick();

    expect(promptStatus(row)).toBe('answered');
    expect((await pollerStateOf(KEY))?.lastAnsweredPromptKey).not.toBeNull();
    expect(taskEvents).toHaveBeenCalledWith('prompt_answered_auto');
  });
});

describe("[#3706] P2-2: the Enter fallback's record after a stop or a relaunch", () => {
  async function fallbackUpToTheEnter(during: () => void): Promise<void> {
    process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR] = 'claude=enabled';
    pane = CLAUDE_UNRECOGNISED_LIST;
    enable();
    sendSpecialKeys.mockImplementationOnce(async (_s, keys) => {
      keysSent.push(...keys);
      during();
    });
    await firstTick(); // seen once: the candidate
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    await settle();
  }

  it('a relaunch during the Enter: no record for the new session, the audit is kept', async () => {
    await fallbackUpToTheEnter(() => beginEnterFallbackSession(WT, 'claude'));
    expect(keysSent).toEqual(['Enter']);
    expect(getLastEnterFallback(WT, 'claude')).toBeNull();
    expect(recordAnsweredPrompt).toHaveBeenCalledTimes(1);
  });

  it('a stop during the Enter: the forgotten record is not put back, the audit is kept', async () => {
    await fallbackUpToTheEnter(() => disable());
    expect(keysSent).toEqual(['Enter']);
    expect(getLastEnterFallback(WT, 'claude')).toBeNull();
    expect(recordAnsweredPrompt).toHaveBeenCalledTimes(1);
  });

  it('negative: an Enter that lands in the same generation is recorded as sent', async () => {
    await fallbackUpToTheEnter(() => {});
    expect(getLastEnterFallback(WT, 'claude')?.outcome).toBe('sent');
  });
});

describe('[#3706] P2-3: an answer stopped with keys already on the pane', () => {
  /** Type `y`, then stop the Enter with `stop`; then let `ticks` more ticks run. */
  async function stopAfterTheY(stop: () => void, ticks = 3): Promise<void> {
    showTypedPrompt();
    enable();
    await firstTick();
    expect(keysSent).toEqual(['y']);
    stop();
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    for (let i = 0; i < ticks; i++) {
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
      await settle();
    }
  }

  it('a renewal: the next ticks do not type the answer again', async () => {
    await stopAfterTheY(() => setAutoYesEnabled(WT, 'claude', true, ONE_HOUR));
    expect(keysSent).toEqual(['y']);
    expect(captureSessionOutput.mock.calls.length).toBeGreaterThan(1);
  });

  it('disable → enable: the new poller does not type the answer again', async () => {
    await stopAfterTheY(() => {
      disable();
      enable();
    });
    expect(keysSent).toEqual(['y']);
    expect(captureSessionOutput.mock.calls.length).toBeGreaterThan(1);
  });

  it('negative: once the prompt left the screen, its return is answered', async () => {
    await stopAfterTheY(() => setAutoYesEnabled(WT, 'claude', true, ONE_HOUR), 0);
    pane = 'idle';
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    await settle();
    showTypedPrompt();
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS * 3);
    await settle();
    expect(keysSent.slice(0, 3)).toEqual(['y', 'y', '<Enter>']);
  });

  it("negative: a relaunched session's prompt is answered", async () => {
    await stopAfterTheY(() => setAutoYesEnabled(WT, 'claude', true, ONE_HOUR), 0);
    beginEnterFallbackSession(WT, 'claude');
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS * 3);
    await settle();
    expect(keysSent.slice(0, 3)).toEqual(['y', 'y', '<Enter>']);
  });

  it('negative: a stop before any key leaves the next tick free to answer', async () => {
    guardReadGate = deferred();
    enable();
    await firstTick();
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
    const gate = guardReadGate;
    guardReadGate = null;
    gate.resolve();
    await settle();
    expect(keysSent).toEqual([]);

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    await settle();
    expect(keysSent).toEqual(['Enter']);
  });
});

// ---------------------------------------------------------------------------
// Re-instruction 2 (Codex re-review P2 x 4)
// ---------------------------------------------------------------------------

describe('[#3706] re-review P2-1: the response poller restart re-reads the session', () => {
  it('a relaunch during the last await of the follow-up: the response poller is not restarted', async () => {
    enable();
    // The audit row is written, then — while the follow-up awaits its modules —
    // the CLI is relaunched under the same poller.
    recordAnsweredPrompt.mockImplementationOnce(() => {
      queueMicrotask(() => beginEnterFallbackSession(WT, 'claude'));
    });
    await firstTick();

    expect(keysSent).toEqual(['Enter']);
    expect(recordAnsweredPrompt).toHaveBeenCalledTimes(1);
    expect(startResponsePolling).not.toHaveBeenCalled();
  });

  it('negative: no relaunch, the response poller is restarted once', async () => {
    enable();
    await firstTick();
    expect(startResponsePolling).toHaveBeenCalledTimes(1);
  });
});

/** gemini answers a numbered list by typing the digit, then Enter after a wait. */
const GEMINI_LIST_A = 'Select an option:\n\u276F 1. Yes\n  2. No';
const GEMINI_LIST_A_CURSOR_MOVED = 'Select an option:\n  1. Yes\n\u276F 2. No';
const GEMINI_LIST_B = 'Select an option:\n\u276F 1. Apply the patch\n  2. Skip it';

function enableTool(tool: CLIToolType, worktreeId = WT): void {
  setAutoYesEnabled(worktreeId, tool, true, ONE_HOUR);
  startAutoYesPolling(worktreeId, tool);
}

/** Type the answer to `first`, stop its Enter with a renewal, then show `next` for 3 ticks. */
async function stopTheAnswerThenShow(tool: CLIToolType, first: string, typed: string, next: string): Promise<void> {
  if (first === PROMPT_TYPED) showTypedPrompt();
  pane = first;
  enableTool(tool);
  await firstTick();
  expect(keysSent).toEqual([typed]);
  setAutoYesEnabled(WT, tool, true, ONE_HOUR);
  await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
  await settle();
  pane = next;
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    await settle();
  }
}

describe('[#3706] re-review P2-2: the stopped answer is held for that screen only', () => {
  it('a different list under the same question is answered', async () => {
    await stopTheAnswerThenShow('gemini', GEMINI_LIST_A, '1', GEMINI_LIST_B);
    expect(keysSent.slice(0, 3)).toEqual(['1', '1', '<Enter>']);
  });

  it('negative: the same list with only its cursor moved is still held', async () => {
    await stopTheAnswerThenShow('gemini', GEMINI_LIST_A, '1', GEMINI_LIST_A_CURSOR_MOVED);
    expect(keysSent).toEqual(['1']);
  });
});

describe('[#3706] re-review P2-4: a prompt left for a human is published as withheld', () => {
  it('the stopped answer is recorded as a suppression, so Push does not read it as "answering"', async () => {
    clearPolicySuppressions();
    await stopTheAnswerThenShow('claude', PROMPT_TYPED, 'y', PROMPT_TYPED);
    expect(keysSent).toEqual(['y']);

    const suppression = getLastPolicySuppression(WT, 'claude');
    expect(suppression?.reason).toBe('partial-answer');
    expect(
      decidePromptPush({ worktreeId: WT, cliToolId: 'claude', waitingSince: Date.now() - 1 }),
    ).toMatchObject({ suppress: false, reason: 'policy-withheld' });
  });

  it('negative: an ordinary answer records no suppression and Push stays quiet', async () => {
    clearPolicySuppressions();
    enable();
    await firstTick();
    expect(getLastPolicySuppression(WT, 'claude')).toBeNull();
    expect(
      decidePromptPush({ worktreeId: WT, cliToolId: 'claude', waitingSince: Date.now() - 1 }),
    ).toMatchObject({ suppress: true, reason: 'auto-yes-answering' });
  });
});
