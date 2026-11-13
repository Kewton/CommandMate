/**
 * Issue #4303 re-instruction 2: a strict answer refused right before a key is
 * stopped where `strict-respond` keeps its result with the operation — so the
 * token, the kept operation, the response and the record all carry the keys
 * actually sent, and a replay of the same operation reads back what the first
 * response said.
 *
 * Unlike `strict-answer-foreground-gate-4303.test.ts` (which hands the settle
 * step a result built by hand), this runs the shipping chain the route runs:
 * `answerStrictlyAsInputWriter` → `respondStrictly` (its real operation table
 * and token store) → `createStrictRespondDeps`. Only tmux, the capture and the
 * task history are stubbed; the observation and its token are the real ones
 * (`buildPromptObservation`) over the measured agy trust screen.
 *
 * Positive control: before the fix, `sendKey` refused the Enter by throwing —
 * `strict-respond` counted it (2 keys, `send_failed`) and kept that, while the
 * response was corrected to 1 afterwards, so the replay said 2.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const h = vi.hoisted(() => ({
  foreground: 'other' as 'shell' | 'other' | 'unknown',
  /** Set by a key: what the pane shows next, and who holds it after. */
  onKey: null as null | ((key: string) => void),
  keys: [] as string[],
  frame: '',
  running: true,
}));

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: vi.fn(async () => ''),
  readSessionPaneCommand: vi.fn(async () => 'agy'),
  sendSessionAnswerKey: vi.fn(async (_worktreeId: string, _cliToolId: string, key: string) => {
    h.keys.push(key);
    h.onKey?.(key);
  }),
}));

vi.mock('@/lib/tmux/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux')>()),
  readPaneForeground: vi.fn(async () => h.foreground),
}));

vi.mock('@/lib/auto-yes-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auto-yes-state')>()),
  getAutoYesState: vi.fn(() => null),
}));

vi.mock('@/lib/tasks/task-transition-service', () => ({
  applyEventToActiveTask: vi.fn(),
}));

vi.mock('@/lib/session/current-output-builder', () => ({
  buildCurrentOutput: vi.fn(async () => payloadOf(h.frame)),
}));

vi.mock('@/lib/prompt-observation/session', () => ({
  observeSession: vi.fn(
    (worktreeId: string, target: { cliToolId: string; instanceId?: string }, payload: ObservationPayload) =>
      observeWith(worktreeId, target.instanceId ?? target.cliToolId, payload)
  ),
}));

import type Database from 'better-sqlite3';
import { buildPromptObservation, type ObservationPayload } from '@/lib/prompt-observation/observe';
import { forgetScreenAppearance, noteScreenAppearance } from '@/lib/prompt-observation/appearance';
import { clearStrictRespondState, respondStrictly } from '@/lib/prompt-observation/strict-respond';
import type { PromptObservationKind } from '@/lib/prompt-observation/kinds';
import type { StrictRespondResult } from '@/lib/prompt-observation/types';
import { clearStartupTrust } from '@/lib/cli-tools/antigravity-startup-trust';
import {
  answerStrictlyAsInputWriter,
  createStrictRespondDeps,
  newStrictAnswerGate,
  recordStrictAnswer,
  type StrictAnswerTarget,
  type StrictInputLockRefusal,
} from '@/lib/session/strict-prompt-answer-io';
import { resetInstanceInputLocks, type InstanceInputTicket } from '@/lib/session/instance-input-lock';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import { readPaneForeground } from '@/lib/tmux/tmux';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const TRUST = readFileSync(path.join(FIXTURES, 'prompt-observation-3755/antigravity-trust.txt'), 'utf8');
const COMPOSER = readFileSync(path.join(FIXTURES, 'antigravity-live-2364/boot-idle.txt'), 'utf8');
const TRUST_ON_NO = TRUST.replace('> Yes, I trust this folder\n  No, exit', '  Yes, I trust this folder\n> No, exit');
const FOLDER = '/Users/agy-user/share/work/github_kewton/CommandAgent-issue-643-tools-bash-cd-next-js-id-635-637';

const WORKTREE = 'wt-4303-op';
const SESSION = 'mcbd-antigravity-wt-4303-op';
const GENERATION = Date.now() - 60_000;
const DB = null as unknown as Database.Database;

function payloadOf(frame: string): ObservationPayload {
  const idle = frame === COMPOSER;
  return {
    isRunning: h.running,
    sessionName: SESSION,
    sessionStatus: idle ? 'ready' : 'waiting',
    sessionStatusReason: idle ? 'input_prompt' : 'antigravity_selection_list',
    fullOutput: frame,
    isPromptWaiting: false,
    promptData: null,
    promptView: null,
    isSelectionListActive: !idle,
    isPagerActive: false,
    isDismissablePanelActive: false,
    isUnclassifiedActive: false,
    startingSince: null,
    autoYes: undefined,
    serverPollerActive: false,
  };
}

