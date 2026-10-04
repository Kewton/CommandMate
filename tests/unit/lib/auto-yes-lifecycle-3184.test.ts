/**
 * The Auto-Yes lifecycle table, one test per event (Issue #3184, design §8.5).
 *
 * Real state and real pollers: the pollers are started against the real
 * module with their timers faked, so nothing ever polls a pane.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AUTO_YES_LIFECYCLE,
  applyAutoYesStateRule,
  releaseAutoYes,
  stopAutoYesPollersFor,
  type AutoYesLifecycleEvent,
} from '@/lib/auto-yes-lifecycle';
import {
  buildCompositeKey,
  clearAllAutoYesStates,
  getAutoYesState,
  getAutoYesStateCompositeKeys,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import {
  clearAllPollerStates,
  getActivePollerCount,
  isPollerActive,
  startAutoYesPolling,
} from '@/lib/auto-yes-poller';

const WT = 'wt-3184-a';
const OTHER = 'wt-3184-b';

function arm(worktreeId: string, tool: 'claude' | 'codex', instanceId?: string): string {
  setAutoYesEnabled(worktreeId, tool, true, undefined, undefined, instanceId);
  const started = startAutoYesPolling(worktreeId, tool, instanceId);
  expect(started.started).toBe(true);
  return buildCompositeKey(worktreeId, tool, instanceId);
}

const exists = (key: string) => getAutoYesStateCompositeKeys().includes(key);

describe('AUTO_YES_LIFECYCLE (Issue #3184)', () => {
  let a1: string;
  let a2: string;
  let b1: string;

  beforeEach(() => {
    vi.useFakeTimers();
    clearAllAutoYesStates();
    clearAllPollerStates();
    a1 = arm(WT, 'claude');
    a2 = arm(WT, 'claude', 'claude-2');
    b1 = arm(OTHER, 'codex');
  });

  afterEach(() => {
    clearAllPollerStates();
    clearAllAutoYesStates();
    vi.useRealTimers();
  });

  it('has a rule for exactly the six events of the design', () => {
    expect(Object.keys(AUTO_YES_LIFECYCLE).sort()).toEqual([
      'consecutive-errors',
      'instance-removed',
      'orphan-swept',
      'server-shutdown',
      'session-killed',
      'worktree-deleted',
    ]);
  });

  it('session-killed: disables the instance with no reason (as #3188) and stops its poller', () => {
    releaseAutoYes('session-killed', { scope: 'instance', worktreeId: WT, cliToolId: 'claude', instanceId: 'claude-2' });

    const state = getAutoYesState(WT, 'claude', 'claude-2');
    expect(state?.enabled).toBe(false);
    expect(state?.stopReason).toBeUndefined();
    expect(isPollerActive(a2)).toBe(false);
    // Negative control: the primary and the other worktree keep running.
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(true);
    expect(isPollerActive(a1)).toBe(true);
    expect(isPollerActive(b1)).toBe(true);
  });

  it('instance-removed: deletes the instance’s entry and stops its poller', () => {
    releaseAutoYes('instance-removed', { scope: 'instance', worktreeId: WT, cliToolId: 'claude', instanceId: 'claude-2' });

    expect(exists(a2)).toBe(false);
    expect(isPollerActive(a2)).toBe(false);
    expect(exists(a1)).toBe(true);
    expect(isPollerActive(a1)).toBe(true);
  });

  it('worktree-deleted: deletes every entry of the worktree and stops its pollers', () => {
    releaseAutoYes('worktree-deleted', { scope: 'worktree', worktreeId: WT });

    expect(exists(a1)).toBe(false);
    expect(exists(a2)).toBe(false);
    expect(isPollerActive(a1)).toBe(false);
    expect(isPollerActive(a2)).toBe(false);
    expect(exists(b1)).toBe(true);
    expect(isPollerActive(b1)).toBe(true);
  });

  it('orphan-swept: deletes the one key, in two halves the sweep calls separately', () => {
    applyAutoYesStateRule('orphan-swept', { scope: 'key', compositeKey: a2 });
    expect(exists(a2)).toBe(false);
    expect(isPollerActive(a2)).toBe(true);

    stopAutoYesPollersFor('orphan-swept', { scope: 'key', compositeKey: a2 });
    expect(isPollerActive(a2)).toBe(false);
    expect(exists(a1)).toBe(true);
  });

  it('consecutive-errors: disables with consecutive_errors and stops the poller', () => {
    releaseAutoYes('consecutive-errors', { scope: 'key', compositeKey: a2 });

    const state = getAutoYesState(WT, 'claude', 'claude-2');
    expect(state?.enabled).toBe(false);
    expect(state?.stopReason).toBe('consecutive_errors');
    expect(isPollerActive(a2)).toBe(false);
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(true);
  });

  it('server-shutdown: stops every poller and leaves the in-memory state to the process', () => {
    releaseAutoYes('server-shutdown', { scope: 'all' });

    expect(getActivePollerCount()).toBe(0);
    expect(exists(a1)).toBe(true);
    expect(exists(b1)).toBe(true);
  });

  it('the poller’s own consecutive-errors path applies the same row (cycle-free copy)', () => {
    // auto-yes-poller cannot import the lifecycle module (that module reaches
    // the poller through the auto-yes-manager barrel), so it applies the row
    // itself. Pin both ends: the row, and the call that restates it.
    expect(AUTO_YES_LIFECYCLE['consecutive-errors']).toEqual({
      state: 'disable',
      stopReason: 'consecutive_errors',
      poller: 'stop',
    });
    const poller = readFileSync(path.resolve(__dirname, '../../../src/lib/auto-yes-poller.ts'), 'utf8');
    expect(poller).toMatch(/disableAutoYes\(worktreeId, cliToolId, 'consecutive_errors',/);
    expect(poller).not.toMatch(/from '\.\/auto-yes-lifecycle'/);
  });

  it.each(Object.keys(AUTO_YES_LIFECYCLE) as AutoYesLifecycleEvent[])(
    '%s: never throws for a target that holds nothing',
    (event) => {
      expect(() =>
        releaseAutoYes(event, { scope: 'instance', worktreeId: 'wt-3184-none', cliToolId: 'codex' }),
      ).not.toThrow();
    },
  );
});
