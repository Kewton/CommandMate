/**
 * The Auto-Yes confirmation ledger's PR 2 entry points — the hook request, the
 * CLI mode, the API approval and `/prompt-response` — driven the way their
 * callers drive them (Issue #3820, design `docs/design/auto-yes-measurement-3820.md`
 * §2.3〜§2.6・§3.4, PR 2).
 *
 * The callers themselves are covered by the route / service / adjudication
 * suites; this one pins the lines each entry point writes.
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
  AUTO_YES_LEDGER_HOOK_LINK_WINDOW_MS,
  beginLedgerHookRequest,
  beginLedgerTick,
  closeLedgerHookRequest,
  decideLedgerHookRequest,
  endLedgerTick,
  getAutoYesLedgerErrorCountForTests,
  noteLedgerApiDecisionReplied,
  noteLedgerPollerStopped,
  observeLedgerCliMode,
  observeLedgerScreen,
  recordLedgerApiAdjudication,
  recordLedgerPromptResponse,
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
  setAutoYesLedgerFaultForTests,
  type LedgerScope,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';
import { beginEnterFallbackSession } from '@/lib/polling/auto-yes-enter-fallback-state';

const T0 = Date.UTC(2026, 9, 21, 10, 0, 0);
const SCOPE: LedgerScope = { worktreeId: 'wt-3820', cliToolId: 'claude', instanceId: 'claude' };
const API_SCOPE: LedgerScope = { worktreeId: 'wt-3820', cliToolId: 'opencode', instanceId: 'opencode' };

let now = T0;

const lines = (event: string): Array<Record<string, unknown>> =>
  mockLogger.info.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

/** One hook request on SCOPE, decided and replied to. */
function hookRequest(decision: Parameters<typeof decideLedgerHookRequest>[1], delivered = true): string | null {
  const id = beginLedgerHookRequest(SCOPE, now);
  now += 15;
  decideLedgerHookRequest(id, decision);
  now += 5;
  closeLedgerHookRequest(id, { delivered });
  return id;
}

const ALLOW = { outcome: 'allow', allowSuppressesDialog: true, promptType: 'multiple_choice' } as const;

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

