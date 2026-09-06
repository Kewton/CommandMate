/**
 * The model edge's fan-out (Issue #2357): one subscription, three receivers.
 *
 * The edge itself is judged in `agent-event-state` and pinned by
 * `tests/unit/lib/session/agent-model-change-2357.test.ts`. What is pinned
 * here is what happens AFTER it fires, driven end to end from a real hook
 * delivery so the suite proves the subscription is armed and not merely that a
 * function can be called:
 *
 *  1. a history row is written (real in-memory DB), in the readers' language,
 *     identified by its request id;
 *  2. the room receives the row as a `message` frame and then the
 *     `model_changed` frame — in that order, through the injected publisher;
 *  3. the push notifier is asked exactly once.
 *
 * And the arming: `startWaitingStatusBroadcast` (what `setupWebSocket` calls)
 * arms this subscription with the same publisher, `stopWaitingStatusBroadcast`
 * disarms it, and re-arming does not double-send.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database | null;

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  },
}));
mockLogger.withContext.mockReturnValue(mockLogger);
vi.mock('@/lib/logger', () => ({
  createLogger: () => mockLogger,
  generateRequestId: () => 'test-request-id',
}));

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => {
    if (db === null) throw new Error('database unavailable');
    return db;
  },
}));

// The push is the one receiver with side effects outside the process, so it is
// the one thing stubbed — and only that function: the sentence and the locale
// resolution stay real, because the history row is built from them.
const notifyModelChangePush = vi.fn();
vi.mock('@/lib/push/model-change-push-notifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/push/model-change-push-notifier')>();
  return {
    ...actual,
    notifyModelChangePush: (...args: unknown[]) => notifyModelChangePush(...args),
  };
});

import { upsertPushSubscription } from '@/lib/db';
import { getMessages, MODEL_CHANGE_REQUEST_ID_PREFIX } from '@/lib/db/chat-db';
import {
  buildModelChangedEvent,
  handleAgentModelChange,
  isModelChangeBroadcastActive,
  startModelChangeBroadcast,
  stopModelChangeBroadcast,
} from '@/lib/realtime/model-change-broadcast';
import { MODEL_CHANGED_EVENT_TYPE, parseRealtimeEvent } from '@/lib/realtime/types';
import {
  isWaitingStatusBroadcastActive,
  startWaitingStatusBroadcast,
  stopWaitingStatusBroadcast,
} from '@/lib/realtime/waiting-broadcast';
import {
  clearAgentStopEvents,
  recordAgentEvent,
  recordCapturedModelInfo,
  type AgentModelChange,
} from '@/lib/session/agent-event-state';

const WT = 'wt-2357-rt';
const T0 = 1_800_000_000_000;

const CHANGE: AgentModelChange = {
  worktreeId: WT,
  cliToolId: 'codex',
  instanceId: 'codex',
  from: 'gpt-5.6-sol',
  to: 'gpt-5-mini',
  source: 'hook',
  at: T0 + 30_000,
};

/** Frames the injected publisher received, in order. */
let published: Array<{ worktreeId: string; data: unknown }>;
const publish = (worktreeId: string, data: unknown): void => {
  published.push({ worktreeId, data });
};

function hook(model: string, at: number, event: 'session_start' | 'user_prompt_submit' = 'user_prompt_submit'): void {
  recordAgentEvent(WT, 'codex', 'codex', { event, at, detail: null, sessionId: 'ses-1', model });
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-2357', '/tmp/wt-2357', '/tmp/repo', 'repo', T0);
  published = [];
  notifyModelChangePush.mockReset();
  notifyModelChangePush.mockResolvedValue(null);
  for (const fn of [mockLogger.debug, mockLogger.info, mockLogger.warn, mockLogger.error]) {
    fn.mockReset();
  }
  clearAgentStopEvents();
  stopWaitingStatusBroadcast();
});

afterEach(() => {
  stopWaitingStatusBroadcast();
  clearAgentStopEvents();
  db?.close();
  db = null;
});

// =============================================================================
// The frame
// =============================================================================

describe('buildModelChangedEvent', () => {
  it('carries the edge field for field, under the shared type', () => {
    expect(buildModelChangedEvent(CHANGE)).toEqual({
      type: MODEL_CHANGED_EVENT_TYPE,
      worktreeId: WT,
      cliTool: 'codex',
      instance: 'codex',
      from: 'gpt-5.6-sol',
      to: 'gpt-5-mini',
      source: 'hook',
      at: T0 + 30_000,
    });
  });

  it('survives the room envelope a client unwraps', () => {
    const raw = JSON.stringify({ type: 'broadcast', worktreeId: WT, data: buildModelChangedEvent(CHANGE) });
    const parsed = parseRealtimeEvent(raw);
    expect(parsed).toMatchObject({ type: 'model_changed', worktreeId: WT, instance: 'codex', to: 'gpt-5-mini' });
  });
});

// =============================================================================
// The three receivers
// =============================================================================

