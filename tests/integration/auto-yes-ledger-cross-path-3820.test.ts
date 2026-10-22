/**
 * The Auto-Yes confirmation ledger across its paths, end to end (Issue #3820,
 * design `docs/design/auto-yes-measurement-3820.md` §7 PR 5).
 *
 * Each case drives the real entry points the way a server would, in the order
 * an agent would reach them — the hook routes (`POST /api/hooks/permission-request`,
 * `POST /api/hooks/agent-event`), the poller's tick (`detectAndRespondToPrompt`
 * over live captures) and the API adjudication (`adjudicatePendingPermission`)
 * — and then reads what was recorded twice:
 *
 *  - the ledger's own log lines, written by the real logger in the production
 *    text format and caught on the console;
 *  - those same lines through the PR 4 daily count
 *    (`measureAutoYesObservation`), as "requests N · confirmations N ·
 *    intervals N · answers N".
 *
 * No server, tmux or agent runs: the screen is a captured frame, the send is a
 * mock, and the contract policy is a real task row in an in-memory SQLite.
 * Time is the faked `Date`; the ledger's hourly clock is driven by hand.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';

// Every module's logger is quiet except the ledger's, which is the real one.
const { quiet } = vi.hoisted(() => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() };
  logger.withContext.mockReturnValue(logger);
  return { quiet: logger };
});
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return {
    ...actual,
    createLogger: (name: string) => (name === 'auto-yes-confirmation-ledger' ? actual.createLogger(name) : quiet),
    generateRequestId: vi.fn(() => 'test-request-id'),
  };
});

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database | null): void;
}
vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database | null) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

// The poller's tick: the send and everything around it that would reach tmux,
// WebSocket or another server (as in `auto-yes-confirmation-ledger-agy-call-3820.test.ts`).
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
const sendPromptAnswer = vi.hoisted(() => vi.fn(async (_params: unknown) => {}));
vi.mock('@/lib/prompt-answer-sender', () => ({ sendPromptAnswer }));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn(), isSessionRunning: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (tool: string) => ({ getSessionName: (id: string) => `cm-${id}-${tool}`, name: tool }),
    }),
  },
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { createTask, upsertWorktree } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearAllPollerStates, detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { resetAntigravityPermissionReceiptsForTests } from '@/lib/polling/antigravity-permission-receipts';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { adjudicatePendingPermission } from '@/lib/hooks/permission-adjudication';
import { clearPermissionDecisions } from '@/lib/hooks/permission-decision-state';
import { recordDecisionDelivery, resetPendingDecisions } from '@/lib/hooks/sources/pending-decisions';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { toOpencodePendingPermission } from '@/lib/hooks/sources/opencode/payloads';
import type { AgentEventSource } from '@/lib/hooks/sources/types';
import {
  AUTO_YES_LEDGER_CLOCK_MS,
  resetAutoYesConfirmationLedgerForTests,
  runAutoYesLedgerHourForTests,
  setAutoYesLedgerClockTimersForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV, AUTO_YES_LEDGER_LOG_MODULE } from '@/lib/polling/auto-yes-confirmation-ledger-types';
import { measureAutoYesObservation } from '@/lib/agent-health/auto-yes-observation';
import { addLogLine, createLogAggregate, parseLogLine } from '@/lib/agent-health/metrics-perf';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-ledger-cross-3820';
const WT_PATH = process.cwd();
const ONE_HOUR_MS = 3_600_000;
const H = AUTO_YES_LEDGER_CLOCK_MS;

/** The daily count runs at 12:30; its window is the 24 hours to 12:00 (design §4.3). */
const NOW = new Date('2026-10-22T12:30:00.000Z');
/** Every case starts inside that window. */
const T0 = new Date('2026-10-22T09:10:00.000Z').getTime();

const read = (...parts: string[]): string => readFileSync(path.join(process.cwd(), ...parts), 'utf8');
/** A frame as the poller hands it to the tick: ANSI and box drawing stripped. */
const asPollerSees = (...parts: string[]): string => stripBoxDrawing(stripAnsi(read(...parts)));

