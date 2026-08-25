/**
 * `capture --json` learning what a worker has spent and what it is being asked
 * (Issue #2040).
 *
 * `structuredEvents` could say what a session was *doing* and nothing about what
 * it had *cost*, and its `pendingDecisions` said a human was blocked without
 * saying on what — an orchestrate loop reading it cannot tell "waiting on `rm
 * -rf`" from "waiting to be told which colour", and answers those two completely
 * differently.
 *
 * Both additions are **additive**, which is the property the acceptance
 * criterion names and the one this file spends most of its assertions on: the
 * existing keys of a pending-decision entry keep their type, their meaning and
 * their presence, because `.claude/skills/orchestrate-monitor`'s parsers read
 * this payload in an unbounded loop.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: (...args: unknown[]) => isRunning(...args) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:opencode'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  clearAgentStopEvents,
  recordAgentEvent,
  recordAskUserQuestion,
  reportPermissionRequestPending,
} from '@/lib/session/agent-event-state';
import {
  recordAgentSessionTelemetry,
  resetAgentSessionTelemetry,
} from '@/lib/hooks/agent-session-telemetry';
import { OPENCODE_QUESTION_TOOL_NAME } from '@/lib/hooks/pending-decision-kind';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';

const db = {} as Database.Database;

/** The two-choice question the fixtures publish, in parsed form. */
const COLOUR_QUESTION: AskUserQuestionSpec = {
  promptId: null,
  questions: [
    {
      question: 'Which colour do you prefer?',
      header: 'Colour preference',
      multiSelect: false,
      choices: [
        { label: 'Red', description: 'The colour red' },
        { label: 'Blue', description: 'The colour blue' },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  resetAgentSessionTelemetry();
  isRunning.mockResolvedValue(true);
  vi.mocked(captureSessionOutput).mockResolvedValue('some agent output\n');
});

afterEach(() => {
  resetAgentSessionTelemetry();
  clearAgentStopEvents();
});

describe('structuredEvents.session', () => {
  it('is null on every session nothing has reported one for', async () => {
    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');

    // Present-and-null, not absent: `capture --json | jq '.structuredEvents.session'`
    // has to answer "nothing knows" rather than nothing at all.
    expect(payload.structuredEvents).toHaveProperty('session');
    expect(payload.structuredEvents.session).toBeNull();
  });

  it('publishes what the agent reported, verbatim', async () => {
    recordAgentSessionTelemetry(
      { worktreeId: 'wt-1', cliToolId: 'opencode', instanceId: 'opencode' },
      {
        id: 'ses_abc',
        title: 'Fix the flaky test',
        agent: 'build',
        model: 'claude-sonnet-4.6',
        provider: 'github-copilot',
        cost: 0.4213,
        tokens: {
          input: 120,
          output: 30,
          reasoning: 0,
          cacheRead: 4096,
          cacheWrite: 512,
          total: null,
        },
        at: 1_700_000_000_000,
      },
    );

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');

    // Nothing rounds the cost or prettifies the model: a reader compares these
    // against what the agent says about itself.
    expect(payload.structuredEvents.session).toEqual({
      id: 'ses_abc',
      title: 'Fix the flaky test',
      agent: 'build',
      model: 'claude-sonnet-4.6',
      provider: 'github-copilot',
      cost: 0.4213,
      tokens: {
        input: 120,
        output: 30,
        reasoning: 0,
        cacheRead: 4096,
        cacheWrite: 512,
        total: null,
      },
      at: 1_700_000_000_000,
    });
  });

  it('keeps the record of one instance out of the record of another', async () => {
    recordAgentSessionTelemetry(
      { worktreeId: 'wt-1', cliToolId: 'opencode', instanceId: 'opencode-2' },
      {
        id: 'ses_second',
        title: null,
        agent: null,
        model: null,
        provider: null,
        cost: 9,
        tokens: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null },
        at: 1,
      },
    );

    const primary = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    const second = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode-2');

    expect(primary.structuredEvents.session).toBeNull();
    expect(second.structuredEvents.session?.id).toBe('ses_second');
  });
});

describe('pendingDecisions[].kind', () => {
  it('reads an ordinary approval as a permission and adds nothing else', async () => {
    reportPermissionRequestPending('wt-1', 'opencode', 'opencode', 'bash', Date.now());

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    const [entry] = payload.structuredEvents.pendingDecisions ?? [];

    expect(entry.kind).toBe('permission');
    // A question's list is not invented for an approval: the three verdicts are
    // the SOURCE's and are published as `promptData.decisionOptions`.
    expect(entry.questionOptions).toBeNull();
  });

  it('reads the opencode question marker as a question and quotes its choices', async () => {
    reportPermissionRequestPending(
      'wt-1',
      'opencode',
      'opencode',
      OPENCODE_QUESTION_TOOL_NAME,
      Date.now(),
    );
    recordAskUserQuestion('wt-1', 'opencode', 'opencode', COLOUR_QUESTION, Date.now());

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    const [entry] = payload.structuredEvents.pendingDecisions ?? [];

    expect(entry.kind).toBe('question');
    // The numbers are the PAYLOAD's order, which is what `respond <id> <n>`
    // resolves against — not a screen's.
    expect(entry.questionOptions).toEqual([
      { number: 1, label: 'Red' },
      { number: 2, label: 'Blue' },
    ]);
  });

  it('reads the AskUserQuestion tool as a question too', async () => {
    // The same recovery, on the tool that raises a real `PermissionRequest` for
    // its picker. Both writers mark the record; this is the second marker.
    reportPermissionRequestPending('wt-1', 'claude', 'claude', 'AskUserQuestion', Date.now());
    recordAskUserQuestion('wt-1', 'claude', 'claude', COLOUR_QUESTION, Date.now());

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');
    const [entry] = payload.structuredEvents.pendingDecisions ?? [];

    expect(entry.kind).toBe('question');
    expect(entry.questionOptions).toHaveLength(2);
  });

  it('does not lend a live question payload to an approval sitting beside it', async () => {
    // The case that separates "the kind decides" from "an episode exists". A
    // question is in flight AND an approval is open on the same instance — which
    // opencode really does (#1758 §5.4/§5.5 are two events on one stream) — and
    // only the question entry may quote the choices. An approval whose
    // `questionOptions` said `Red / Blue` would invite a caller to answer `1` at
    // a dialog whose `1` means `Allow once`.
    //
    // Two records need two identities: an anonymous report merges with another
    // anonymous one (`openDecision`), which is why the approval here arrives the
    // way opencode's does — as a `notification` carrying its own `per_…`.
    //
    // The approval is recorded FIRST, and that ordering is the model's rather
    // than this test's convenience: an identified report with no record of its
    // own adopts the anonymous prediction that forecast it, so an approval
    // arriving after the question would merge into the question's record.
    const now = Date.now();
    recordAgentEvent('wt-1', 'opencode', 'opencode', {
      event: 'notification',
      at: now,
      detail: 'permission_prompt',
      sessionId: null,
      decisionId: 'per_1111111111111111111111111',
      toolName: 'bash',
    });
    reportPermissionRequestPending('wt-1', 'opencode', 'opencode', OPENCODE_QUESTION_TOOL_NAME, now);
    recordAskUserQuestion('wt-1', 'opencode', 'opencode', COLOUR_QUESTION, now);

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    const entries = payload.structuredEvents.pendingDecisions ?? [];

    expect(entries).toHaveLength(2);
    const question = entries.find((entry) => entry.toolName === OPENCODE_QUESTION_TOOL_NAME);
    const approval = entries.find((entry) => entry.toolName === 'bash');
    expect(question?.kind).toBe('question');
    expect(question?.questionOptions).toHaveLength(2);
    expect(approval?.kind).toBe('permission');
    expect(approval?.questionOptions).toBeNull();
  });

  it('says question with no options when the payload is no longer held', async () => {
    // The marker outlives the episode (they expire on different rules), and a
    // list quoted from nothing would number choices the agent never sent.
    reportPermissionRequestPending(
      'wt-1',
      'opencode',
      'opencode',
      OPENCODE_QUESTION_TOOL_NAME,
      Date.now(),
    );

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    const [entry] = payload.structuredEvents.pendingDecisions ?? [];

    expect(entry.kind).toBe('question');
    expect(entry.questionOptions).toBeNull();
  });
});

describe('the addition is additive', () => {
  it('leaves every pre-#2040 key of a decision entry unchanged', async () => {
    reportPermissionRequestPending('wt-1', 'opencode', 'opencode', 'bash', Date.now());

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    const [entry] = payload.structuredEvents.pendingDecisions ?? [];

    // The keys `.claude/skills/orchestrate-monitor` and `wait` were already
    // reading, each with its pre-#2040 type. Stated as a whole object rather
    // than key by key so a REMOVAL fails here as loudly as a retype would.
    expect(entry).toMatchObject({
      id: null,
      at: expect.any(Number),
      source: 'permission-request',
      toolName: 'bash',
      confirmedAt: null,
      scraperCorroborated: false,
      deliveryExpired: expect.any(Boolean),
    });
    // …and exactly two keys more than that, so the payload cannot grow a third
    // without this file being read again.
    expect(Object.keys(entry).sort()).toEqual([
      'at',
      'confirmedAt',
      'deliveryExpired',
      'id',
      'kind',
      'questionOptions',
      'scraperCorroborated',
      'source',
      'toolName',
    ]);
  });
});
