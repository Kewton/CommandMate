/**
 * Auto-Yes leaves the `AskUserQuestion` confirm pages to a human, on Claude as
 * well as on Command Code, under a reason of its own (Issue #3748).
 *
 * (a) `isAutoYesDeclinedConfirmPage` / `isAutoYesDeclinedConfirmFrame`: the one
 *     predicate the server's poller and the browser's fallback share.
 *     陽性: Claude's `Ready to submit your answers?` / `❯ 1. Submit answers` /
 *     `2. Cancel` (live 2.1.268 and 2.1.240 captures) and #3497's two Command
 *     Code pages. 陰性: Claude's question screens, its answered idle pane, its
 *     ordinary numbered permission dialog, and a tool with no confirm page.
 * (b) the poller sends no key to Claude's confirm page and records
 *     `question-confirm-page`; Command Code's page (#3497) is recorded under
 *     the same reason instead of `unclassified-frame`.
 * (c) 陰性対照: Claude's ordinary permission dialog is answered `1` as before,
 *     and `poller:response-sent` now names the question and the answer. An
 *     `AskUserQuestion` quoting the page's wording is not the page; since
 *     #3822 it is withheld as a question (`question-left-to-human`).
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
      getTool: (cliToolId: string) => ({
        name: cliToolId,
        getSessionName: (worktreeId: string, instanceId?: string) =>
          `cm-${worktreeId}-${instanceId ?? cliToolId}`,
      }),
    }),
  },
}));

const warn = vi.fn();
const info = vi.fn();
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: (...args: unknown[]) => info(...(args as [])),
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
import { MAX_LOGGED_QUESTION_LENGTH } from '@/lib/polling/auto-yes-prompt-suppression';
import {
  isAutoYesDeclinedConfirmFrame,
  isAutoYesDeclinedConfirmPage,
} from '@/lib/polling/auto-yes-confirm-page';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { COMMAND_CODE_FREE_TEXT_CONFIRM_FRAME } from '@tests/fixtures/command-code-askuserquestion-3497/free-text-confirm';
import {
  askUserQuestionAsking,
  bashApprovalRunning,
  editApprovalWithDiff,
} from '@tests/fixtures/claude-confirm-lookalikes-3748/frames';

const WT = 'wt-3748-autoyes';
const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const DETECTION_FIXTURES = path.resolve(__dirname, '../detection/fixtures');

function fixture(dir: string, file: string): string {
  return readFileSync(path.join(FIXTURES, dir, file), 'utf8');
}

const CLAUDE_REVIEW = fixture('claude-live-2486', 'tabs-preview-review.txt');
const CLAUDE_Q1 = fixture('claude-live-2486', 'tabs-preview-q1.txt');
const CLAUDE_Q2 = fixture('claude-live-2486', 'tabs-preview-q2.txt');
const CLAUDE_TABS_Q1 = fixture('claude-live-2486', 'tabs-q1.txt');
const CLAUDE_ANSWERED_IDLE = fixture('claude-live-2486', 'tabs-preview-answered-idle.txt');
const CLAUDE_SUBMIT_1708 = readFileSync(
  path.join(DETECTION_FIXTURES, 'claude-live-1708', 'askuserquestion-submit-taskpanel.txt'),
  'utf8',
);
const CLAUDE_BASH_APPROVAL = readFileSync(
  path.join(DETECTION_FIXTURES, 'claude-live-1708', 'bash-approval-taskpanel.txt'),
  'utf8',
);
/**
 * The page's wording on frames that are not the page: what the first reading
 * (`detectClaudeDialog`'s `ask_user`, a substring of the four rows above the
 * options) took for it. Each must still be answered `1`.
 */
