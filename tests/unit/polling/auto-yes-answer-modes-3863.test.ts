/**
 * Issue #3863: Auto-Yes's answer modes — `recommended` (the default) answers a
 * question with its recommended option, `careful` leaves it to a human.
 *
 * Driven through the real `detectAndRespondToPrompt` over live captures
 * (`claude-live-2486/tabs-q1.txt`, a claude AskUserQuestion; #2521's reported
 * Command Code question screen) and over variants of them written to a
 * temporary directory (`os.tmpdir()`, removed after each test): the marker
 * moved to option 2, on two options, on none, on the free-text row, at the end
 * of a description, wrapped onto its own row, and a title the pane may have
 * wrapped into its description.
 *
 * Positive controls (fail on the implementation before #3863):
 * - under `recommended` the claude question is answered (it was withheld as a
 *   question whatever the setting), and with option 2's number when option 2
 *   is the recommended one (the default is 1);
 * - under `careful` Command Code's question is withheld (its `legacy` gate let
 *   it through), and so is claude's under `CM_AUTOYES_DIALOG_GATE=claude=legacy`
 *   (the kill switch used to bring the answer back);
 * - the ledger's lines carry the mode.
 * Negative controls: a permission is answered alike under both modes; a
 * screen with no question is unchanged; the confirm page is still withheld.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) => sendPromptAnswer(params as { answer: string }),
}));
vi.mock('@/lib/tmux/tmux', () => ({ sendSpecialKeys: vi.fn(async () => {}) }));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(async () => ''),
  captureSessionOutputFresh: vi.fn(async () => ''),
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
      getTool: (id: string) => ({
        name: id,
        getSessionName: (worktreeId: string, instanceId?: string) => `cm-${worktreeId}-${instanceId ?? id}`,
      }),
    }),
  },
}));

const mockLogger = vi.hoisted(() => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createTask } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { AUTO_YES_DIALOG_GATE_ENV_VAR } from '@/lib/polling/auto-yes-dialog-gate';
import { withheldAtSend } from '@/lib/polling/auto-yes-poller-steps';
import type { JudgedPrompt } from '@/lib/polling/auto-yes-prompt-suppression';
import {
  clearAllAutoYesStates,
  getAutoYesState,
  POLLING_INTERVAL_MS,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import { clearAllPollerStates, detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import {
  resetAutoYesConfirmationLedgerForTests,
  runAutoYesLedgerHourForTests,
  setAutoYesLedgerClockTimersForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';
import type { AutoYesAnswerMode } from '@/types/auto-yes-answer-mode';
import { clearAutoYesDecisions, publishAutoYesDecision } from '@/lib/polling/auto-yes-decision-state';

const WT = 'wt-3863';
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Live captures (see each directory's README). */
const CLAUDE_QUESTION = read('fixtures/claude-live-2486/tabs-q1.txt');
const CLAUDE_PREVIEW_QUESTION = read('fixtures/claude-live-2486/preview-q1.txt');
const CLAUDE_CONFIRM_PAGE = read('fixtures/claude-live-2486/tabs-preview-review.txt');
const CLAUDE_BASH_APPROVAL = read('unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt');
const COMMAND_CODE_QUESTION = read('fixtures/command-code-askuserquestion-2521/askuserquestion-wrapped-1530-200x1000.txt');
const COMMAND_CODE_SHELL_DIALOG = read('fixtures/command-code-live-2250/dialog-shell-command.txt');

/** The rows of the claude capture the variants edit, as captured. */
const CLAUDE_OPTION_1_TITLE = '整えた状態で続行 (Recommended)';
const CLAUDE_OPTION_1_PLAIN = '整えた状態で続行';
const CLAUDE_OPTION_2_TITLE = 'ファイル読取のみで続行';
const CLAUDE_OPTION_2_DESCRIPTION_END = 'Recommended Next Actions に回ります。';

let tmpDir: string | null = null;

/**
 * A variant of a live capture, written to and read back from a temporary
 * directory: the repository's fixtures are never edited.
 */