/** agy (live, #2364): a Bash approval dialog, and the pane after it went. */
const AGY_DIALOG = asPollerSees('tests/fixtures/antigravity-live-2364/dialog-bash-wrapped.txt');
const AGY_IDLE = asPollerSees('tests/fixtures/antigravity-live-2364/idle-after-deny.txt');
/** claude (live, #1708): a Bash approval dialog, and an idle composer. */
const CLAUDE_DIALOG = asPollerSees('tests/unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt');
const CLAUDE_IDLE = asPollerSees('tests/unit/lib/detection/fixtures/claude-live-1708/idle-taskpanel.txt');

const AGY_PRE_TOOL_USE = JSON.parse(read('tests/fixtures/hooks/antigravity/pre-tool-use.json')) as Record<string, unknown>;
const AGY_CONVERSATION = AGY_PRE_TOOL_USE.conversationId as string;
const AGY_CALL = `${AGY_CONVERSATION}:${AGY_PRE_TOOL_USE.stepIdx as number}`;
const CLAUDE_PERMISSION_REQUEST = {
  ...(JSON.parse(read('tests/fixtures/hooks/claude/permission-request.json')) as Record<string, unknown>),
  cwd: WT_PATH,
};
const OPENCODE_PERMISSION_ASKED = JSON.parse(read('tests/fixtures/hooks/opencode/permission-asked.json')) as Record<string, unknown>;

let db: Database.Database | null = null;
/** The console lines the real logger wrote for the ledger, in order. */
let written: string[] = [];
/** One poller per instance, kept across ticks as the real loop keeps it. */
let pollers: Map<string, AutoYesPollerState>;

const at = (ms: number): void => {
  vi.setSystemTime(T0 + ms);
};

const asReq = (req: Request) => req as unknown as NextRequest;

async function permissionRequest(tool: CLIToolType, body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/hooks/permission-request/route');
  const response = await POST(
    asReq(
      new Request(`http://localhost/api/hooks/permission-request?tool=${tool}&worktreeId=${WT}&instanceId=${tool}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  );
  return { status: response.status, body: (await response.json()) as unknown };
}

/** agy's `PostToolUse` as `scripts/hooks/cmate-agent-event.sh` posts it. */
async function agyPostToolUse(stepIdx: number) {
  const { POST } = await import('@/app/api/hooks/agent-event/route');
  const response = await POST(
    asReq(
      new Request('http://localhost/api/hooks/agent-event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tool: 'antigravity',
          event: 'post_tool_use',
          worktreeId: WT,
          instanceId: 'antigravity',
          sessionId: AGY_CONVERSATION,
          detail: 'run_command',
          stepIdx,
        }),
      })
    )
  );
  return { status: response.status, body: (await response.json()) as unknown };
}

/** One poller tick over `clean` for the tool's primary instance. */
async function tick(tool: CLIToolType, clean: string): Promise<string> {
  let state = pollers.get(tool);
  if (state === undefined) {
    state = {
      timerId: null,
      cliToolId: tool,
      instanceId: tool,
      consecutiveErrors: 0,
      currentInterval: 2000,
      lastServerResponseTimestamp: null,
      lastAnsweredPromptKey: null,
      lastAnsweredAt: null,
      stopCheckBaselineLength: -1,
    };
    pollers.set(tool, state);
  }
  return detectAndRespondToPrompt(WT, state, tool, clean, clean.split('\n'), tool);
}

/** A running task whose contract sets Auto-Yes off for `tool`: the hook abstains and the poller withholds. */
function contractModeOff(tool: CLIToolType): void {
  createTask(db!, {
    worktreeId: WT,
    cliToolId: tool,
    instanceId: null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: a task
goal: do the thing
scope:
  allow: ["src/**"]
autoYes:
  mode: 'off'
`,
      'task.yaml'
    ),
    status: 'running',
  });
}