const CLAUDE_LOOKALIKES = [
  ['a Bash approval running `grep -rn "review your answers" src`', bashApprovalRunning('grep -rn "review your answers" src')],
  ['a Bash approval running `grep -rn "Ready to submit your answers?" src`', bashApprovalRunning('grep -rn "Ready to submit your answers?" src')],
  ['a Bash approval described as `Ready to submit your answers?`', bashApprovalRunning('ls', 'Ready to submit your answers?')],
  ['an Edit approval whose diff holds both sentences', editApprovalWithDiff()],
  ['an AskUserQuestion asking `Do you want to review your answers before continuing?`', askUserQuestionAsking('Do you want to review your answers before continuing?')],
  ['an AskUserQuestion whose question ends `Ready to submit your answers?`', askUserQuestionAsking('Ready to submit your answers?')],
] as const;
/** Issue #3822: the lookalikes that are questions, left to a human since #3822. */
const isAskUserQuestionLookalike = (name: string): boolean => name.startsWith('an AskUserQuestion');
const CC_NO_BACK_HINT = fixture('command-code-askuserquestion-3497', 'review-page-no-back-hint.txt');
const CC_FREE_TEXT_CONFIRM = COMMAND_CODE_FREE_TEXT_CONFIRM_FRAME;

function pollerState(cliToolId: CLIToolType): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId,
    instanceId: cliToolId,
    consecutiveErrors: 0,
    currentInterval: POLLING_INTERVAL_MS,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** One tick of the poller on `raw`, spelled the way `capturePollerFrame` hands it over. */
function respondTo(cliToolId: CLIToolType, raw: string, state = pollerState(cliToolId)): Promise<string> {
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(WT, state, cliToolId, clean, clean.split('\n'), cliToolId, raw);
}

function events(spy: typeof warn, name: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter(([event]) => event === name)
    .map(([, data]) => data as Record<string, unknown>);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: 'wt-3748',
    path: '/tmp/wt-3748',
    branch: 'fix/3748',
    repositoryPath: '/tmp/wt-3748-repo',
    repositoryName: 'wt-3748-repo',
    cliToolId: 'claude',
  });
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  sendPromptAnswer.mockClear();
  warn.mockClear();
  info.mockClear();
});

afterEach(() => {
  db.close();
});

describe('[#3748] (a) the shared confirm-page predicate', () => {
  it.each([
    ['claude: 2.1.268 Review / Submit answers (tabs + preview)', 'claude', CLAUDE_REVIEW],
    ['claude: 2.1.240 Submit answers (task panel, no footer)', 'claude', CLAUDE_SUBMIT_1708],
    ['command-code: Review page without its back hint (#3497)', 'command-code', CC_NO_BACK_HINT],
    ['command-code: free-text question drawn as Submit / Cancel (#3497)', 'command-code', CC_FREE_TEXT_CONFIRM],
  ] as const)('陽性 %s', (_name, tool, raw) => {
    expect(isAutoYesDeclinedConfirmPage(tool, normalizeFrame(raw, tool))).toBe(true);
    expect(isAutoYesDeclinedConfirmFrame(tool, raw)).toBe(true);
  });

  it.each([
    ['claude: question 1 with a preview pane', 'claude', CLAUDE_Q1],
    ['claude: question 2', 'claude', CLAUDE_Q2],
    ['claude: question 1 with the tab row only', 'claude', CLAUDE_TABS_Q1],
    ['claude: answered, idle composer (the reply lists the answers)', 'claude', CLAUDE_ANSWERED_IDLE],
    ['claude: ordinary Bash permission dialog', 'claude', CLAUDE_BASH_APPROVAL],
    // Same frame, another tool: only the two tools with a measured page answer true.
    ['codex: Claude’s confirm page under another tool id', 'codex', CLAUDE_REVIEW],
    ['claude: Command Code’s confirm page under Claude’s id', 'claude', CC_FREE_TEXT_CONFIRM],
    ...CLAUDE_LOOKALIKES.map(([name, raw]) => [`claude: ${name}`, 'claude', raw] as const),
  ] as const)('陰性 %s', (_name, tool, raw) => {
    expect(isAutoYesDeclinedConfirmPage(tool, normalizeFrame(raw, tool))).toBe(false);
    expect(isAutoYesDeclinedConfirmFrame(tool, raw)).toBe(false);
  });

  it('no frame is no confirm page', () => {
    expect(isAutoYesDeclinedConfirmFrame('claude', null)).toBe(false);
    expect(isAutoYesDeclinedConfirmFrame('command-code', undefined)).toBe(false);
    expect(isAutoYesDeclinedConfirmFrame('claude', '')).toBe(false);
  });
});

