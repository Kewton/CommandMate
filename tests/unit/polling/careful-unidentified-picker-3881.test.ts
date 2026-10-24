/**
 * Issue #3881 (the second half, finding 3): copilot's question (`ask_user`)
 * and codex's `request_user_input` draw the same picker as their menus, and
 * neither module marks a question (`isAskUserQuestion`). The `careful` answer
 * mode now leaves a copilot / codex numbered list nothing marks as a question
 * or as a permission to a human (`classifyAutoYesQuestion` → `unidentified`,
 * recorded as `question-left-to-human`); `recommended` answers it as before.
 *
 * Driven through the real `detectAndRespondToPrompt` over live captures
 * (copilot 1.0.80's permission dialog and `/permissions` picker, codex's
 * approval) and variants of two of them written to a temporary directory
 * (`os.tmpdir()`, removed after each test): the copilot picker and the codex
 * approval with their rows replaced by an `ask_user` / `request_user_input`-
 * like choice. No live capture of either question is in the repository; the
 * variants only ever withhold (nothing synthesised is answered that was not
 * answered before).
 *
 * Positive controls (fail on the implementation before this change): under
 * `careful` both variants are withheld, at the tick and at the last look
 * before the key. Negative controls: the same screens under `recommended` are
 * answered as before; the measured permission dialog, approval and the
 * `/permissions` picker (its rows read as mode changes) are not
 * `unidentified`; a claude list is not either (only the two tools are).
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
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import {
  AUTO_YES_DIALOG_GATE_ENV_VAR,
  QUESTION_EVIDENCE_UNREAD_TOOLS,
  classifyAutoYesQuestion,
  evaluateAutoYesDialogGate,
} from '@/lib/polling/auto-yes-dialog-gate';
import { withheldAtSend } from '@/lib/polling/auto-yes-poller-steps';
import type { JudgedPrompt } from '@/lib/polling/auto-yes-prompt-suppression';
import { clearAllAutoYesStates, POLLING_INTERVAL_MS, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearAllPollerStates, detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { clearAutoYesDecisions } from '@/lib/polling/auto-yes-decision-state';
import type { AutoYesAnswerMode } from '@/types/auto-yes-answer-mode';
import type { PromptData } from '@/types/models';

const WT = 'wt-3881-careful';
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Live captures (see each directory's README). */
const COPILOT_PERMISSIONS_PICKER = read('unit/lib/detection/fixtures/copilot-picker-1895/picker-permissions.txt');
const COPILOT_PERMISSION = read('unit/lib/detection/fixtures/copilot-live-1885/permission-dialog.txt');
const CODEX_APPROVAL = read('unit/lib/detection/fixtures/codex-live-1628/approval-run-command.txt');

let tmpDir: string | null = null;

