/**
 * The push poller rings on the same upstream fault as `capture --json` on codex
 * 0.160's split screen (Issue #3946): both call `matchPaneUpstreamFault`, which
 * also reads the transcript's last row above `realtimeSnippet`. The frames are
 * SYNTHETIC (tests/fixtures/upstream-faults/README.md).
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
  getWorktreeById: () => ({ id: 'wt-3946', name: 'wt-3946', path: '/repos/wt-3946' }),
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

const WT = 'wt-3946';
const FIXTURES = join(__dirname, '../../fixtures');
const read = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf8');
const CAPACITY_FRAME = read('upstream-faults/codex-0.160.0-model-capacity-3946.txt');
const NEXT_TURN_FRAME = read('upstream-faults/codex-0.160.0-model-capacity-next-turn-3946.txt');
const INTERRUPTED_FRAME = read('startup-screen-3293/codex-0.160.0-first-turn-interrupted.txt');

const pushedFaultIds = (): unknown[] => notifyUpstreamFaultPush.mock.calls.map(([input]) => input.faultId);

beforeEach(() => {
  vi.clearAllMocks();
  stopPolling(WT, 'codex');
});

describe('upstream-fault push on codex 0.160 split screen (Issue #3946)', () => {
  it('notifies model-capacity from the transcript row above the window', async () => {
    captureSessionOutput.mockResolvedValue(CAPACITY_FRAME);
    await checkForResponse(WT, 'codex');
    expect(pushedFaultIds()).toEqual(['model-capacity']);
    expect(notifyUpstreamFaultPush.mock.calls[0][0].matchedText).toBe(
      '■ Selected model is at capacity. Please try a different model.',
    );
  });

  it('past turn: a healthy next turn after the capacity row hands over no fault', async () => {
    captureSessionOutput.mockResolvedValue(NEXT_TURN_FRAME);
    await checkForResponse(WT, 'codex');
    expect(pushedFaultIds()).toEqual([null]);
  });

  it('negative control: the measured interrupted frame hands over no fault', async () => {
    captureSessionOutput.mockResolvedValue(INTERRUPTED_FRAME);
    await checkForResponse(WT, 'codex');
    expect(pushedFaultIds()).toEqual([null]);
  });
});
