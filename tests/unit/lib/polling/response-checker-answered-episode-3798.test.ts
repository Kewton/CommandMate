/**
 * Issue #3798 (PR 3): the response poller hands the Auto-Yes poller's last
 * answer to its prompt observation (`docs/design/issue-3798-waiting-episode.md`
 * §2.4 表 O-1, R1-7, §6.4).
 *
 * A second confirmation of the same turn, read by the response poller after
 * the Auto-Yes poller answered the first, is a new wait: the old one is
 * replaced, and the notification is held under a hold of its own rather than
 * the first wait's, which ran out long ago. Without the answer — or with an
 * answer to another wait — the wait is kept, as before, and a wait Auto-Yes did
 * not answer still rings once its hold is over.
 *
 * Scaffold as in `response-checker-waiting-episode-3798.test.ts` (the real
 * `checkForResponse`, a real database, only `web-push` stubbed), with Auto-Yes
 * on and the clock faked.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: vi.fn(),
  },
}));

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
const isSessionRunning = vi.fn<(...a: unknown[]) => Promise<boolean>>();
type FrameMeta = { fetchStartedAt: number; source: 'fetched' | 'cache' | 'joined' };
/** The capture fetched the frame itself, now. */
const ownFetch = (): FrameMeta => ({ fetchStartedAt: Date.now(), source: 'fetched' });
const frameMeta = vi.fn<(...a: unknown[]) => FrameMeta>(ownFetch);
vi.mock('@/lib/session/cli-session', () => ({
  // Issue #3798: and tells the observer where its frame came from, as cli-session does.
  captureSessionOutput: async (...a: unknown[]) => {
    const output = await captureSessionOutput(...a);
    globalThis.__captureFrameMetaSink?.getStore()?.(frameMeta()!);
    return output;
  },
  isSessionRunning: (...a: unknown[]) => isSessionRunning(...a),
}));

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m }));
const getSessionState = vi.fn(() => ({ lastCapturedLine: 0, inProgressMessageId: null }));
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: (...a: unknown[]) => getSessionState(...(a as [])),
  updateSessionState: vi.fn(),
  getWorktreeById: () => ({ id: 'wt-3798-rc', name: 'feature-x' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

const recordClaudeConversation = vi.fn(async () => {});
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: () => recordClaudeConversation() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));

