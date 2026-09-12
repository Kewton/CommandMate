/**
 * One Command Code question, ONE reading, across every consumer (Issue #2522).
 *
 * Issue #2521 gave this screen a status and nothing else. This Issue gives it a
 * payload, and a payload is only worth having if every surface that acts on it
 * agrees about what the question is, which options exist and which one is the
 * default. The table below is the same one
 * `antigravity-dialog-producers-2368.test.ts` pins for agy, and every column is
 * the REAL producer with the REAL pre-processing in front of it:
 *
 * | column            | what it is                                                          |
 * |-------------------|---------------------------------------------------------------------|
 * | status            | `detectSessionStatus` — `/current-output`, the chat surface, `wait`  |
 * | response poller   | `detectPromptWithOptions` / `extractResponse` — the stored `prompt` row and its push |
 * | prompt-response   | the route's #161 re-verification — PromptPanel Submit, `respond`     |
 * | Auto-Yes          | `detectAndRespondToPrompt` — the keys an unattended run sends        |
 *
 * ## Why the pre-processing is the point here and not a detail
 *
 * The four paths clean their captures differently, and 確定仕様 C is written
 * against exactly that: `normalizeFrame` keeps the box drawing, while
 * `detectPromptWithOptions`, `captureAndCleanOutput` and the route all run
 * `stripBoxDrawing` — which blanks the 200-column U+2500 rule this screen's
 * region is anchored on. A reader added to the shared entry point alone would
 * have answered on the status path and nowhere else, and the way to notice that
 * is to drive each column through the string it actually receives rather than
 * injecting a finished `promptData`. Nothing in this file mocks a detector.
 *
 * The last block is the control for the wiring specifically: the same poller
 * call with the raw frame withheld reads nothing at all.
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
        name: 'Command Code',
        isRunning: async () => true,
        getSessionName: (worktreeId: string, instanceId?: string) =>
          `cm-${worktreeId}-${instanceId ?? 'command-code'}`,
      }),
    }),
  },
}));
// Command Code publishes no per-decision ids, so the structured layer declines
// in production too; stubbed so the KEYSTROKE path is what is under test.
vi.mock('@/lib/hooks/structured-decision-response', () => ({
  answerStructuredDecision: vi.fn().mockResolvedValue({
    kind: 'not-applicable',
    reason: 'no-pending-decision',
  }),
}));
vi.mock('@/lib/session/agent-event-state', () => ({ getAskUserQuestion: vi.fn(() => null) }));

import { POST as promptResponse } from '@/app/api/worktrees/[id]/prompt-response/route';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { detectPromptWithOptions, extractResponse } from '@/lib/polling/response-checker';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { upsertWorktree } from '@/lib/db';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';

const WT = 'wt-2522-producers';
const DIR_2521 = path.resolve(__dirname, '../../../fixtures/command-code-askuserquestion-2521');
const DIR_2522 = path.resolve(__dirname, '../../../fixtures/command-code-askuserquestion-2522');

const REPORTED = readFileSync(
  path.join(DIR_2521, 'askuserquestion-wrapped-1530-200x1000.txt'),
  'utf8',
);
const FLAT = readFileSync(path.join(DIR_2522, 'question-flat-short.txt'), 'utf8');
const MULTI_SELECT = readFileSync(
  path.join(DIR_2522, 'unsupported-multi-select-checkboxes.txt'),
  'utf8',
);

/** The capture as `captureAndCleanOutput` hands it to the Auto-Yes poller. */
const asPollerSees = (raw: string): string => stripBoxDrawing(stripAnsi(raw));

/** The fields every surface branches on, from a multiple_choice prompt. */
function shapeOf(promptData: PromptData | null | undefined): unknown {
  if (promptData?.type !== 'multiple_choice') return promptData?.type ?? null;
  const { question, options, submitMode } = promptData;
  return {
    question,
    submitMode,
    options: options.map((o) => ({
      number: o.number,
      label: o.label,
      isDefault: o.isDefault,
      requiresTextInput: o.requiresTextInput,
    })),
  };
}

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'command-code',
    instanceId: 'command-code',
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

