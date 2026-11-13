/**
 * Issue #4304 F1-a (the contract after §6-6, acceptance table §3.4 T1 / T2 /
 * T6 / T9 / T10 / T11 for the strict `respond`): through the real route
 * `POST /prompt-response/strict`, its real deps (`createStrictRespondDeps`), the
 * real input lock and the real launch trust debt.
 *
 * - T1: a key refused before it was sent — the input ticket lost before the
 *   pane look or after it — is not a key: code 40, `keysSent: 0`, no task row,
 *   no poll restart, the launch's trust debt kept. Before the fix the ticket's
 *   refusals were plain `Error`s and counted as a key that may have gone.
 * - T2: the same refusal after a key keeps the count of the keys before it.
 * - T6 / T9: what the answer does to the CURRENT state (task row, poll restart,
 *   push) waits for the pane after every await: a pane replaced after the
 *   Enter gets none of it (the history log line stays); the answered pane
 *   dead by the answer still does.
 * - T10: a replayed operation sends and acts on nothing again.
 * - T11: the transport's own "not started" is not a key; a failure that may
 *   have typed (indeterminate, a non-Error throw) is counted, as before.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';

const { info, frames, hooks, outside, settleOutside } = vi.hoisted(() => {
  /**
   * Work run from OUTSIDE the answer's async context, as a relaunch's
   * `invalidateInstanceInput` is (inside it, the answer's own ticket survives).
   * Registered before any request, so its callbacks run in the test's context.
   */
  const queue: Array<() => void> = [];
  let wake: () => void = () => {};
  const loop = async (): Promise<void> => {
    for (;;) {
      await new Promise<void>((resolve) => (wake = resolve));
      while (queue.length > 0) queue.shift()?.();
    }
  };
  void loop();
  return {
    info: vi.fn(),
    frames: { current: '', composer: '', running: true },
    hooks: {
      /** Run right before the next payload build (a strict read), then cleared. */
      onBuild: null as null | (() => void),
      /** Run inside `checkPaneGeneration` — the pane look right before a key. */
      onCheck: null as null | (() => void),
    },
    outside: (fn: () => void) => {
      queue.push(fn);
      wake();
    },
    settleOutside: async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
});

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  const make = (module: string): import('@/lib/logger').Logger => ({
    debug: () => {},
    info: (action, data) => info(module, action, data),
    warn: () => {},
    error: () => {},
    withContext: () => make(module),
  });
  return { ...actual, createLogger: make };
});

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}
vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      mockDb = null;
    },
  };
});

vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn().mockResolvedValue({ verdict: 'owned' }),
}));

vi.mock('@/lib/session/cli-session', async () => {
  const helper = await import('@tests/unit/session/bound-frame-test-helper');
  const module = helper.withBoundCaptureCliSessionDoubles({
    captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
    readSessionPaneCommand: vi.fn().mockResolvedValue('agy'),
    sendSessionAnswerKey: vi.fn(async (_id: string, _tool: string, key: string) => {
      if (key === 'Enter') frames.current = frames.composer;
    }),
  });
  const check = module.checkPaneGeneration;
  return {
    ...module,
    checkPaneGeneration: async (sessionName: string, expected: import('@/lib/session/cli-session').PaneGeneration) => {
      const hook = hooks.onCheck;
      hooks.onCheck = null;
      hook?.();
      await settleOutside();
      return check(sessionName, expected);
    },
  };
});

vi.mock('@/lib/session/current-output-builder', () => ({
  buildCurrentOutput: vi.fn(async () => {
    const hook = hooks.onBuild;
    hooks.onBuild = null;
    hook?.();
    await settleOutside();
    const idle = frames.current === frames.composer;
    return {
      isRunning: frames.running,
      sessionName: 'mcbd-antigravity-wt-4304-strict',
      sessionStatus: idle ? 'ready' : 'waiting',
      sessionStatusReason: idle ? 'input_prompt' : 'antigravity_selection_list',
      fullOutput: frames.current,
      isPromptWaiting: false,
      promptData: null,
      promptView: null,
      isSelectionListActive: !idle,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      startingSince: null,
      serverPollerActive: false,
    };
  }),
}));

