/**
 * Issue #2361: a Claude `/model` switch reaching the three #2357 receivers.
 *
 * #2357 announces a model change on three routes — a system row on the chat
 * surface, the `model_changed` frame the session row turns amber on, and a
 * push — and its acceptance criterion "a Claude session switching with
 * `/model` drives the same three routes" was merged unmet: Claude's hook names
 * the model on `SessionStart` alone, and the frame reader had no rule for the
 * confirmation line. This suite pins the criterion the way it now holds:
 *
 *  1. arm the fan-out exactly as `setupWebSocket` does
 *     (`startWaitingStatusBroadcast`);
 *  2. deliver the real `SessionStart` hook, so the hook latch holds the exact
 *     id and the frame has something to overtake;
 *  3. feed the LIVE 2.1.263 frames through `extractModelInfo` +
 *     `recordCapturedModelInfo`, which is byte-for-byte the status poll's path
 *     (`worktree-status-helper.ts`);
 *  4. assert the history row, the socket frames, and the push — once, with the
 *     frame's value — and nothing on the polls that follow.
 *
 * The push is stubbed at its one outward function; the sentence, the locale
 * resolution and the in-memory database are real.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
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
import { extractModelInfo } from '@/lib/detection/model-info-extractor';
import { isModelChangeBroadcastActive } from '@/lib/realtime/model-change-broadcast';
import { startWaitingStatusBroadcast, stopWaitingStatusBroadcast } from '@/lib/realtime/waiting-broadcast';
import {
  clearAgentStopEvents,
  getResolvedAgentModelInfo,
  recordAgentEvent,
  recordCapturedModelInfo,
} from '@/lib/session/agent-event-state';

const WT = 'wt-2361-int';
const T0 = 1_800_000_000_000;
/** What claude 2.1.263 put on `SessionStart` for the probe session's default. */
const HOOK_FABLE = 'claude-fable-5-1[1m]';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/claude-model-switch-2361');
const frameText = (name: string): string => fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8');

/** Frames the injected publisher received, in order. */
let published: Array<{ worktreeId: string; data: Record<string, unknown> }>;
const publish = (worktreeId: string, data: unknown): void => {
  published.push({ worktreeId, data: data as Record<string, unknown> });
};

/** A real hook delivery, as `/api/hooks/agent-event` records it. */
function sessionStart(model: string | null, at: number): void {
  recordAgentEvent(WT, 'claude', 'claude', {
    event: 'session_start',
    at,
    detail: null,
    sessionId: 'ses-2361',
    model,
  });
}

/** One status poll over a live frame — the same two calls `worktree-status-helper` makes. */
function poll(name: string, at: number): void {
  recordCapturedModelInfo(WT, 'claude', 'claude', extractModelInfo('claude', frameText(name)), at);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-2361', '/tmp/wt-2361', '/tmp/repo', 'repo', T0);
  published = [];
  notifyModelChangePush.mockReset();
  notifyModelChangePush.mockResolvedValue(null);
  clearAgentStopEvents();
  stopWaitingStatusBroadcast();
});

afterEach(() => {
  stopWaitingStatusBroadcast();
  clearAgentStopEvents();
  db?.close();
  db = null;
});

