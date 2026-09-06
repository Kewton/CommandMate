/**
 * One agy dialog, one answer on the wire (Issue #2364).
 *
 * Three producers describe the same pane, and the Issue measured them
 * disagreeing: `/current-output` said `antigravity_selection_list` with no
 * prompt, the response poller stored a `prompt` row whose question had the diff
 * preview joined into it, and the push notification quoted that question. On the
 * wrapped-label dialog the status side said "generating" while the poller
 * stored nothing at all.
 *
 * This suite drives the real producers over the live 1.1.27 frames:
 *
 *  - `buildCurrentOutput` — the status API payload the chat surface, the
 *    terminal tab and `capture --json` read (`isPromptWaiting` /
 *    `isSelectionListActive` / `promptData`);
 *  - `checkForResponse` — the poller's stored `prompt` row (`createMessage`)
 *    and, through a real in-memory database with only `web-push` stubbed, the
 *    `kind: 'prompt'` notification and its excerpt.
 *
 * `vi.mock` is hoisted, so every module both producers reach is mocked once at
 * the top; the fixtures are read from disk untouched (ANSI intact), as the
 * server would capture them.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { PromptData } from '@/types/models';

let db: Database.Database;

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: vi.fn(),
  },
}));

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: vi.fn(async () => true),
}));

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-2364', ...m }));
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: vi.fn(() => ({ lastCapturedLine: 0, inProgressMessageId: null })),
  updateSessionState: vi.fn(),
  getWorktreeById: () => ({ id: 'wt-2364', name: 'agy-probe' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({
        isRunning: async () => true,
        getSessionName: (worktreeId: string, instanceId?: string) => `cm-${worktreeId}-${instanceId ?? 'antigravity'}`,
      }),
    }),
  },
}));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => null),
  buildCompositeKey: (worktreeId: string, cliToolId: string, instanceId?: string) =>
    `${worktreeId}:${cliToolId}:${instanceId ?? cliToolId}`,
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => false),
}));

import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { upsertPushSubscription } from '@/lib/db/push-subscriptions-db';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { clearWaitingEpisodes } from '@/lib/session/waiting-episode-state';

const WT = 'wt-2364';
const FIXTURE_DIR = path.resolve(__dirname, '../../../fixtures/antigravity-live-2364');
const frame = (name: string): string => readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8');
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;

let savedEnv: Record<string, string | undefined>;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The `kind: 'prompt'` notification bodies actually handed to web-push. */
function promptPushBodies(): string[] {
  return sendNotification.mock.calls
    .map(([, payload]) => JSON.parse(payload as string) as { kind: string; body: string })
    .filter((p) => p.kind === 'prompt')
    .map((p) => p.body);
}

/** The `prompt` row the poller stored, or null. */
function storedPrompt(): PromptData | null {
  const call = createMessage.mock.calls.find(([, m]) => m.messageType === 'prompt');
  return (call?.[1].promptData as PromptData | undefined) ?? null;
}

/** The three fields the surfaces branch on, from a multiple_choice prompt. */
function shapeOf(promptData: { type: string } | null | undefined): unknown {
  if (promptData?.type !== 'multiple_choice') return promptData?.type ?? null;
  const { question, options, instructionText } = promptData as PromptData & { type: 'multiple_choice' };
  return {
    question,
    options: options.map((o) => ({ number: o.number, label: o.label, isDefault: o.isDefault })),
    instructionText,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertPushSubscription(db, { endpoint: 'https://push.example/agy', p256dh: 'p', auth: 'a', locale: 'en' });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  vi.clearAllMocks();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  stopPolling(WT, 'antigravity');
  clearWaitingEpisodes();
  resetNotificationDedup();
  resetWaitingPushDedup();
});

afterEach(() => {
  stopPolling(WT, 'antigravity');
  clearWaitingEpisodes();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe.each([
  {
    name: 'dialog-create-file',
    question: 'Allow creation of this file?',
    optionCount: 2,
    /** Text the old reading dragged into the question / excerpt and must not. */
    notInQuestion: 'hello-agy.txt',
  },
  {
    name: 'dialog-bash-wrapped',
    question: 'Do you want to proceed?',
    optionCount: 4,
    notInQuestion: 'Requesting permission for',
  },
])('[#2364] $name — status, stored prompt and push agree', ({ name, question, optionCount, notInQuestion }) => {
  it('publishes an answerable prompt on /current-output', async () => {
    captureSessionOutput.mockResolvedValue(frame(name));

    const payload = await buildCurrentOutput({} as never, WT, 'antigravity');

    expect(payload.sessionStatus).toBe('waiting');
    expect(payload.sessionStatusReason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.isSelectionListActive).toBe(false);
    expect(payload.isUnclassifiedActive).toBe(false);
    expect(payload.promptData?.type).toBe('multiple_choice');
    expect(payload.promptData?.question).toBe(question);
    if (payload.promptData?.type !== 'multiple_choice') throw new Error('expected multiple_choice');
    expect(payload.promptData.options).toHaveLength(optionCount);
  });

  it('stores the same prompt and quotes its question in the push', async () => {
    captureSessionOutput.mockResolvedValue(frame(name));

    expect(await checkForResponse(WT, 'antigravity')).toBe(true);
    await flush();

    const stored = storedPrompt();
    expect(stored?.type).toBe('multiple_choice');
    expect(stored?.question).toBe(question);
    if (stored?.type !== 'multiple_choice') throw new Error('expected multiple_choice');
    expect(stored.options).toHaveLength(optionCount);

    const bodies = promptPushBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(question);
    expect(bodies[0]).not.toContain(notInQuestion);
  });

  it('is one reading, not three', async () => {
    captureSessionOutput.mockResolvedValue(frame(name));

    const status = detectSessionStatus(frame(name), 'antigravity');
    const payload = await buildCurrentOutput({} as never, WT, 'antigravity');
    await checkForResponse(WT, 'antigravity');
    await flush();

    const fromStatus = shapeOf(status.promptDetection.promptData);
    expect(shapeOf(payload.promptData)).toEqual(fromStatus);
    expect(shapeOf(storedPrompt())).toEqual(fromStatus);
    expect(fromStatus).not.toBeNull();
  });
});

describe('[#2364] the picker keeps publishing an open selection list', () => {
  it('is a menu on /current-output and stores no prompt row', async () => {
    captureSessionOutput.mockResolvedValue(frame('picker-switch-model'));

    const payload = await buildCurrentOutput({} as never, WT, 'antigravity');
    expect(payload.sessionStatus).toBe('waiting');
    expect(payload.sessionStatusReason).toBe(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
    expect(payload.isSelectionListActive).toBe(true);
    expect(payload.isPromptWaiting).toBe(false);

    await checkForResponse(WT, 'antigravity');
    await flush();
    expect(storedPrompt()).toBeNull();
    expect(promptPushBodies()).toHaveLength(0);
  });
});
