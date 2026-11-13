/**
 * Auto-Yes holds a Command Code permission that follows a declined question in
 * the same turn (Issue #4313, D-1).
 *
 * #4228 UAT S8-cmc: the operator declined an `AskUserQuestion`
 * (`└ User declined to answer questions`), the agent went on with its own
 * recommendation ("回答がなかったので、推奨案で進めます"), and Auto-Yes answered
 * the shell permissions that followed (`git add`, `git commit`) with `1` — the
 * commit the operator had just declined to approve went through.
 *
 * (a) 陽性: the declined line in the current turn + a shell permission dialog →
 *     no key, recorded as `declined-question` (before the fix: `1` was sent);
 * (b) 陰性対照: a declined line in an earlier turn, and a permission dialog with
 *     no declined line at all, are answered `1` as before;
 * (c) the reader's turn boundary, one condition at a time;
 * (d) `cmate wait` names the reason.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
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
  clearAllPollerStates,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { POLLING_INTERVAL_MS, clearAllAutoYesStates } from '@/lib/auto-yes-state';
import { upsertWorktree } from '@/lib/db';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  clearPolicySuppressions,
  getLastPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import {
  COMMAND_CODE_DECLINED_QUESTION_PATTERN,
  isCommandCodeQuestionDeclinedThisTurn,
} from '@/lib/detection/tools/command-code/declined-question';
import { formatSuppressionNotice } from '../../../../src/cli/commands/wait-notices';

const WT = 'wt-4313-autoyes';
const INSTANCE = 'command-code';
const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const DIR = 'command-code-declined-question-4313';

function fixture(dir: string, file: string): string {
  return readFileSync(path.join(FIXTURES, dir, file), 'utf8');
}

/** Declined line (real, capture L57) in this turn, then the shell dialog (synthetic). */
const DECLINED_THIS_TURN = fixture(DIR, 'declined-this-turn-shell-permission.txt');
/** The whole declined turn (real), then a new user turn and a shell dialog (synthetic). */
const DECLINED_PREVIOUS_TURN = fixture(DIR, 'declined-previous-turn-shell-permission.txt');
/** A real shell dialog with no question anywhere (1.49.0). */
const PLAIN_SHELL_DIALOG = fixture('command-code-live-2250', 'dialog-shell-1490.txt');

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'command-code',
    instanceId: INSTANCE,
    consecutiveErrors: 0,
    currentInterval: POLLING_INTERVAL_MS,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** One tick of the poller on `raw`, spelled the way `capturePollerFrame` hands it over. */
function respondTo(raw: string, state: AutoYesPollerState = pollerState()): Promise<string> {
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(WT, state, 'command-code', clean, clean.split('\n'), INSTANCE, raw);
}

function skipWarnings(): Array<Record<string, unknown>> {
  return warn.mock.calls
    .filter(([event]) => event === 'poller:auto-yes-skipped-declined-question')
    .map(([, data]) => data as Record<string, unknown>);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: 'cc-4313',
    path: '/tmp/cc-4313',
    branch: 'fix/4313',
    repositoryPath: '/tmp/cc-4313-repo',
    repositoryName: 'cc-4313-repo',
    cliToolId: 'command-code',
  });
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  sendPromptAnswer.mockClear();
  warn.mockClear();
});

afterEach(() => {
  db.close();
});

