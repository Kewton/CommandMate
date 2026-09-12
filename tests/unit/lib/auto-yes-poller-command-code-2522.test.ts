/**
 * Auto-Yes answers Command Code's `AskUserQuestion` — capture, reader, policy,
 * keystroke (Issue #2522).
 *
 * ## What was broken, and why "the reader is wired in" was not enough
 *
 * Issue #2521 recognised the screen on the status path, which reads
 * `NormalizedFrame.raw`. The Auto-Yes poller reads `captureAndCleanOutput`,
 * i.e. `stripBoxDrawing(stripAnsi(capture))` — and `stripBoxDrawing` blanks the
 * 200-column U+2500 rule the question region is anchored on. So the reading
 * this Issue added to `detectPromptOnCleanFrame` answered `null` on this path no
 * matter how right it was: the string it was handed no longer contained the
 * screen's own seam.
 *
 * The fix is a WIRING change — `pollAutoYes` keeps the tick's raw capture and
 * carries it — and a wiring change can only be tested through the wiring. So the
 * first block drives `startAutoYesPolling` itself: the only thing stubbed
 * between `tmux capture-pane` and `sendPromptAnswer` is the transport at each
 * end. `tests/unit/lib/detection/command-code-dialog-producers-2522.test.ts`
 * holds the matching negative control (the same reader, the raw frame withheld,
 * nothing read).
 *
 * ## What the rest of the file pins
 *
 * 確定仕様 D's "only when the contract allows it". Auto-Yes being able to read
 * this screen is exactly when it matters that `off` / `safe` / a deny pattern /
 * a free-text default still send nothing, so each is asserted on THIS frame
 * rather than inherited from `auto-yes-poller-policy.test.ts`'s Claude one.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { PromptData } from '@/types/models';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string; promptData?: PromptData }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) =>
    sendPromptAnswer(params as { answer: string; promptData?: PromptData }),
}));

const captureSessionOutput = vi.fn(async () => '');
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...args: unknown[]) =>
    captureSessionOutput(...(args as unknown as [])),
}));

vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({
        name: 'Command Code',
        getSessionName: (worktreeId: string, instanceId?: string) =>
          `cm-${worktreeId}-${instanceId ?? 'command-code'}`,
      }),
    }),
  },
}));

const warn = vi.fn();
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warn(...(args as [])),
    error: vi.fn(),
  }),
}));

import {
  detectAndRespondToPrompt,
  capturePollerFrame,
  startAutoYesPolling,
  stopAllAutoYesPolling,
  clearAllPollerStates,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import {
  POLLING_INTERVAL_MS,
  clearAllAutoYesStates,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import { createTask, upsertWorktree } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { clearAutoYesPolicyCache, invalidateSessionAutoYesPolicy } from '@/lib/polling/auto-yes-policy';
import {
  clearPolicySuppressions,
  getLastPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';

const WT = 'wt-2522-autoyes';
const DIR_2521 = path.resolve(__dirname, '../../fixtures/command-code-askuserquestion-2521');
const DIR_2522 = path.resolve(__dirname, '../../fixtures/command-code-askuserquestion-2522');

const REPORTED = readFileSync(
  path.join(DIR_2521, 'askuserquestion-wrapped-1530-200x1000.txt'),
  'utf8',
);
const DEFAULT_IS_FREE_TEXT = readFileSync(
  path.join(DIR_2522, 'question-default-on-free-text.txt'),
  'utf8',
);
const UNREADABLE = readFileSync(path.join(DIR_2522, 'unsupported-region-too-tall.txt'), 'utf8');

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'command-code',
    instanceId: 'command-code',
    consecutiveErrors: 0,
    currentInterval: POLLING_INTERVAL_MS,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** Drive the real poller path for one frame: capture → reader → policy → send. */
async function respondTo(raw: string, instanceId = 'command-code'): Promise<string> {
  const frame = await capturePollerFrame(WT, 'command-code', undefined, instanceId);
  const state = pollerState();
  state.instanceId = instanceId;
  return detectAndRespondToPrompt(
    WT,
    state,
    'command-code',
    frame.clean,
    frame.clean.split('\n'),
    instanceId,
    frame.raw,
  );
}

