/**
 * The push notifier judges an upstream fault on the same rows as
 * `capture --json`'s `upstreamFault` (Issue #3936, review of eaeab6d P2).
 *
 * `current-output` judges on `realtimeSnippet`, which walks back to the last
 * row with content when the tail of the 1000-row pane is blank (#2768). The
 * poller used to read the raw last 100 rows, so on an inline codex pane whose
 * content ends at row 129 the capture showed `model-capacity` and the phone
 * was never told. The synthetic capacity frame
 * (tests/fixtures/upstream-faults/README.md) is that layout.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: async () => true,
}));
vi.mock('@/lib/db', () => ({
  createMessage: vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m })),
  getSessionState: vi.fn(() => ({ lastCapturedLine: 1002, inProgressMessageId: null })),
  updateSessionState: vi.fn(),
  getWorktreeById: () => ({ id: 'wt-3936', name: 'wt-3936', path: '/repos/wt-3936' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
const notifyUpstreamFaultPush = vi.fn(async (_input: Record<string, unknown>) => {});
vi.mock('@/lib/push/failure-push-notifier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push/failure-push-notifier')>()),
  notifyUpstreamFaultPush: (input: Record<string, unknown>) => notifyUpstreamFaultPush(input),
}));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/polling/structured-history-gate', () => ({
  isStructuredHistoryWriterLive: vi.fn(() => false),
  captureStructuredHistoryTurn: vi.fn(async () => false),
}));
vi.mock('@/lib/tmux/geometry-delegation', () => ({
  probeGeometryDelegation: vi.fn(async () => ({ delegated: false, released: false })),
}));

import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import { matchUpstreamFault } from '@/lib/detection/upstream-faults';
import { buildRealtimeSnippet } from '@/lib/realtime-snippet';

const WT = 'wt-3936';
const FIXTURES = join(__dirname, '../../fixtures');
const CAPACITY_FRAME = readFileSync(join(FIXTURES, 'upstream-faults/codex-model-capacity-3936.txt'), 'utf8');
const IDLE_FRAME = readFileSync(join(FIXTURES, 'codex-idle-composer-0155/idle-after-turn.txt'), 'utf8');

const pushedFaultIds = (): unknown[] => notifyUpstreamFaultPush.mock.calls.map(([input]) => input.faultId);

beforeEach(() => {
  vi.clearAllMocks();
  stopPolling(WT, 'codex');
});

describe('upstream-fault push reads the realtimeSnippet window (Issue #3936)', () => {
  it('premise: the capacity row is above a blank tail, and capture --json sees it', () => {
    expect(CAPACITY_FRAME.split('\n').slice(-100).every((row) => row.trim() === '')).toBe(true);
    expect(matchUpstreamFault(buildRealtimeSnippet(CAPACITY_FRAME))?.fault.id).toBe('model-capacity');
  });

  it('notifies model-capacity for the frame capture --json reports it on', async () => {
    captureSessionOutput.mockResolvedValue(CAPACITY_FRAME);
    await checkForResponse(WT, 'codex');
    expect(pushedFaultIds()).toEqual(['model-capacity']);
    expect(notifyUpstreamFaultPush.mock.calls[0][0].matchedText).toContain('Selected model is at capacity');
  });

  it('negative control: the healthy codex idle frame hands over no fault', async () => {
    captureSessionOutput.mockResolvedValue(IDLE_FRAME);
    await checkForResponse(WT, 'codex');
    expect(pushedFaultIds()).toEqual([null]);
  });

  it('negative control: a bottom-anchored frame is still judged on its last 100 rows only', async () => {
    // A fault 150 rows up on a full pane has scrolled out of "now" for both readers.
    const rows = ['■ Selected model is at capacity. Please try a different model.', ...new Array(150).fill('  transcript row')];
    captureSessionOutput.mockResolvedValue(rows.join('\n'));
    await checkForResponse(WT, 'codex');
    expect(pushedFaultIds()).toEqual([null]);
  });
});
