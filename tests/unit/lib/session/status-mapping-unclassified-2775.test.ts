/**
 * `status-mapping`'s half of Issue #2775: an unclassified `running` raises no
 * activity flag, and `isUnclassifiedCliStatus` is the one reader of the flag the
 * server publishes instead.
 *
 * The pre-#2775 table (`sessionStatusToActivityFlags` with one argument) is
 * re-stated literally below as the byte-identity bar: every existing caller
 * passes one argument, and none of them may see a different answer.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { SessionStatus } from '@/lib/detection/status-detector';
import {
  deriveBranchStatus,
  deriveCliStatus,
  isUnclassifiedCliStatus,
  sessionStatusToActivityFlags,
  type CliToolStatusFlags,
} from '@/lib/session/status-mapping';

describe('[#2775] sessionStatusToActivityFlags', () => {
  const PRE_2775: ReadonlyArray<[SessionStatus, boolean, boolean]> = [
    ['idle', false, false],
    ['ready', false, false],
    ['running', false, true],
    ['waiting', true, false],
  ];

  it.each(PRE_2775)('%s without the second argument is unchanged', (status, waiting, processing) => {
    expect(sessionStatusToActivityFlags(status)).toEqual({
      isWaitingForResponse: waiting,
      isProcessing: processing,
    });
    expect(sessionStatusToActivityFlags(status, false)).toEqual({
      isWaitingForResponse: waiting,
      isProcessing: processing,
    });
  });

  it('an unclassified running raises no activity flag', () => {
    expect(sessionStatusToActivityFlags('running', true)).toEqual({
      isWaitingForResponse: false,
      isProcessing: false,
    });
  });

  it.each(['idle', 'ready', 'waiting'] as const)(
    'the flag is ignored for %s (it can only be true for running)',
    (status) => {
      expect(sessionStatusToActivityFlags(status, true)).toEqual(sessionStatusToActivityFlags(status));
    },
  );

  it('does not change deriveBranchStatus, which has no reason to read', () => {
    expect(deriveBranchStatus('running', true)).toBe('running');
  });
});

describe('[#2775] isUnclassifiedCliStatus', () => {
  const triple = (
    isRunning: boolean,
    isWaitingForResponse: boolean,
    isProcessing: boolean,
    isUnclassified?: boolean,
  ): CliToolStatusFlags => ({
    isRunning,
    isWaitingForResponse,
    isProcessing,
    ...(isUnclassified === undefined ? {} : { isUnclassified }),
  });

  const ROWS: ReadonlyArray<[string, CliToolStatusFlags | undefined, boolean]> = [
    ['no entry', undefined, false],
    ['an unclassified session on its own', triple(true, false, false, true), true],
    ['a plain ready (no key)', triple(true, false, false), false],
    ['a ready with the key false', triple(true, false, false, false), false],
    // A reading outranks "cannot tell": a structured waiting, or a working
    // sibling folded into the same per-tool aggregate.
    ['unclassified but waiting', triple(true, true, false, true), false],
    ['unclassified but processing (aggregate)', triple(true, false, true, true), false],
    ['unclassified but not running', triple(false, false, false, true), false],
  ];

  it.each(ROWS)('%s → %s', (_name, entry, expected) => {
    expect(isUnclassifiedCliStatus(entry)).toBe(expected);
  });

  it('deriveCliStatus never reads the flag — the five-value vocabulary is unchanged', () => {
    expect(deriveCliStatus(triple(true, false, false, true))).toBe('ready');
    expect(deriveCliStatus(triple(true, false, true, true))).toBe('running');
    expect(deriveCliStatus(triple(true, true, false, true))).toBe('waiting');
    expect(deriveCliStatus(triple(false, false, false, true))).toBe('idle');
  });
});