function seedTask(autoYes: string): void {
  createTask(db, {
    worktreeId: WT,
    cliToolId: 'command-code',
    instanceId: null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: a task
goal: do the thing
scope:
  allow: ["src/**"]
${autoYes}`,
      'task.yaml',
    ),
    status: 'running',
  });
  invalidateSessionAutoYesPolicy(`${WT}:command-code`);
}

function suppressionWarnings(): Array<Record<string, unknown>> {
  return warn.mock.calls
    .filter(([action]) => action === 'poller:auto-yes-suppressed-by-policy')
    .map(([, data]) => data as Record<string, unknown>);
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
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  sendPromptAnswer.mockClear();
  warn.mockClear();
  captureSessionOutput.mockReset();
  captureSessionOutput.mockResolvedValue(REPORTED);
});

afterEach(() => {
  stopAllAutoYesPolling();
  vi.useRealTimers();
  db.close();
});

// ===========================================================================
// A. The wiring, driven through the poller's own loop
// ===========================================================================

describe('[#2522] the Auto-Yes loop answers the question screen', () => {
  it('captures, reads and sends `1` on its first tick', async () => {
    vi.useFakeTimers();
    setAutoYesEnabled(WT, 'command-code', true);

    expect(startAutoYesPolling(WT, 'command-code').started).toBe(true);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 10);

    expect(captureSessionOutput).toHaveBeenCalled();
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);

    const [params] = sendPromptAnswer.mock.calls[0];
    expect(params.answer).toBe('1');
    expect(params.promptData?.type).toBe('multiple_choice');
    if (params.promptData?.type !== 'multiple_choice') throw new Error('shape');
    expect(params.promptData.question).toBe(
      'Approve proceeding from the plan into worktree creation and dispatch?',
    );
    expect(params.promptData.options).toHaveLength(4);
    // 確定仕様 D: the digit alone. An Enter paired with it would confirm
    // whatever the tool painted next.
    expect(params.promptData.submitMode).toBe('answer_only');
  });

  it('keeps one capture per tick and reads both spellings off it', async () => {
    // The shape of the fix: `stripBoxDrawing` runs once, on the string the other
    // steps read, and the raw one is the SAME instant rather than a second
    // `capture-pane`. Answering keys aimed at a frame the dialog has already
    // left is the race this avoids.
    const frame = await capturePollerFrame(WT, 'command-code');

    expect(captureSessionOutput).toHaveBeenCalledTimes(1);
    expect(frame.raw).toBe(REPORTED);
    expect(frame.clean).toBe(stripBoxDrawing(stripAnsi(REPORTED)));
    expect(frame.clean).not.toContain('─'.repeat(40));
  });

  it('records the answer in the chat history it can be audited from', async () => {
    expect(await respondTo(REPORTED)).toBe('responded');

    const rows = db
      .prepare(`SELECT content, prompt_data FROM chat_messages WHERE worktree_id = ? ORDER BY id`)
      .all(WT) as Array<{ content: string; prompt_data: string | null }>;

    expect(rows).toHaveLength(1);
    // The question and every option, as the reader produced them — so the audit
    // trail says which choice was made rather than which rows the pane showed.
    expect(rows[0].content).toContain('Type something...');
    const promptData = JSON.parse(rows[0].prompt_data ?? 'null') as {
      question: string;
      options: Array<{ number: number }>;
      answer?: string;
    };
    expect(promptData.question).toBe(
      'Approve proceeding from the plan into worktree creation and dispatch?',
    );
    expect(promptData.options).toHaveLength(4);
  });

  it('answers the same screen once, not once per poll', async () => {
    // #306's duplicate guard, on this frame. The screen stays painted until the
    // tool repaints it, so a second answer would be a second keystroke into
    // whatever replaced it.
    const state = pollerState();
    const frame = await capturePollerFrame(WT, 'command-code');
    const call = (): Promise<string> =>
      detectAndRespondToPrompt(
        WT, state, 'command-code', frame.clean, frame.clean.split('\n'), 'command-code', frame.raw,
      );

    expect(await call()).toBe('responded');
    expect(await call()).toBe('duplicate');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// B. What it must NOT answer
// ===========================================================================

describe('[#2522] Auto-Yes withholds exactly where the contract says to', () => {
  it("sends nothing under mode: 'off'", async () => {
    seedTask("autoYes:\n  mode: 'off'\n");

    expect(await respondTo(REPORTED)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(suppressionWarnings()).toEqual([
      expect.objectContaining({ reason: 'mode-off', promptType: 'multiple_choice' }),
    ]);
  });

  it("sends nothing under mode: 'safe', which allows yes_no only", async () => {
    seedTask('autoYes:\n  mode: safe\n');

    expect(await respondTo(REPORTED)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(suppressionWarnings()).toEqual([
      expect.objectContaining({ reason: 'type-not-allowed' }),
    ]);
  });

  it('sends nothing when a deny pattern matches THIS question’s description', async () => {
    // #1699's surface, on this screen: the deny pattern has to reach the
    // descriptions, which are the sentences the options are actually promising.
    // `--worker-method` appears only inside option 1's wrapped description.
    seedTask(
      "autoYes:\n  mode: allow-listed\n  allowPromptTypes: [multiple_choice]\n" +
        "  denyPatterns: ['--worker-method']\n",
    );

    expect(await respondTo(REPORTED)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'command-code')).toMatchObject({
      reason: 'deny-pattern',
      pattern: '--worker-method',
    });
  });

  it('does not let a deny word from ABOVE the rule suppress this question', async () => {
    // The other half of #1699. The transcript above the rule is full of earlier
    // turns; the region stops at the rule, so nothing up there is judged.
    expect(REPORTED).toContain('Presenting dispatch decision');
    seedTask(
      "autoYes:\n  mode: allow-listed\n  allowPromptTypes: [multiple_choice]\n" +
        "  denyPatterns: ['Presenting dispatch decision']\n",
    );

    expect(await respondTo(REPORTED)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('answers an allow-listed type no deny pattern matches', async () => {
    seedTask(
      "autoYes:\n  mode: allow-listed\n  allowPromptTypes: [multiple_choice]\n" +
        "  denyPatterns: ['^never-matches$']\n",
    );

    expect(await respondTo(REPORTED)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the default option is the free-text row', async () => {
    // 確定仕様 A / D: `Type something...` is a TextInput in the TUI, not a
    // fourth choice, and a digit sent at it answers nothing. `requiresTextInput`
    // is what stops `resolveBaseAnswer` producing one.
    captureSessionOutput.mockResolvedValue(DEFAULT_IS_FREE_TEXT);

    expect(await respondTo(DEFAULT_IS_FREE_TEXT)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('sends nothing on a question screen it cannot read', async () => {
    // 確定仕様 B: no auto-answer for the `unsupported` state, and no fall-through
    // to the generic parser's partial list either.
    captureSessionOutput.mockResolvedValue(UNREADABLE);

    expect(await respondTo(UNREADABLE)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('sends nothing while Auto-Yes is off, however readable the screen is', async () => {
    vi.useFakeTimers();

    expect(startAutoYesPolling(WT, 'command-code')).toEqual({
      started: false,
      reason: 'auto-yes not enabled',
    });
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS * 3);

    expect(captureSessionOutput).not.toHaveBeenCalled();
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('keeps one instance’s frame and answer away from another', async () => {
    // #896's scope, on this screen: the composite key carries the instance, and
    // the session the keys are sent to is resolved from it.
    expect(await respondTo(REPORTED, 'command-code-2')).toBe('responded');

    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(sendPromptAnswer.mock.calls[0][0]).toMatchObject({
      sessionName: `cm-${WT}-command-code-2`,
    });
  });
});
