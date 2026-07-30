/**
 * Golden tests for the session status vocabulary mapping (Issue #1550).
 *
 * Issue #1550 is a behaviour-preserving refactor: these tests pin the mapping
 * that shipped before the conversions were moved into one module, so any future
 * change to the correspondence has to be a deliberate edit of this table.
 */

import { describe, it, expect } from 'vitest';
import {
  sessionStatusToActivityFlags,
  deriveCliStatus,
  deriveSessionStatus,
  deriveBranchStatus,
  type CliToolStatusFlags,
} from '@/lib/session/status-mapping';
import type { SessionStatus } from '@/lib/detection/status-detector';
import type { BranchStatus } from '@/types/sidebar';

/** Every value of SessionStatus, spelled out so a new value fails to compile. */
const ALL_SESSION_STATUSES = ['idle', 'ready', 'running', 'waiting'] as const;

// Compile-time guard: if SessionStatus gains a value, this assignment breaks.
const _sessionStatusCoverage: readonly SessionStatus[] = ALL_SESSION_STATUSES;
const _sessionStatusExhaustive: (typeof ALL_SESSION_STATUSES)[number] =
  null as unknown as SessionStatus;
void _sessionStatusCoverage;
void _sessionStatusExhaustive;

describe('sessionStatusToActivityFlags (Issue #1550)', () => {
  const TABLE: ReadonlyArray<
    [SessionStatus, { isWaitingForResponse: boolean; isProcessing: boolean }]
  > = [
    ['idle', { isWaitingForResponse: false, isProcessing: false }],
    ['ready', { isWaitingForResponse: false, isProcessing: false }],
    ['running', { isWaitingForResponse: false, isProcessing: true }],
    ['waiting', { isWaitingForResponse: true, isProcessing: false }],
  ];

  it.each(TABLE)('%s → %j', (status, expected) => {
    expect(sessionStatusToActivityFlags(status)).toEqual(expected);
  });

  it('covers every SessionStatus value', () => {
    expect(TABLE.map(([status]) => status)).toEqual([...ALL_SESSION_STATUSES]);
  });

  it('reproduces the pre-refactor inline expressions in worktree-status-helper', () => {
    // Before Issue #1550 the helper computed these two booleans inline as
    // `status === 'waiting'` / `status === 'running'`. Assert the extracted
    // function is equivalent for every input rather than trusting the move.
    for (const status of ALL_SESSION_STATUSES) {
      expect(sessionStatusToActivityFlags(status)).toEqual({
        isWaitingForResponse: status === 'waiting',
        isProcessing: status === 'running',
      });
    }
  });

  it('never reports both waiting and processing for a single status', () => {
    for (const status of ALL_SESSION_STATUSES) {
      const flags = sessionStatusToActivityFlags(status);
      expect(flags.isWaitingForResponse && flags.isProcessing).toBe(false);
    }
  });
});

describe('deriveCliStatus — full boolean-triple table (Issue #1550)', () => {
  // All 2^3 = 8 flag combinations, plus the absent-input case.
  const TABLE: ReadonlyArray<[CliToolStatusFlags, BranchStatus]> = [
    [{ isRunning: false, isWaitingForResponse: false, isProcessing: false }, 'idle'],
    [{ isRunning: false, isWaitingForResponse: false, isProcessing: true }, 'running'],
    [{ isRunning: false, isWaitingForResponse: true, isProcessing: false }, 'waiting'],
    [{ isRunning: false, isWaitingForResponse: true, isProcessing: true }, 'waiting'],
    [{ isRunning: true, isWaitingForResponse: false, isProcessing: false }, 'ready'],
    [{ isRunning: true, isWaitingForResponse: false, isProcessing: true }, 'running'],
    [{ isRunning: true, isWaitingForResponse: true, isProcessing: false }, 'waiting'],
    [{ isRunning: true, isWaitingForResponse: true, isProcessing: true }, 'waiting'],
  ];

  it('enumerates all 8 flag combinations', () => {
    expect(TABLE).toHaveLength(8);
    expect(new Set(TABLE.map(([flags]) => JSON.stringify(flags))).size).toBe(8);
  });

  it.each(TABLE)('%j → %s', (flags, expected) => {
    expect(deriveCliStatus(flags)).toBe(expected);
  });

  it('returns idle when no status is supplied', () => {
    expect(deriveCliStatus(undefined)).toBe('idle');
  });

  it('gives waiting precedence over processing', () => {
    expect(
      deriveCliStatus({ isRunning: true, isWaitingForResponse: true, isProcessing: true })
    ).toBe('waiting');
  });

  it('never produces generating (no boolean-triple source exists)', () => {
    for (const [flags] of TABLE) {
      expect(deriveCliStatus(flags)).not.toBe('generating');
    }
  });
});

