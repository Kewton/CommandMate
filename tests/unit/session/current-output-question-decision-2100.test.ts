/**
 * The published payload for an addressable QUESTION (Issue #2100).
 *
 * ## The invariant this Issue changes, deliberately
 *
 * #2031 held one biconditional over the whole payload:
 *
 *     decisionOptions published  ⇔  decisionId non-null
 *
 * It was right for the only kind of addressable decision that existed then. It
 * is wrong now, and holding it would have been the bug: the three verdicts are
 * an APPROVAL's replies, a question is answered with its own choices, and
 * `readPromptQuestionChoices` refuses to draw a picker the moment
 * `decisionOptions` is non-empty (#2039 gate 3). Publishing both for a question
 * would put `Allow once / Allow always / Reject` over the agent's own options,
 * and a verdict sent to a question is refused at the source
 * (`question-needs-answer-verdict`).
 *
 * So the invariant is now kind-aware, and this suite states it:
 *
 *     decisionId non-null  ⇔  an addressable decision exists
 *     decisionOptions      ⇔  that decision is an APPROVAL
 *
 * #2031's own suite is unchanged and still passes, because every case in it is
 * an approval.
 *
 * ## Why the assertions go through `readPromptQuestionChoices`
 *
 * That function is the browser's whole decision about whether to offer to
 * answer, and it applies three gates at once. Asserting the payload fields
 * separately can be satisfied by a payload the panel still refuses — which is
 * exactly the state #2100 found in production: every ingredient measured and
 * logged (`opencode-question-recorded {questionCount:1, optionCounts:[2]}`) and
 * the panel drawing nothing.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));
vi.mock('@/lib/db', () => ({
  getSessionState: vi.fn(() => null),
  createMessage: vi.fn(),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: vi.fn().mockResolvedValue(true) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-2100:opencode'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  clearAgentStopEvents,
  recordAgentEvent,
  recordAskUserQuestion,
  reportQuestionPending,
} from '@/lib/session/agent-event-state';
import {
  STRUCTURED_DECISION_OPTIONS,
  type StructuredPromptWaitingData,
} from '@/lib/session/structured-prompt';
import {
  readPromptDecisionId,
  readPromptQuestionChoices,
} from '@/components/worktree/prompt-decision-id';
import { OPENCODE_QUESTION_TOOL_NAME } from '@/lib/hooks/pending-decision-kind';
import { ASK_USER_QUESTION_TOOL } from '@/lib/hooks/permission-request-payload';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-2100';
const QUESTION_ID = 'que_03dc885bc001HI96F7K2i7q5c9';
const PERMISSION_ID = 'per_0000000000000000000000000';
const db = {} as Database.Database;
/** A frame the scraper reads as busy — it contributes no prompt of its own. */
const BUSY_FRAME = 'writing files\nediting src/app/page.tsx\n';

/** The spec `parseOpencodeQuestion` produces from a live `question.asked`. */
function spec(labels: string[] = ['alpha', 'beta'], count = 1): AskUserQuestionSpec {
  return {
    questions: Array.from({ length: count }, (_unused, index) => ({
      question: index === 0 ? 'Which option do you prefer?' : `Follow-up ${index}`,
      header: 'Preference',
      multiSelect: false,
      choices: labels.map((label) => ({ label, description: `Option ${label}` })),
    })),
    promptId: QUESTION_ID,
  };
}

/**
 * Everything `ingestOpencodeEvent` does for a `question.asked`, in the order it
 * does it. Driven through the two exported writers rather than the ingest so
 * this suite stays a statement about the PAYLOAD; the ingest's own wiring is
 * pinned in `tests/unit/hooks/sources/opencode-question-decision-2100.test.ts`.
 */
function openQuestion(
  cliToolId: CLIToolType,
  options: { decisionId?: string | null; labels?: string[]; count?: number } = {}
): void {
  const at = Date.now() - 1_000;
  const questionSpec = spec(options.labels, options.count);
  recordAgentEvent(WT, cliToolId, cliToolId, {
    event: 'notification',
    at,
    detail: 'question_prompt',
    sessionId: 'ses-1',
  });
  recordAskUserQuestion(WT, cliToolId, cliToolId, questionSpec, at);
  reportQuestionPending(
    WT,
    cliToolId,
    cliToolId,
    {
      toolName: OPENCODE_QUESTION_TOOL_NAME,
      decisionId: options.decisionId === undefined ? QUESTION_ID : options.decisionId,
      detail: 'question_prompt',
    },
    at
  );
}

/** An ordinary opencode approval, for the unchanged-behaviour cases. */
function openApproval(cliToolId: CLIToolType, decisionId?: string): void {
  recordAgentEvent(WT, cliToolId, cliToolId, {
    event: 'notification',
    at: Date.now() - 1_000,
    detail: 'permission_prompt',
    sessionId: 'ses-1',
    message: 'touch /tmp/marker.txt',
    ...(decisionId ? { decisionId } : {}),
  });
}

async function promptOf(cliToolId: CLIToolType): Promise<StructuredPromptWaitingData> {
  const payload = await buildCurrentOutput(db, WT, cliToolId, cliToolId);
  expect(payload.isPromptWaiting).toBe(true);
  return payload.promptData as StructuredPromptWaitingData;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
});