function observeWith(worktreeId: string, instanceId: string, payload: ObservationPayload) {
  const now = Date.now();
  const instance = { worktreeId, cliToolId: 'antigravity', instanceId };
  return buildPromptObservation({
    ...instance,
    resolvedBy: 'roster',
    payload,
    sessionGeneration: GENERATION,
    contract: { policy: null, taskId: null },
    appearance: {
      note: (fingerprint) => noteScreenAppearance(instance, fingerprint, now),
      forget: () => forgetScreenAppearance(instance),
    },
    now,
  });
}

let instanceSeq = 0;
let target: StrictAnswerTarget;

/** The token `commandmate prompt` would have printed for the pane as it is now. */
function tokenNow(): string {
  const token = observeWith(WORKTREE, target.instanceId!, payloadOf(h.frame)).screen?.token;
  if (!token) throw new Error('no token issued for the fixture');
  return token;
}

/** The trust screen's keys: Down → `No, exit`, Enter on it → the session ends, on Yes → the composer. */
function trustKeys(key: string): void {
  if (key === 'Down' && h.frame === TRUST) h.frame = TRUST_ON_NO;
  else if (key === 'Enter') {
    if (h.frame === TRUST_ON_NO) h.running = false;
    h.frame = COMPOSER;
  }
}

/** What the route does: the answer as the session's input writer, then its record. */
async function answer(
  answerLabel: string,
  observationToken: string,
  operationId: string
): Promise<StrictRespondResult | StrictInputLockRefusal> {
  const result = await answerStrictlyAsInputWriter(SESSION, (ticket, gate) =>
    respondStrictly(
      {
        worktreeId: WORKTREE,
        sessionName: SESSION,
        expectScreen: 'antigravity-trust' as PromptObservationKind,
        observationToken,
        answer: answerLabel,
        expectTarget: FOLDER,
        operationId,
      },
      createStrictRespondDeps(DB, target, ticket, gate)
    )
  );
  if (!('refused' in result)) recordStrictAnswer(DB, target, result, 'cli');
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearStrictRespondState();
  resetInstanceInputLocks();
  target = {
    worktreeId: WORKTREE,
    cliToolId: 'antigravity',
    instanceId: `antigravity-4303-${++instanceSeq}`,
    sessionName: SESSION,
    resolvedBy: 'roster',
  };
  h.foreground = 'other';
  h.keys = [];
  h.frame = TRUST;
  h.running = true;
  h.onKey = trustKeys;
});

afterEach(() => {
  clearStrictRespondState();
  clearStartupTrust();
  resetInstanceInputLocks();
});

describe('[#4303 re-instruction 2] refused before the 2nd key: the kept operation says the keys actually sent', () => {
  it('Down sent, then unknown: the first response and the replay both say 1 key, the Enter never typed', async () => {
    h.onKey = (key) => {
      trustKeys(key);
      if (key === 'Down') h.foreground = 'unknown';
    };
    const token = tokenNow();

    const first = await answer('No', token, 'op-4303-a');
    expect(first).toMatchObject({ code: 41, keysSent: 1, delivery: 'partial', replayed: false });
    expect(h.keys).toEqual(['Down']);

    // The record carries the same count.
    expect(vi.mocked(applyEventToActiveTask)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applyEventToActiveTask).mock.calls[0][5]).toMatchObject({
      reason: expect.stringContaining('1 key(s) sent'),
    });

    // The same operation again (the agent back in front): read back, nothing typed.
    h.foreground = 'other';
    const replay = await answer('No', token, 'op-4303-a');
    expect(replay).toMatchObject({ code: 41, keysSent: 1, replayed: true });
    expect({ ...(replay as StrictRespondResult), replayed: false }).toEqual(first);
    expect(h.keys).toEqual(['Down']);
    // A replay is not recorded twice.
    expect(vi.mocked(applyEventToActiveTask)).toHaveBeenCalledTimes(1);

    // The token went with the key that was typed: on the same screen again,
    // another operation on it is refused as used.
    h.frame = TRUST;
    const other = await answer('No', token, 'op-4303-b');
    expect(other).toMatchObject({ code: 40, reason: 'token_consumed', keysSent: 0 });
    expect(h.keys).toEqual(['Down']);
  });

  it.each(['shell', 'unknown'] as const)('%s after the Down: no Enter left for it', async (foreground) => {
    h.onKey = (key) => {
      trustKeys(key);
      if (key === 'Down') h.foreground = foreground;
    };
    const result = await answer('No', tokenNow(), `op-4303-${foreground}`);
    expect(result).toMatchObject({ code: 41, keysSent: 1 });
    expect(h.keys).toEqual(['Down']);
  });
});