describe('[#3820 PR 2] a hook request', () => {
  it('is the confirmation when an allow draws no dialog: answered by the reply, at L1', () => {
    const id = hookRequest(ALLOW);

    expect(lines(EV.hookRequestClosed)).toEqual([
      expect.objectContaining({ hookRequestId: id, outcome: 'allow', allowSuppressesDialog: true, replyMs: 20 }),
    ]);
    const [opened] = lines(EV.opened);
    expect(opened).toEqual(expect.objectContaining({ source: 'hook', hookRequestId: id, promptType: 'multiple_choice' }));
    expect(lines(EV.attemptSettled)).toEqual([
      expect.objectContaining({ confirmationId: opened.confirmationId, basis: 'L1', result: 'ok', late: false }),
    ]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({
        confirmationId: opened.confirmationId,
        source: 'hook',
        decision: 'answer',
        basis: 'L1',
        answeredAtClose: true,
        resolution: 'resolved-by-reply',
        resolvedBy: 'auto',
        intervals: 0,
        withheldMsTotal: 0,
      }),
    ]);
  });

  it('opens no confirmation for an allow that still draws the dialog (agy)', () => {
    hookRequest({ ...ALLOW, allowSuppressesDialog: false });

    expect(lines(EV.hookRequestClosed)).toEqual([
      expect.objectContaining({ outcome: 'allow', allowSuppressesDialog: false }),
    ]);
    expect(lines(EV.opened)).toHaveLength(0);
    expect(lines(EV.closed)).toHaveLength(0);
  });

  it.each(['policy-suppressed', 'auto-yes-disabled', 'ask-user-question'])(
    'closes an abstention (%s) when it replies, holding no waiting time and opening no confirmation',
    (reason) => {
      hookRequest({ outcome: 'abstained', abstainReason: reason, allowSuppressesDialog: true, promptType: 'multiple_choice' });

      expect(lines(EV.hookRequestClosed)).toEqual([
        expect.objectContaining({ outcome: 'abstained', abstainReason: reason }),
      ]);
      const closed = lines(EV.hookRequestClosed)[0];
      expect(Object.keys(closed)).not.toContain('withheldMs');
      expect(lines(EV.opened)).toHaveLength(0);
      expect(lines(EV.withholdStarted)).toHaveLength(0);
    },
  );

  it('leaves the waiting to the screen confirmation that follows an abstention, and marks it', () => {
    hookRequest({ outcome: 'abstained', abstainReason: 'policy-suppressed', allowSuppressesDialog: true, promptType: 'multiple_choice' });
    now += 1_000;
    const token = beginLedgerTick(SCOPE);
    observeLedgerScreen(SCOPE, 'screen-A', 'multiple_choice');
    endLedgerTick(SCOPE, token);

    expect(lines(EV.opened)).toEqual([
      expect.objectContaining({ source: 'screen', afterHookAbstain: 'policy-suppressed' }),
    ]);
    expect(lines(EV.opened)[0]).not.toHaveProperty('hookRequestId');
  });

  it('marks a screen confirmation soon after an allow as after it, as a separate confirmation', () => {
    hookRequest(ALLOW);
    now += AUTO_YES_LEDGER_HOOK_LINK_WINDOW_MS;
    const token = beginLedgerTick(SCOPE);
    observeLedgerScreen(SCOPE, 'screen-A', 'multiple_choice');
    endLedgerTick(SCOPE, token);

    const opened = lines(EV.opened);
    expect(opened).toHaveLength(2);
    expect(opened[1]).toEqual(expect.objectContaining({ source: 'screen', afterHookAllow: true }));
    expect(opened[1].confirmationId).not.toBe(opened[0].confirmationId);
  });

  it('does not mark a screen confirmation past the window', () => {
    hookRequest(ALLOW);
    now += AUTO_YES_LEDGER_HOOK_LINK_WINDOW_MS + 1;
    const token = beginLedgerTick(SCOPE);
    observeLedgerScreen(SCOPE, 'screen-A', 'multiple_choice');
    endLedgerTick(SCOPE, token);

    const screen = lines(EV.opened).filter((line) => line.source === 'screen');
    expect(screen).toHaveLength(1);
    expect(screen[0]).not.toHaveProperty('afterHookAllow');
    expect(screen[0]).not.toHaveProperty('afterHookAbstain');
  });

  it('records a reply the route could not write as decided as an abstention, and its allow unanswered', () => {
    hookRequest(ALLOW, false);

    expect(lines(EV.hookRequestClosed)).toEqual([
      expect.objectContaining({ outcome: 'abstained', abstainReason: 'error' }),
    ]);
    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'failed' })]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ answeredAtClose: false, resolution: 'unresolved-after-send', resolvedBy: 'unknown' }),
    ]);
  });

  it('records a request that named no known worktree, and opens nothing for it', () => {
    const id = beginLedgerHookRequest({ worktreeId: null, cliToolId: 'claude', instanceId: undefined }, now);
    decideLedgerHookRequest(id, { ...ALLOW, outcome: 'abstained', abstainReason: 'worktree-unresolved' });
    closeLedgerHookRequest(id, { delivered: true });

    expect(lines(EV.hookRequestClosed)).toEqual([
      expect.objectContaining({ outcome: 'abstained', abstainReason: 'worktree-unresolved' }),
    ]);
    expect(lines(EV.opened)).toHaveLength(0);
  });

  it('ignores a decision or a close for no request (the API adjudication passes none)', () => {
    decideLedgerHookRequest(undefined, ALLOW);
    closeLedgerHookRequest(undefined, { delivered: true });
    decideLedgerHookRequest(null, ALLOW);

    expect(mockLogger.info.mock.calls.filter(([name]) => String(name).startsWith('auto-yes-'))).toEqual([]);
  });
});