/** A variant of a live capture, written to and read back from a temporary directory. */
function variant(source: string, edits: ReadonlyArray<[RegExp, string]>): string {
  let text = source;
  for (const [from, to] of edits) {
    expect(from.test(text), `the capture holds ${from}`).toBe(true);
    text = text.replace(from, to);
  }
  tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'cm-3881-careful-'));
  const file = path.join(tmpDir, `variant-${fs.readdirSync(tmpDir).length}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  return fs.readFileSync(file, 'utf8');
}

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

function clean(raw: string): string {
  return stripBoxDrawing(stripAnsi(raw));
}

/** One tick over `raw`, with the raw capture, the way `pollAutoYes` calls it. */
function tick(tool: CLIToolType, raw: string): ReturnType<typeof detectAndRespondToPrompt> {
  const text = clean(raw);
  return detectAndRespondToPrompt(WT, pollerState(tool), tool, text, text.split('\n'), undefined, raw);
}

function enable(tool: CLIToolType, answerMode: AutoYesAnswerMode): void {
  setAutoYesEnabled(WT, tool, true, 3_600_000, undefined, undefined, answerMode);
}

function promptOf(tool: CLIToolType, raw: string): PromptData {
  const text = clean(raw);
  const detection = detectPromptOnCleanFrame(text, tool, text.split('\n'), raw);
  expect(detection.isPrompt).toBe(true);
  return detection.promptData!;
}

const sentAnswers = (): string[] => sendPromptAnswer.mock.calls.map(([params]) => params.answer);

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

/** The copilot picker with an `ask_user`-like choice in place of its mode rows. */
const COPILOT_ASK_USER_LIKE = (): string =>
  variant(COPILOT_PERMISSIONS_PICKER, [
    [/Manual(\u001b\[[0-9;]*m)? \S*(\u001b\[[0-9;]*m)?/, 'Keep the branch'],
    [/Allow all/, 'Rebase onto develop'],
  ]);

/** The codex approval with a `request_user_input`-like choice in place of its rows. */
const CODEX_REQUEST_USER_INPUT_LIKE = (): string =>
  variant(CODEX_APPROVAL, [
    [/Yes, proceed \([^\n]*/, 'Cloud-managed platform'],
    [/Yes, and don't ask again for commands that start with[^\n]*/, 'On-premises'],
    [/No, and tell Codex what to do differently[^\n]*/, 'Containers'],
  ]);

const UNIDENTIFIED: ReadonlyArray<[string, CLIToolType, () => string]> = [
  ['copilot, an ask_user-like picker', 'copilot', COPILOT_ASK_USER_LIKE],
  ['codex, a request_user_input-like dialog', 'codex', CODEX_REQUEST_USER_INPUT_LIKE],
];

describe('[#3881] premises: what the tools read off these screens', () => {
  it('only copilot and codex are the tools without a question reader', () => {
    expect([...QUESTION_EVIDENCE_UNREAD_TOOLS].sort()).toEqual(['codex', 'copilot']);
  });

  it.each(UNIDENTIFIED)('%s: vouched for by the gate, with no question marker', (_label, tool, frame) => {
    const promptData = promptOf(tool, frame());
    expect(promptData.type).toBe('multiple_choice');
    expect(promptData.type === 'multiple_choice' && promptData.isAskUserQuestion).not.toBe(true);
    const gate = evaluateAutoYesDialogGate(tool, 'multiple_choice', clean(frame()));
    expect(gate.gated).toBe(true);
    expect(gate.allowed).toBe(true);
    // copilot calls it a picker (no `do you want to`), codex a permission (its approval footer).
    expect(gate.dialog?.kind).toBe(tool === 'copilot' ? 'picker' : 'permission');
  });
});

describe('[#3881] classifyAutoYesQuestion names the list it cannot tell', () => {
  it.each(UNIDENTIFIED)('%s → unidentified with the tool; null without (the reading before)', (_label, tool, frame) => {
    const promptData = promptOf(tool, frame());
    expect(classifyAutoYesQuestion(promptData, undefined, tool)).toBe('unidentified');
    expect(classifyAutoYesQuestion(promptData, undefined)).toBeNull();
    // A tool outside the two keeps null.
    expect(classifyAutoYesQuestion(promptData, undefined, 'claude')).toBeNull();
  });

  it('the measured screens whose rows read as permissions are not unidentified', () => {
    expect(classifyAutoYesQuestion(promptOf('copilot', COPILOT_PERMISSION), undefined, 'copilot')).toBeNull();
    expect(classifyAutoYesQuestion(promptOf('copilot', COPILOT_PERMISSIONS_PICKER), undefined, 'copilot')).toBeNull();
    expect(classifyAutoYesQuestion(promptOf('codex', CODEX_APPROVAL), undefined, 'codex')).toBeNull();
  });

  it('a yes/no prompt is never unidentified', () => {
    const yesNo: PromptData = { type: 'yes_no', question: 'Proceed?', options: ['yes', 'no'], status: 'pending' };
    expect(classifyAutoYesQuestion(yesNo, undefined, 'codex')).toBeNull();
  });
});

describe('[#3881] careful leaves the unidentified list to a human (positive)', () => {
  it.each(UNIDENTIFIED)('%s: no key, recorded as question-left-to-human', async (_label, tool, frame) => {
    enable(tool, 'careful');
    expect(await tick(tool, frame())).toBe('no_answer');
    expect(sentAnswers()).toEqual([]);
    expect(getLastPolicySuppression(WT, tool)?.reason).toBe('question-left-to-human');
  });

  it('the last look before the key withholds it too, under careful', () => {
    enable('copilot', 'careful');
    const judged = {
      worktreeId: WT,
      cliToolId: 'copilot',
      instanceId: 'copilot',
      compositeKey: `${WT}:copilot:copilot`,
      pollerState: pollerState('copilot'),
      promptData: promptOf('copilot', COPILOT_ASK_USER_LIKE()),
      promptKey: 'k',
      frameKey: 'f',
      answerMode: 'recommended',
    } as JudgedPrompt;
    // The tick began under `recommended`; the grant says `careful` now.
    expect(withheldAtSend(judged, true)).toBe(true);
    expect(getLastPolicySuppression(WT, 'copilot')?.reason).toBe('question-left-to-human');
  });
});

describe('[#3881] what does not change (negative)', () => {
  it.each(UNIDENTIFIED)('%s, under recommended: answered as before (its default row)', async (_label, tool, frame) => {
    enable(tool, 'recommended');
    expect(await tick(tool, frame())).toBe('responded');
    expect(sentAnswers()).toEqual(['1']);
  });

  it.each(['careful', 'recommended'] as const)('copilot permission dialog under %s: its allow-once row', async mode => {
    enable('copilot', mode);
    expect(await tick('copilot', COPILOT_PERMISSION)).toBe('responded');
    expect(sentAnswers()).toEqual(['1']);
  });

  it.each(['careful', 'recommended'] as const)('codex approval under %s: its allow-once row', async mode => {
    enable('codex', mode);
    expect(await tick('codex', CODEX_APPROVAL)).toBe('responded');
    expect(sentAnswers()).toEqual(['1']);
  });
});