async function promptResponseVerdict(
  answer = '1',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await promptResponse(postRequest({ answer, cliTool: 'command-code' }), {
    params: Promise.resolve({ id: WT }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: 'cc-2522',
    path: '/tmp/cc-2522',
    branch: 'feature/2522',
    repositoryPath: '/tmp/cc-2522-repo',
    repositoryName: 'cc-2522-repo',
    cliToolId: 'command-code',
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
  {
    name: 'the reported 200x1000 capture',
    raw: REPORTED,
    question: 'Approve proceeding from the plan into worktree creation and dispatch?',
    optionCount: 4,
  },
  {
    name: 'the same screen with nothing wrapped',
    raw: FLAT,
    question: 'Approve proceeding from the plan into worktree creation and dispatch?',
    optionCount: 4,
  },
])('[#2522] $name — every consumer reads one frame', ({ raw, question, optionCount }) => {
  it('the status verdict is an answerable prompt', () => {
    const status = detectSessionStatus(raw, 'command-code');

    expect(status.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(status.hasActivePrompt).toBe(true);
    expect(status.promptDetection.promptData?.question).toBe(question);
    if (status.promptDetection.promptData?.type !== 'multiple_choice') throw new Error('shape');
    expect(status.promptDetection.promptData.options).toHaveLength(optionCount);
  });

  it('the response poller reads the same prompt through its own cleaning', () => {
    const detection = detectPromptWithOptions(raw, 'command-code');

    expect(detection.isPrompt).toBe(true);
    expect(detection.promptData?.question).toBe(question);
    if (detection.promptData?.type !== 'multiple_choice') throw new Error('shape');
    expect(detection.promptData.options).toHaveLength(optionCount);
  });

  it('the extractor ends the turn on the prompt and carries it to the save path', () => {
    // The row History stores, and the excerpt the push notification quotes. The
    // early `command-code` branch of `extractResponse` is what carries it.
    const extracted = extractResponse(raw, 0, 'command-code');

    expect(extracted?.isComplete).toBe(true);
    expect(extracted?.promptDetection?.isPrompt).toBe(true);
    expect(extracted?.promptDetection?.promptData?.question).toBe(question);
  });

  it('the prompt-response route verifies it and sends the answer', async () => {
    captured.mockReturnValue(raw);

    const { status, body } = await promptResponseVerdict();

    expect(status).toBe(200);
    expect(body.reason).toBeUndefined();
    expect(body.success).toBe(true);
    const sent = sentPromptData();
    expect(sent?.question).toBe(question);
    if (sent?.type !== 'multiple_choice') throw new Error('shape');
    expect(sent.options).toHaveLength(optionCount);
  });

  it('the Auto-Yes poller answers it from the same tick’s raw capture', async () => {
    const clean = asPollerSees(raw);

    const result = await detectAndRespondToPrompt(
      WT,
      pollerState(),
      'command-code',
      clean,
      clean.split('\n'),
      'command-code',
      raw,
    );

    expect(result).toBe('responded');
    expect(sendPromptAnswer.mock.calls.map(([p]) => p.answer)).toEqual(['1']);
  });

  it('is one reading, not five', async () => {
    // The assertion the table exists for: the columns are compared to EACH
    // OTHER, so a change that moves all of them together stays green and a
    // change that moves one goes red.
    const fromStatus = shapeOf(detectSessionStatus(raw, 'command-code').promptDetection.promptData);
    const fromResponsePoller = shapeOf(detectPromptWithOptions(raw, 'command-code').promptData);
    const fromExtractor = shapeOf(extractResponse(raw, 0, 'command-code')?.promptDetection?.promptData);

    captured.mockReturnValue(raw);
    await promptResponseVerdict();
    const fromRoute = shapeOf(sentPromptData());

    sendPromptAnswer.mockClear();
    const clean = asPollerSees(raw);
    await detectAndRespondToPrompt(
      WT, pollerState(), 'command-code', clean, clean.split('\n'), 'command-code', raw,
    );
    const fromAutoYes = shapeOf(sentPromptData());

    expect(fromStatus).not.toBeNull();
    expect(fromResponsePoller).toEqual(fromStatus);
    expect(fromExtractor).toEqual(fromStatus);
    expect(fromRoute).toEqual(fromStatus);
    expect(fromAutoYes).toEqual(fromStatus);
  });
});

describe('[#2522] an unsupported question screen reaches no consumer', () => {
  it('saves no prompt, sends no key and refuses the route', async () => {
    // 確定仕様 B's third state, across the same table. The generic parser DOES
    // find four options on this frame — `1. [ ] lint` and friends — and the
    // whole point is that none of them reaches anything.
    expect(detectSessionStatus(MULTI_SELECT, 'command-code').hasActivePrompt).toBe(false);
    expect(detectPromptWithOptions(MULTI_SELECT, 'command-code').isPrompt).toBe(false);
    expect(extractResponse(MULTI_SELECT, 0, 'command-code')?.promptDetection).toBeUndefined();

    captured.mockReturnValue(MULTI_SELECT);
    const { status, body } = await promptResponseVerdict();
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.reason).toBe('unsupported_dialog_layout');

    const clean = asPollerSees(MULTI_SELECT);
    expect(
      await detectAndRespondToPrompt(
        WT, pollerState(), 'command-code', clean, clean.split('\n'), 'command-code', MULTI_SELECT,
      ),
    ).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });
});

describe('[#2522] the raw frame is what carries the reading, and the control says so', () => {
  it('the poller reads nothing when the tick’s raw capture is withheld', async () => {
    // The mutation control for 確定仕様 C's wiring. This is EXACTLY the call the
    // poller made before this Issue — clean string, no raw — and it is the
    // reason "add the reader to `detectPromptOnCleanFrame`" was not enough.
    const clean = asPollerSees(REPORTED);

    const result = await detectAndRespondToPrompt(
      WT,
      pollerState(),
      'command-code',
      clean,
      clean.split('\n'),
      'command-code',
    );

    expect(result).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('and reads it when the same call is given the raw capture', async () => {
    const clean = asPollerSees(REPORTED);

    const result = await detectAndRespondToPrompt(
      WT, pollerState(), 'command-code', clean, clean.split('\n'), 'command-code', REPORTED,
    );

    expect(result).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('leaves `precomputedLines` as the split of the CLEAN string', async () => {
    // 確定仕様 C: the stop-condition delta and every other tool's reading are
    // measured on `cleanOutput`, and handing the raw split instead would move
    // them. Passing a raw-derived split with the clean string is a mismatch the
    // generic parser would read off the wrong rows — asserted by showing the
    // reading does not depend on it for THIS screen, and that the clean split is
    // what the poller actually passes (see `pollAutoYes`).
    const clean = asPollerSees(REPORTED);
    expect(clean.split('\n')).not.toEqual(REPORTED.split('\n'));

    const result = await detectAndRespondToPrompt(
      WT, pollerState(), 'command-code', clean, clean.split('\n'), 'command-code', REPORTED,
    );
    expect(result).toBe('responded');
  });
});
