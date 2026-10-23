/**
 * Issue #3822: what Auto-Yes answers, and the last look before a key.
 *
 * - A generic `(y/n)` on an `enforce` tool is answered only where the tool's
 *   own `detectDialog` vouched for the frame; none of them draws one, so it is
 *   left to a human and recorded as `unclassified-frame` (the user's decision
 *   of 2026-10-20). `legacy` tools are unchanged (#3823).
 * - A question to the operator (an AskUserQuestion picker) is the human's; it
 *   is recorded as `question-left-to-human` (the confirm page after it keeps
 *   `question-confirm-page`).
 * - Right before the first key, the grant and the contract are read again
 *   (past the policy cache): a contract switched to `off`, a deny pattern added
 *   after the tick's lookup, a lookup that now fails, or a grant that ran out
 *   withholds the key.
 *
 * Positive controls are real captures: a claude Bash approval, a codex run
 * approval, a Command Code shell dialog and an agy approval with its hook
 * receipt, each answered as before.
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

let db: Database.Database;
let taskLookupFailure: Error | null = null;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    getActiveTaskForInstance: (...args: Parameters<typeof actual.getActiveTaskForInstance>) => {
      if (taskLookupFailure) throw taskLookupFailure;
      return actual.getActiveTaskForInstance(...args);
    },
  };
});

const sendPromptAnswer = vi.fn(async (_params: { answer: string }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) => sendPromptAnswer(params as { answer: string }),
}));
const sendSpecialKeys = vi.fn(async (_session: string, _keys: string[]) => {});
vi.mock('@/lib/tmux/tmux', () => ({
  sendSpecialKeys: (session: string, keys: string[]) => sendSpecialKeys(session, keys),
}));
let lastTickRaw = '';
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(async () => ''),
  captureSessionOutputFresh: vi.fn(async () => lastTickRaw),
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
import { clearAutoYesPolicyCache, getSessionAutoYesPolicy } from '@/lib/polling/auto-yes-policy';
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { AUTO_YES_ENTER_FALLBACK_ENV_VAR, clearEnterFallbacks } from '@/lib/polling/auto-yes-enter-fallback';
import {
  recordAntigravityPermissionReceipt,
  resetAntigravityPermissionReceiptsForTests,
} from '@/lib/polling/antigravity-permission-receipts';
import {
  AUTO_YES_DIALOG_GATE_ENV_VAR,
  evaluateAutoYesDialogGate,
  evaluateDialogPresence,
  isAutoYesQuestionPrompt,
  type AutoYesDialogGateVerdict,
} from '@/lib/polling/auto-yes-dialog-gate';
import { withheldAtSend } from '@/lib/polling/auto-yes-poller-steps';
import type { JudgedPrompt } from '@/lib/polling/auto-yes-prompt-suppression';
import { clearAllAutoYesStates, POLLING_INTERVAL_MS, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearAllPollerStates, detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import type { PromptData } from '@/types/models';

const WT = 'wt-3822';
const ROOT = path.resolve(__dirname, '../..');
const fixture = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/** Real captures (see each directory's README). */
const CLAUDE_BASH_APPROVAL = 'unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt';
const CODEX_RUN_APPROVAL = 'unit/lib/detection/fixtures/codex-live-1628/approval-run-command.txt';
const COMMAND_CODE_SHELL_DIALOG = 'fixtures/command-code-live-2250/dialog-shell-command.txt';
const AGY_BASH_DIALOG = 'fixtures/antigravity-live-2364/dialog-bash-oneline.txt';
const CLAUDE_ASK_USER_QUESTION = 'fixtures/claude-live-2486/tabs-q1.txt';

/** A bare `(y/n)` on the pane: no tool draws it as a dialog. */
const GENERIC_YES_NO = 'Do you want to proceed? (y/n)';
/** An agent's reply ending in a `(y/n)` it quotes (a script's own question). */
const REPLY_QUOTING_YES_NO = [
  '⏺ The install script will stop and ask you this before it overwrites anything:',
  '',
  '  Overwrite the existing config? (y/n)',
].join('\n');

/** A numbered list no detector reads: the Enter fallback's screen (#3397). */
const UNRECOGNISED_LIST = [
  '⏺ Pick one',
  '',
  '❯ 1. On-premises deployment',
  '  2. Cloud-managed platform',
  '  3. Kubernetes',
  '',
  '  Which one?',
].join('\n');