/** opencode's declared capabilities; its delivery lands without an HTTP call. */
const OPENCODE_DELIVERING: AgentEventSource = {
  ...opencodeAgentEventSource,
  decide: async (ref, decision) => {
    recordDecisionDelivery(ref, decision.id, { delivered: true, reason: 'delivered' });
  },
} as AgentEventSource;

/** The ledger's lines of `event`, parsed back off what the logger wrote. */
function lines(event: string): Array<Record<string, unknown>> {
  return written
    .map((raw) => parseLogLine(raw))
    .filter((line) => line !== null && line.name === `${AUTO_YES_LEDGER_LOG_MODULE} ${event}` && line.data !== null)
    .map((line) => JSON.parse(line!.data!) as Record<string, unknown>);
}

/** The ledger's hourly clock on every UTC hour boundary from the one after now to the window's end. */
function hoursToWindowEnd(): void {
  const end = Math.floor(NOW.getTime() / H) * H;
  for (let boundary = Math.ceil(Date.now() / H) * H; boundary <= end; boundary += H) {
    vi.setSystemTime(boundary);
    runAutoYesLedgerHourForTests(boundary);
  }
}

/** The PR 4 daily count over what the logger wrote. */
function dailyCount() {
  hoursToWindowEnd();
  const agg = createLogAggregate(NOW);
  for (const raw of written) addLogLine(agg, raw);
  const result = measureAutoYesObservation(agg.autoYes, agg);
  if (result.status !== 'ok') throw new Error(`auto-yes-observation skipped: ${result.status === 'skip' ? result.reason : ''}`);
  return result;
}

