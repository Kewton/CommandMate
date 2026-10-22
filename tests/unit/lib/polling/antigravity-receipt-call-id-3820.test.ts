/**
 * The call a receipt names, kept for the Auto-Yes ledger (Issue #3820, design
 * `docs/design/auto-yes-measurement-3820.md` §2.4, PR 3): the receipt record
 * holds the `callId` of agy's `PreToolUse`, and the episode the gate accepted
 * returns the `callId` of the receipt it accepted. Recording only — the
 * verdicts are pinned not to change with it.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAntigravityPermissionReceiptCallId,
  recordAntigravityPermissionReceipt,
  resetAntigravityPermissionReceiptsForTests,
} from '@/lib/polling/antigravity-permission-receipts';
import {
  beginAntigravityFrameRead,
  endAntigravityFrameRead,
  getAntigravityAcceptedReceiptCallId,
  judgeAntigravityPermissionReceipt,
} from '@/lib/polling/antigravity-receipt-episodes';

const WT = 'wt-3820-receipt-call';
const T0 = Date.UTC(2026, 9, 22, 10, 0, 0);

/** One bracketed poller read at `now` that sees a dialog candidate. */
function readWithDialog(now: number) {
  beginAntigravityFrameRead(WT, undefined, now);
  const verdict = judgeAntigravityPermissionReceipt(WT, undefined, now);
  endAntigravityFrameRead(WT, undefined, now);
  return verdict;
}

/** One bracketed poller read at `now` that sees nothing. */
function readClear(now: number): void {
  beginAntigravityFrameRead(WT, undefined, now);
  endAntigravityFrameRead(WT, undefined, now);
}

beforeEach(() => resetAntigravityPermissionReceiptsForTests());
afterEach(() => resetAntigravityPermissionReceiptsForTests());

describe('[#3820 PR 3] the receipt record keeps the call', () => {
  it('stores the call the PreToolUse named, per instance, latest first', () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', T0, 'conv:25');
    expect(getAntigravityPermissionReceiptCallId(WT, 'antigravity', undefined)).toBe('conv:25');
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', T0 + 1, 'conv:27');
    expect(getAntigravityPermissionReceiptCallId(WT, 'antigravity', 'antigravity')).toBe('conv:27');
    expect(getAntigravityPermissionReceiptCallId(WT, 'antigravity', 'antigravity-2')).toBeNull();
  });

  it('keeps no call for a receipt recorded the old way (negative control)', () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', T0);
    expect(getAntigravityPermissionReceiptCallId(WT, 'antigravity', undefined)).toBeNull();
  });
});

describe('[#3820 PR 3] the accepted episode returns its receipt’s call', () => {
  it('returns the call of the receipt it accepted, for as long as the episode lasts', () => {
    readClear(T0);
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', T0 + 100, 'conv:25');
    expect(readWithDialog(T0 + 2_000).ok).toBe(true);
    expect(getAntigravityAcceptedReceiptCallId(WT, undefined)).toBe('conv:25');
    // Past the window the dialog is still the same episode.
    readWithDialog(T0 + 5_000);
    expect(getAntigravityAcceptedReceiptCallId(WT, undefined)).toBe('conv:25');
  });

  it('forgets it when the episode ends (a read with no dialog)', () => {
    readClear(T0);
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', T0 + 100, 'conv:25');
    readWithDialog(T0 + 2_000);
    readClear(T0 + 4_000);
    expect(getAntigravityAcceptedReceiptCallId(WT, undefined)).toBeNull();
  });

  it('moves to the newer call when a newer receipt replaces the dialog with no clear read between', () => {
    readClear(T0);
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', T0 + 100, 'conv:25');
    readWithDialog(T0 + 2_000);
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', T0 + 3_000, 'conv:27');
    expect(readWithDialog(T0 + 4_000).ok).toBe(true);
    expect(getAntigravityAcceptedReceiptCallId(WT, undefined)).toBe('conv:27');
  });

  it('returns none for an episode that was not accepted, and the verdict is the same with or without a call', () => {
    readClear(T0);
    // A dialog with no receipt at all: `never`.
    expect(readWithDialog(T0 + 1_000)).toEqual(expect.objectContaining({ ok: false, cause: 'never' }));
    expect(getAntigravityAcceptedReceiptCallId(WT, undefined)).toBeNull();

    // The same accepted read, with and without a call on the receipt.
    const verdicts = [null, 'conv:25'].map((callId) => {
      resetAntigravityPermissionReceiptsForTests();
      readClear(T0);
      recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', T0 + 100, callId);
      return readWithDialog(T0 + 2_000);
    });
    expect(verdicts[1]).toEqual(verdicts[0]);
  });
});