vi.mock('@/lib/session/agent-event-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/agent-event-state')>()),
  getAgentEventGenerationStartedAt: vi.fn(() => 1_800_000_000_000),
}));
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/api/worktrees/[id]/prompt-response/strict/route';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { observeSession } from '@/lib/prompt-observation/session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { sendSessionAnswerKey } from '@/lib/session/cli-session';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import { startPolling } from '@/lib/polling/response-poller';
import { clearStrictRespondState } from '@/lib/prompt-observation/strict-respond';
import type { CurrentOutputPayload } from '@/lib/session/current-output-types';
import { clearAllAutoYesStates } from '@/lib/auto-yes-state';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { invalidateInstanceInput, resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import {
  clearStartupTrust,
  isStartupTrustPending,
  markStartupTrustPending,
} from '@/lib/cli-tools/antigravity-startup-trust';
import {
  TEST_PANE_GENERATION,
  resetTestPaneGenerations,
  setTestPaneGeneration,
} from '@tests/unit/session/bound-frame-test-helper';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');
const TRUST = read('prompt-observation-3755/antigravity-trust.txt');
const COMPOSER = read('antigravity-live-2364/boot-idle.txt');
const FOLDER = '/Users/agy-user/share/work/github_kewton/CommandAgent-issue-643-tools-bash-cd-next-js-id-635-637';
const H = { ...TEST_PANE_GENERATION, paneId: '%99' };

let worktreeSeq = 0;
let WT = '';

function post(body: Record<string, unknown>): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/prompt-response/strict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(request, { params: Promise.resolve({ id: WT }) });
}

/** The session the route answers. */
function session(): string {
  return CLIToolManager.getInstance().getTool('antigravity').getSessionName(WT, 'antigravity');
}

async function body(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const payload = (await vi.mocked(buildCurrentOutput)(null as never, WT, 'antigravity')) as CurrentOutputPayload;
  const token = observeSession(WT, { cliToolId: 'antigravity', instanceId: 'antigravity' }, payload).screen?.token;
  if (!token) throw new Error('no token for the fixture');
  return {
    expectScreen: 'antigravity-trust',
    observation: token,
    answer: 'Yes',
    expectTarget: FOLDER,
    operationId: `op-4304-${worktreeSeq}-${Math.random().toString(36).slice(2, 10)}`,
    answeredBy: 'cli',
    ...over,
  };
}

/**
 * The session's pane is now `reading` — for the pane look by session name and
 * for the bound reads by worktree target (the test double keys those apart).
 */
function movePane(reading: { generation: typeof TEST_PANE_GENERATION; dead: boolean }): void {
  setTestPaneGeneration(session(), reading);
  setTestPaneGeneration(`antigravity:${WT}:antigravity`, reading);
}

/** "No": a Down that moves the highlight, then the Enter. */
function downMovesHighlight(): void {
  vi.mocked(sendSessionAnswerKey).mockImplementationOnce(async () => {
    frames.current = frames.current.replace('> Yes, I trust this folder\n  No, exit', '  Yes, I trust this folder\n> No, exit');
  });
}

function expectNothingActedOn(): void {
  expect(applyEventToActiveTask).not.toHaveBeenCalled();
  expect(startPolling).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearStrictRespondState();
  clearAllAutoYesStates();
  resetTestPaneGenerations();
  resetInstanceInputLocks();
  clearStartupTrust();
  hooks.onBuild = null;
  hooks.onCheck = null;
  WT = `wt-4304-strict-${++worktreeSeq}`;
  const db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  upsertWorktree(db, {
    id: WT,
    name: 'Strict',
    path: '/nonexistent-4304/strict',
    repositoryPath: '/nonexistent-4304',
    repositoryName: 'Strict',
    cliToolId: 'antigravity',
  });
  frames.current = TRUST;
  frames.composer = COMPOSER;
  frames.running = true;
});

afterEach(() => {
  resetTestPaneGenerations();
  clearStartupTrust();
});

describe('[#4304 F1-a T1] a key refused before it was sent is no key, whatever refused it', () => {
  it('positive: the input ticket lost after the pane look — code 40, keysSent 0, nothing recorded or resumed, the trust debt kept', async () => {
    const request = await body();
    markStartupTrustPending(session());
    hooks.onCheck = () => outside(() => invalidateInstanceInput(session()));

    const result = await (await post(request)).json();

    expect(result).toMatchObject({ code: 40, reason: 'input_lock_lost', delivery: 'not-sent', keysSent: 0 });
    expect(sendSessionAnswerKey).not.toHaveBeenCalled();
    expectNothingActedOn();
    expect(isStartupTrustPending(session())).toBe(true);
  });

  it('positive: the input ticket lost before the key (during the last read) — the same refusal', async () => {
    const request = await body();
    markStartupTrustPending(session());
    hooks.onBuild = () => outside(() => invalidateInstanceInput(session()));

    const result = await (await post(request)).json();

    expect(result).toMatchObject({ code: 40, reason: 'input_lock_lost', delivery: 'not-sent', keysSent: 0 });
    expect(sendSessionAnswerKey).not.toHaveBeenCalled();
    expectNothingActedOn();
    expect(isStartupTrustPending(session())).toBe(true);
  });

  it('positive: the pane replaced before the key is the same delivery (code 40, keysSent 0)', async () => {
    const request = await body();
    hooks.onCheck = () => setTestPaneGeneration(session(), { generation: H, dead: false });

    const result = await (await post(request)).json();

    expect(result).toMatchObject({ code: 40, delivery: 'not-sent', keysSent: 0 });
    expect(sendSessionAnswerKey).not.toHaveBeenCalled();
    expectNothingActedOn();
  });

  it('negative: nothing refuses — one Enter, recorded and resumed, the debt dropped', async () => {
    const request = await body();
    markStartupTrustPending(session());

    const result = await (await post(request)).json();

    expect(result).toMatchObject({ code: 0, keysSent: 1 });
    expect(sendSessionAnswerKey).toHaveBeenCalledTimes(1);
    expect(applyEventToActiveTask).toHaveBeenCalledTimes(1);
    expect(startPolling).toHaveBeenCalledTimes(1);
    expect(isStartupTrustPending(session())).toBe(false);
  });
});

