/**
 * The screen reading never saves an OpenCode V2 reply (Issue #4187, §5.3 S1〜S6).
 *
 * Decision of #4187: V2's replies are written only from its own server's
 * document (`lib/hooks/sources/opencode-v2/history`), including the turns that
 * ended while the event stream was not live (the recovery sync on reconnect).
 * The poller does not save them from the pane, whatever the subscription's
 * liveness — a `lost` stream's turns are written later under `oc-turn:<id>`,
 * which a scraped row cannot carry, so both writing would double the turn.
 *
 * `pattern-anchors-4175.test.ts` pins this at `extractResponse`; this pins it
 * one layer up, at `checkForResponse`, on the measured frames, with the real
 * structured-history gate asking a stubbed liveness (`lost` / `unknown`).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceLiveness } from '@/lib/hooks/sources/types';

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: vi.fn(async () => true),
}));

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m }));
const sessionLine = vi.hoisted(() => ({ value: 0 }));
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: () => ({ lastCapturedLine: sessionLine.value, inProgressMessageId: null }),
  updateSessionState: (_db: unknown, _wt: string, _cli: string, line: number) => {
    sessionLine.value = line;
  },
  getWorktreeById: (_db: unknown, id: string) => ({ id, name: id, path: `/repos/${id}` }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-session-ownership', () => ({
  findTerminalSessionRefusal: vi.fn(async () => null),
}));
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));
vi.mock('@/lib/tmux/geometry-delegation', () => ({
  probeGeometryDelegation: vi.fn(async () => ({ delegated: false, released: false })),
}));
const onRelayTurnCompleted = vi.fn();
vi.mock('@/lib/relay/relay-triggers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/relay-triggers')>()),
  onRelayTurnCompleted: (...a: unknown[]) => onRelayTurnCompleted(...a),
}));

/** The liveness the real gate is told; the subscription itself is not opened. */
const liveness = vi.hoisted(() => ({ value: { state: 'unknown' } as SourceLiveness }));
vi.mock('@/lib/hooks/sources/opencode-v2/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode-v2/subscription')>()),
  getOpencodeV2Liveness: () => liveness.value,
  isOpencodeV2StructuredHistoryLive: () => liveness.value.state === 'live',
}));

import { checkForResponse } from '@/lib/polling/response-checker';
import { getPollerKey, stopPolling } from '@/lib/polling/response-poller-core';
import {
  hasPendingScrapedResponse,
  resetPendingScrapedResponses,
} from '@/lib/polling/pending-scraped-response';
import { isStructuredHistoryWriterLive } from '@/lib/polling/structured-history-gate';

const fixture = (rel: string): string =>
  readFileSync(resolve(__dirname, '../../../fixtures', rel), 'utf8');

const WT = 'wt-4187-scrape';
const LOST: SourceLiveness = { state: 'lost', since: 1, reason: 'stream-ended' };
const UNKNOWN: SourceLiveness = { state: 'unknown' };

function lineCount(raw: string): number {
  return raw.split('\n').length;
}

function expectNothingSaved(): void {
  expect(createMessage.mock.calls.filter(([, m]) => m.role === 'assistant')).toEqual([]);
  expect(hasPendingScrapedResponse(getPollerKey(WT, 'opencode-v2'))).toBe(false);
  expect(onRelayTurnCompleted).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  stopPolling(WT, 'opencode-v2');
  resetPendingScrapedResponses();
  sessionLine.value = 0;
  liveness.value = UNKNOWN;
});

describe('the screen reading saves no OpenCode V2 reply (Issue #4187)', () => {
  it('the gate is really asked, and really answers "not live" for lost / unknown', () => {
    // The premise: were the gate to say live, the stand-down would hide the
    // assertions below behind a different reason.
    liveness.value = LOST;
    expect(isStructuredHistoryWriterLive(WT, 'opencode-v2')).toBe(false);
    liveness.value = { state: 'live', lastHeartbeatAt: 1 };
    expect(isStructuredHistoryWriterLive(WT, 'opencode-v2')).toBe(true);
  });

  it.each([
    ['S1 long-done (echo off screen)', 'opencode-v2-live-4175/long-done.txt', LOST],
    ['S2 quote-footer-done (standalone)', 'opencode-v2-live-4175/quote-footer-done.txt', UNKNOWN],
    ['S3 interrupted', 'opencode-v2-live-4175/interrupted.txt', LOST],
    ['S4 idle-after-turn', 'opencode-v2-live-4175/idle-after-turn.txt', UNKNOWN],
    ['S5 turn-done-after-approval', 'opencode-v2-live-2945/turn-done-after-approval.txt', LOST],
    ['S5 question-answered', 'opencode-v2-live-2945/question-answered.txt', LOST],
  ])('%s: no row, nothing held, no relay completion', async (_name, rel, state) => {
    liveness.value = state;
    captureSessionOutput.mockResolvedValue(fixture(rel));
    await checkForResponse(WT, 'opencode-v2');
    expectNothingSaved();
  });

  it('S6 the same frame read again (cursor 0, then its line count) still saves nothing', async () => {
    const raw = fixture('opencode-v2-live-4175/long-done.txt');
    captureSessionOutput.mockResolvedValue(raw);
    liveness.value = LOST;
    sessionLine.value = 0;
    await checkForResponse(WT, 'opencode-v2');
    expectNothingSaved();
    sessionLine.value = lineCount(raw);
    await checkForResponse(WT, 'opencode-v2');
    expectNothingSaved();
  });
});