/** "requests N · confirmations N · intervals N · answers N" (and the details asked about besides). */
function countsOf(details: Record<string, unknown> | undefined) {
  const d = details ?? {};
  return {
    hookRequests: d.hookRequests,
    confirmations: d.confirmations,
    withheldIntervals: d.withheldIntervals,
    answered: d.answered,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.stubEnv('CM_LOG_LEVEL', 'info');
  vi.stubEnv('CM_LOG_FORMAT', 'text');
  written = [];
  const catchLedger = (line: unknown) => {
    if (typeof line === 'string' && line.includes(`[${AUTO_YES_LEDGER_LOG_MODULE}]`)) written.push(line);
  };
  vi.spyOn(console, 'log').mockImplementation(catchLedger);
  vi.spyOn(console, 'warn').mockImplementation(catchLedger);
  pollers = new Map();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  clearAgentStopEvents();
  clearPermissionDecisions();
  resetPendingDecisions();
  resetAntigravityPermissionReceiptsForTests();
  upsertWorktree(db, { id: WT, name: 'feature/3820', path: WT_PATH, repositoryPath: WT_PATH, repositoryName: 'fixture' });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  clearAgentStopEvents();
  clearPermissionDecisions();
  resetPendingDecisions();
  resetAntigravityPermissionReceiptsForTests();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('[#3820 PR 5] agy: request → dialog → answer → gone, end to end', () => {
  it('is one request and one confirmation tied to it by the call, no interval, and one answer in the count', async () => {
    setAutoYesEnabled(WT, 'antigravity', true, ONE_HOUR_MS);

    expect(await permissionRequest('antigravity', AGY_PRE_TOOL_USE)).toEqual({ status: 200, body: { decision: 'allow' } });
    at(1_000);
    expect(await tick('antigravity', AGY_DIALOG)).toBe('responded');
    at(3_000);
    expect(await tick('antigravity', AGY_IDLE)).toBe('no_prompt');
    at(4_000);
    expect((await agyPostToolUse(AGY_PRE_TOOL_USE.stepIdx as number)).status).toBe(202);

    const [request] = lines(EV.hookRequestClosed);
    expect(lines(EV.hookRequestClosed)).toEqual([
      expect.objectContaining({ cliToolId: 'antigravity', outcome: 'allow', allowSuppressesDialog: false, callId: AGY_CALL }),
    ]);
    expect(lines(EV.opened)).toEqual([
      expect.objectContaining({ source: 'screen', cliToolId: 'antigravity', callId: AGY_CALL, hookRequestId: request.hookRequestId }),
    ]);
    const [opened] = lines(EV.opened);
    expect(lines(EV.attemptSettled)).toEqual([
      expect.objectContaining({ confirmationId: opened.confirmationId, result: 'ok', late: false }),
    ]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({
        confirmationId: opened.confirmationId,
        resolution: 'resolved-after-answer',
        answeredAtClose: true,
        intervals: 0,
      }),
    ]);
    // The PostToolUse after the dialog had gone adds nothing.
    expect(lines(EV.hookRequestDialogUnobserved)).toHaveLength(0);

    const { details, records } = dailyCount();
    expect(countsOf(details)).toEqual({ hookRequests: 1, confirmations: 1, withheldIntervals: 0, answered: 1 });
    expect(details).toMatchObject({ hookAllowed: 1, hookAbstained: 0, dialogUnobserved: 0, resolvedAfterAnswer: 1, lostOnRestart: 0 });
    expect(records).toContainEqual(expect.objectContaining({ kind: 'answered', tool: 'antigravity', count: 1 }));
  });
});

describe('[#3820 PR 5] claude: the three ways a hook request meets the screen (N2)', () => {
  it('"allow only": one request, which is the one confirmation, answered by the reply', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);

    expect(await permissionRequest('claude', CLAUDE_PERMISSION_REQUEST)).toEqual({
      status: 200,
      body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } },
    });
    // No dialog follows.
    at(2_000);
    expect(await tick('claude', CLAUDE_IDLE)).toBe('no_prompt');

    const [request] = lines(EV.hookRequestClosed);
    expect(request).toEqual(expect.objectContaining({ cliToolId: 'claude', outcome: 'allow', allowSuppressesDialog: true }));
    expect(lines(EV.opened)).toEqual([expect.objectContaining({ source: 'hook', hookRequestId: request.hookRequestId })]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ source: 'hook', basis: 'L1', resolution: 'resolved-by-reply', resolvedBy: 'auto' }),
    ]);

    const { details } = dailyCount();
    expect(countsOf(details)).toEqual({ hookRequests: 1, confirmations: 1, withheldIntervals: 0, answered: 1 });
    expect(details).toMatchObject({ hookAllowed: 1, resolvedByReply: 1, resolvedByAuto: 1 });
  });

  it('"the screen after an abstention": one request with no time, one confirmation with one interval', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);
    contractModeOff('claude');

    expect(await permissionRequest('claude', CLAUDE_PERMISSION_REQUEST)).toEqual({ status: 200, body: {} });
    at(1_000);
    expect(await tick('claude', CLAUDE_DIALOG)).toBe('no_answer');
    at(3_000);
    expect(await tick('claude', CLAUDE_DIALOG)).toBe('no_answer');
    // A human answers at the terminal; the dialog goes.
    at(5_000);
    expect(await tick('claude', CLAUDE_IDLE)).toBe('no_prompt');

    expect(lines(EV.hookRequestClosed)).toEqual([
      expect.objectContaining({ outcome: 'abstained', abstainReason: 'policy-suppressed' }),
    ]);
    expect(lines(EV.opened)).toEqual([
      expect.objectContaining({ source: 'screen', afterHookAbstain: 'policy-suppressed' }),
    ]);
    expect(lines(EV.withholdStarted)).toEqual([expect.objectContaining({ reason: 'mode-off', startedAtMs: T0 + 1_000 })]);
    expect(lines(EV.withholdEnded)).toEqual([expect.objectContaining({ end: 'gone', withheldMs: 4_000 })]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ resolution: 'resolved-while-withheld', resolvedBy: 'unknown', intervals: 1 }),
    ]);

    const { details, records } = dailyCount();
    expect(countsOf(details)).toEqual({ hookRequests: 1, confirmations: 1, withheldIntervals: 1, answered: 0 });
    // The wait is the screen confirmation's alone: not counted again for the request.
    expect(details).toMatchObject({ hookAbstained: 1, withheldMsTotal: 4_000 });
    expect(records).toContainEqual({ kind: 'hook-abstained', tool: 'claude', reason: 'policy-suppressed', count: 1 });
  });

  it('"another dialog after an allow": one request, two confirmations — the hook’s and the screen’s afterHookAllow', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);

    await permissionRequest('claude', CLAUDE_PERMISSION_REQUEST);
    // claude's own safety check right after the allow, which the poller answers.
    at(1_000);
    expect(await tick('claude', CLAUDE_DIALOG)).toBe('responded');
    at(3_000);
    expect(await tick('claude', CLAUDE_IDLE)).toBe('no_prompt');

    const [request] = lines(EV.hookRequestClosed);
    expect(lines(EV.opened)).toEqual([
      expect.objectContaining({ source: 'hook', hookRequestId: request.hookRequestId }),
      expect.objectContaining({ source: 'screen', afterHookAllow: true }),
    ]);
    // Not asserted to be the same call: the screen's confirmation names no request.
    expect(lines(EV.opened)[1]).not.toHaveProperty('hookRequestId');
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ source: 'hook', resolution: 'resolved-by-reply' }),
      expect.objectContaining({ source: 'screen', resolution: 'resolved-after-answer', resolvedBy: 'unknown' }),
    ]);
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);

    const { details } = dailyCount();
    expect(countsOf(details)).toEqual({ hookRequests: 1, confirmations: 2, withheldIntervals: 0, answered: 2 });
  });
});

