/**
 * One agy dialog, ONE reading — now across all four consumers (Issue #2368).
 *
 * `antigravity-dialog-producers-2364.test.ts` drove three of them (the status
 * payload, the stored `prompt` row, the push excerpt) and found them agreeing.
 * The fourth was never in that table, and it was the one that had drifted: the
 * Auto-Yes poller still called the generic `detectPrompt`, so on agy's wrapped
 * Bash approval it read `isPrompt: false` and typed nothing, while the other
 * three published the same frame as a waiting four-option prompt. Measured
 * live: five seconds to answer a two-option file creation, 70+ seconds of
 * silence on the four-option command approval.
 *
 * So this file is the same table with the missing column filled in, and every
 * column is the REAL producer:
 *
 * | column           | what it is                                                       |
 * |------------------|------------------------------------------------------------------|
 * | status           | `detectSessionStatus` — `/current-output`, the chat surface, `wait`|
 * | response poller  | `detectPromptWithOptions` — the stored `prompt` row and its push  |
 * | prompt-response  | the route's #161 re-verification — PromptPanel Submit, `respond`  |
 * | Auto-Yes         | `detectAndRespondToPrompt` — the keys an unattended run sends     |
 *
 * The last two are driven end to end (the real `POST` handler, the real poller)
 * and read through the `promptData` each hands to `sendPromptAnswer`, because
 * the keystroke is the only place a disagreement actually costs anything.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { NextRequest } from 'next/server';
import type { PromptData } from '@/types/models';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string; promptData?: PromptData }) => {});
vi.mock('@/lib/prompt-answer-sender', async (importOriginal) => {
  // `PromptAnswerRejectedError` is caught by name in the route, so the real
  // class has to survive the mock; only the send is replaced.
  const actual = await importOriginal<typeof import('@/lib/prompt-answer-sender')>();
  return {
    ...actual,
    sendPromptAnswer: (params: unknown) =>
      sendPromptAnswer(params as { answer: string; promptData?: PromptData }),
  };
});

const captured = vi.fn<() => string>(() => '');
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(async () => captured()),
  captureSessionOutputFresh: vi.fn(async () => captured()),
  isSessionRunning: vi.fn(async () => true),
}));

vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
  broadcastTerminalSnapshot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({
        name: 'Antigravity',
        isRunning: async () => true,
        getSessionName: (worktreeId: string, instanceId?: string) =>
          `cm-${worktreeId}-${instanceId ?? 'antigravity'}`,
      }),
    }),
  },
}));
// The structured layer (#1898) answers over the agent's own API and returns
// before any keystroke. Declined here so the KEYSTROKE path — the one that
// reads the frame — is the path under test.
vi.mock('@/lib/hooks/structured-decision-response', () => ({
  answerStructuredDecision: vi.fn().mockResolvedValue({
    kind: 'not-applicable',
    reason: 'no-pending-decision',
  }),
}));
vi.mock('@/lib/session/agent-event-state', () => ({ getAskUserQuestion: vi.fn(() => null) }));

import { POST as promptResponse } from '@/app/api/worktrees/[id]/prompt-response/route';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { detectPromptWithOptions } from '@/lib/polling/response-checker';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { upsertWorktree } from '@/lib/db';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';

const WT = 'wt-2368-producers';
const FIXTURE_DIR = path.resolve(__dirname, '../../../fixtures/antigravity-live-2364');
const frame = (name: string): string => readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8');

/** The capture as `captureAndCleanOutput` hands it to the Auto-Yes poller. */
const asPollerSees = (raw: string): string => stripBoxDrawing(stripAnsi(raw));

/** The three fields every surface branches on, from a multiple_choice prompt. */
function shapeOf(promptData: PromptData | null | undefined): unknown {
  if (promptData?.type !== 'multiple_choice') return promptData?.type ?? null;
  const { question, options, instructionText } = promptData;
  return {
    question,
    options: options.map((o) => ({ number: o.number, label: o.label, isDefault: o.isDefault })),
    instructionText,
  };
}

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'antigravity',
    instanceId: 'antigravity',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** The `promptData` the last `sendPromptAnswer` call was given. */
function sentPromptData(): PromptData | null {
  const last = sendPromptAnswer.mock.calls.at(-1);
  return (last?.[0].promptData as PromptData | undefined) ?? null;
}

function postRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

/** Column 3: the route's #161 re-verification, driven end to end. */
async function promptResponseVerdict(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await promptResponse(
    postRequest({ answer: '1', cliTool: 'antigravity' }),
    { params: Promise.resolve({ id: WT }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: 'agy-2368',
    path: '/tmp/agy-2368',
    branch: 'feature/2368',
    repositoryPath: '/tmp/agy-2368-repo',
    repositoryName: 'agy-2368-repo',
    cliToolId: 'antigravity',
  });
  vi.clearAllMocks();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
});

