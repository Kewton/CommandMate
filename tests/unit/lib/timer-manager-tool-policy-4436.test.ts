/**
 * Issue #4436 (PM decision Q4): a message scheduled on the screen is sent later
 * by the server with nobody at the keyboard, so for the tool policy it is a
 * `send` from the origin `timer`. Under the default declaration (`personal`) an
 * antigravity timer is refused when it fires: nothing is typed, the session is
 * not even looked at, and the timer row says why (code + FAQ link).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANTIGRAVITY_CONSUMER_TERMS,
  ANTIGRAVITY_FAQ_URL,
  TOOL_POLICY_DENIED,
  USAGE_DECLARATION_ENV,
} from '@/lib/tool-policy/policy';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

const mockDb = { prepare: vi.fn() };
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => mockDb) }));

const mockGetTimerById = vi.fn();
const mockUpdateTimerStatus = vi.fn();
vi.mock('@/lib/db/timer-db', () => ({
  getTimerById: (...args: unknown[]) => mockGetTimerById(...args),
  getPendingTimers: vi.fn().mockReturnValue([]),
  updateTimerStatus: (...args: unknown[]) => mockUpdateTimerStatus(...args),
  cancelTimer: vi.fn(),
  cancelTimersByWorktree: vi.fn().mockReturnValue(0),
  cleanupOldTimers: vi.fn().mockReturnValue(0),
  recoverStuckSendingTimers: vi.fn().mockReturnValue(0),
}));

const mockIsRunning = vi.fn().mockResolvedValue(true);
const mockGetTool = vi.fn(() => ({ isRunning: mockIsRunning }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: vi.fn().mockReturnValue({ getTool: (...args: unknown[]) => mockGetTool(...(args as [])) }) },
}));

const mockSendUserMessage = vi.fn().mockResolvedValue({ ok: true, message: { id: 'msg-1' } });
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => mockSendUserMessage(...args),
}));

import { scheduleTimer, stopAllTimers } from '@/lib/timer-manager';

const savedDeclaration = process.env[USAGE_DECLARATION_ENV];
function declare(value: string | undefined): void {
  if (value === undefined) delete process.env[USAGE_DECLARATION_ENV];
  else process.env[USAGE_DECLARATION_ENV] = value;
}

function pendingTimer(cliToolId: string) {
  return {
    id: 'timer-4436',
    worktreeId: 'wt-4436',
    cliToolId,
    instanceId: cliToolId,
    message: 'continue',
    delayMs: 0,
    scheduledSendTime: Date.now(),
    status: 'pending',
    createdAt: Date.now(),
    sentAt: null,
  };
}

async function fire(cliToolId: string): Promise<void> {
  mockGetTimerById.mockReturnValue(pendingTimer(cliToolId));
  scheduleTimer('timer-4436', 'wt-4436', 0);
  await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).__timerManagerState = undefined;
  declare(undefined);
});

afterEach(() => {
  stopAllTimers();
  vi.useRealTimers();
  declare(savedDeclaration);
});

describe('Issue #4436: a fired timer goes through the tool policy (send from origin timer)', () => {
  const DECLARATIONS: Array<[string, string | undefined, boolean]> = [
    ['unset (personal)', undefined, false],
    ['personal', 'personal', false],
    ['api-key', 'api-key', true],
    ['enterprise', 'enterprise', true],
  ];

  for (const tool of CLI_TOOL_IDS) {
    for (const [label, value, unlocks] of DECLARATIONS) {
      const sends = tool !== 'antigravity' || unlocks;
      it(`4436 I1/I2/I3: a ${tool} timer with the declaration ${label} ${sends ? 'is sent once' : 'is refused (0 sends)'}`, async () => {
        declare(value);
        await fire(tool);

        expect(mockSendUserMessage).toHaveBeenCalledTimes(sends ? 1 : 0);
        if (sends) {
          expect(mockUpdateTimerStatus).toHaveBeenCalledWith(mockDb, 'timer-4436', 'sent', expect.any(Number));
        } else {
          // Nothing about the session is touched: no tool lookup, no isRunning.
          expect(mockGetTool).not.toHaveBeenCalled();
          expect(mockIsRunning).not.toHaveBeenCalled();
          expect(mockUpdateTimerStatus).toHaveBeenCalledTimes(1);
          const [, id, status, sentAt, reason] = mockUpdateTimerStatus.mock.calls[0];
          expect([id, status, sentAt]).toEqual(['timer-4436', 'failed', undefined]);
          expect(reason).toContain(TOOL_POLICY_DENIED);
          expect(reason).toContain(ANTIGRAVITY_CONSUMER_TERMS);
          expect(reason).toContain(ANTIGRAVITY_FAQ_URL);
        }
      });
    }
  }

  it('4436 I6: removing the declaration refuses the next timer', async () => {
    declare('api-key');
    await fire('antigravity');
    expect(mockSendUserMessage).toHaveBeenCalledTimes(1);

    declare(undefined);
    await fire('antigravity');
    expect(mockSendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('4436: a timer that is no longer pending is left alone (no refusal written)', async () => {
    mockGetTimerById.mockReturnValue({ ...pendingTimer('antigravity'), status: 'cancelled' });
    scheduleTimer('timer-4436', 'wt-4436', 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockUpdateTimerStatus).not.toHaveBeenCalled();
  });
});