describe('[#3820 PR 5] the API adjudication makes no hook request (N2)', () => {
  it('an opencode approval is one confirmation and no hook request', async () => {
    setAutoYesEnabled(WT, 'opencode', true, ONE_HOUR_MS);

    const outcome = await adjudicatePendingPermission(
      OPENCODE_DELIVERING,
      { worktreeId: WT, cliToolId: 'opencode', instanceId: 'opencode' },
      toOpencodePendingPermission(OPENCODE_PERMISSION_ASKED, Date.now())!,
      opencodeAgentEventSource.parsePermissionRequest(OPENCODE_PERMISSION_ASKED)
    );

    expect(outcome).toEqual(expect.objectContaining({ behavior: 'allow', delivered: true, settled: true }));
    expect(lines(EV.hookRequestClosed)).toHaveLength(0);
    expect(lines(EV.opened)).toEqual([expect.objectContaining({ source: 'api', cliToolId: 'opencode' })]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ basis: 'L1', resolution: 'resolved-by-reply', resolvedBy: 'auto' }),
    ]);

    const { details } = dailyCount();
    expect(countsOf(details)).toEqual({ hookRequests: 0, confirmations: 1, withheldIntervals: 0, answered: 1 });
  });
});

describe('[#3820 PR 5] a human answers first', () => {
  it('(hook) before the dialog reaches the screen: one abstained request with no time, no confirmation', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);
    contractModeOff('claude');

    expect(await permissionRequest('claude', CLAUDE_PERMISSION_REQUEST)).toEqual({ status: 200, body: {} });
    // The human answered before the poller's next tick: it never sees the dialog.
    at(2_000);
    expect(await tick('claude', CLAUDE_IDLE)).toBe('no_prompt');

    expect(lines(EV.hookRequestClosed)).toEqual([
      expect.objectContaining({ outcome: 'abstained', abstainReason: 'policy-suppressed' }),
    ]);
    expect(lines(EV.opened)).toHaveLength(0);

    const { details, records } = dailyCount();
    expect(countsOf(details)).toEqual({ hookRequests: 1, confirmations: 0, withheldIntervals: 0, answered: 0 });
    expect(details).toMatchObject({ hookAbstained: 1, withheldMsTotal: 0, withheldMsMax: null });
    // A count, never a time (design §2.3: neither 0 seconds nor any other).
    expect(records).toContainEqual({ kind: 'hook-abstained', tool: 'claude', reason: 'policy-suppressed', count: 1 });
  });

  it('(screen) while the confirmation is withheld: resolved-while-withheld, by nobody known', async () => {
    contractModeOff('claude');

    at(0);
    expect(await tick('claude', CLAUDE_DIALOG)).toBe('no_answer');
    at(2_000);
    expect(await tick('claude', CLAUDE_DIALOG)).toBe('no_answer');
    at(4_000);
    expect(await tick('claude', CLAUDE_IDLE)).toBe('no_prompt');

    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ resolution: 'resolved-while-withheld', resolvedBy: 'unknown', answeredAtClose: false }),
    ]);

    const { details } = dailyCount();
    expect(countsOf(details)).toEqual({ hookRequests: 0, confirmations: 1, withheldIntervals: 1, answered: 0 });
    expect(details).toMatchObject({ resolvedWhileWithheld: 1, resolvedByUnknown: 1, withheldMsTotal: 4_000 });
  });
});