describe('claude /model switch → the three #2357 routes (Issue #2361)', () => {
  it('drives the history row, the model_changed frame and the push from the live frames', () => {
    upsertPushSubscription(db!, { endpoint: 'https://push.example/ja', p256dh: 'p', auth: 'a', locale: 'ja' });
    startWaitingStatusBroadcast(publish);
    expect(isModelChangeBroadcastActive()).toBe(true);

    // Session start: the hook names the exact id, the banner is polled.
    sessionStart(HOOK_FABLE, T0);
    poll('fullscreen-boot-fable', T0 + 2_000);
    poll('fullscreen-picker-open', T0 + 4_000);
    expect(getResolvedAgentModelInfo(WT, 'claude', 'claude')).toEqual({ model: HOOK_FABLE, effort: 'xhigh' });
    expect(published).toEqual([]);
    expect(notifyModelChangePush).not.toHaveBeenCalled();
    expect(getMessages(db!, WT)).toHaveLength(0);

    // `/model` → Sonnet 5, `s`. The next poll reads the pane.
    poll('fullscreen-switch-sonnet-session-only', T0 + 6_000);

    // Route 1: the chat surface's system row, in the readers' language.
    const rows = getMessages(db!, WT, { cliToolId: 'claude', instanceId: 'claude' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'assistant',
      messageType: 'normal',
      cliToolId: 'claude',
      instanceId: 'claude',
      content: `モデルが ${HOOK_FABLE} から Sonnet 5 に変わりました`,
      requestId: `${MODEL_CHANGE_REQUEST_ID_PREFIX}${T0 + 6_000}`,
    });

    // Route 2: the socket — the row as a `message` frame, then `model_changed`.
    expect(published.map((p) => p.worktreeId)).toEqual([WT, WT]);
    expect(published[0].data.type).toBe('message');
    expect(published[1].data).toEqual({
      type: 'model_changed',
      worktreeId: WT,
      cliTool: 'claude',
      instance: 'claude',
      from: HOOK_FABLE,
      to: 'Sonnet 5',
      source: 'frame',
      at: T0 + 6_000,
    });

    // Route 3: the push, once, with the edge.
    expect(notifyModelChangePush).toHaveBeenCalledTimes(1);
    expect(notifyModelChangePush).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WT, cliToolId: 'claude', from: HOOK_FABLE, to: 'Sonnet 5', source: 'frame' })
    );

    // And what every surface now publishes for the instance.
    expect(getResolvedAgentModelInfo(WT, 'claude', 'claude')).toEqual({ model: 'Sonnet 5', effort: 'xhigh' });
  });

  it('fires once per switch: later polls of the same pane, and the same model again, are silent', () => {
    startWaitingStatusBroadcast(publish);
    sessionStart(HOOK_FABLE, T0);
    poll('fullscreen-boot-fable', T0 + 2_000);
    poll('fullscreen-switch-haiku-arg', T0 + 4_000);
    expect(published).toHaveLength(2);
    expect(notifyModelChangePush).toHaveBeenCalledTimes(1);

    // Every two seconds, the same pane …
    poll('fullscreen-switch-haiku-arg', T0 + 6_000);
    poll('fullscreen-switch-haiku-arg', T0 + 8_000);
    // … `/model haiku` again, and the picker closed with Esc.
    poll('fullscreen-same-model-haiku-arg', T0 + 10_000);
    poll('fullscreen-picker-escaped-kept', T0 + 12_000);
    expect(published).toHaveLength(2);
    expect(notifyModelChangePush).toHaveBeenCalledTimes(1);
    expect(getMessages(db!, WT)).toHaveLength(1);
  });

  it('fires from the acceptance frame — banner scrolled away, the confirmation line alone', () => {
    startWaitingStatusBroadcast(publish);
    sessionStart(HOOK_FABLE, T0);
    poll('fullscreen-switch-sonnet-banner-scrolled', T0 + 600_000);
    expect(published).toHaveLength(2);
    expect(published[1].data).toMatchObject({ type: 'model_changed', from: HOOK_FABLE, to: 'Sonnet 5', source: 'frame' });
    expect(notifyModelChangePush).toHaveBeenCalledTimes(1);

    // The line scrolls away too: the latch holds, nothing fires.
    poll('fullscreen-switch-line-scrolled', T0 + 660_000);
    expect(getResolvedAgentModelInfo(WT, 'claude', 'claude').model).toBe('Sonnet 5');
    expect(published).toHaveLength(2);
  });

  it('a second switch is a second edge, from the frame value to the next', () => {
    startWaitingStatusBroadcast(publish);
    sessionStart(HOOK_FABLE, T0);
    poll('fullscreen-switch-sonnet-session-only', T0 + 2_000);
    poll('fullscreen-switch-opus-default-effort-high', T0 + 4_000);
    expect(published.filter((p) => p.data.type === 'model_changed').map((p) => [p.data.from, p.data.to])).toEqual([
      [HOOK_FABLE, 'Sonnet 5'],
      ['Sonnet 5', 'Opus 5 (1M context)'],
    ]);
    expect(notifyModelChangePush).toHaveBeenCalledTimes(2);
    expect(getResolvedAgentModelInfo(WT, 'claude', 'claude')).toEqual({ model: 'Opus 5 (1M context)', effort: 'high' });
  });

  it('still fires when the hook never spoke — a session that predates the server process', () => {
    startWaitingStatusBroadcast(publish);
    poll('fullscreen-boot-fable', T0);
    poll('fullscreen-switch-sonnet-banner-scrolled', T0 + 2_000);
    expect(published).toHaveLength(2);
    expect(published[1].data).toMatchObject({ type: 'model_changed', from: 'Fable 5.1', to: 'Sonnet 5', source: 'frame' });
    expect(notifyModelChangePush).toHaveBeenCalledTimes(1);
  });
});