function pollerState(cliToolId: CLIToolType = 'claude'): AutoYesPollerState {
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
function tick(
  tool: CLIToolType,
  raw: string,
  state: AutoYesPollerState = pollerState(tool),
): ReturnType<typeof detectAndRespondToPrompt> {
  lastTickRaw = raw;
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(WT, state, tool, clean, clean.split('\n'), undefined, raw);
}

function seedTask(autoYes: string): void {
  createTask(db, {
    worktreeId: WT,
    cliToolId: 'claude',
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

const warnings = (event: string): Array<Record<string, unknown>> =>
  mockLogger.warn.mock.calls.filter(([name]) => name === event).map(([, data]) => data as Record<string, unknown>);

const enterCalls = () => sendSpecialKeys.mock.calls.filter(([, keys]) => keys.length === 1 && keys[0] === 'Enter');

const originalEnterEnv = process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR];
const originalGateEnv = process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  taskLookupFailure = null;
  lastTickRaw = '';
  vi.clearAllMocks();
  mockLogger.withContext.mockReturnValue(mockLogger);
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  clearEnterFallbacks();
  clearAllPollerStates();
  clearAllAutoYesStates();
  resetAntigravityPermissionReceiptsForTests();
  delete process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR];
  delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  clearEnterFallbacks();
  clearAllPollerStates();
  clearAllAutoYesStates();
  resetAntigravityPermissionReceiptsForTests();
  if (originalEnterEnv === undefined) delete process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR];
  else process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR] = originalEnterEnv;
  if (originalGateEnv === undefined) delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
  else process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = originalGateEnv;
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('[#3822] the dialog gate judges a yes/no prompt on an enforce tool', () => {
  it.each(['claude', 'codex', 'copilot', 'opencode', 'opencode-v2'] as const)(
    '%s: a (y/n) its rules do not vouch for is refused',
    (tool) => {
      const verdict = evaluateAutoYesDialogGate(tool, 'yes_no', GENERIC_YES_NO, {} as NodeJS.ProcessEnv);
      expect(verdict).toMatchObject({ allowed: false, dialog: null, mode: 'enforce', gated: true });
    },
  );

  it.each(['gemini', 'antigravity', 'vibe-local', 'command-code'] as const)(
    'negative: %s (legacy) is not judged, as before (#3823)',
    (tool) => {
      const verdict = evaluateAutoYesDialogGate(tool, 'yes_no', GENERIC_YES_NO, {} as NodeJS.ProcessEnv);
      expect(verdict).toMatchObject({ allowed: true, gated: false, mode: 'legacy' });
    },
  );

  it('negative: the kill switch puts a tool back to legacy for yes/no too', () => {
    const verdict = evaluateAutoYesDialogGate('claude', 'yes_no', GENERIC_YES_NO, {
      [AUTO_YES_DIALOG_GATE_ENV_VAR]: 'claude=legacy',
    } as unknown as NodeJS.ProcessEnv);
    expect(verdict).toMatchObject({ allowed: true, gated: false, mode: 'legacy' });
  });

  it('negative: the presence gate (History, /prompt-response) still reads a (y/n) as present', () => {
    expect(evaluateDialogPresence('claude', 'yes_no', GENERIC_YES_NO)).toMatchObject({
      present: true,
      gated: false,
    });
  });
});

