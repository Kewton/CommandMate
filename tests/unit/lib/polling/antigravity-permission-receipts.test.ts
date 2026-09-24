/**
 * The short-lived record of agy's `PreToolUse` questions (Issue #2849).
 *
 * The record answers one question for the Auto-Yes side — "did agy ask
 * CommandMate about a tool call for this instance a moment ago?" — so what is
 * pinned here is what makes that answer trustworthy: the window's edges, that
 * one instance's question never vouches for another's dialog, and that a
 * payload with no tool name leaves no record.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS,
  hasRecentAntigravityPermissionReceipt,
  recordAntigravityPermissionReceipt,
  resetAntigravityPermissionReceiptsForTests,
} from '@/lib/polling/antigravity-permission-receipts';

const WT = 'wt-2849';
const NOW = 1_800_000_000_000;

beforeEach(() => {
  resetAntigravityPermissionReceiptsForTests();
});

afterEach(() => {
  resetAntigravityPermissionReceiptsForTests();
});

describe('the window', () => {
  it('is 8 seconds: the hook timeout (5s) plus the capture lag', () => {
    expect(ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS).toBe(8_000);
  });

  it('has no receipt before anything was recorded', () => {
    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', undefined, NOW)).toBe(false);
  });

  it('counts a receipt made just now', () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', NOW);

    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', undefined, NOW)).toBe(true);
  });

  it('counts a receipt exactly at the window edge, and not a millisecond past it', () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', NOW);
    const edge = NOW + ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS;

    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', undefined, edge)).toBe(true);
    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', undefined, edge + 1)).toBe(false);
  });

  it('measures a default `now` against the clock', () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command');
    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity')).toBe(true);

    recordAntigravityPermissionReceipt(
      WT,
      'antigravity',
      'antigravity',
      'run_command',
      Date.now() - ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS - 1,
    );
    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity')).toBe(false);
  });
});

describe('one entry per instance', () => {
  it('keeps only the most recent question: a later one replaces an earlier one', () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', NOW);
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'write_to_file', NOW + 5_000);

    // The window runs from the LATER question…
    expect(
      hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', undefined, NOW + 12_000),
    ).toBe(true);
    // …and the earlier tool name is gone.
    expect(
      hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', NOW + 6_000),
    ).toBe(false);
    expect(
      hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'write_to_file', NOW + 6_000),
    ).toBe(true);
  });
});

describe('the tool name', () => {
  beforeEach(() => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', NOW);
  });

  it('is compared when the caller gives one', () => {
    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', NOW)).toBe(true);
    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'write_to_file', NOW)).toBe(false);
  });

  it('is not compared when the caller gives none: a frame carries no tool name', () => {
    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', undefined, NOW)).toBe(true);
  });

  it('still respects the window when it matches', () => {
    const late = NOW + ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS + 1;

    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', late)).toBe(false);
  });
});

describe('a payload with no tool name', () => {
  it('leaves no record', () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', null, NOW);

    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', undefined, NOW)).toBe(false);
  });

  it('does not refresh an earlier receipt either', () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', NOW);
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', null, NOW + 7_000);

    expect(
      hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', undefined, NOW + 9_000),
    ).toBe(false);
  });
});

describe('instances are kept apart', () => {
  it('does not let one instance vouch for another in the same worktree', () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity-2', 'run_command', NOW);

    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity-2', undefined, NOW)).toBe(true);
    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', undefined, NOW)).toBe(false);
    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity-3', undefined, NOW)).toBe(false);
  });

  it('does not let one worktree vouch for another', () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', NOW);

    expect(hasRecentAntigravityPermissionReceipt('wt-other', 'antigravity', 'antigravity', undefined, NOW)).toBe(false);
  });

  it('does not let another tool in the same worktree vouch for agy', () => {
    recordAntigravityPermissionReceipt(WT, 'claude', 'claude', 'run_command', NOW);

    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', undefined, NOW)).toBe(false);
  });

  it('spells the primary instance the same whether its id is given or omitted', () => {
    // The hook route records `instanceParam ?? tool`; the Auto-Yes poller carries
    // `undefined` for the primary. Both must land on one key.
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', NOW);

    expect(
      hasRecentAntigravityPermissionReceipt(WT, 'antigravity', undefined, undefined, NOW),
    ).toBe(true);
  });
});

describe('reset', () => {
  it('empties every entry', () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', NOW);
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity-2', 'run_command', NOW);

    resetAntigravityPermissionReceiptsForTests();

    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', undefined, NOW)).toBe(false);
    expect(hasRecentAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity-2', undefined, NOW)).toBe(false);
  });
});

describe('the hot-reload store', () => {
  it('lives on globalThis, so a second copy of the module reads what the first wrote', () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', NOW);

    expect(globalThis.__antigravityPermissionReceipts?.size).toBe(1);
  });
});