function variant(source: string, edits: ReadonlyArray<[string, string]>): string {
  let text = source;
  for (const [from, to] of edits) {
    expect(text.includes(from), `the capture holds ${JSON.stringify(from)}`).toBe(true);
    text = text.replace(from, to);
  }
  tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'cm-3863-'));
  const file = path.join(tmpDir, `variant-${fs.readdirSync(tmpDir).length}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  return fs.readFileSync(file, 'utf8');
}

/** An ASCII title long enough to fill the captured pane's option row. */
const LONG_TITLE = `Continue with the prepared permissions ${'and keep every child as it is '.repeat(5)}`.trimEnd();

const CLAUDE_REC_ON_2 = (): string =>
  variant(CLAUDE_QUESTION, [
    [CLAUDE_OPTION_1_TITLE, CLAUDE_OPTION_1_PLAIN],
    [`2.\u001b[39m ${CLAUDE_OPTION_2_TITLE}`, `2.\u001b[39m ${CLAUDE_OPTION_2_TITLE} (Recommended)`],
  ]);
const CLAUDE_REC_ON_BOTH = (): string =>
  variant(CLAUDE_QUESTION, [[`2.\u001b[39m ${CLAUDE_OPTION_2_TITLE}`, `2.\u001b[39m ${CLAUDE_OPTION_2_TITLE}（推奨）`]]);
const CLAUDE_NO_REC = (): string => variant(CLAUDE_QUESTION, [[CLAUDE_OPTION_1_TITLE, CLAUDE_OPTION_1_PLAIN]]);
/** Option 2's DESCRIPTION ends in the marker; no title carries one. */
const CLAUDE_MARKER_IN_DESCRIPTION = (): string =>
  variant(CLAUDE_QUESTION, [
    [CLAUDE_OPTION_1_TITLE, CLAUDE_OPTION_1_PLAIN],
    [CLAUDE_OPTION_2_DESCRIPTION_END, `${CLAUDE_OPTION_2_DESCRIPTION_END} (Recommended)`],
  ]);
/** Option 2's title fills the pane and its marker is drawn alone on the row under it. */
const CLAUDE_MARKER_WRAPPED = (): string =>
  variant(CLAUDE_QUESTION, [
    [CLAUDE_OPTION_1_TITLE, CLAUDE_OPTION_1_PLAIN],
    [`2.\u001b[39m ${CLAUDE_OPTION_2_TITLE}`, `2.\u001b[39m ${LONG_TITLE}${' '.repeat(10)}\n     (Recommended)`],
  ]);
/** Option 2's title fills the pane: the row under it may be its wrap or its description. */
const CLAUDE_TITLE_UNDELIMITED = (): string =>
  variant(CLAUDE_QUESTION, [[`2.\u001b[39m ${CLAUDE_OPTION_2_TITLE}`, `2.\u001b[39m ${LONG_TITLE}`]]);

const CC_OPTION_1 = 'Prepare worktrees + dispatch (Recommended)';
const CC_OPTION_2 = 'Worktrees only, then pause';
const CC_REC_ON_2 = (): string =>
  variant(COMMAND_CODE_QUESTION, [
    [CC_OPTION_1, 'Prepare worktrees + dispatch'],
    [CC_OPTION_2, `${CC_OPTION_2} (Recommended)`],
  ]);
const CC_REC_ON_FREE_TEXT = (): string =>
  variant(COMMAND_CODE_QUESTION, [
    [CC_OPTION_1, 'Prepare worktrees + dispatch'],
    ['Type something...', 'Type something... (Recommended)'],
  ]);

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

/** One tick over `raw`, with the raw capture, the way `pollAutoYes` calls it. */
function tick(tool: CLIToolType, raw: string, state = pollerState(tool)): ReturnType<typeof detectAndRespondToPrompt> {
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(WT, state, tool, clean, clean.split('\n'), undefined, raw);
}

function enable(tool: CLIToolType, answerMode?: AutoYesAnswerMode): void {
  setAutoYesEnabled(WT, tool, true, 3_600_000, undefined, undefined, answerMode);
}

/** What the reader says about each option's title, on the poller's own spelling. */
function recommendationsOf(tool: CLIToolType, raw: string): unknown {
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectPromptOnCleanFrame(clean, tool, clean.split('\n'), raw).optionRecommendations;
}

const sentAnswers = (): string[] => sendPromptAnswer.mock.calls.map(([params]) => params.answer);
const ledger = (event: string): Array<Record<string, unknown>> =>
  mockLogger.info.mock.calls.filter(([name]) => name === event).map(([, data]) => data as Record<string, unknown>);

function seedTask(cliToolId: CLIToolType, autoYes: string): void {
  createTask(db, {
    worktreeId: WT,
    cliToolId,
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
}

const originalGateEnv = process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  mockLogger.withContext.mockReturnValue(mockLogger);
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  clearAllPollerStates();
  clearAllAutoYesStates();
  clearAutoYesDecisions();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
  delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
});

afterEach(() => {
  db.close();
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  clearAllPollerStates();
  clearAllAutoYesStates();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  if (originalGateEnv === undefined) delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
  else process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = originalGateEnv;
  if (tmpDir !== null) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

// ---------------------------------------------------------------------------
// The readers
// ---------------------------------------------------------------------------

describe('[#3863] the readers say what each option title shows', () => {
  it('claude AskUserQuestion: the title, not the description under it', () => {
    expect(recommendationsOf('claude', CLAUDE_QUESTION)).toEqual([true, false, false, false]);
    expect(recommendationsOf('claude', CLAUDE_REC_ON_2())).toEqual([false, true, false, false]);
    expect(recommendationsOf('claude', CLAUDE_REC_ON_BOTH())).toEqual([true, true, false, false]);
    expect(recommendationsOf('claude', CLAUDE_MARKER_IN_DESCRIPTION())).toEqual([false, false, false, false]);
  });

  it('claude: a marker wrapped onto its own row belongs to the title (live preview capture, and a wide title)', () => {
    expect(recommendationsOf('claude', CLAUDE_PREVIEW_QUESTION)).toEqual([true, false]);
    expect(recommendationsOf('claude', CLAUDE_MARKER_WRAPPED())).toEqual([false, true, false, false]);
  });

  it("claude: a title that may have wrapped into its description is 'unknown', never false", () => {
    expect(recommendationsOf('claude', CLAUDE_TITLE_UNDELIMITED())).toEqual([true, 'unknown', false, false]);
  });

  it('command-code: the title row, the description indented under it and the pane wrap under that', () => {
    expect(recommendationsOf('command-code', COMMAND_CODE_QUESTION)).toEqual([true, false, false, false]);
    expect(recommendationsOf('command-code', CC_REC_ON_2())).toEqual([false, true, false, false]);
  });

  it('command-code: （推奨） at the end of a Japanese title, and descriptions at indent 0 / 1 / 2 (#2522 shapes)', () => {
    expect(recommendationsOf('command-code', read('fixtures/command-code-askuserquestion-2522/question-japanese-fullwidth.txt'))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(
      recommendationsOf('command-code', read('fixtures/command-code-askuserquestion-2522/question-description-indent-0-1-2.txt')),
    ).toEqual([false, false, false]);
  });

  it('negative: a permission dialog carries no reading (it is not a question)', () => {
    expect(recommendationsOf('claude', CLAUDE_BASH_APPROVAL)).toBeUndefined();
    expect(recommendationsOf('command-code', COMMAND_CODE_SHELL_DIALOG)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// recommended (おまかせ)
// ---------------------------------------------------------------------------

describe('[#3863] recommended: a question is answered with its recommended option', () => {
  it('claude: the recommended option (1), Auto-Yes on without a mode', async () => {
    enable('claude');
    expect(getAutoYesState(WT, 'claude')?.answerMode).toBe('recommended');
    expect(await tick('claude', CLAUDE_QUESTION)).toBe('responded');
    expect(sentAnswers()).toEqual(['1']);
  });

  it('claude: option 2 when option 2 is the recommended one, though the cursor is on 1', async () => {
    enable('claude', 'recommended');
    expect(await tick('claude', CLAUDE_REC_ON_2())).toBe('responded');
    expect(sentAnswers()).toEqual(['2']);
  });

  it('claude: no recommended option → the default (the cursor), and a marker in a description does not count', async () => {
    enable('claude', 'recommended');
    expect(await tick('claude', CLAUDE_NO_REC())).toBe('responded');
    expect(await tick('claude', CLAUDE_MARKER_IN_DESCRIPTION(), pollerState('claude'))).toBe('responded');
    expect(sentAnswers()).toEqual(['1', '1']);
  });

  it('claude: the marker wrapped onto the next row is read with its title', async () => {
    enable('claude', 'recommended');
    expect(await tick('claude', CLAUDE_MARKER_WRAPPED())).toBe('responded');
    expect(sentAnswers()).toEqual(['2']);
  });

  it.each([
    ['two recommended options', CLAUDE_REC_ON_BOTH],
    ['a title that cannot be told from its description', CLAUDE_TITLE_UNDELIMITED],
  ] as const)('claude: %s → no key, recommended-option-unidentified', async (_name, frame) => {
    enable('claude', 'recommended');
    expect(await tick('claude', frame())).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'claude')).toMatchObject({ reason: 'recommended-option-unidentified' });
  });

  it('command-code: the recommended option, by its number', async () => {
    enable('command-code', 'recommended');
    expect(await tick('command-code', COMMAND_CODE_QUESTION)).toBe('responded');
    expect(await tick('command-code', CC_REC_ON_2(), pollerState('command-code'))).toBe('responded');
    expect(sentAnswers()).toEqual(['1', '2']);
  });

  it('command-code: the recommended option is the free-text row → no key', async () => {
    enable('command-code', 'recommended');
    expect(await tick('command-code', CC_REC_ON_FREE_TEXT())).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'command-code')).toMatchObject({ reason: 'recommended-option-unidentified' });
  });

  it('the contract is the ceiling: mode safe still withholds the question (type-not-allowed)', async () => {
    enable('claude', 'recommended');
    seedTask('claude', 'autoYes:\n  mode: safe\n');
    expect(await tick('claude', CLAUDE_QUESTION)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'claude')).toMatchObject({ reason: 'type-not-allowed' });
  });

  it('negative: the Submit/Cancel confirm page is still left to a human', async () => {
    enable('claude', 'recommended');
    expect(await tick('claude', CLAUDE_CONFIRM_PAGE)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'claude')).toMatchObject({ reason: 'question-confirm-page' });
  });
});

// ---------------------------------------------------------------------------
// careful (慎重)
// ---------------------------------------------------------------------------

describe('[#3863] careful: a question is left to a human', () => {
  it.each([
    ['claude', CLAUDE_QUESTION],
    ['command-code', COMMAND_CODE_QUESTION],
  ] as const)('%s: no key, question-left-to-human', async (tool, raw) => {
    enable(tool, 'careful');
    expect(await tick(tool, raw)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, tool)).toMatchObject({ reason: 'question-left-to-human' });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'poller:auto-yes-skipped-question',
      expect.objectContaining({ answerMode: 'careful' }),
    );
  });

  it('the kill switch (CM_AUTOYES_DIALOG_GATE=claude=legacy) does not bring the answer back', async () => {
    process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = 'claude=legacy';
    enable('claude', 'careful');
    expect(await tick('claude', CLAUDE_QUESTION)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'claude')).toMatchObject({ reason: 'question-left-to-human' });
  });

  it('an allow-listed contract naming multiple_choice does not bring it back either', async () => {
    enable('command-code', 'careful');
    seedTask('command-code', 'autoYes:\n  mode: allow-listed\n  allowPromptTypes: [multiple_choice]\n');
    expect(await tick('command-code', COMMAND_CODE_QUESTION)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });
});

describe('[#3863] negative: a permission is answered alike under both modes', () => {
  it.each(['recommended', 'careful'] as const)('%s', async (mode) => {
    enable('claude', mode);
    enable('command-code', mode);
    expect(await tick('claude', CLAUDE_BASH_APPROVAL)).toBe('responded');
    expect(await tick('command-code', COMMAND_CODE_SHELL_DIALOG)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(2);
    expect(getLastPolicySuppression(WT, 'claude')).toBeNull();
    expect(getLastPolicySuppression(WT, 'command-code')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The last look before the key
// ---------------------------------------------------------------------------

describe('[#3863] the mode is read again right before the key', () => {
  const judgedQuestion = (answerMode: AutoYesAnswerMode): JudgedPrompt => {
    const clean = stripBoxDrawing(stripAnsi(CLAUDE_QUESTION));
    const detection = detectPromptOnCleanFrame(clean, 'claude', clean.split('\n'), CLAUDE_QUESTION);
    return {
      worktreeId: WT,
      cliToolId: 'claude',
      instanceId: undefined,
      compositeKey: `${WT}:claude`,
      pollerState: pollerState('claude'),
      promptData: detection.promptData!,
      promptKey: 'k',
      frameKey: 'f',
      optionRecommendations: detection.optionRecommendations,
      answerMode,
    };
  };

  it('a tick that began under recommended sends nothing once the grant is careful', () => {
    enable('claude', 'careful');
    expect(withheldAtSend(judgedQuestion('recommended'), true)).toBe(true);
    expect(getLastPolicySuppression(WT, 'claude')).toMatchObject({ reason: 'question-left-to-human' });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'poller:auto-yes-skipped-question',
      expect.objectContaining({ answerMode: 'careful', atSend: true }),
    );
  });

  it('negative: still recommended, the key goes', () => {
    enable('claude', 'recommended');
    expect(withheldAtSend(judgedQuestion('recommended'), true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

describe('[#3863] the ledger records the mode the decision was made under', () => {
  it('the withheld interval, its checkpoint and the closing line carry careful', async () => {
    enable('claude', 'careful');
    const state = pollerState('claude');
    expect(await tick('claude', CLAUDE_QUESTION, state)).toBe('no_answer');
    expect(ledger(EV.withholdStarted)).toEqual([
      expect.objectContaining({ reason: 'question-left-to-human', answerMode: 'careful' }),
    ]);
    runAutoYesLedgerHourForTests(Date.now());
    expect(ledger(EV.checkpoint)).toEqual([expect.objectContaining({ answerMode: 'careful' })]);
    expect(await tick('claude', 'nothing on screen\n', state)).toBe('no_prompt');
    expect(ledger(EV.withholdEnded)).toEqual([expect.objectContaining({ answerMode: 'careful' })]);
    expect(ledger(EV.closed)).toEqual([expect.objectContaining({ decision: 'withhold', answerMode: 'careful' })]);
  });

  it('the send attempt and the closing line carry recommended', async () => {
    enable('claude', 'recommended');
    const state = pollerState('claude');
    expect(await tick('claude', CLAUDE_QUESTION, state)).toBe('responded');
    expect(ledger(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'ok', answerMode: 'recommended' })]);
    expect(await tick('claude', 'nothing on screen\n', state)).toBe('no_prompt');
    expect(ledger(EV.closed)).toEqual([expect.objectContaining({ decision: 'answer', answerMode: 'recommended' })]);
  });
});

// ---------------------------------------------------------------------------
// The published decision
// ---------------------------------------------------------------------------

describe('[#3863] the decision a mode made does not outlive the mode', () => {
  const published = (raw: string) => {
    const clean = stripBoxDrawing(stripAnsi(raw));
    return publishAutoYesDecision({
      compositeKey: `${WT}:claude`,
      grant: getAutoYesState(WT, 'claude'),
      promptData: detectPromptOnCleanFrame(clean, 'claude', clean.split('\n'), raw).promptData,
      pollerActive: true,
    });
  };

  it('careful: withheld (question-left-to-human); the mode changed on the same screen: none until judged again', async () => {
    enable('claude', 'careful');
    expect(await tick('claude', CLAUDE_QUESTION)).toBe('no_answer');
    expect(published(CLAUDE_QUESTION)).toMatchObject({ state: 'withheld', reason: 'question-left-to-human' });

    enable('claude', 'recommended');
    expect(published(CLAUDE_QUESTION).state).toBe('none');
  });

  it('recommended, unidentified: withheld with its own reason', async () => {
    enable('claude', 'recommended');
    const raw = CLAUDE_REC_ON_BOTH();
    expect(await tick('claude', raw)).toBe('no_answer');
    expect(published(raw)).toMatchObject({ state: 'withheld', reason: 'recommended-option-unidentified' });
  });
});