describe('[#3822] a question is told from a permission', () => {
  const gate = (overrides: Partial<AutoYesDialogGateVerdict>): AutoYesDialogGateVerdict => ({
    allowed: true,
    dialog: { kind: 'dialog', options: ['1', '2'], answerMode: 'numbered' },
    mode: 'enforce',
    gated: true,
    ...overrides,
  });
  const picker = (isAskUserQuestion: boolean): PromptData => ({
    type: 'multiple_choice',
    question: 'Which approach?',
    status: 'pending',
    options: [
      { number: 1, label: 'A', isDefault: true },
      { number: 2, label: 'B', isDefault: false },
    ],
    ...(isAskUserQuestion ? { isAskUserQuestion: true } : {}),
  });

  it('an AskUserQuestion picker on a gated frame is a question', () => {
    expect(isAutoYesQuestionPrompt(picker(true), gate({}))).toBe(true);
  });

  it("OpenCode V2's question form is a question", () => {
    expect(
      isAutoYesQuestionPrompt(
        picker(false),
        gate({ dialog: { kind: 'question', options: ['1'], answerMode: 'numbered', submitMode: 'answer_only' } }),
      ),
    ).toBe(true);
  });

  it('negative: a permission dialog is not', () => {
    expect(
      isAutoYesQuestionPrompt(picker(false), gate({ dialog: { kind: 'permission', options: [], answerMode: 'numbered' } })),
    ).toBe(false);
  });

  it("negative: claude's `ask_user` (read off the approval's own rows, #3748) is not", () => {
    expect(
      isAutoYesQuestionPrompt(picker(false), gate({ dialog: { kind: 'ask_user', options: [], answerMode: 'numbered' } })),
    ).toBe(false);
  });

  it('negative: an ungated (legacy) frame is not judged (#3823)', () => {
    expect(isAutoYesQuestionPrompt(picker(true), gate({ gated: false, mode: 'legacy', dialog: null }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The poller: negatives
// ---------------------------------------------------------------------------

describe('[#3822] the poller leaves a generic yes/no to a human', () => {
  it.each([
    ['claude', GENERIC_YES_NO],
    ['claude', REPLY_QUOTING_YES_NO],
    ['codex', GENERIC_YES_NO],
  ] as const)('%s: %j gets no key, and the reason is recorded', async (tool, frame) => {
    expect(await tick(tool, frame)).toBe('no_answer');

    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, tool)).toMatchObject({
      reason: 'unclassified-frame',
      mode: null,
      promptType: 'yes_no',
    });
    expect(warnings('poller:auto-yes-skipped-unclassified-frame')).toEqual([
      expect.objectContaining({ promptType: 'yes_no', gateMode: 'enforce' }),
    ]);
  });

  it('Auto-Yes turned on with the (y/n) already open: still not answered, however many ticks', async () => {
    const state = pollerState('claude');
    for (let i = 0; i < 3; i++) expect(await tick('claude', GENERIC_YES_NO, state)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    // Recorded on every tick, warned once per frame.
    expect(warnings('poller:auto-yes-skipped-unclassified-frame')).toHaveLength(1);
  });

  it('the Enter fallback does not take it either (the frame is answerable, not unreadable)', async () => {
    process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR] = 'claude=enabled';
    const state = pollerState('claude');
    for (let i = 0; i < 3; i++) expect(await tick('claude', GENERIC_YES_NO, state)).toBe('no_answer');
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('negative: a legacy tool answers the same (y/n) as before (#3823)', async () => {
    expect(await tick('gemini', GENERIC_YES_NO)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledWith(expect.objectContaining({ answer: 'y' }));
  });
});

describe('[#3822] the poller leaves a question to a human', () => {
  it('claude: an AskUserQuestion picker gets no key, recorded as question-left-to-human', async () => {
    expect(await tick('claude', fixture(CLAUDE_ASK_USER_QUESTION))).toBe('no_answer');

    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'claude')).toMatchObject({
      reason: 'question-left-to-human',
      mode: null,
      promptType: 'multiple_choice',
    });
    expect(warnings('poller:auto-yes-skipped-question')).toEqual([
      expect.objectContaining({ reason: 'question-left-to-human', promptType: 'multiple_choice' }),
    ]);
  });

  it('an allow-listed contract naming multiple_choice does not delegate it', async () => {
    seedTask("autoYes:\n  mode: allow-listed\n  allowPromptTypes: [multiple_choice]\n");
    expect(await tick('claude', fixture(CLAUDE_ASK_USER_QUESTION))).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The poller: positives (real captures)
// ---------------------------------------------------------------------------

describe('[#3822] controls: a permission the tool vouches for is answered as before', () => {
  it.each([
    ['claude', CLAUDE_BASH_APPROVAL],
    ['codex', CODEX_RUN_APPROVAL],
    ['command-code', COMMAND_CODE_SHELL_DIALOG],
  ] as const)('%s: %s', async (tool, rel) => {
    expect(await tick(tool, fixture(rel))).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(getLastPolicySuppression(WT, tool)).toBeNull();
  });

  it('antigravity: the approval its hook asked about a moment ago', async () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', Date.now());
    const raw = fixture(AGY_BASH_DIALOG);
    const clean = stripBoxDrawing(stripAnsi(raw));
    expect(
      await detectAndRespondToPrompt(WT, pollerState('antigravity'), 'antigravity', clean, clean.split('\n'), 'antigravity'),
    ).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('a known "no contract" is answered (the fresh read finds none either)', async () => {
    expect(await tick('claude', fixture(CLAUDE_BASH_APPROVAL))).toBe('responded');
    expect(warnings('poller:auto-yes-suppressed-by-policy')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The last look before a key
// ---------------------------------------------------------------------------

/** The tick's own lookup reads the cache, as it would within the TTL. */
function primeNoContract(): void {
  expect(getSessionAutoYesPolicy(WT, 'claude')).toBeNull();
}

describe('[#3822] the contract is read again right before the key', () => {
  it('a deny pattern added after the cached lookup withholds the key', async () => {
    primeNoContract();
    seedTask("autoYes:\n  denyPatterns: ['probe1708-marker']\n");

    expect(await tick('claude', fixture(CLAUDE_BASH_APPROVAL))).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'claude')).toMatchObject({ reason: 'deny-pattern' });
    expect(warnings('poller:auto-yes-suppressed-by-policy')).toEqual([
      expect.objectContaining({ reason: 'deny-pattern', atSend: true }),
    ]);
  });

  it("a contract switched to `off` after the cached lookup withholds the key", async () => {
    primeNoContract();
    seedTask("autoYes:\n  mode: 'off'\n");

    expect(await tick('claude', fixture(CLAUDE_BASH_APPROVAL))).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'claude')).toMatchObject({ reason: 'mode-off', mode: 'off' });
  });

  it('a lookup that fails at the last look is "contract unknown": no key', async () => {
    primeNoContract();
    taskLookupFailure = new Error('SQLITE_BUSY');

    expect(await tick('claude', fixture(CLAUDE_BASH_APPROVAL))).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'claude')).toMatchObject({ reason: 'policy-lookup-failed', mode: null });
  });

  // Issue #3821: the Enter fallback is retired — the unreadable list gets no
  // key with or without the contract, so the contract is not read for it and
  // the frame is recorded as the dialog gate refused it.
  it('[#3821] the Enter fallback (retired): with a deny pattern added, no Enter', async () => {
    process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR] = 'claude=enabled';
    const state = pollerState('claude');
    expect(await tick('claude', UNRECOGNISED_LIST, state)).toBe('no_answer');
    seedTask("autoYes:\n  denyPatterns: ['Kubernetes']\n");

    expect(await tick('claude', UNRECOGNISED_LIST, state)).toBe('no_answer');
    expect(enterCalls()).toHaveLength(0);
    expect(getLastPolicySuppression(WT, 'claude')).toMatchObject({ reason: 'unclassified-frame' });
  });

  it('[#3821] the Enter fallback (retired): with nothing changed, no Enter either', async () => {
    process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR] = 'claude=enabled';
    const state = pollerState('claude');
    expect(await tick('claude', UNRECOGNISED_LIST, state)).toBe('no_answer');
    expect(await tick('claude', UNRECOGNISED_LIST, state)).toBe('no_answer');
    expect(enterCalls()).toHaveLength(0);
  });
});

describe('[#3822] the grant is read again right before the key (a poller tick)', () => {
  const judged = (): JudgedPrompt => ({
    worktreeId: WT,
    cliToolId: 'claude',
    instanceId: undefined,
    compositeKey: `${WT}:claude`,
    pollerState: pollerState('claude'),
    promptData: {
      type: 'multiple_choice',
      question: 'Do you want to proceed?',
      status: 'pending',
      options: [
        { number: 1, label: 'Yes', isDefault: true },
        { number: 2, label: 'No', isDefault: false },
      ],
    },
    promptKey: 'k',
    frameKey: 'f',
  });

  it('negative: on and inside its window, the key goes', () => {
    setAutoYesEnabled(WT, 'claude', true, 3_600_000);
    expect(withheldAtSend(judged(), true)).toBe(false);
  });

  it('expired since the tick began: no key, and nothing recorded as a suppression', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    setAutoYesEnabled(WT, 'claude', true, 3_600_000);
    vi.setSystemTime(1_800_000_000_000 + 3_600_001);

    expect(withheldAtSend(judged(), true)).toBe(true);
    expect(getLastPolicySuppression(WT, 'claude')).toBeNull();
    expect(warnings('poller:auto-yes-withheld-at-send')).toEqual([
      expect.objectContaining({ reason: 'expired' }),
    ]);
  });

  it('turned off since the tick began: no key', () => {
    setAutoYesEnabled(WT, 'claude', true, 3_600_000);
    setAutoYesEnabled(WT, 'claude', false);
    expect(withheldAtSend(judged(), true)).toBe(true);
    expect(warnings('poller:auto-yes-withheld-at-send')).toEqual([
      expect.objectContaining({ reason: 'auto-yes-disabled' }),
    ]);
  });

  it('negative: a direct caller (no generation) is not asked about the grant', () => {
    expect(withheldAtSend(judged(), false)).toBe(false);
  });
});