describe('handleAgentModelChange', () => {
  it('writes the history row, in the readers’ language, marked by its request id', () => {
    upsertPushSubscription(db!, { endpoint: 'https://push.example/ja', p256dh: 'p', auth: 'a', locale: 'ja' });

    handleAgentModelChange(CHANGE, publish);

    const rows = getMessages(db!, WT, { cliToolId: 'codex', instanceId: 'codex' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'assistant',
      messageType: 'normal',
      cliToolId: 'codex',
      instanceId: 'codex',
      content: 'モデルが gpt-5.6-sol から gpt-5-mini に変わりました',
      requestId: `${MODEL_CHANGE_REQUEST_ID_PREFIX}${T0 + 30_000}`,
    });
    expect(rows[0].timestamp.getTime()).toBe(T0 + 30_000);
  });

  it('publishes the row as a `message` frame and then the `model_changed` frame', () => {
    handleAgentModelChange(CHANGE, publish);

    expect(published.map((p) => p.worktreeId)).toEqual([WT, WT]);
    const [messageFrame, modelFrame] = published.map((p) => p.data as Record<string, unknown>);
    expect(messageFrame.type).toBe('message');
    expect(messageFrame.message).toMatchObject({
      role: 'assistant',
      cliToolId: 'codex',
      instanceId: 'codex',
      content: 'Model changed from gpt-5.6-sol to gpt-5-mini',
    });
    expect(modelFrame).toEqual(buildModelChangedEvent(CHANGE));
  });

  it('asks the push notifier exactly once, with the edge', () => {
    handleAgentModelChange(CHANGE, publish);
    expect(notifyModelChangePush).toHaveBeenCalledTimes(1);
    expect(notifyModelChangePush).toHaveBeenCalledWith(CHANGE);
  });

  it('still sends the socket frame and the push when the database cannot take the row', () => {
    db!.close();
    db = null;

    expect(() => handleAgentModelChange(CHANGE, publish)).not.toThrow();

    expect(published).toHaveLength(1);
    expect(published[0].data).toEqual(buildModelChangedEvent(CHANGE));
    expect(notifyModelChangePush).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'model-change-history-failed',
      expect.objectContaining({ worktreeId: WT, instanceId: 'codex' })
    );
  });

  it('still pushes when the publisher throws', () => {
    const broken = (): void => {
      throw new Error('no room');
    };
    expect(() => handleAgentModelChange(CHANGE, broken)).not.toThrow();
    expect(notifyModelChangePush).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'model-change-broadcast-failed',
      expect.objectContaining({ worktreeId: WT })
    );
  });

  it('logs the transition where an operator can find it', () => {
    handleAgentModelChange(CHANGE, publish);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'model-changed',
      expect.objectContaining({ worktreeId: WT, instanceId: 'codex', from: 'gpt-5.6-sol', to: 'gpt-5-mini', source: 'hook' })
    );
  });
});

// =============================================================================
// The arming
// =============================================================================

describe('arming through the waiting broadcast', () => {
  it('is armed by startWaitingStatusBroadcast and driven by a real hook delivery', () => {
    expect(isModelChangeBroadcastActive()).toBe(false);
    startWaitingStatusBroadcast(publish);
    expect(isWaitingStatusBroadcastActive()).toBe(true);
    expect(isModelChangeBroadcastActive()).toBe(true);

    hook('gpt-5.6-sol', T0, 'session_start');
    expect(published).toEqual([]);
    expect(notifyModelChangePush).not.toHaveBeenCalled();

    hook('gpt-5-mini', T0 + 30_000);
    expect(published).toHaveLength(2);
    expect(published[1].data).toMatchObject({
      type: 'model_changed',
      worktreeId: WT,
      instance: 'codex',
      from: 'gpt-5.6-sol',
      to: 'gpt-5-mini',
      source: 'hook',
    });
    expect(notifyModelChangePush).toHaveBeenCalledTimes(1);
    expect(getMessages(db!, WT)).toHaveLength(1);
  });

  it('fires for a frame-read change exactly as for a hook one', () => {
    startWaitingStatusBroadcast(publish);
    recordCapturedModelInfo(WT, 'copilot', 'copilot', { model: 'GPT-5.6 Sol', effort: 'medium' }, T0);
    recordCapturedModelInfo(WT, 'copilot', 'copilot', { model: 'gpt-5-mini', effort: 'medium' }, T0 + 45_000);
    expect(published).toHaveLength(2);
    expect(published[1].data).toMatchObject({ type: 'model_changed', cliTool: 'copilot', source: 'frame' });
  });

  it('is disarmed by stopWaitingStatusBroadcast', () => {
    startWaitingStatusBroadcast(publish);
    stopWaitingStatusBroadcast();
    expect(isModelChangeBroadcastActive()).toBe(false);

    hook('gpt-5.6-sol', T0, 'session_start');
    hook('gpt-5-mini', T0 + 30_000);
    expect(published).toEqual([]);
    expect(notifyModelChangePush).not.toHaveBeenCalled();
  });

  it('re-arming replaces the subscription rather than adding a second one', () => {
    startWaitingStatusBroadcast(publish);
    startWaitingStatusBroadcast(publish);
    startModelChangeBroadcast(publish);

    hook('gpt-5.6-sol', T0, 'session_start');
    hook('gpt-5-mini', T0 + 30_000);
    expect(published).toHaveLength(2);
    expect(notifyModelChangePush).toHaveBeenCalledTimes(1);

    stopModelChangeBroadcast();
    expect(isModelChangeBroadcastActive()).toBe(false);
  });
});
