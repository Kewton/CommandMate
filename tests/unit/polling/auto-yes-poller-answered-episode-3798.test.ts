/**
 * Issue #3798 (PR 3): the Auto-Yes poller closes the wait it answered
 * (`docs/design/issue-3798-waiting-episode.md` §2.4 tables O-1 / O-2, §2.5
 * "Auto-Yes poller", §6.4).
 *
 * The answer is an observation of its own: in the synchronous step the send
 * returns to, the confirmation answered is a fresh prompt — a wait opens if
 * none is open — and the poller records the episode it answered (`lastAnswer`). A
 * frame with nothing left to answer then closes that episode and no other: a
 * wait it did not answer, one that replaced the answered one, a failed
 * capture, a frame no rule reads and an episode that moved during the tick are
 * left as they are. A second confirmation of the same turn after an answer is
 * a new wait with a hold of its own (R1-7).
 *
 * Driven through the real poller with fake timers, over copilot's live
 * permission dialog (three options, which Auto-Yes answers on the screen path)
 * and the same dialog for another command, built in memory. opencode's
 * dialogs are not typed into on this path in this tree (v1's `←`/`→` strip is
 * vouched for as keys, v2's question is answered over the API: see
 * `tests/unit/lib/polling/auto-yes-live-region-3183.test.ts`), so copilot
 * carries the "poller-answered prompt types" case. The cases the
 * held branch (`07610c745`) had for agy's survey, picker, trust screen and
 * receipt-withheld dialog are rewritten at the end on `lastAnswer.episodeId`.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const capture = vi.hoisted(() => ({
  frame: '',
  fail: false,
  during: null as null | (() => void),
}));
vi.mock('@/lib/session/cli-session', () => ({
  // Issue #3798: and tells the observer where the frame came from, as cli-session does.
  captureSessionOutput: vi.fn(async () => {
    if (capture.fail) throw new Error('capture failed');
    const during = capture.during;
    capture.during = null;
    during?.();
    globalThis.__captureFrameMetaSink?.getStore()?.({ fetchStartedAt: Date.now(), source: 'fetched' });
    return capture.frame;
  }),
  captureSessionOutputFresh: vi.fn(async () => capture.frame),
  getSessionPresence: vi.fn(async () => 'present'),
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
const sendPromptAnswer = vi.hoisted(() => vi.fn(async (_params: unknown) => {}));
vi.mock('@/lib/prompt-answer-sender', () => ({ sendPromptAnswer }));
vi.mock('@/lib/polling/response-poller', () => ({
  startPolling: vi.fn(),
  stopPolling: vi.fn(),
  clearPromptHashCache: vi.fn(),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (id: string) => ({ getSessionName: (wt: string) => `cm-${wt}-${id}`, name: id }),
    }),
  },
}));
vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: true }),
}));
const sendNotification = vi.hoisted(() => vi.fn(async () => ({ statusCode: 201 })));
vi.mock('web-push', () => ({ default: { sendNotification, setVapidDetails: vi.fn() } }));

import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { readWaitingScreen } from '@/lib/detection/waiting-screen-reading';
import { buildCompositeKey, clearAllAutoYesStates, COOLDOWN_INTERVAL_MS, POLLING_INTERVAL_MS, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearAllPollerStates, startAutoYesPolling, stopAllAutoYesPolling } from '@/lib/auto-yes-poller';
import { getAutoYesLastAnswer, partialAnswerScreenKey } from '@/lib/polling/auto-yes-poller-state';
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import { startWaitingObservation } from '@/lib/session/waiting-episode-binding';
import { clearAutoYesHolds, decidePromptPush, autoYesHoldStartedAt } from '@/lib/push/prompt-push-gate';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { startWaitingPushNotifier, stopWaitingPushNotifier } from '@/lib/push/waiting-push-notifier';
import { upsertPushSubscription } from '@/lib/db/push-subscriptions-db';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  closeEpisode,
  getWaitingEpisodeRecord,
  onWaitingEpisodeTransition,
  openEpisode,
  rebindEpisode,
  type WaitingEpisodeTransition,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-answered';
const TOOL = 'copilot' as const;
const PARTS = { worktreeId: WT, cliToolId: TOOL, instanceId: TOOL };
const KEY = buildCompositeKey(WT, TOOL, TOOL);
const T0 = 1_800_000_000_000;
const FIXTURES = path.resolve(__dirname, '../lib/detection/fixtures/copilot-live-1885');
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8');
/** copilot 1.0's live permission dialog: Yes / Yes, and don't ask again / No. */
const CONFIRM = fixture('permission-dialog');
/** The same dialog for another command: another confirmation, another screen key. */
const CONFIRM_OTHER = CONFIRM.replaceAll('sleep 25; echo finished', 'npm run build && ls  ').replaceAll(
  '`sleep`',
  '`npm`  ',
);
/** The turn ended: nothing on screen to answer. */
const IDLE = fixture('turn-complete');
/** A frame no rule reads. */
const UNREADABLE = ['', '', 'zzzz', ''].join('\n');

