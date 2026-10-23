/**
 * Issue #3798 (PR 1b): the response poller as an observer of the waiting
 * episodes (`docs/design/issue-3798-waiting-episode.md` §2.4 規則 8, O2 / C2).
 *
 * O2 — the prompt it saves — is planned BEFORE the prompt dedup registers the
 * hash: a frame fetched before the close of the very confirmation it shows (an
 * answer and a stop landed during the capture) saves nothing, registers
 * nothing and pushes nothing, so the next tick's frame decides. C2 — the reply
 * it records — closes only the episode the tick started against.
 *
 * Driven through the real `checkForResponse` and the real `isDuplicatePrompt`,
 * with a real database and only `web-push` stubbed (as in
 * `response-checker-waiting-push-1790.test.ts`).
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
const getCaptureFetchStartedAt = vi.fn<(...a: unknown[]) => number | null>(() => null);
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: (...a: unknown[]) => isSessionRunning(...a),
  getCaptureFetchStartedAt: (...a: unknown[]) => getCaptureFetchStartedAt(...a),
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
import { getAgentTurn } from '@/lib/session/agent-event-turn';
import { startWaitingObservation } from '@/lib/session/waiting-episode-binding';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  getWaitingEpisodeRecord,
  onWaitingEpisodeTransition,
  openEpisode,
  type WaitingEpisodeTransition,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-rc';
const PARTS = { worktreeId: WT, cliToolId: 'claude' as const, instanceId: 'claude' };
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

const REPLY_PANE = [
  '❯ apply the refactor',
  '⏺ Done — the hook now debounces resize events.',
  '',
  '─'.repeat(40),
  '❯ ',
  '─'.repeat(40),
  '  ⏸ manual mode on · ? for shortcuts                       focus',
].join('\n');

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
const savedPrompts = () => createMessage.mock.calls.filter(([, m]) => m.messageType === 'prompt').length;

/** A tick on `pane`, reset as the poller restarts after an answer (the prompt dedup goes with it). */
async function tick(pane: string): Promise<boolean> {
  captureSessionOutput.mockResolvedValueOnce(pane);
  const result = await checkForResponse(WT, 'claude');
  await flush();
  return result;
}

beforeEach(() => {
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
  getCaptureFetchStartedAt.mockReturnValue(null);
  getSessionState.mockReturnValue({ lastCapturedLine: 0, inProgressMessageId: null });

  stopPolling(WT, 'claude');
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  resetNotificationDedup();
  resetWaitingPushDedup();
  startWaitingPushNotifier();
  edges = [];
  onWaitingEpisodeTransition((t) => edges.push(t));

  event('session_start', Date.now() - 10_000);
  event('user_prompt_submit', Date.now() - 9_000);
});