afterEach(() => {
  clearPolicySuppressions();
  db.close();
});

describe.each([
  { name: 'dialog-create-file', question: 'Allow creation of this file?', optionCount: 2 },
  { name: 'dialog-bash-wrapped', question: 'Do you want to proceed?', optionCount: 4 },
])('[#2368] $name — all four consumers read one frame', ({ name, question, optionCount }) => {
  it('the status verdict is an answerable prompt', () => {
    const status = detectSessionStatus(frame(name), 'antigravity');

    expect(status.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(status.hasActivePrompt).toBe(true);
    expect(status.promptDetection.promptData?.type).toBe('multiple_choice');
    expect(status.promptDetection.promptData?.question).toBe(question);
    if (status.promptDetection.promptData?.type !== 'multiple_choice') throw new Error('shape');
    expect(status.promptDetection.promptData.options).toHaveLength(optionCount);
  });

  it('the response poller reads the same prompt', () => {
    const detection = detectPromptWithOptions(frame(name), 'antigravity');

    expect(detection.isPrompt).toBe(true);
    expect(detection.promptData?.question).toBe(question);
    if (detection.promptData?.type !== 'multiple_choice') throw new Error('shape');
    expect(detection.promptData.options).toHaveLength(optionCount);
  });

  it('the prompt-response route verifies it and sends the answer', async () => {
    captured.mockReturnValue(frame(name));

    const { status, body } = await promptResponseVerdict();

    // The #2364 symptom on this route was `prompt_no_longer_active`: Submit did
    // nothing while the dialog stayed up.
    expect(status).toBe(200);
    expect(body.reason).toBeUndefined();
    expect(body.success).toBe(true);
    const sent = sentPromptData();
    expect(sent?.question).toBe(question);
    if (sent?.type !== 'multiple_choice') throw new Error('shape');
    expect(sent.options).toHaveLength(optionCount);
  });

  it('the Auto-Yes poller answers it — the column #2364 left out', async () => {
    const clean = asPollerSees(frame(name));

    const result = await detectAndRespondToPrompt(
      WT,
      pollerState(),
      'antigravity',
      clean,
      clean.split('\n'),
      'antigravity',
    );

    expect(result).toBe('responded');
    // The `>` gutter is on option 1 on both frames, and it is what is answered
    // — never one of agy's `always allow` rows.
    expect(sendPromptAnswer.mock.calls.map(([p]) => p.answer)).toEqual(['1']);
    const sent = sentPromptData();
    expect(sent?.question).toBe(question);
    if (sent?.type !== 'multiple_choice') throw new Error('shape');
    expect(sent.options).toHaveLength(optionCount);
  });

  it('is one reading, not four', async () => {
    // The assertion the table exists for: the four columns are compared to each
    // other, not each to a hand-written expectation, so a change that moves all
    // of them together stays green and a change that moves one goes red.
    const fromStatus = shapeOf(detectSessionStatus(frame(name), 'antigravity').promptDetection.promptData);
    const fromResponsePoller = shapeOf(detectPromptWithOptions(frame(name), 'antigravity').promptData);

    captured.mockReturnValue(frame(name));
    await promptResponseVerdict();
    const fromRoute = shapeOf(sentPromptData());

    sendPromptAnswer.mockClear();
    const clean = asPollerSees(frame(name));
    await detectAndRespondToPrompt(WT, pollerState(), 'antigravity', clean, clean.split('\n'), 'antigravity');
    const fromAutoYes = shapeOf(sentPromptData());

    expect(fromStatus).not.toBeNull();
    expect(fromResponsePoller).toEqual(fromStatus);
    expect(fromRoute).toEqual(fromStatus);
    expect(fromAutoYes).toEqual(fromStatus);
  });
});

describe('[#2368] the Switch Model picker is still nobody\'s prompt', () => {
  // 受入条件 4 / #995: the picker has no numbered rows, so no consumer finds a
  // prompt on it and Auto-Yes has nothing to type into it.
  it('is a selection list on the status path and silence everywhere else', async () => {
    const raw = frame('picker-switch-model');

    const status = detectSessionStatus(raw, 'antigravity');
    expect(status.reason).toBe(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
    expect(status.hasActivePrompt).toBe(false);

    expect(detectPromptWithOptions(raw, 'antigravity').isPrompt).toBe(false);

    captured.mockReturnValue(raw);
    const { body } = await promptResponseVerdict();
    expect(body.reason).toBe('prompt_no_longer_active');

    sendPromptAnswer.mockClear();
    const clean = asPollerSees(raw);
    expect(
      await detectAndRespondToPrompt(WT, pollerState(), 'antigravity', clean, clean.split('\n'), 'antigravity'),
    ).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });
});