describe('[#3820 PR 2] the CLI mode a PermissionRequest states', () => {
  it('writes the first mode of a session, a change, and nothing for a repeat', () => {
    observeLedgerCliMode(SCOPE, 'default');
    observeLedgerCliMode(SCOPE, 'default');
    observeLedgerCliMode(SCOPE, 'acceptEdits');

    expect(lines(EV.cliModeObserved)).toEqual([
      expect.objectContaining({ worktreeId: 'wt-3820', instanceId: 'claude', mode: 'default', change: 'first' }),
      expect.objectContaining({ mode: 'acceptEdits', change: 'changed' }),
    ]);
  });

  it('starts again in a new session of the instance', () => {
    observeLedgerCliMode(SCOPE, 'default');
    beginEnterFallbackSession('wt-3820', 'claude', 'claude');
    observeLedgerCliMode(SCOPE, 'default');

    const observed = lines(EV.cliModeObserved);
    expect(observed.map((line) => line.change)).toEqual(['first', 'first']);
    expect(observed[1].sessionEpoch).not.toBe(observed[0].sessionEpoch);
  });

  it('writes a word that is not a mode as (other), never the text', () => {
    observeLedgerCliMode(SCOPE, 'rm -rf / && echo');

    expect(lines(EV.cliModeObserved)).toEqual([expect.objectContaining({ mode: '(other)' })]);
  });
});

describe('[#3820 PR 2] an approval CommandMate holds (opencode)', () => {
  const ADJ = { delivered: true, settled: true, promptType: 'multiple_choice' } as const;

  it('is one confirmation, answered and released by a delivered allow', () => {
    recordLedgerApiAdjudication(API_SCOPE, 'per_1', { ...ADJ, outcome: 'allow' });

    expect(lines(EV.opened)).toEqual([expect.objectContaining({ source: 'api', cliToolId: 'opencode' })]);
    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ basis: 'L1', result: 'ok' })]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ answeredAtClose: true, resolution: 'resolved-by-reply', resolvedBy: 'auto' }),
    ]);
    expect(lines(EV.hookRequestClosed)).toHaveLength(0);
  });

  it('counts an undelivered allow as a failed send, not an answer, and keeps it open', () => {
    recordLedgerApiAdjudication(API_SCOPE, 'per_1', { ...ADJ, outcome: 'allow', delivered: false, settled: false });

    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'failed' })]);
    expect(lines(EV.withholdStarted)).toEqual([expect.objectContaining({ reason: 'send-failed', source: 'api' })]);
    expect(lines(EV.closed)).toHaveLength(0);
  });

  it('continues the same confirmation on a re-adjudication, and a later delivery ends its interval', () => {
    recordLedgerApiAdjudication(API_SCOPE, 'per_1', {
      ...ADJ,
      outcome: 'abstained',
      withholdReason: 'deny-pattern',
      delivered: false,
      settled: false,
    });
    now += 30_000;
    recordLedgerApiAdjudication(API_SCOPE, 'per_1', { ...ADJ, outcome: 'allow' });

    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.withholdEnded)).toEqual([
      expect.objectContaining({ end: 'answered', lastReason: 'deny-pattern', withheldMs: 30_000 }),
    ]);
    expect(lines(EV.closed)).toEqual([expect.objectContaining({ resolution: 'resolved-by-reply', intervals: 1 })]);
  });

  it('withholds nothing for an abstention without a policy reason (Auto-Yes off)', () => {
    recordLedgerApiAdjudication(API_SCOPE, 'per_1', { ...ADJ, outcome: 'abstained', delivered: false, settled: false });

    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.withholdStarted)).toHaveLength(0);
  });

  it('closes on the agent’s reply when Auto-Yes did not settle it, by an unknown hand', () => {
    recordLedgerApiAdjudication(API_SCOPE, 'per_1', {
      ...ADJ,
      outcome: 'abstained',
      withholdReason: 'mode-off',
      delivered: false,
      settled: false,
    });
    noteLedgerApiDecisionReplied(API_SCOPE, 'per_1');
    noteLedgerApiDecisionReplied(API_SCOPE, 'per_1');

    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ resolution: 'resolved-while-withheld', resolvedBy: 'unknown' }),
    ]);
  });

  it('keeps an approval open when the poller stops looking at the screen', () => {
    recordLedgerApiAdjudication(API_SCOPE, 'per_1', { ...ADJ, outcome: 'abstained', delivered: false, settled: false });
    noteLedgerPollerStopped('wt-3820:opencode', 'manual');

    expect(lines(EV.presenceChanged)).toHaveLength(0);
    noteLedgerPollerStopped('wt-3820:opencode', 'session-killed');
    expect(lines(EV.closed)).toEqual([expect.objectContaining({ resolution: 'abandoned', abandonReason: 'session-killed' })]);
  });
});

