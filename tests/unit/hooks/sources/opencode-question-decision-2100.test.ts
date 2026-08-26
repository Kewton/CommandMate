/**
 * The question's id and its choices, kept all the way to the retained record
 * (Issue #2100).
 *
 * ## What was measured, and how it differed from the Issue's hypothesis
 *
 * The Issue proposed that opencode 1.18.22 delivered a question through two
 * different routes — `question.asked` (carrying an id) and a
 * `permission-request` shape (carrying none) — and that the second was what the
 * browser saw. **That is not what happens.** Driven live on 1.18.23 in an
 * isolated `HOME` (`docs/design/opencode-server-live-verification.md` §27.3),
 * three question calls produced the same three frames every time:
 *
 * ```
 * message.part.updated  tool=question status=pending    -> no word
 * question.asked        id=que_… questions=[…]          -> notification / question_prompt
 * message.part.updated  tool=question status=running    -> pre_tool_use / "question"
 * ```
 *
 * The last two land in the **same millisecond**. There is one arrival route,
 * and it carries the id. `promptData.source` read `permission-request` because
 * the ingest *stamped* it that way: it called `reportPermissionRequestPending`,
 * whose whole contract is a forecast with no id and a 20-second bound.
 *
 * So two independent defects, both pinned below:
 *
 *  1. **the id was discarded** — parsed into `spec.promptId` and then dropped,
 *     so the record was anonymous and the record's own `source` said the dialog
 *     was merely predicted. That record also expired after 20 s, while the
 *     agent waits forever (no `session.idle` arrives at all — measured §27.4).
 *  2. **the choices were deleted 1 ms later** — the tool part for the SAME call
 *     hit `applyAskUserQuestionTransition`'s "the agent moved on to another
 *     tool" rule, because opencode names its tool `question` and the rule tested
 *     Claude's `AskUserQuestion` alone.
 *
 * Each defect on its own is enough to leave `readPromptQuestionChoices()`
 * returning null, which is why both are asserted here rather than through the
 * payload alone.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  },
}));
mockLogger.withContext.mockReturnValue(mockLogger);

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));
vi.mock('@/lib/hooks/permission-decision-service', () => ({
  resolvePermissionRequest: vi.fn(() => ({ behavior: null, reason: 'auto-yes-disabled' })),
  PERMISSION_DECISION_SLOW_MS: 500,
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({}) as never) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn(() => null) }));
vi.mock('@/lib/hooks/agent-event-service', () => ({
  applyAgentStopEvent: vi
    .fn()
    .mockResolvedValue({ taskId: null, taskEventApplied: false, verificationRunId: null }),
}));
// The phone notification #2045 raises from this ingest. Stubbed so the suite
// never reaches the push subsystem; what it is called with is not this Issue's.
vi.mock('@/lib/hooks/sources/opencode/push', () => ({
  notifyOpencodeQuestionPush: vi.fn().mockResolvedValue(undefined),
  notifyOpencodeSessionErrorPush: vi.fn().mockResolvedValue(undefined),
}));

import { ingestOpencodeEvent } from '@/lib/hooks/sources/opencode/ingest';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import {
  clearAgentStopEvents,
  getAskUserQuestion,
  getPendingDecisions,
  getStructuredPromptWaiting,
} from '@/lib/session/agent-event-state';
import { pendingDecisionKind } from '@/lib/hooks/pending-decision-kind';
import { DIALOG_PENDING_MAX_MS } from '@/lib/session/provisional-turn';
import { resetPendingDecisions, type NormalizedAgentEvent } from '@/lib/hooks/sources';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');
const NOW = 1_800_000_000_000;
const TARGET = { worktreeId: 'wt-2100', cliToolId: 'opencode', instanceId: 'opencode' } as const;
/** The `properties.id` of `question-asked.json`. */
const QUESTION_ID = 'que_0000000000000000000000000';

function frame(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

function normalized(name: string, receivedAt: number = NOW): NormalizedAgentEvent {
  const event = opencodeAgentEventSource.normalizeEvent({ payload: frame(name), receivedAt });
  if (!event) throw new Error(`fixture ${name} did not normalise`);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  resetPendingDecisions();
});

describe('the frame pair a live question actually produces', () => {
  it('maps the tool part to `pre_tool_use` / `question` — the frame that used to erase the choices', () => {
    // Not an assumption about the fixture: this is the mapping that makes the
    // release rule below reachable at all. If a future opencode stopped
    // publishing a tool part for `question`, this fails and the exemption in
    // `applyAskUserQuestionTransition` becomes dead rather than load-bearing.
    const part = normalized('message-part-updated-question-running-2100');
    expect(part.event).toBe('pre_tool_use');
    expect(part.detail).toBe('question');

    const asked = normalized('question-asked');
    expect(asked.event).toBe('notification');
    expect(asked.detail).toBe('question_prompt');
  });
});