describe('[#4304 F1-a T2] a refusal after a key keeps the count of the keys before it', () => {
  it('positive: Down sent, the ticket lost before the Enter — 41 with keysSent 1, not 2', async () => {
    const request = await body({ answer: 'No' });
    downMovesHighlight();
    // The read that shows the highlight on "No" (after the Down), then the Enter's own look.
    hooks.onCheck = () => {
      hooks.onCheck = () => outside(() => invalidateInstanceInput(session()));
    };

    const result = await (await post(request)).json();

    expect(result).toMatchObject({ code: 41, reason: 'screen_moved_mid_send', keysSent: 1 });
    expect(vi.mocked(sendSessionAnswerKey).mock.calls.map((call) => call[2])).toEqual(['Down']);
  });
});

describe('[#4304 F1-a T6 / T9] the current state is acted on only while the session shows the answered pane', () => {
  it('positive: the pane replaced after the Enter — no task row, no poll restart; the history line stays', async () => {
    const request = await body();
    vi.mocked(sendSessionAnswerKey).mockImplementationOnce(async () => {
      frames.current = frames.composer;
      movePane({ generation: H, dead: false });
    });

    const result = await (await post(request)).json();

    expect(result).toMatchObject({ keysSent: 1 });
    expectNothingActedOn();
    expect(info).toHaveBeenCalledWith(
      'api/prompt-response-strict',
      'strict-prompt-answered',
      expect.objectContaining({ paneMoved: true, keysSent: 1 }),
    );
  });

  it('negative: the answered pane, dead by the answer — recorded and resumed (the same G)', async () => {
    const request = await body();
    vi.mocked(sendSessionAnswerKey).mockImplementationOnce(async () => {
      frames.current = frames.composer;
      movePane({ generation: TEST_PANE_GENERATION, dead: true });
    });

    const result = await (await post(request)).json();

    expect(result).toMatchObject({ code: 0, keysSent: 1 });
    expect(applyEventToActiveTask).toHaveBeenCalledTimes(1);
    expect(startPolling).toHaveBeenCalledTimes(1);
  });
});

describe('[#4304 F1-a T10] a replayed operation sends and acts on nothing again', () => {
  it('the same operation id twice: one key, one task row, one poll restart, the same result', async () => {
    const request = await body();
    const first = await (await post(request)).json();
    const second = await (await post(request)).json();

    expect(second).toMatchObject({ ...first, replayed: true });
    expect(sendSessionAnswerKey).toHaveBeenCalledTimes(1);
    expect(applyEventToActiveTask).toHaveBeenCalledTimes(1);
    expect(startPolling).toHaveBeenCalledTimes(1);
  });
});

describe('[#4304 F1-a T11] the transport: not started is no key; a failure that may have typed is one', () => {
  function transportError(delivery: 'not-started' | 'indeterminate'): Error {
    return Object.assign(new Error('tmux send-keys failed'), { name: 'TmuxSendError', delivery, keysDelivered: 0 });
  }

  it('positive: not started — code 40, keysSent 0, nothing recorded', async () => {
    const request = await body();
    vi.mocked(sendSessionAnswerKey).mockRejectedValueOnce(transportError('not-started'));

    const result = await (await post(request)).json();

    expect(result).toMatchObject({ code: 40, reason: 'send_not_started', keysSent: 0 });
    expectNothingActedOn();
  });

  it('negative: an indeterminate transport failure is counted (41 send_failed, keysSent 1)', async () => {
    const request = await body();
    vi.mocked(sendSessionAnswerKey).mockRejectedValueOnce(transportError('indeterminate'));

    const result = await (await post(request)).json();

    expect(result).toMatchObject({ code: 41, reason: 'send_failed', keysSent: 1 });
  });

  it('negative: a non-Error throw is counted too (it may have typed)', async () => {
    const request = await body();
    vi.mocked(sendSessionAnswerKey).mockImplementationOnce(() => Promise.reject('boom'));

    const result = await (await post(request)).json();

    expect(result).toMatchObject({ code: 41, reason: 'send_failed', keysSent: 1 });
  });
});
