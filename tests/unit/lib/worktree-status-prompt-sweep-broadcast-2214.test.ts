/**
 * The stale-prompt sweep on the status path publishes what it stamped
 * (Issue #2214, completing #2195).
 *
 * `detectWorktreeSessionStatus` is the third caller of
 * `markPendingPromptsAsAnswered` — the two routes behind it (`GET /api/worktrees`
 * and `GET /api/worktrees/[id]`) reach it on every list and detail read. #2195
 * added the `onUpdated` callback and wired the poller's two sweeps to it; this
 * one was left passing four arguments, so a row it flipped from `pending` to
 * `answered` reached open panes only on their next history poll — which #2195
 * itself demoted to a 15 s fallback.
 *
 * Two properties are pinned, and the second is the one with teeth:
 *
 *  1. the event type is `message_updated`, because the row already existed and
 *     was already delivered once. Asserted on the producer directly: a client
 *     rendering test cannot see the difference, since `useSplitMessages` upserts
 *     `message` and `message_updated` by the same ID.
 *  2. **nothing this callback does can reach the status verdict.** The sweep sits
 *     inside a `try` whose `catch` means "capture failed, assume processing", so
 *     a throwing push would not merely lose a frame — it would publish a wrong
 *     status to the sidebar, Home, Sessions, Review and the command palette.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { ChatMessage } from '@/types/models';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string, instanceId?: string) =>
          instanceId && instanceId !== cliToolId
            ? `${cliToolId}-${worktreeId}-${instanceId}`
            : `${cliToolId}-${worktreeId}`,
        name: cliToolId,
      }),
    }),
  },
}));

vi.mock('@/lib/cli-tools/types', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/types')>()),
  CLI_TOOL_IDS: ['claude'] as readonly CLIToolType[],
}));

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue('$ '),
}));

vi.mock('@/lib/detection/status-detector', () => ({
  detectSessionStatus: vi.fn().mockReturnValue({
    status: 'ready',
    confidence: 'high',
    reason: 'input_prompt',
    // False is what opens the sweep branch: a prompt still on screen is not
    // stale, so nothing is swept while one is showing.
    hasActivePrompt: false,
    promptDetection: { isPrompt: false, cleanContent: '' },
  }),
}));

vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: true }),
}));

vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getLastServerResponseTimestamp: vi.fn().mockReturnValue(null),
  buildCompositeKey: vi.fn((worktreeId: string, cliToolId: string) => `${worktreeId}:${cliToolId}`),
}));

const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: (...args: unknown[]) => broadcastMessage(...args),
}));

import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';

const db = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;

/** The row the sweep stamps, as `markPendingPromptsAsAnswered` hands it back. */
const SWEPT_ROW: ChatMessage = {
  id: 'msg-2214',
  worktreeId: 'wt-2214',
  role: 'assistant',
  content: 'Do you want to proceed?',
  timestamp: new Date('2026-09-01T00:00:00.000Z'),
  messageType: 'prompt',
  promptData: {
    type: 'multiple_choice',
    question: 'Do you want to proceed?',
    options: [
      { number: 1, label: 'Yes' },
      { number: 2, label: 'No' },
    ],
    status: 'answered',
    answer: '(answered via terminal)',
    answeredBy: 'terminal',
  },
  cliToolId: 'claude',
  instanceId: 'claude',
  archived: false,
};

/** A still-pending prompt row, which is what makes the helper sweep at all. */
const PENDING_ROW: ChatMessage = {
  ...SWEPT_ROW,
  promptData: {
    type: 'multiple_choice',
    question: 'Do you want to proceed?',
    options: [
      { number: 1, label: 'Yes' },
      { number: 2, label: 'No' },
    ],
    status: 'pending',
  },
};

const getMessages = vi.fn(() => [PENDING_ROW]);
const getAgentInstances = vi.fn(() => [] as AgentInstance[]);

/**
 * A sweep that stamped exactly one row, reported through `onUpdated`.
 *
 * Standing in for the DB function is what keeps this a test of the *helper's*
 * wiring: #2195 already proved the callback fires once per stamped row.
 */
const markPendingPromptsAsAnswered = vi.fn(
  (
    _db: unknown,
    _worktreeId: string,
    _cliToolId: CLIToolType,
    _instanceId?: string,
    onUpdated?: (message: ChatMessage) => void
  ) => {
    onUpdated?.(SWEPT_ROW);
    return 1;
  }
);

function detect() {
  return detectWorktreeSessionStatus(
    'wt-2214',
    new Set(['claude-wt-2214']),
    db,
    getMessages as never,
    markPendingPromptsAsAnswered as never,
    getAgentInstances as never
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  broadcastMessage.mockReset();
  getMessages.mockReturnValue([PENDING_ROW]);
  getAgentInstances.mockReturnValue([]);
});

describe('the stale-prompt sweep (Issue #2214)', () => {
  it('passes an `onUpdated` callback to the sweep', async () => {
    await detect();

    expect(markPendingPromptsAsAnswered).toHaveBeenCalledWith(
      db,
      'wt-2214',
      'claude',
      'claude',
      expect.any(Function)
    );
  });

  it('publishes each stamped row as `message_updated`', async () => {
    await detect();

    await vi.waitFor(() => {
      expect(broadcastMessage).toHaveBeenCalledTimes(1);
    });
    const [type, payload] = broadcastMessage.mock.calls[0] as [
      string,
      { worktreeId: string; message: ChatMessage },
    ];
    // `message`, not `message_updated`, would tell a client to append a row it
    // already has — the same call `response-checker` makes for this DB function.
    expect(type).toBe('message_updated');
    expect(payload.worktreeId).toBe('wt-2214');
    expect(payload.message).toMatchObject({
      id: 'msg-2214',
      cliToolId: 'claude',
      instanceId: 'claude',
      promptData: { status: 'answered', answeredBy: 'terminal' },
    });
  });

  it('sweeps nothing — and publishes nothing — when no prompt is pending', async () => {
    // Already answered: nothing for the sweep to find, and therefore nothing
    // for it to publish.
    getMessages.mockReturnValue([SWEPT_ROW]);

    await detect();

    await Promise.resolve();
    expect(markPendingPromptsAsAnswered).not.toHaveBeenCalled();
    expect(broadcastMessage).not.toHaveBeenCalled();
  });

  it('publishes a wrong status to nobody when the socket throws', async () => {
    broadcastMessage.mockImplementation(() => {
      throw new Error('socket is gone');
    });

    const status = await detect();

    // The whole point. A throw that reached the enclosing `catch` would land
    // here as `isProcessing: true` on a session that is sitting at its prompt,
    // and that verdict is what the sidebar, Home, Sessions, Review and the
    // command palette all draw from.
    expect(status.sessionStatusByInstance['claude']).toMatchObject({
      isRunning: true,
      isProcessing: false,
    });
    expect(status.isProcessing).toBe(false);
    expect(status.isSessionRunning).toBe(true);

    await vi.waitFor(() => {
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'prompt-sweep-broadcast-failed',
        expect.objectContaining({ worktreeId: 'wt-2214' })
      );
    });
  });
});
