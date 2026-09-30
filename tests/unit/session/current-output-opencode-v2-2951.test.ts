/**
 * What `GET /current-output` (and so `capture --json`) publishes for OpenCode
 * V2's approvals and questions (Issue #2951).
 *
 *  - an approval's `decisionOptions` are in v2's own words — `Allow once /
 *    Always allow / Reject` — while v1's stay `Allow once / Allow always /
 *    Reject`; numbers and wire replies are the same for both;
 *  - a question whose field takes a typed answer carries `custom: true` to the
 *    browser, which is what makes the panel and the phone sheet offer an input.
 *
 * The harness is `current-output-question-decision-2100.test.ts`'s.
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
    getInstance: () => ({ getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning: vi.fn().mockResolvedValue(true) }) }),
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

describe('an approval, in the words of the tool that asked', () => {
  it('OpenCode V2 publishes `Allow once / Always allow / Reject`', async () => {
    openApproval('opencode-v2', PERMISSION_ID);
    const promptData = await promptOf('opencode-v2');

    expect(promptData.decisionId).toBe(PERMISSION_ID);
    expect(promptData.decisionOptions).toEqual([
      { number: 1, label: 'Allow once', reply: 'once' },
      { number: 2, label: 'Always allow', reply: 'always' },
      { number: 3, label: 'Reject', reply: 'reject' },
    ]);
  });

  it('v1 is unchanged', async () => {
    openApproval('opencode', PERMISSION_ID);
    const promptData = await promptOf('opencode');

    expect(promptData.decisionOptions).toBe(STRUCTURED_DECISION_OPTIONS);
    expect(promptData.decisionOptions?.map((option) => option.label)).toEqual([
      'Allow once',
      'Allow always',
      'Reject',
    ]);
  });
});

describe('a question that takes a typed answer', () => {
  function openCustomQuestion(custom: boolean): void {
    const at = Date.now() - 1_000;
    const questionSpec = spec();
    if (custom) questionSpec.questions[0].custom = true;
    recordAgentEvent(WT, 'opencode-v2', 'opencode-v2', {
      event: 'notification',
      at,
      detail: 'question_prompt',
      sessionId: 'ses-1',
    });
    recordAskUserQuestion(WT, 'opencode-v2', 'opencode-v2', questionSpec, at);
    reportQuestionPending(
      WT,
      'opencode-v2',
      'opencode-v2',
      { toolName: OPENCODE_QUESTION_TOOL_NAME, decisionId: QUESTION_ID, detail: 'question_prompt' },
      at
    );
  }

  it('carries `custom: true` to the browser, and the panel reads it', async () => {
    openCustomQuestion(true);
    const promptData = await promptOf('opencode-v2');

    expect(promptData.askUserQuestion).toEqual({
      question: 'Which option do you prefer?',
      labels: ['alpha', 'beta'],
      questionCount: 1,
      custom: true,
    });
    expect(readPromptQuestionChoices(promptData)).toMatchObject({ custom: true });
  });

  it('carries no `custom` for a question that does not take one', async () => {
    openCustomQuestion(false);
    const promptData = await promptOf('opencode-v2');

    expect(promptData.askUserQuestion).not.toHaveProperty('custom');
    expect(readPromptQuestionChoices(promptData)).not.toHaveProperty('custom');
    expect(readPromptDecisionId(promptData)).toBe(QUESTION_ID);
  });
});