describe('[#4303 re-instruction 2] refused before the first key: nothing kept, the token unspent', () => {
  it.each(['shell', 'unknown'] as const)(
    '%s at the read before the first key: a refusal, and the same operation and token then go through',
    async (foreground) => {
      const token = tokenNow();
      h.onKey = trustKeys;
      // Admitted with the agent in front; it is gone by the answer's own read.
      let reads = 0;
      vi.mocked(readPaneForeground).mockImplementation(async () => (++reads === 1 ? 'other' : foreground));

      const refused = await answer('Yes', token, 'op-4303-zero');
      expect(refused).toEqual({ refused: 'agent_not_in_foreground', message: expect.stringContaining('Nothing was sent') });
      expect(h.keys).toEqual([]);
      expect(vi.mocked(applyEventToActiveTask)).not.toHaveBeenCalled();

      vi.mocked(readPaneForeground).mockImplementation(async () => 'other');
      const sent = await answer('Yes', token, 'op-4303-zero');
      expect(sent).toMatchObject({ code: 0, keysSent: 1, outcome: 'advanced', replayed: false });
      expect(h.keys).toEqual(['Enter']);
    }
  );

  it('the ticket lost after the read: the startup gate (asked before the token) refuses, recorded as session_replaced', async () => {
    // A ticket the test controls (the lock keeps its own holder's ticket on invalidation).
    let current = true;
    const ticket = { isCurrent: () => current } as unknown as InstanceInputTicket;
    const gate = newStrictAnswerGate();
    const deps = createStrictRespondDeps(DB, target, ticket, gate);
    const read = await deps.read();
    expect(read.ok).toBe(true);
    expect(deps.startup.isWindowOpen()).toBe(false);
    current = false;
    expect(deps.startup.isWindowOpen()).toBe(true);
    expect(gate).toEqual({ refusedBeforeKey: { refused: 'session_replaced' }, keysSent: 0 });
    expect(h.keys).toEqual([]);
  });

  it('the same through strict-respond: exit 40 before the token, then the same operation and token go through', async () => {
    const token = tokenNow();
    let current = true;
    const ticket = { isCurrent: () => current } as unknown as InstanceInputTicket;
    const request = {
      worktreeId: WORKTREE,
      sessionName: SESSION,
      expectScreen: 'antigravity-trust' as PromptObservationKind,
      observationToken: token,
      answer: 'Yes',
      expectTarget: FOLDER,
      operationId: 'op-4303-ticket',
    };
    // Lost between the read's own check and the gate: the frame read is where it happens.
    vi.mocked(readPaneForeground).mockImplementationOnce(async () => {
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => { current = false; })));
      return 'other';
    });
    const gate = newStrictAnswerGate();
    const refused = await respondStrictly(request, createStrictRespondDeps(DB, target, ticket, gate));
    expect(refused).toMatchObject({ code: 40, reason: 'startup_window_open', keysSent: 0 });
    expect(gate.refusedBeforeKey).toEqual({ refused: 'session_replaced' });
    expect(h.keys).toEqual([]);

    current = true;
    const sent = await respondStrictly(request, createStrictRespondDeps(DB, target, ticket, newStrictAnswerGate()));
    expect(sent).toMatchObject({ code: 0, keysSent: 1, replayed: false });
    expect(h.keys).toEqual(['Enter']);
  });
});

describe('[#4303 re-instruction 2] negative controls: the agent in front all along', () => {
  it('Down and Enter both reach the pane, one foreground read before each key', async () => {
    const result = await answer('No', tokenNow(), 'op-4303-ok');
    expect(result).toMatchObject({ code: 0, keysSent: 2, outcome: 'session-ended' });
    expect(h.keys).toEqual(['Down', 'Enter']);
    // Admission, the read before the Down, the read before the Enter — none after it.
    expect(readPaneForeground).toHaveBeenCalledTimes(3);
  });

  it('a shell after the exiting Enter is the answer done (#3788), not a refusal', async () => {
    h.onKey = (key) => {
      trustKeys(key);
      if (key === 'Enter') h.foreground = 'shell';
    };
    const result = await answer('No', tokenNow(), 'op-4303-exit');
    expect(result).toMatchObject({ code: 0, keysSent: 2, outcome: 'session-ended' });
    expect(h.keys).toEqual(['Down', 'Enter']);
  });
});