describe('[#3748] (b) the poller leaves the confirm page alone, under its own reason', () => {
  it('claude: the Submit answers page gets no key', async () => {
    expect(await respondTo('claude', CLAUDE_REVIEW)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'claude', 'claude')).toMatchObject({
      reason: 'question-confirm-page',
      mode: null,
      promptType: 'multiple_choice',
    });
    const [skipped] = events(warn, 'poller:auto-yes-skipped-question-confirm');
    expect(skipped).toMatchObject({
      worktreeId: WT,
      cliToolId: 'claude',
      reason: 'question-confirm-page',
      options: ['1. Submit answers', '2. Cancel'],
    });
  });

  it('command-code: #3497’s page is recorded as question-confirm-page, not unclassified-frame', async () => {
    expect(await respondTo('command-code', CC_FREE_TEXT_CONFIRM)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'command-code', 'command-code')).toMatchObject({
      reason: 'question-confirm-page',
    });
  });
});

describe('[#3748] (c) 陰性対照 and the response-sent log', () => {
  it('claude: an ordinary permission dialog is answered `1`, logged with its question and answer', async () => {
    expect(await respondTo('claude', CLAUDE_BASH_APPROVAL)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
    expect(events(warn, 'poller:auto-yes-skipped-question-confirm')).toEqual([]);

    const [sent] = events(info, 'poller:response-sent');
    expect(sent).toMatchObject({
      worktreeId: WT,
      cliToolId: 'claude',
      promptType: 'multiple_choice',
      answer: '1',
    });
    expect(typeof sent.question).toBe('string');
    expect(String(sent.question).length).toBeGreaterThan(0);
  });

  it.each(CLAUDE_LOOKALIKES.filter(([name]) => !isAskUserQuestionLookalike(name)))('claude: %s is answered `1`', async (_name, raw) => {
    expect(await respondTo('claude', raw)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
    expect(events(warn, 'poller:auto-yes-skipped-question-confirm')).toEqual([]);
    expect(getLastPolicySuppression(WT, 'claude', 'claude')).toBeNull();
  });

  // Issue #3822 (decided 2026-10-20: Auto-Yes answers permissions only; a
  // question is the human's). These two were `is answered \`1\``: under #3748
  // they pinned that the confirm-page predicate does not mistake a question
  // whose wording quotes the page for the page itself, and the answer `1` was
  // how that showed. The question is now withheld for being a question, so
  // what shows the same thing is the reason: `question-left-to-human`, not
  // `question-confirm-page`, and not the confirm page's WARN.
  it.each(CLAUDE_LOOKALIKES.filter(([name]) => isAskUserQuestionLookalike(name)))(
    'claude: %s gets no key, recorded as question-left-to-human rather than the confirm page (#3822)',
    async (_name, raw) => {
      expect(await respondTo('claude', raw)).toBe('no_answer');
      expect(sendPromptAnswer).not.toHaveBeenCalled();
      expect(events(warn, 'poller:auto-yes-skipped-question-confirm')).toEqual([]);
      expect(events(warn, 'poller:auto-yes-skipped-question')).toEqual([
        expect.objectContaining({ reason: 'question-left-to-human', promptType: 'multiple_choice' }),
      ]);
      expect(getLastPolicySuppression(WT, 'claude', 'claude')).toMatchObject({
        reason: 'question-left-to-human',
        mode: null,
        promptType: 'multiple_choice',
      });
    },
  );

  it('a yes/no prompt logs `y` and a question cut to the logged length', async () => {
    const long = `Apply ${'x'.repeat(MAX_LOGGED_QUESTION_LENGTH + 200)}?`;
    const raw = ['Working on the change.', '', `${long} (y/n)`, ''].join('\n');
    expect(await respondTo('command-code', raw)).toBe('responded');
    const [sent] = events(info, 'poller:response-sent');
    expect(sent).toMatchObject({ promptType: 'yes_no', answer: 'y' });
    expect(String(sent.question).length).toBeLessThanOrEqual(MAX_LOGGED_QUESTION_LENGTH + 1);
  });
});