describe('deriveSessionStatus — reverse edge (Issue #1550)', () => {
  const TABLE: ReadonlyArray<
    [
      { isSessionRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean },
      SessionStatus | null,
    ]
  > = [
    [{ isSessionRunning: false, isWaitingForResponse: false, isProcessing: false }, null],
    [{ isSessionRunning: false, isWaitingForResponse: true, isProcessing: true }, null],
    [{ isSessionRunning: true, isWaitingForResponse: false, isProcessing: false }, 'ready'],
    [{ isSessionRunning: true, isWaitingForResponse: false, isProcessing: true }, 'running'],
    [{ isSessionRunning: true, isWaitingForResponse: true, isProcessing: false }, 'waiting'],
    [{ isSessionRunning: true, isWaitingForResponse: true, isProcessing: true }, 'waiting'],
  ];

  it.each(TABLE)('%j → %s', (flags, expected) => {
    expect(deriveSessionStatus(flags)).toBe(expected);
  });

  it('returns null (not idle) when no session is running', () => {
    expect(
      deriveSessionStatus({
        isSessionRunning: false,
        isWaitingForResponse: false,
        isProcessing: false,
      })
    ).toBeNull();
  });

  it('round-trips SessionStatus → flags → SessionStatus for running sessions', () => {
    for (const status of ALL_SESSION_STATUSES) {
      const roundTripped = deriveSessionStatus({
        isSessionRunning: true,
        ...sessionStatusToActivityFlags(status),
      });
      // 'idle' is the one non-fixpoint: a live session that the detector calls
      // 'idle' is reported to the API as 'ready'.
      expect(roundTripped).toBe(status === 'idle' ? 'ready' : status);
    }
  });
});

describe('deriveBranchStatus — SessionStatus × isRunning table (Issue #1550)', () => {
  const TABLE: ReadonlyArray<[SessionStatus | null, boolean, BranchStatus]> = [
    [null, false, 'idle'],
    ['idle', false, 'idle'],
    ['ready', false, 'idle'],
    ['running', false, 'idle'],
    ['waiting', false, 'idle'],
    [null, true, 'ready'],
    ['idle', true, 'ready'],
    ['ready', true, 'ready'],
    ['running', true, 'running'],
    ['waiting', true, 'waiting'],
  ];

  it('enumerates every (SessionStatus | null) × isRunning combination', () => {
    expect(TABLE).toHaveLength((ALL_SESSION_STATUSES.length + 1) * 2);
  });

  it.each(TABLE)('sessionStatus=%s isRunning=%s → %s', (status, isRunning, expected) => {
    expect(deriveBranchStatus(status, isRunning)).toBe(expected);
  });

  it('collapses every status to idle when the session is not running', () => {
    for (const status of [...ALL_SESSION_STATUSES, null]) {
      expect(deriveBranchStatus(status, false)).toBe('idle');
    }
  });

  it('agrees with the live chain (activity flags → deriveCliStatus)', () => {
    // deriveBranchStatus must not become a parallel implementation: assert it
    // equals the composition the production code path actually performs.
    for (const status of ALL_SESSION_STATUSES) {
      const viaChain = deriveCliStatus({
        isRunning: true,
        ...sessionStatusToActivityFlags(status),
      });
      expect(deriveBranchStatus(status, true)).toBe(viaChain);
    }
  });
});

describe('table integrity — a wrong expectation is recorded as a failure', () => {
  // Guards against a vacuously-green table: if `it.each` silently passed on a
  // mismatched row, this deliberate mismatch would go unnoticed too.
  it('fails a row whose expected value is wrong', () => {
    expect(() => expect(deriveCliStatus(undefined)).toBe('running')).toThrow();
    expect(() => expect(sessionStatusToActivityFlags('waiting')).toEqual({
      isWaitingForResponse: false,
      isProcessing: false,
    })).toThrow();
    expect(() => expect(deriveBranchStatus('running', true)).toBe('idle')).toThrow();
    expect(() =>
      expect(
        deriveSessionStatus({
          isSessionRunning: false,
          isWaitingForResponse: false,
          isProcessing: false,
        })
      ).toBe('idle')
    ).toThrow();
  });
});

describe('single definition site (Issue #1550 acceptance)', () => {
  it('re-exports the same function object from @/types/sidebar', async () => {
    const sidebar = await import('@/types/sidebar');
    expect(sidebar.deriveCliStatus).toBe(deriveCliStatus);
  });
});