import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import { upsertPushSubscription } from '@/lib/db/push-subscriptions-db';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { startWaitingPushNotifier, stopWaitingPushNotifier } from '@/lib/push/waiting-push-notifier';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import { buildCompositeKey, clearAllAutoYesStates, getAutoYesState, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { autoYesPollerStates } from '@/lib/polling/auto-yes-poller-generation';
import { partialAnswerScreenKey, type AutoYesPollerState } from '@/lib/polling/auto-yes-poller-state';
import { clearAutoYesHolds } from '@/lib/push/prompt-push-gate';
import { clearAllPromptCards, getPromptCardEpisodeId } from '@/lib/push/prompt-card-state';
import {
  clearPolicySuppressions,
  getLastPolicySuppression,
  recordPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  getWaitingEpisodeRecord,
  onWaitingEpisodeTransition,
  type WaitingEpisodeTransition,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-rc';
const KEY = buildCompositeKey(WT, 'claude', 'claude');
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;

function promptPane(file: string): string {
  return [
    '❯ apply the refactor',
    '',
    '⏺ I need permission to edit the file.',
    '',
    `Do you want to make this edit to ${file}?`,
    '❯ 1. Yes',
    '  2. Yes, allow all edits during this session (shift+tab)',
    '  3. No',
    '',
    'Esc to cancel · Tab to amend',
  ].join('\n');
}
const PROMPT_PANE = promptPane('useVirtualKeyboard.ts');
const OTHER_PROMPT_PANE = promptPane('package.json');

let savedEnv: Record<string, string | undefined>;
let edges: WaitingEpisodeTransition[];

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function promptPushes(): number {
  return sendNotification.mock.calls
    .map(([, payload]) => JSON.parse(payload as string) as { kind: string })
    .filter((p) => p.kind === 'prompt').length;
}

function event(e: string, at: number = Date.now()): void {
  recordAgentEvent(WT, 'claude', 'claude', { event: e as never, at, detail: null, sessionId: 's-1' });
}

const record = () => getWaitingEpisodeRecord(WT, 'claude', 'claude');

/** A tick on `pane`; the poller then restarts, as after an answer (the prompt dedup goes with it). */
async function tick(pane: string): Promise<boolean> {
  captureSessionOutput.mockResolvedValueOnce(pane);
  const result = await checkForResponse(WT, 'claude');
  await flush();
  stopPolling(WT, 'claude');
  return result;
}

function screenKeyOf(pane: string): string {
  const result = detectPromptOnCleanFrame(pane, 'claude', pane.split('\n'));
  expect(result.isPrompt).toBe(true);
  return partialAnswerScreenKey(result.promptData!);
}

/** What the Auto-Yes poller's answering tick leaves on its state. */
function autoYesAnswered(episodeId: string, pane: string): void {
  const state: AutoYesPollerState = {
    timerId: null,
    cliToolId: 'claude',
    instanceId: 'claude',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: Date.now(),
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
    lastAnswer: { episodeId, screenKey: screenKeyOf(pane), at: Date.now() },
  };
  autoYesPollerStates.set(KEY, state);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_800_000_000_000);
  db = new Database(':memory:');
  runMigrations(db);
  upsertPushSubscription(db, { endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a', locale: 'en' });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  vi.clearAllMocks();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  isSessionRunning.mockResolvedValue(true);
  frameMeta.mockImplementation(ownFetch);
  getSessionState.mockReturnValue({ lastCapturedLine: 0, inProgressMessageId: null });

  stopPolling(WT, 'claude');
  autoYesPollerStates.delete(KEY);
  clearAllAutoYesStates();
  clearAutoYesHolds();
  clearPolicySuppressions();
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  resetNotificationDedup();
  resetWaitingPushDedup();
  clearAllPromptCards();
  startWaitingPushNotifier();
  edges = [];
  onWaitingEpisodeTransition((t) => edges.push(t));

  event('session_start', Date.now() - 10_000);
  event('user_prompt_submit', Date.now() - 9_000);
  setAutoYesEnabled(WT, 'claude', true);
});

afterEach(() => {
  stopWaitingPushNotifier();
  stopPolling(WT, 'claude');
  autoYesPollerStates.delete(KEY);
  clearAllAutoYesStates();
  clearAutoYesHolds();
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.useRealTimers();
});

describe('[#3798] the response poller and the Auto-Yes poller\'s last answer', () => {
  it('a second confirmation after the answered one, in the same turn: replaced, held under a new hold, no push', async () => {
    expect(await tick(PROMPT_PANE)).toBe(true);
    const first = record()!;
    expect(first.binding.kind).toBe('turn');
    expect(promptPushes()).toBe(0);
    autoYesAnswered(first.episodeId, PROMPT_PANE);

    // The next confirmation, long after the first wait's hold ran out.
    vi.setSystemTime(Date.now() + 30_000);
    expect(await tick(OTHER_PROMPT_PANE)).toBe(true);
    const second = record()!;
    expect(second.episodeId).not.toBe(first.episodeId);
    expect(edges.map((e) => [e.cause, e.previousEpisodeId])).toEqual([
      ['opened', null],
      ['replaced', first.episodeId],
    ]);
    expect(promptPushes()).toBe(0);
  });

  it('control: an answer to another wait keeps this one, which rings once its hold is over (as before)', async () => {
    expect(await tick(PROMPT_PANE)).toBe(true);
    const first = record()!;
    autoYesAnswered('wep-another-wait', PROMPT_PANE);

    vi.setSystemTime(Date.now() + 30_000);
    expect(await tick(OTHER_PROMPT_PANE)).toBe(true);
    expect(record()?.episodeId).toBe(first.episodeId);
    expect(edges.map((e) => e.cause)).toEqual(['opened']);
    expect(promptPushes()).toBe(1);
  });

  it('negative: the answered confirmation itself, read again, keeps the wait', async () => {
    expect(await tick(PROMPT_PANE)).toBe(true);
    const first = record()!;
    autoYesAnswered(first.episodeId, PROMPT_PANE);

    vi.setSystemTime(Date.now() + 1_000);
    await tick(PROMPT_PANE);
    expect(record()?.episodeId).toBe(first.episodeId);
    expect(edges.map((e) => e.cause)).toEqual(['opened']);
  });
});

describe('[#3798] the response poller names the episode it commits to the gate and the fan-out (review R3)', () => {
  const WITHHELD = { reason: 'deny-pattern' as const, mode: 'allow-listed' as const, promptType: 'multiple_choice' as const };
  const promptPayloads = () =>
    sendNotification.mock.calls
      .map(([, payload]) => JSON.parse(payload as string) as { kind: string; episodeId?: string; order?: number; body: string })
      .filter((p) => p.kind === 'prompt');

  it('positive: a suppression recorded for A in the very millisecond B replaces it is not B\'s reason — B is held, no push', async () => {
    expect(await tick(PROMPT_PANE)).toBe(true);
    const first = record()!;
    autoYesAnswered(first.episodeId, PROMPT_PANE);

    vi.setSystemTime(Date.now() + 30_000);
    recordPolicySuppression(WT, 'claude', 'claude', WITHHELD);
    const stale = getLastPolicySuppression(WT, 'claude', 'claude')!;
    expect(stale.episodeId).toBe(first.episodeId);

    expect(await tick(OTHER_PROMPT_PANE)).toBe(true);
    const second = record()!;
    expect(second.episodeId).not.toBe(first.episodeId);
    // Precondition: the same millisecond, so `at >= since` alone reads A's record as B's.
    expect(second.since).toBe(stale.at);
    expect(promptPushes()).toBe(0);
  });

  it('negative: a suppression recorded for B itself is B\'s reason — it rings at once', async () => {
    expect(await tick(PROMPT_PANE)).toBe(true);
    const first = record()!;
    autoYesAnswered(first.episodeId, PROMPT_PANE);
    vi.setSystemTime(Date.now() + 30_000);
    expect(await tick(OTHER_PROMPT_PANE)).toBe(true);
    const second = record()!;
    expect(promptPushes()).toBe(0);

    // The poller withholds B on its next tick; a later read of B (the dedup
    // reset, as after a restart) asks the gate with B's id.
    recordPolicySuppression(WT, 'claude', 'claude', WITHHELD);
    expect(getLastPolicySuppression(WT, 'claude', 'claude')?.episodeId).toBe(second.episodeId);
    vi.setSystemTime(Date.now() + 1_000);
    resetWaitingPushDedup();
    expect(await tick(OTHER_PROMPT_PANE)).toBe(true);
    expect(record()?.episodeId).toBe(second.episodeId);
    expect(promptPushes()).toBe(1);
  });

  it('the card: one push, carrying the committed episode\'s id and an order, and the prompt\'s own question', async () => {
    setAutoYesEnabled(WT, 'claude', false);
    expect(getAutoYesState(WT, 'claude', 'claude')?.enabled).toBe(false);
    expect(await tick(PROMPT_PANE)).toBe(true);
    const opened = record()!;
    const payloads = promptPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ episodeId: opened.episodeId, order: expect.any(Number) });
    expect(payloads[0].body).toContain('useVirtualKeyboard.ts');
    expect(getPromptCardEpisodeId(WT)).toBe(opened.episodeId);
  });

  it('the card of a replacement names the new episode', async () => {
    setAutoYesEnabled(WT, 'claude', false);
    expect(await tick(PROMPT_PANE)).toBe(true);
    const first = record()!;
    autoYesAnswered(first.episodeId, PROMPT_PANE);
    vi.setSystemTime(Date.now() + 30_000);
    expect(await tick(OTHER_PROMPT_PANE)).toBe(true);
    const second = record()!;
    expect(second.episodeId).not.toBe(first.episodeId);
    const payloads = promptPayloads();
    expect(payloads.map((p) => p.episodeId)).toEqual([first.episodeId, second.episodeId]);
    expect(payloads[1].order!).toBeGreaterThan(payloads[0].order!);
    expect(payloads[1].body).toContain('package.json');
  });
});