describe('[#4313] (a) a permission after a question declined in this turn is held', () => {
  it('the fixture is what it claims: the declined line, then a numbered shell dialog', () => {
    expect(DECLINED_THIS_TURN).toContain(' └ User declined to answer questions');
    expect(DECLINED_THIS_TURN).toContain('Command Code needs to execute git add README.md');
    expect(DECLINED_THIS_TURN).toContain('❯ 1. Yes');
  });

  it('sends no key', async () => {
    expect(await respondTo(DECLINED_THIS_TURN)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('records why as `declined-question`, through the suppression channel', async () => {
    await respondTo(DECLINED_THIS_TURN);
    expect(getLastPolicySuppression(WT, 'command-code', INSTANCE)).toMatchObject({
      reason: 'declined-question',
      mode: null,
      promptType: 'multiple_choice',
    });
  });

  it('warns once per frame, naming the options it left alone', async () => {
    const state = pollerState();
    expect(await respondTo(DECLINED_THIS_TURN, state)).toBe('no_answer');
    expect(await respondTo(DECLINED_THIS_TURN, state)).toBe('no_answer');
    const warnings = skipWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      worktreeId: WT,
      cliToolId: 'command-code',
      instanceId: INSTANCE,
      reason: 'declined-question',
      promptType: 'multiple_choice',
    });
    expect(warnings[0].options).toEqual(expect.arrayContaining(['1. Yes']));
  });
});

describe('[#4313] (b) 陰性対照: answered as before', () => {
  it.each([
    ['the declined line is in an earlier turn', DECLINED_PREVIOUS_TURN],
    ['a shell dialog with no question at all (#2250, 1.49.0)', PLAIN_SHELL_DIALOG],
  ])('%s: sends `1`', async (_name, raw) => {
    expect(await respondTo(raw)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
    expect(skipWarnings()).toEqual([]);
    expect(getLastPolicySuppression(WT, 'command-code', INSTANCE)?.reason).not.toBe('declined-question');
  });
});

describe('[#4313] (c) the current turn, one boundary at a time', () => {
  const declinedOn = (raw: string): boolean => isCommandCodeQuestionDeclinedThisTurn(normalizeFrame(raw, 'command-code'));
  const rows = DECLINED_PREVIOUS_TURN.split('\n');
  const userRow = rows.findIndex((row) => row.startsWith('❯ README'));
  const workedRow = rows.findIndex((row) => row.startsWith('✻ Worked for'));

  it('positive control: the two fixtures read as they should', () => {
    expect(declinedOn(DECLINED_THIS_TURN)).toBe(true);
    expect(declinedOn(DECLINED_PREVIOUS_TURN)).toBe(false);
    expect(declinedOn(PLAIN_SHELL_DIALOG)).toBe(false);
    expect(userRow).toBeGreaterThan(workedRow);
    expect(workedRow).toBeGreaterThan(0);
  });

  it('a later user row alone ends the turn', () => {
    const mutated = rows.filter((_, i) => i !== workedRow).join('\n');
    expect(declinedOn(mutated)).toBe(false);
  });

  it('the turn summary (`✻ Worked for`) alone ends the turn', () => {
    const mutated = rows.filter((_, i) => i !== userRow).join('\n');
    expect(declinedOn(mutated)).toBe(false);
  });

  it('with both removed, the earlier declined line reads as this turn', () => {
    const mutated = rows.filter((_, i) => i !== userRow && i !== workedRow).join('\n');
    expect(declinedOn(mutated)).toBe(true);
  });

  it('the dialog cursor row (`❯ 1. Yes`) is not a user row', () => {
    // The dialog sits below the declined line; its `❯` must not end the turn.
    expect(DECLINED_THIS_TURN.indexOf('❯ 1. Yes')).toBeGreaterThan(
      DECLINED_THIS_TURN.indexOf('User declined to answer questions'),
    );
    expect(declinedOn(DECLINED_THIS_TURN)).toBe(true);
  });

  it('the 1.54.1 wording (#2754 capture, `Esc` on a question) matches too', () => {
    const idle = readFileSync(
      path.join(FIXTURES, 'command-code-askuserquestion-2754', 'not-applicable-question-cancelled.txt'),
      'utf8',
    );
    expect(COMMAND_CODE_DECLINED_QUESTION_PATTERN.test(stripAnsi(idle).split('\n')[41] ?? '')).toBe(true);
  });

  it('the wording of the other disposition (`wants to discuss`) is not a decline', () => {
    expect(COMMAND_CODE_DECLINED_QUESTION_PATTERN.test(' └ User wants to discuss the questions instead of answering')).toBe(false);
    expect(COMMAND_CODE_DECLINED_QUESTION_PATTERN.test(' └ User declined to answer questions')).toBe(true);
    // Quoted in an agent reply, mid-sentence: not the tool block's row.
    expect(COMMAND_CODE_DECLINED_QUESTION_PATTERN.test('⠶ The log says User declined to answer questions.')).toBe(false);
  });
});

describe('[#4313] (d) cmate wait names the reason', () => {
  it('has its own wording, not the contract’s or an unknown reason’s', () => {
    const line = formatSuppressionNotice(
      { reason: 'declined-question', mode: null, promptType: 'multiple_choice', at: Date.now() },
      3,
    );
    expect(line).toContain('reason=declined-question');
    expect(line).toContain('declined');
    expect(line).not.toContain('by contract policy');
    expect(line).not.toContain('does not recognise');
  });
});
