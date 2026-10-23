/**
 * The ledger's records split out of `auto-yes-confirmation-ledger.ts`
 * (Issue #3848): the helpers over the state, the writing of one line, and the
 * public names the ledger still exports from its own path.
 *
 * Positive control: before the split `auto-yes-ledger-records.ts` did not
 * exist, so this file fails to import it. Negative controls: the ledger module
 * re-exports the very same constants, and a line written through the ledger's
 * entry point still carries `ledgerVersion` and `bootId`.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const ledgerLog = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('@/lib/logger', () => {
  const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, withContext: () => quiet };
  const make = (module: string) => {
    if (module !== 'auto-yes-confirmation-ledger') return quiet;
    const logger = { ...quiet, info: ledgerLog.info, withContext: () => logger };
    return logger;
  };
  return { createLogger: make, generateRequestId: () => 'req' };
});

import {
  AUTO_YES_LEDGER_CLOCK_MS,
  AUTO_YES_LEDGER_HOOK_LINK_WINDOW_MS,
  AUTO_YES_LEDGER_MAX_OPEN_PER_INSTANCE,
  AUTO_YES_LEDGER_MAX_OPEN_TOTAL,
  AUTO_YES_LEDGER_RECORDED_PATHS,
  AUTO_YES_LEDGER_UNOBSERVABLE_TIMEOUT_MS,
  callKey,
  callsOf,
  currentEntry,
  emit,
  endedCallsOf,
  keyOf,
  rememberBounded,
  type LedgerEntry,
  type LedgerState,
} from '@/lib/polling/auto-yes-ledger-records';
import * as ledger from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_LOG_MODULE, AUTO_YES_LEDGER_VERSION } from '@/lib/polling/auto-yes-confirmation-ledger-types';

function bareState(): LedgerState {
  return {
    bootId: 'boot1234',
    startedAt: 0,
    nextConfirmation: 0,
    entries: new Map(),
    apiDecisions: new Map(),
    nextHookRequest: 0,
    hookRequests: new Map(),
    lastHookRequest: new Map(),
    cliModes: new Map(),
    current: new Map(),
    ticks: new Map(),
    nextTick: 0,
    pending: new Map(),
    errors: 0,
    lastAliveAt: null,
    clock: null,
  };
}

afterEach(() => {
  ledgerLog.info.mockReset();
  ledger.resetAutoYesConfirmationLedgerForTests();
});

describe('auto-yes-ledger-records (Issue #3848)', () => {
  it('keyOf uses the given compositeKey, else builds it from the ids', () => {
    expect(keyOf({ worktreeId: 'wt', cliToolId: 'claude', instanceId: undefined, compositeKey: 'given' })).toBe('given');
    expect(keyOf({ worktreeId: 'wt', cliToolId: 'claude', instanceId: undefined })).toBe('wt:claude');
    expect(keyOf({ worktreeId: 'wt', cliToolId: 'claude', instanceId: 'claude' })).toBe('wt:claude');
  });

  it('callKey joins the key and the call with a NUL', () => {
    expect(callKey('wt:antigravity', 'conv:3')).toBe('wt:antigravity\u0000conv:3');
  });

  it('callsOf / endedCallsOf create the maps an older state lacks, and keep them', () => {
    const state = bareState();
    expect(state.calls).toBeUndefined();
    const calls = callsOf(state);
    expect(state.calls).toBe(calls);
    expect(callsOf(state)).toBe(calls);
    const ended = endedCallsOf(state);
    expect(state.endedCalls).toBe(ended);
    expect(endedCallsOf(state)).toBe(ended);
  });

  it('currentEntry reads the screen confirmation of the instance, or nothing', () => {
    const state = bareState();
    expect(currentEntry(state, 'wt:claude')).toBeUndefined();
    const entry = { id: 'boot1234-1' } as LedgerEntry;
    state.entries.set(entry.id, entry);
    state.current.set('wt:claude', entry.id);
    expect(currentEntry(state, 'wt:claude')).toBe(entry);
    state.current.set('wt:codex', 'gone');
    expect(currentEntry(state, 'wt:codex')).toBeUndefined();
  });

  it('rememberBounded drops the oldest past max, and a re-set key becomes the newest', () => {
    const map = new Map<string, number>();
    rememberBounded(map, 'a', 1, 2);
    rememberBounded(map, 'b', 2, 2);
    rememberBounded(map, 'a', 3, 2);
    expect([...map.entries()]).toEqual([['b', 2], ['a', 3]]);
    rememberBounded(map, 'c', 4, 2);
    expect([...map.entries()]).toEqual([['a', 3], ['c', 4]]);
  });

  it('emit writes the line with ledgerVersion and bootId on the ledger logger', () => {
    const state = bareState();
    emit(state, 'test.event', { atMs: 5 } as never);
    expect(ledgerLog.info).toHaveBeenCalledWith('test.event', {
      ledgerVersion: AUTO_YES_LEDGER_VERSION,
      bootId: 'boot1234',
      atMs: 5,
    });
    expect(AUTO_YES_LEDGER_LOG_MODULE).toBe('auto-yes-confirmation-ledger');
    expect(state.errors).toBe(0);
  });

  it('emit counts a logger that throws and does not pass it on', () => {
    const state = bareState();
    ledgerLog.info.mockImplementationOnce(() => {
      throw new Error('logger down');
    });
    expect(() => emit(state, 'test.event', { atMs: 5 } as never)).not.toThrow();
    expect(state.errors).toBe(1);
  });

  it('the ledger module re-exports the same constants', () => {
    expect(ledger.AUTO_YES_LEDGER_RECORDED_PATHS).toBe(AUTO_YES_LEDGER_RECORDED_PATHS);
    expect(ledger.AUTO_YES_LEDGER_HOOK_LINK_WINDOW_MS).toBe(AUTO_YES_LEDGER_HOOK_LINK_WINDOW_MS);
    expect(ledger.AUTO_YES_LEDGER_CLOCK_MS).toBe(AUTO_YES_LEDGER_CLOCK_MS);
    expect(ledger.AUTO_YES_LEDGER_UNOBSERVABLE_TIMEOUT_MS).toBe(AUTO_YES_LEDGER_UNOBSERVABLE_TIMEOUT_MS);
    expect(ledger.AUTO_YES_LEDGER_MAX_OPEN_PER_INSTANCE).toBe(AUTO_YES_LEDGER_MAX_OPEN_PER_INSTANCE);
    expect(ledger.AUTO_YES_LEDGER_MAX_OPEN_TOTAL).toBe(AUTO_YES_LEDGER_MAX_OPEN_TOTAL);
  });

  it('a line written through the ledger still goes through emit (started, then opened)', () => {
    ledger.recordLedgerPromptResponse(
      { worktreeId: 'wt', cliToolId: 'claude', instanceId: undefined },
      { basis: 'human', promptType: 'yes_no', result: 'ok' },
    );
    const events = ledgerLog.info.mock.calls.map((call) => call[0] as string);
    expect(events.length).toBeGreaterThan(1);
    for (const [, fields] of ledgerLog.info.mock.calls) {
      expect(fields).toMatchObject({ ledgerVersion: AUTO_YES_LEDGER_VERSION, bootId: expect.any(String) });
    }
    expect(ledger.getAutoYesLedgerErrorCountForTests()).toBe(0);
  });
});
