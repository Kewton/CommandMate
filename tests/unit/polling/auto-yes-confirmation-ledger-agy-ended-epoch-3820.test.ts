/**
 * The memory of a confirmation agy's `PostToolUse` closed (Issue #3820, design
 * `docs/design/auto-yes-measurement-3820.md` §2.4, PR 3): it keeps a stale
 * frame still showing the dialog from being counted again — in the session it
 * was closed in, and no further. A relaunched session, or a stop that ends the
 * session (kill, removal, the worktree deleted), forgets it, so the first
 * sighting of the same screen key without a call is a new confirmation. A stop
 * that only stops looking (Auto-Yes turned off by hand, expired, an unknown
 * reason) keeps it: turned back on, the same call's stale frame is not counted
 * again. The memory is bounded per instance.
 *
 * Driven through the ledger's entry points the way the poller calls them, as
 * `auto-yes-confirmation-ledger-3820.test.ts` does.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import {
  beginLedgerTick,
  endLedgerTick,
  noteLedgerPollerStopped,
  noteLedgerToolCallEnded,
  noteLedgerWorktreeStopped,
  observeLedgerScreen,
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
  type LedgerScope,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';
import { beginEnterFallbackSession } from '@/lib/polling/auto-yes-enter-fallback-state';

const T0 = Date.UTC(2026, 9, 22, 10, 0, 0);
const WT = 'wt-3820-ended-epoch';
const SCOPE: LedgerScope = { worktreeId: WT, cliToolId: 'antigravity', instanceId: 'antigravity' };
const KEY = `${WT}:antigravity`;
const CALL = 'conv:25';

let now = T0;

const lines = (event: string): Array<Record<string, unknown>> =>
  mockLogger.info.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

/** One poller tick that reads the screen and sees the dialog, tied to `callId` or not. */
function tick(scope: LedgerScope, callId?: string): void {
  now += 2_000;
  const token = beginLedgerTick(scope);
  observeLedgerScreen(scope, 'screen-dialog', 'permission_request', callId !== undefined ? { callId } : {});
  endLedgerTick(scope, token);
}

/** The dialog seen tied to the call, then the call's `PostToolUse` closes it while the frame still shows it. */
function seenAndEnded(scope: LedgerScope = SCOPE): void {
  tick(scope, CALL);
  now += 500;
  noteLedgerToolCallEnded(scope, CALL);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAutoYesConfirmationLedgerForTests();
  now = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
});

afterEach(() => {
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  vi.restoreAllMocks();
});

describe('[#3820 PR 3] an ended call is remembered in its own session only', () => {
  it('does not reopen a stale frame of the same session, with or without the call (negative control)', () => {
    seenAndEnded();
    tick(SCOPE);
    tick(SCOPE, CALL);

    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.closed)).toHaveLength(1);
  });

  it('opens a new confirmation for the same screen key without a call after the session is relaunched', () => {
    seenAndEnded();
    beginEnterFallbackSession(WT, 'antigravity', 'antigravity');
    tick(SCOPE);

    expect(lines(EV.opened)).toHaveLength(2);
    expect(lines(EV.opened)[1]).not.toHaveProperty('callId');
  });

  it.each([['session-killed'], ['instance-removed']])(
    'forgets it when the instance’s poller stops (%s)',
    (reason) => {
      seenAndEnded();
      noteLedgerPollerStopped(KEY, reason);
      tick(SCOPE);

      expect(lines(EV.opened)).toHaveLength(2);
    },
  );

  it('forgets it when the worktree stops, and only for that worktree', () => {
    const other: LedgerScope = { worktreeId: `${WT}-other`, cliToolId: 'antigravity', instanceId: 'antigravity' };
    seenAndEnded();
    seenAndEnded(other);
    noteLedgerWorktreeStopped(WT, 'worktree-deleted');
    tick(SCOPE);
    tick(other);

    expect(lines(EV.opened).map((line) => line.worktreeId)).toEqual([WT, other.worktreeId, WT]);
  });

  it('keeps it for at most 1024 instances, dropping the oldest', () => {
    seenAndEnded();
    for (let i = 0; i < 1024; i += 1) {
      seenAndEnded({ worktreeId: `${WT}-${i}`, cliToolId: 'antigravity', instanceId: 'antigravity' });
    }
    mockLogger.info.mockClear();
    // The newest is still remembered; the first, pushed out, opens again.
    tick({ worktreeId: `${WT}-1023`, cliToolId: 'antigravity', instanceId: 'antigravity' });
    expect(lines(EV.opened)).toHaveLength(0);
    tick(SCOPE);
    expect(lines(EV.opened)).toHaveLength(1);
  });

  describe('a stop that only stops looking keeps it (Auto-Yes OFF → ON)', () => {
    it.each([['manual'], ['expired'], ['not-enabled'], ['stop-pattern'], ['some-future-reason']])(
      'does not reopen the same call’s stale frame after the poller stops (%s) and restarts',
      (reason) => {
        seenAndEnded();
        noteLedgerPollerStopped(KEY, reason);
        tick(SCOPE, CALL);
        tick(SCOPE);

        expect(lines(EV.opened)).toHaveLength(1);
      },
    );

    it('does not reopen it after the whole worktree is turned off by hand and on again', () => {
      seenAndEnded();
      noteLedgerWorktreeStopped(WT, 'manual');
      tick(SCOPE, CALL);

      expect(lines(EV.opened)).toHaveLength(1);
    });

    it('still opens a new one after a manual stop once the session is relaunched (the epoch decides)', () => {
      seenAndEnded();
      noteLedgerPollerStopped(KEY, 'manual');
      beginEnterFallbackSession(WT, 'antigravity', 'antigravity');
      tick(SCOPE);

      expect(lines(EV.opened)).toHaveLength(2);
    });
  });

  describe('a stop that ends the session forgets it', () => {
    it('opens a new one after the session is killed and relaunched, with no call', () => {
      seenAndEnded();
      noteLedgerPollerStopped(KEY, 'session-killed');
      beginEnterFallbackSession(WT, 'antigravity', 'antigravity');
      tick(SCOPE);

      expect(lines(EV.opened)).toHaveLength(2);
    });

    it('opens a new one after the worktree is deleted and its session relaunched, with no call', () => {
      seenAndEnded();
      noteLedgerWorktreeStopped(WT, 'worktree-deleted');
      beginEnterFallbackSession(WT, 'antigravity', 'antigravity');
      tick(SCOPE);

      expect(lines(EV.opened)).toHaveLength(2);
    });
  });
});