const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
let savedEnv: Record<string, string | undefined>;
let edges: WaitingEpisodeTransition[] = [];

const record = () => getWaitingEpisodeRecord(WT, TOOL, TOOL);
const lastAnswer = () => getAutoYesLastAnswer(KEY);
const edgeLog = () => edges.map((e) => [e.cause, e.closeReason]);
const promptPushes = () =>
  sendNotification.mock.calls
    .map((call) => JSON.parse((call as unknown as [unknown, string])[1]) as { kind: string })
    .filter((p) => p.kind === 'prompt').length;

function promptOf(raw: string) {
  const clean = stripBoxDrawing(stripAnsi(raw));
  const result = detectPromptOnCleanFrame(clean, TOOL, clean.split('\n'), raw);
  expect(result.isPrompt).toBe(true);
  return result.promptData!;
}

function event(e: string, at: number = Date.now()): void {
  recordAgentEvent(WT, TOOL, TOOL, { event: e as never, at, detail: null, sessionId: 's-1' });
}

/** One poller tick over `frame`, `ms` from now. */
async function pollerTick(frame: string, ms: number = POLLING_INTERVAL_MS): Promise<void> {
  capture.frame = frame;
  await vi.advanceTimersByTimeAsync(ms);
}

/** A wait another observer (the status probe) opened before the poller answered. */
function openWait(at: number = Date.now()) {
  return openEpisode(
    PARTS,
    {
      since: at,
      kind: 'prompt',
      binding: { kind: 'unattributed', generation: startWaitingObservation(WT, TOOL, TOOL).generation, lastClosedTurnId: null },
      openedBy: 'status-probe',
      promptScreenKey: null,
    },
    at,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
  db = new Database(':memory:');
  runMigrations(db);
  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';
  process.env.CM_VAPID_SUBJECT = 'mailto:test@example.com';
  upsertPushSubscription(db, { endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a', locale: 'en' });
  capture.frame = IDLE;
  capture.fail = false;
  capture.during = null;
  sendPromptAnswer.mockClear();
  sendNotification.mockClear();
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearAgentStopEvents();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  clearAutoYesHolds();
  resetNotificationDedup();
  resetWaitingPushDedup();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  edges = [];
  onWaitingEpisodeTransition((t) => {
    if (t.worktreeId === WT) edges.push(t);
  });
  event('session_start', T0 - 10_000);
  setAutoYesEnabled(WT, TOOL, true);
  expect(startAutoYesPolling(WT, TOOL).started).toBe(true);
});

afterEach(() => {
  stopWaitingPushNotifier();
  stopAllAutoYesPolling();
  clearAllPollerStates();
  clearAllAutoYesStates();
  clearAgentStopEvents();
  clearAutoYesHolds();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  db.close();
  vi.useRealTimers();
});

describe('[#3798] preconditions: the frames read as this file says', () => {
  it('the two dialogs are two confirmations; the idle frame waits for nothing; the unreadable one is unknown', () => {
    expect(partialAnswerScreenKey(promptOf(CONFIRM))).not.toBe(partialAnswerScreenKey(promptOf(CONFIRM_OTHER)));
    const read = (output: string) =>
      readWaitingScreen({ cliToolId: TOOL, output, structuredWaiting: false, structuredSince: null }).kind;
    expect(read(IDLE)).toBe('not-waiting');
    expect(read(UNREADABLE)).toBe('unknown');
  });
});

describe('[#3798] the poller closes the wait it answered', () => {
  it('no wait at answer time: the poller opens one and records lastAnswer; the cleared screen closes it', async () => {
    await pollerTick(CONFIRM);
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    const opened = record();
    expect(opened).toMatchObject({ openedBy: 'auto-yes-poller', kind: 'prompt' });
    expect(lastAnswer()).toEqual({
      episodeId: opened!.episodeId,
      screenKey: partialAnswerScreenKey(promptOf(CONFIRM)),
      at: expect.any(Number),
    });

    // The cooldown tick after the answer reads the dialog gone.
    await pollerTick(IDLE, COOLDOWN_INTERVAL_MS);
    expect(record()).toBeNull();
    expect(edgeLog()).toEqual([
      ['opened', null],
      ['closed', 'poller-answered'],
    ]);
  });

  it('the UAT shape: a wait the status probe opened, answered by the poller, closes on the cleared screen without a browser', async () => {
    const opened = openWait();
    await pollerTick(CONFIRM);
    expect(record()?.episodeId).toBe(opened.episodeId);
    expect(lastAnswer()?.episodeId).toBe(opened.episodeId);

    await pollerTick(IDLE, COOLDOWN_INTERVAL_MS);
    expect(record()).toBeNull();
    expect(edges.at(-1)).toMatchObject({ cause: 'closed', previousEpisodeId: opened.episodeId, closeReason: 'poller-answered' });
  });
});

describe('[#3798] what the poller does not close', () => {
  it('does not close: an unanswered wait, an answer to an earlier wait, a capture failure, an unclassified frame, a swap during the tick', async () => {
    // An unanswered wait.
    const unanswered = openWait();
    await pollerTick(IDLE);
    expect(record()?.episodeId).toBe(unanswered.episodeId);
    closeEpisode(PARTS, unanswered.episodeId, 'screen-cleared', Date.now());
    vi.advanceTimersByTime(1);

    // An answer to an earlier wait: the answered episode ended, another opened.
    await pollerTick(CONFIRM);
    const answered = lastAnswer()!.episodeId;
    closeEpisode(PARTS, answered, 'turn-stop', Date.now());
    vi.advanceTimersByTime(1);
    const later = openWait();
    await pollerTick(IDLE, COOLDOWN_INTERVAL_MS);
    expect(record()?.episodeId).toBe(later.episodeId);
    closeEpisode(PARTS, later.episodeId, 'screen-cleared', Date.now());
    vi.advanceTimersByTime(1);

    // The poller answers a fresh wait; the next ticks fail to capture, then read nothing.
    await pollerTick(CONFIRM_OTHER, COOLDOWN_INTERVAL_MS);
    const current = record()!;
    expect(lastAnswer()?.episodeId).toBe(current.episodeId);
    capture.fail = true;
    await pollerTick(IDLE, COOLDOWN_INTERVAL_MS);
    expect(record()?.episodeId).toBe(current.episodeId);
    capture.fail = false;
    await pollerTick(UNREADABLE, 10_000);
    expect(record()?.episodeId).toBe(current.episodeId);

    // A swap during the tick: the episode is rebound while this tick captures.
    capture.during = () => {
      expect(
        rebindEpisode(
          PARTS,
          current.episodeId,
          { kind: 'unattributed', generation: startWaitingObservation(WT, TOOL, TOOL).generation, lastClosedTurnId: 'other' },
          Date.now(),
        ),
      ).toBe(true);
    };
    capture.frame = IDLE;
    await vi.advanceTimersToNextTimerAsync();
    expect(capture.during).toBeNull();
    expect(record()?.episodeId).toBe(current.episodeId);

    // Control: the next tick, with nothing moving under it, closes it.
    await vi.advanceTimersToNextTimerAsync();
    expect(record()).toBeNull();
    expect(edges.at(-1)).toMatchObject({ cause: 'closed', previousEpisodeId: current.episodeId, closeReason: 'poller-answered' });
  });
});

describe('[#3798] a second confirmation after an answer is a new wait', () => {
  it('poller-answered prompt types (opencode numbered choice, copilot ≤3 options): a second prompt with a different screen key in the same turn is replaced and held, not allowed at once', async () => {
    event('user_prompt_submit');
    await pollerTick(CONFIRM);
    const first = record()!;
    expect(first.binding.kind).toBe('turn');

    // The agent works on (a frame nothing reads, so nothing closes the wait),
    // then asks its next confirmation in the same turn, well after the first
    // wait's hold ran out.
    await pollerTick(UNREADABLE, 20_000);
    expect(record()?.episodeId).toBe(first.episodeId);
    // Only from here: the first wait's own hold ending over the unread frames
    // is not what this case is about.
    startWaitingPushNotifier();
    sendPromptAnswer.mockClear();
    // What the gate says the moment the second wait replaces the first.
    const verdicts: string[] = [];
    onWaitingEpisodeTransition((t) => {
      if (t.cause !== 'replaced' || t.episodeId === null || t.since === null) return;
      const gate = { worktreeId: WT, cliToolId: TOOL, instanceId: TOOL } as const;
      verdicts.push(
        decidePromptPush({
          ...gate,
          waitingSince: t.since,
          waitingEpisodeId: t.episodeId,
          holdStartedAt: autoYesHoldStartedAt({ ...gate, waitingSince: t.since, waitingEpisodeId: t.episodeId }, Date.now()),
        }).reason,
        // Control: kept, the confirmation would be the first wait's, whose hold
        // (from its opening and the answer, both at T0) let it ring at once.
        decidePromptPush({ ...gate, waitingSince: first.since, waitingEpisodeId: first.episodeId, holdStartedAt: first.openedAt })
          .reason,
      );
    });
    await pollerTick(CONFIRM_OTHER);
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    const replaced = edges.find((e) => e.cause === 'replaced');
    expect(replaced).toMatchObject({ previousEpisodeId: first.episodeId });
    expect(verdicts).toEqual(['auto-yes-answering', 'auto-yes-not-answered']);
    expect(lastAnswer()?.episodeId).toBe(replaced!.episodeId);

    await pollerTick(IDLE, COOLDOWN_INTERVAL_MS);
    expect(record()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(promptPushes()).toBe(0);
  });

  it('negative: the same confirmation answered again keeps the wait', async () => {
    event('user_prompt_submit');
    await pollerTick(CONFIRM);
    const opened = record()!;
    // The dedup's retry window passes with the dialog still up; the poller answers it again.
    await pollerTick(CONFIRM, 60_000);
    expect(sendPromptAnswer.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(record()?.episodeId).toBe(opened.episodeId);
    expect(edges.map((e) => e.cause)).toEqual(['opened']);
  });
});

describe('[#3798] the answer is recorded for the wait the send began for (review R1)', () => {
  it('positive: A closed and B opened while the send is in flight — nothing recorded for B, and B is not closed as answered', async () => {
    const a = openWait();
    let b: ReturnType<typeof openWait> | null = null;
    sendPromptAnswer.mockImplementationOnce(async () => {
      expect(closeEpisode(PARTS, a.episodeId, 'turn-stop', Date.now())).toBe(true);
      b = openWait();
    });
    await pollerTick(CONFIRM);
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(b).not.toBeNull();
    expect(record()?.episodeId).toBe(b!.episodeId);
    expect(lastAnswer()).toBeNull();

    // The confirmation gone: B, which nobody answered, stays.
    await pollerTick(IDLE, COOLDOWN_INTERVAL_MS);
    expect(record()?.episodeId).toBe(b!.episodeId);
    expect(edges.some((e) => e.closeReason === 'poller-answered')).toBe(false);
  });

  it('positive: no wait at the send, one opened during it — not taken for the answered one', async () => {
    let b: ReturnType<typeof openWait> | null = null;
    sendPromptAnswer.mockImplementationOnce(async () => {
      b = openWait();
    });
    await pollerTick(CONFIRM);
    expect(record()?.episodeId).toBe(b!.episodeId);
    expect(lastAnswer()).toBeNull();
  });

  it('negative: A rebound during the send is still A — recorded, and closed on the cleared screen', async () => {
    const a = openWait();
    sendPromptAnswer.mockImplementationOnce(async () => {
      expect(
        rebindEpisode(
          PARTS,
          a.episodeId,
          { kind: 'unattributed', generation: startWaitingObservation(WT, TOOL, TOOL).generation, lastClosedTurnId: 'other' },
          Date.now(),
        ),
      ).toBe(true);
    });
    await pollerTick(CONFIRM);
    expect(lastAnswer()?.episodeId).toBe(a.episodeId);

    await pollerTick(IDLE, COOLDOWN_INTERVAL_MS);
    expect(record()).toBeNull();
    expect(edges.at(-1)).toMatchObject({ cause: 'closed', previousEpisodeId: a.episodeId, closeReason: 'poller-answered' });
  });
});

describe('[#3798] an answered wait whose hold runs out over unreadable frames does not notify (review R2)', () => {
  const PERSON_SCREEN = { kind: 'screen' as const, originTurnId: null };

  it('positive: the notifier running from before the answer, the agent working on over frames no rule reads past the hold — no prompt push', async () => {
    startWaitingPushNotifier();
    await pollerTick(CONFIRM);
    const answered = record()!;
    expect(lastAnswer()?.episodeId).toBe(answered.episodeId);

    // Well past the hold (9 s) and several re-asks of the notifier.
    for (let i = 0; i < 10; i += 1) await pollerTick(UNREADABLE, COOLDOWN_INTERVAL_MS);
    expect(Date.now() - answered.openedAt).toBeGreaterThan(30_000);
    expect(record()?.episodeId).toBe(answered.episodeId);
    expect(promptPushes()).toBe(0);

    // Then the screen clears: closed as answered, still nothing sent.
    await pollerTick(IDLE, COOLDOWN_INTERVAL_MS);
    expect(record()).toBeNull();
    expect(promptPushes()).toBe(0);
  });

  it('positive control: the answered wait turns into a screen a person drives — it notifies within a hold', async () => {
    startWaitingPushNotifier();
    await pollerTick(CONFIRM);
    const answered = record()!;
    await pollerTick(UNREADABLE, 10_000);
    expect(promptPushes()).toBe(0);

    // What the poller does on a survey or a picker after the answer (see
    // `auto-yes-poller-close-answered-wait-3798.test.ts`): the same id, now a person's screen.
    expect(
      rebindEpisode(
        PARTS,
        answered.episodeId,
        { ...PERSON_SCREEN, generation: startWaitingObservation(WT, TOOL, TOOL).generation },
        Date.now(),
      ),
    ).toBe(true);
    await pollerTick(UNREADABLE, 10_000);
    expect(record()?.episodeId).toBe(answered.episodeId);
    expect(promptPushes()).toBe(1);
  });

  it('positive control: a wait the poller did not answer, on a frame it cannot read, rings once its 9 s hold is over (as before)', async () => {
    startWaitingPushNotifier();
    capture.frame = UNREADABLE;
    openWait();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(promptPushes()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(promptPushes()).toBe(1);
  });
});