describe('[#3820 PR 2] a /prompt-response answer', () => {
  it('records the browser’s Auto-Yes as basis browser, answered, by an unknown hand', () => {
    recordLedgerPromptResponse(SCOPE, { basis: 'browser', promptType: 'yes_no', result: 'ok' });

    expect(lines(EV.opened)).toEqual([expect.objectContaining({ source: 'prompt-response', promptType: 'yes_no' })]);
    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ basis: 'browser', result: 'ok' })]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ decision: 'answer', basis: 'browser', answeredAtClose: true, resolvedBy: 'unknown' }),
    ]);
  });

  it('records a person’s answer as theirs (human-ui), not as Auto-Yes deciding', () => {
    recordLedgerPromptResponse(SCOPE, { basis: 'human', promptType: 'multiple_choice', result: 'ok' });

    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ decision: 'none', basis: 'human', resolution: 'resolved-after-answer', resolvedBy: 'human-ui' }),
    ]);
  });

  it('never counts a failure as an answer, and opens no interval for it', () => {
    recordLedgerPromptResponse(SCOPE, { basis: 'browser', promptType: 'yes_no', result: 'failed' });

    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'failed' })]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ answeredAtClose: false, resolution: 'unresolved-after-send', resolvedBy: 'unknown', intervals: 0 }),
    ]);
    expect(lines(EV.withholdStarted)).toHaveLength(0);
  });

  it('leaves the screen confirmation of the same instance alone', () => {
    const token = beginLedgerTick(SCOPE);
    observeLedgerScreen(SCOPE, 'screen-A', 'yes_no');
    recordLedgerPromptResponse(SCOPE, { basis: 'human', promptType: 'yes_no', result: 'ok' });
    endLedgerTick(SCOPE, token);

    expect(lines(EV.closed)).toHaveLength(1);
    expect(lines(EV.closed)[0].source).toBe('prompt-response');
  });
});

describe('[#3820 PR 2] the new entry points never throw', () => {
  it('swallows and counts a fault in every one of them', () => {
    setAutoYesLedgerFaultForTests(new Error('injected'));
    expect(beginLedgerHookRequest(SCOPE, now)).toBeNull();
    expect(() => {
      decideLedgerHookRequest('x', ALLOW);
      closeLedgerHookRequest('x', { delivered: true });
      observeLedgerCliMode(SCOPE, 'default');
      recordLedgerApiAdjudication(API_SCOPE, 'per_1', { outcome: 'allow', delivered: true, settled: true, promptType: 'multiple_choice' });
      noteLedgerApiDecisionReplied(API_SCOPE, 'per_1');
      recordLedgerPromptResponse(SCOPE, { basis: 'human', promptType: 'yes_no', result: 'ok' });
    }).not.toThrow();
    setAutoYesLedgerFaultForTests(null);
    // The state did not exist yet, so nothing could be counted; the next use counts from zero.
    expect(getAutoYesLedgerErrorCountForTests()).toBe(0);
  });

  it('swallows a logger that throws', () => {
    hookRequest(ALLOW);
    const writes = mockLogger.info.mock.calls.length;
    mockLogger.info.mockImplementation(() => {
      throw new Error('logger down');
    });
    expect(() => hookRequest(ALLOW)).not.toThrow();
    expect(() => recordLedgerPromptResponse(SCOPE, { basis: 'human', promptType: 'yes_no', result: 'ok' })).not.toThrow();
    expect(mockLogger.info.mock.calls.length).toBeGreaterThan(writes);
    expect(getAutoYesLedgerErrorCountForTests()).toBeGreaterThan(0);
  });
});