describe('an addressable question', () => {
  it('publishes the id and the choices, and no approval verdicts', async () => {
    openQuestion('opencode');
    const promptData = await promptOf('opencode');

    expect(promptData.decisionId).toBe(QUESTION_ID);
    expect(promptData.askUserQuestion).toEqual({
      question: 'Which option do you prefer?',
      labels: ['alpha', 'beta'],
      questionCount: 1,
    });
    // MUTATION TARGET. Dropping the `!addressesQuestion` conjunct from
    // `current-output-builder`'s `decisionOptions` puts the three approval
    // verdicts on a question, and #2039's third gate then refuses the picker —
    // so this and the `readPromptQuestionChoices` case below fail together,
    // which is the pair that has to be inseparable.
    expect(promptData.decisionOptions).toBeUndefined();
    // A question grants nothing that outlives it, so there is no `Allow always`
    // rule list to show the size of.
    expect(promptData.patterns).toBeUndefined();
    // #1725's safety property, untouched: nothing that answers a prompt by
    // typing an option number at a PANE may find one here.
    expect(promptData.options).toEqual([]);
  });

  it('is what the panel reads as an answerable picker', async () => {
    openQuestion('opencode');
    const promptData = await promptOf('opencode');

    expect(readPromptDecisionId(promptData)).toBe(QUESTION_ID);
    const choices = readPromptQuestionChoices(promptData);
    // The acceptance criterion, read through the browser's own function: two
    // labels, in payload order, because the POSITION is the answer that
    // `resolveStructuredQuestionAnswer` resolves a number against.
    expect(choices).toEqual({
      question: 'Which option do you prefer?',
      labels: ['alpha', 'beta'],
      questionCount: 1,
    });
  });

  it('names the real numbers in the one line every surface shows', async () => {
    openQuestion('opencode');
    const promptData = await promptOf('opencode');

    // `promptData.question` is rendered ABOVE the choice buttons. Before this
    // Issue it ended with Claude's warning — "read the option NUMBER off the
    // terminal rather than counting this list" — which contradicted the working
    // numbered buttons underneath it.
    expect(promptData.question).toContain('1 = alpha, 2 = beta');
    expect(promptData.question).not.toContain('The picker renumbers');
  });

  it('withholds the picker when the id is missing, rather than guessing', async () => {
    // The pre-#2100 state, reproduced: choices recorded, no id. A picker whose
    // submit has nothing to address is worse than the read-only list.
    openQuestion('opencode', { decisionId: null });
    const promptData = await promptOf('opencode');

    expect(promptData.decisionId).toBeNull();
    expect(promptData.askUserQuestion).toBeDefined();
    expect(readPromptQuestionChoices(promptData)).toBeNull();
    // And the guidance goes back to the screen-based warning, because the
    // numbers really are unanswerable in that state.
    expect(promptData.question).toContain('The picker renumbers');
  });

  it('withholds the picker for a multi-question call, id or no id', async () => {
    // `answers` is one array per question and a single click cannot say what
    // the others are, so `resolveStructuredQuestionAnswer` refuses the call —
    // a picker whose submit is a guaranteed 400 is worse than the list.
    openQuestion('opencode', { count: 2 });
    const promptData = await promptOf('opencode');

    expect(promptData.decisionId).toBe(QUESTION_ID);
    expect(promptData.askUserQuestion?.questionCount).toBe(2);
    expect(readPromptQuestionChoices(promptData)).toBeNull();
  });
});

describe('what this Issue is not allowed to change', () => {
  it('leaves an opencode APPROVAL publishing all three verdicts', async () => {
    openApproval('opencode', PERMISSION_ID);
    const promptData = await promptOf('opencode');

    expect(promptData.decisionId).toBe(PERMISSION_ID);
    expect(promptData.decisionOptions).toEqual(STRUCTURED_DECISION_OPTIONS);
    // The approval half of the gate: a verdict picker, never a question picker.
    expect(readPromptQuestionChoices(promptData)).toBeNull();
  });

  it('leaves an anonymous opencode approval publishing neither', async () => {
    openApproval('opencode');
    const promptData = await promptOf('opencode');

    expect(promptData.decisionId).toBeNull();
    expect(promptData.decisionOptions).toBeUndefined();
  });

  it("leaves Claude's AskUserQuestion payload byte-identical", async () => {
    // Claude's picker is read off the SCREEN. Its `PermissionRequest` forecast
    // carries no id, its source declares `eventIdentity: null`, and the option
    // numbers on screen are the picker's own — renumbered, with entries the
    // payload never mentioned (#1726 / #1708). None of that may change here.
    const at = Date.now() - 1_000;
    recordAskUserQuestion(WT, 'claude', 'claude', spec(['Red', 'Blue']), at);
    recordAgentEvent(WT, 'claude', 'claude', {
      event: 'notification',
      at,
      detail: 'permission_prompt',
      sessionId: 'ses-1',
      message: 'Claude needs your permission to use AskUserQuestion',
      toolName: ASK_USER_QUESTION_TOOL,
      // Passed deliberately: a hook source cannot set this, and the capability
      // gate must shut whatever the record says.
      decisionId: QUESTION_ID,
    });

    const promptData = await promptOf('claude');

    expect(promptData.decisionId).toBeNull();
    expect(promptData.decisionOptions).toBeUndefined();
    expect(readPromptQuestionChoices(promptData)).toBeNull();
    // The screen-based warning is Claude's, and it stays Claude's.
    expect(promptData.question).toContain('The picker renumbers');
    // The whole shape, not just the fields this Issue touched.
    expect(Object.keys(promptData).sort()).toEqual([
      'askUserQuestion',
      'decisionId',
      'message',
      'options',
      'question',
      'source',
      'status',
      'toolName',
      'type',
    ]);
  });
});