describe('[#3820 PR 5] an end event that never comes', () => {
  it('agy "No": no PostToolUse — the confirmation closes when the dialog goes', async () => {
    setAutoYesEnabled(WT, 'antigravity', true, ONE_HOUR_MS);
    contractModeOff('antigravity');

    // agy's abstention: it draws its own dialog.
    expect(await permissionRequest('antigravity', AGY_PRE_TOOL_USE)).toEqual({ status: 200, body: { decision: 'ask' } });
    at(1_000);
    expect(await tick('antigravity', AGY_DIALOG)).toBe('no_answer');
    // The human chooses "No": the dialog goes, and agy sends no PostToolUse (nor Stop).
    at(3_000);
    expect(await tick('antigravity', AGY_IDLE)).toBe('no_prompt');

    const [request] = lines(EV.hookRequestClosed);
    expect(request).toEqual(expect.objectContaining({ outcome: 'abstained', abstainReason: 'policy-suppressed', callId: AGY_CALL }));
    expect(lines(EV.opened)).toEqual([
      expect.objectContaining({ source: 'screen', callId: AGY_CALL, hookRequestId: request.hookRequestId }),
    ]);
    expect(lines(EV.withholdEnded)).toEqual([expect.objectContaining({ end: 'gone' })]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ resolution: 'resolved-while-withheld', resolvedBy: 'unknown' }),
    ]);
    expect(lines(EV.hookRequestDialogUnobserved)).toHaveLength(0);

    const { details } = dailyCount();
    expect(countsOf(details)).toEqual({ hookRequests: 1, confirmations: 1, withheldIntervals: 1, answered: 0 });
    expect(details).toMatchObject({ confirmationsClosed: 1, openAtWindowEnd: 0, lostOnRestart: 0, dialogUnobserved: 0 });
  });

  it('a server restart: no closed line — lostOnRestart, with the time up to the last checkpoint', async () => {
    contractModeOff('claude');

    expect(await tick('claude', CLAUDE_DIALOG)).toBe('no_answer');
    // 10:00: the hour's checkpoint of the open confirmation (50 minutes withheld).
    vi.setSystemTime(T0 + 50 * 60_000);
    runAutoYesLedgerHourForTests(T0 + 50 * 60_000);
    expect(lines(EV.checkpoint)).toEqual([expect.objectContaining({ intervalMs: 50 * 60_000 })]);
    // 10:20: the process goes — the ledger's memory with it.
    vi.setSystemTime(T0 + 70 * 60_000);
    resetAutoYesConfirmationLedgerForTests();
    clearAllPollerStates();
    pollers = new Map();

    expect(lines(EV.closed)).toHaveLength(0);
    const { details } = dailyCount();
    expect(countsOf(details)).toEqual({ hookRequests: 0, confirmations: 1, withheldIntervals: 1, answered: 0 });
    expect(details).toMatchObject({ lostOnRestart: 1, openAtWindowEnd: 0, confirmationsClosed: 0, withheldMsTotal: 50 * 60_000 });
    // The new process has its own boot.
    expect(new Set(lines(EV.started).map((line) => line.bootId)).size).toBe(2);
  });
});