describe('the id reaches the retained record', () => {
  it('opens the dialog under the question id, not anonymously', async () => {
    await ingestOpencodeEvent(TARGET, normalized('question-asked'));

    const decisions = getPendingDecisions('wt-2100', 'opencode', 'opencode', NOW);
    expect(decisions).toHaveLength(1);
    // MUTATION TARGET. Putting `decisionId: null` back on the
    // `reportQuestionPending` call in `./opencode/ingest` — which is what
    // `reportPermissionRequestPending` hard-codes — fails here, and then again
    // in every payload assertion in
    // `tests/unit/session/current-output-question-decision-2100.test.ts`.
    expect(decisions[0].decisionId).toBe(QUESTION_ID);
    // The kind marker #2040 recovers from, unchanged: the same tool name is
    // still what tells an approval from a question.
    expect(pendingDecisionKind(decisions[0].toolName)).toBe('question');
  });

  it('records the dialog as PROVED, so it outlives the 20 s forecast bound', async () => {
    await ingestOpencodeEvent(TARGET, normalized('question-asked'));

    const waiting = getStructuredPromptWaiting('wt-2100', 'opencode', 'opencode', NOW);
    // `permission-request` would mean "a dialog is about to be drawn".
    // `question.asked` is the agent saying one IS drawn.
    expect(waiting).toMatchObject({ source: 'notification', confirmedAt: NOW });

    // The regression this Issue found and the Issue text did not have. An
    // unconfirmed record is bounded at `DIALOG_PENDING_MAX_MS.predicted`;
    // measured live, `pendingDecisions` emptied at t+20 s and `sessionStatus`
    // went back to `ready` with the question still on screen — and opencode
    // publishes no `session.idle` at all while one is pending (§27.4), so
    // nothing would ever have re-opened it.
    const pastForecastBound = NOW + DIALOG_PENDING_MAX_MS.predicted + 1_000;
    expect(
      getPendingDecisions('wt-2100', 'opencode', 'opencode', pastForecastBound)
    ).toHaveLength(1);
  });
});

describe('the choices survive the tool part that arrives with them', () => {
  it('keeps the recorded question when the SAME call publishes its running part', async () => {
    await ingestOpencodeEvent(TARGET, normalized('question-asked'));
    // Same millisecond on the wire; +1 here only so the two are ordered.
    await ingestOpencodeEvent(
      TARGET,
      normalized('message-part-updated-question-running-2100', NOW + 1)
    );

    // MUTATION TARGET. Narrowing `applyAskUserQuestionTransition`'s
    // `pre_tool_use` exemption back to `ASK_USER_QUESTION_TOOL` alone fails
    // here — and ONLY here among the opencode suites, which is why this case
    // exists separately from the id one above.
    const episode = getAskUserQuestion('wt-2100', 'opencode', 'opencode', NOW + 2);
    expect(episode?.spec.questions[0].choices.map((choice) => choice.label)).toEqual([
      'Red',
      'Blue',
    ]);
    expect(episode?.spec.promptId).toBe(QUESTION_ID);
  });

  it('still releases the question when the agent really does move to another tool', async () => {
    await ingestOpencodeEvent(TARGET, normalized('question-asked'));
    await ingestOpencodeEvent(TARGET, normalized('message-part-updated-tool-running', NOW + 1));

    // `bash`, not `question`. The rule the exemption narrows must go on
    // applying to every other tool, or a stale question would keep supplying
    // option text to a screen that has moved on.
    expect(getAskUserQuestion('wt-2100', 'opencode', 'opencode', NOW + 2)).toBeNull();
  });

  it('releases both the question and the dialog when the answer completes the call', async () => {
    await ingestOpencodeEvent(TARGET, normalized('question-asked'));
    await ingestOpencodeEvent(
      TARGET,
      normalized('message-part-updated-question-running-2100', NOW + 1)
    );
    // `post_tool_use` for the question's own call — the frame opencode emits in
    // the same millisecond as `question.replied`, measured §27.3. This is what
    // retires the record after the browser or the CLI answers, and it must
    // still do so now that the record is confirmed and 30-minute bounded.
    await ingestOpencodeEvent(TARGET, normalized('message-part-updated-tool-completed', NOW + 2));

    expect(getAskUserQuestion('wt-2100', 'opencode', 'opencode', NOW + 3)).toBeNull();
    expect(getPendingDecisions('wt-2100', 'opencode', 'opencode', NOW + 3)).toEqual([]);
  });
});