afterEach(() => {
  stopWaitingPushNotifier();
  stopPolling(WT, 'claude');
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** The first tick: the prompt is saved and its wait opened. Then the poller restarts. */
async function promptSavedOnce(): Promise<string> {
  expect(await tick(PROMPT_PANE)).toBe(true);
  const opened = record()!;
  expect(opened.openedBy).toBe('response-checker');
  stopPolling(WT, 'claude');
  return opened.episodeId;
}

/** A capture during which the agent's stop lands, serving a frame fetched before it. */
function stopDuringCapture(pane: string): void {
  captureSessionOutput.mockImplementationOnce(async () => {
    const fetchedAt = Date.now() - 1;
    getCaptureFetchStartedAt.mockReturnValueOnce(fetchedAt);
    event('stop', Date.now());
    return pane;
  });
}

describe('[#3798] O2: the prompt is planned before the dedup', () => {
  it('a stop during the capture: the same prompt is not reopened and its hash is not registered', async () => {
    await promptSavedOnce();
    stopDuringCapture(PROMPT_PANE);
    expect(await checkForResponse(WT, 'claude')).toBe(false);
    await flush();
    expect(record()).toBeNull();
    expect(savedPrompts()).toBe(1);
    expect(promptPushes()).toBe(1);

    // The next tick's frame — fetched now — still shows it: the hash was not
    // registered, so it is saved and a new wait opens.
    expect(await tick(PROMPT_PANE)).toBe(true);
    expect(record()).not.toBeNull();
    expect(savedPrompts()).toBe(2);
  });

  it('a different prompt read during another closer\'s await still opens', async () => {
    await promptSavedOnce();
    stopDuringCapture(OTHER_PROMPT_PANE);
    expect(await checkForResponse(WT, 'claude')).toBe(true);
    await flush();
    expect(record()).not.toBeNull();
    expect(savedPrompts()).toBe(2);
  });

  it('the same text in the next turn opens a new wait through the real isDuplicatePrompt', async () => {
    const first = await promptSavedOnce();
    expect(await tick(REPLY_PANE)).toBe(true);
    expect(record()).toBeNull();
    stopPolling(WT, 'claude');
    event('stop');
    event('user_prompt_submit');

    expect(await tick(PROMPT_PANE)).toBe(true);
    const second = record()!;
    expect(second.episodeId).not.toBe(first);
    expect(promptPushes()).toBe(2);
    expect(edges.map((e) => e.cause)).toEqual(['opened', 'closed', 'opened']);
  });

  it('a prompt after a scraper_evidence-closed turn with a different screen key is replaced', async () => {
    await promptSavedOnce();
    const opened = record()!;
    expect(opened.binding.kind).toBe('turn');
    // The turn ended without a transition (screen evidence / the stale bound):
    // closed in the turn model, the wait left as it was.
    const turn = getAgentTurn(WT, 'claude', 'claude')!;
    turn.closedAt = Date.now();
    turn.closedBy = 'scraper_evidence';

    expect(await tick(OTHER_PROMPT_PANE)).toBe(true);
    const now = record()!;
    expect(now.episodeId).not.toBe(opened.episodeId);
    expect(edges.map((e) => e.cause)).toEqual(['opened', 'replaced']);
    expect(promptPushes()).toBe(2);
  });

  it('control: the same prompt on that closed turn is the same wait', async () => {
    await promptSavedOnce();
    const opened = record()!;
    const turn = getAgentTurn(WT, 'claude', 'claude')!;
    turn.closedAt = Date.now();
    turn.closedBy = 'scraper_evidence';
    expect(await tick(PROMPT_PANE)).toBe(true);
    expect(record()?.episodeId).toBe(opened.episodeId);
    expect(promptPushes()).toBe(1);
  });
});

describe('[#3798] C2: the reply closes the wait the tick started against', () => {
  it('a turn(T) left after its stop is closed by the recorded reply', async () => {
    const t = getAgentTurn(WT, 'claude', 'claude')!.turnId;
    event('stop');
    openEpisode(
      PARTS,
      {
        since: Date.now(),
        kind: 'prompt',
        binding: { kind: 'turn', generation: startWaitingObservation(WT, 'claude', 'claude').generation, turnId: t },
        openedBy: 'status-probe',
      },
      Date.now(),
    );
    expect(await tick(REPLY_PANE)).toBe(true);
    expect(record()).toBeNull();
    expect(edges.at(-1)).toMatchObject({ cause: 'closed', closeReason: 'response-recorded' });
  });

  it('a wait that opened while the log was written is not this reply\'s to close', async () => {
    recordClaudeConversation.mockImplementationOnce(async () => {
      openEpisode(
        PARTS,
        {
          since: Date.now(),
          kind: 'prompt',
          binding: { kind: 'unattributed', generation: { kind: 'none' }, lastClosedTurnId: null },
          openedBy: 'status-probe',
        },
        Date.now(),
      );
    });
    expect(await tick(REPLY_PANE)).toBe(true);
    expect(record()).not.toBeNull();
  });
});
