/**
 * Issue #3822: Auto-Yes answers a permission dialog with its one "allow this
 * call once" row, by number — never the row that saves a rule, changes the
 * mode or denies, wherever the cursor or the default is.
 *
 * Until #3822 the resolver sent the default row, or row 1. On agy the `>` stays
 * where the operator left it, so a dialog drawn with the cursor on `4. No`
 * (`antigravity-live-2364/dialog-bash-wrapped-highlight-4.txt`) was answered
 * `4`; a cursor on `Yes, allow all edits` or `don't ask again` would have been
 * answered with that row.
 *
 * - The rows are read by `polling/auto-yes-option-effect`, whose rules come
 *   from the live captures read here, one by one (positive: each tool's own
 *   dialog reads as expected and is answered with its allow-once number).
 * - Frames with the cursor moved onto another row are the same captures with
 *   the marker moved, written to a temp dir and read back.
 * - The row order and the "no allow-once row" / "two of them" screens are
 *   built from the captures' own labels (the order is not one any capture has).
 * - Negative controls: tools with no table, and a numbered list whose rows no
 *   table recognises, keep the pre-#3822 default-row reading.
 *
 * @vitest-environment node
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';
import {
  OPTION_EFFECT_TOOLS,
  readOptionEffect,
  selectAllowOnceOption,
  type AutoYesOptionEffect,
} from '@/lib/polling/auto-yes-option-effect';
import { resolveAutoAnswer, resolveAutoAnswerWithPolicy } from '@/lib/polling/auto-yes-resolver';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { clearEnterFallbacks } from '@/lib/polling/auto-yes-enter-fallback';
import {
  recordAntigravityPermissionReceipt,
  resetAntigravityPermissionReceiptsForTests,
} from '@/lib/polling/antigravity-permission-receipts';
import { clearAllAutoYesStates, POLLING_INTERVAL_MS } from '@/lib/auto-yes-state';
import { clearAllPollerStates, detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import type { MultipleChoiceOption, MultipleChoicePromptData } from '@/types/models';

const WT = 'wt-3822-effect';
const ROOT = path.resolve(__dirname, '../..');
const fixture = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/** Live captures of each tool's permission dialog, and how their rows read. */
const DIALOGS: ReadonlyArray<{ tool: CLIToolType; rel: string; effects: AutoYesOptionEffect[] }> = [
  {
    tool: 'claude',
    rel: 'unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt',
    effects: ['allow-once', 'allow-persistent', 'deny'],
  },
  { tool: 'claude', rel: 'fixtures/canary/permission-dialog.raw.txt', effects: ['allow-once', 'mode-change', 'deny'] },
  {
    tool: 'claude',
    rel: 'fixtures/canary/permission-hook-no-decision.raw.txt',
    effects: ['allow-once', 'mode-change', 'deny'],
  },
  {
    tool: 'claude',
    rel: 'fixtures/tui-frame-footer-2776/claude-2.1.278-bash-approval-task-panel.txt',
    effects: ['allow-once', 'allow-persistent', 'deny'],
  },
  {
    tool: 'codex',
    rel: 'unit/lib/detection/fixtures/codex-live-1628/approval-run-command.txt',
    effects: ['allow-once', 'allow-persistent', 'deny'],
  },
  {
    tool: 'codex',
    rel: 'unit/lib/detection/fixtures/codex-live-1628/approval-apply-patch.txt',
    effects: ['allow-once', 'allow-persistent', 'deny'],
  },
  { tool: 'codex', rel: 'fixtures/codex-dialogs-0157/approval.txt', effects: ['allow-once', 'allow-persistent', 'deny'] },
  {
    tool: 'codex',
    rel: 'fixtures/codex-browser-use-2609/approval-form-browser-use.txt',
    effects: ['allow-once', 'allow-persistent', 'deny'],
  },
  {
    tool: 'antigravity',
    rel: 'fixtures/antigravity-live-2364/dialog-bash-oneline.txt',
    effects: ['allow-once', 'allow-persistent', 'allow-persistent', 'deny'],
  },
  {
    tool: 'antigravity',
    rel: 'fixtures/antigravity-live-2364/dialog-bash-wrapped-six.txt',
    effects: ['allow-once', 'allow-persistent', 'allow-persistent', 'deny', 'deny', 'deny'],
  },
  { tool: 'antigravity', rel: 'fixtures/antigravity-live-2364/dialog-create-file.txt', effects: ['allow-once', 'deny'] },
  {
    tool: 'antigravity',
    rel: 'fixtures/strict-respond-3812/permission-run-command.txt',
    effects: ['allow-once', 'allow-persistent', 'allow-persistent', 'deny'],
  },
  {
    tool: 'command-code',
    rel: 'fixtures/command-code-live-2250/dialog-shell-command.txt',
    effects: ['allow-once', 'allow-persistent', 'deny'],
  },
  {
    tool: 'command-code',
    rel: 'fixtures/command-code-live-2250/dialog-create-file.txt',
    effects: ['allow-once', 'mode-change', 'deny'],
  },
  {
    tool: 'command-code',
    rel: 'fixtures/command-code-plan-review-2763/after-approve.txt',
    effects: ['allow-once', 'allow-persistent', 'deny'],
  },
  {
    tool: 'copilot',
    rel: 'unit/lib/detection/fixtures/copilot-live-1885/permission-dialog.txt',
    effects: ['allow-once', 'allow-persistent', 'deny'],
  },
];

/** Live captures whose every row changes the permission mode. */
const MODE_PICKERS: ReadonlyArray<{ tool: CLIToolType; rel: string }> = [
  { tool: 'codex', rel: 'fixtures/codex-live-2310/dialog-permissions-picker.txt' },
  { tool: 'copilot', rel: 'unit/lib/detection/fixtures/copilot-picker-1895/picker-permissions.txt' },
];

function parse(tool: CLIToolType, raw: string): MultipleChoicePromptData {
  const clean = stripBoxDrawing(stripAnsi(raw));
  const result = detectPromptOnCleanFrame(clean, tool, clean.split('\n'), raw);
  expect(result.isPrompt).toBe(true);
  expect(result.promptData?.type).toBe('multiple_choice');
  return result.promptData as MultipleChoicePromptData;
}

/** A prompt built from real labels, renumbered in the order given, the cursor on `defaultIndex`. */
function promptFrom(labels: string[], defaultIndex = 0): MultipleChoicePromptData {
  return {
    type: 'multiple_choice',
    question: 'Do you want to proceed?',
    status: 'pending',
    options: labels.map(
      (label, index): MultipleChoiceOption => ({ number: index + 1, label, isDefault: index === defaultIndex }),
    ),
  };
}

const labelsOf = (tool: CLIToolType, rel: string): string[] =>
  parse(tool, fixture(rel)).options.map((option) => option.label);

let tmp: string | null = null;

/** The capture with the cursor marker moved from row `from` to row `to`, read back from a temp file. */
function withCursorMoved(rel: string, marker: string, from: number, to: number): string {
  const lines = stripAnsi(fixture(rel)).split('\n');
  const fromIndex = lines.findIndex((line) => line.includes(`${marker} ${from}. `));
  const toIndex = lines.findIndex((line, index) => index > fromIndex && line.includes(`  ${to}. `));
  expect(fromIndex).toBeGreaterThanOrEqual(0);
  expect(toIndex).toBeGreaterThan(fromIndex);
  lines[fromIndex] = lines[fromIndex].replace(`${marker} ${from}. `, `  ${from}. `);
  lines[toIndex] = lines[toIndex].replace(`  ${to}. `, `${marker} ${to}. `);
  tmp ??= mkdtempSync(path.join(os.tmpdir(), 'auto-yes-option-effect-3822-'));
  const file = path.join(tmp, `${path.basename(rel)}.${from}-${to}.txt`);
  writeFileSync(file, lines.join('\n'));
  return readFileSync(file, 'utf8');
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

function tick(tool: CLIToolType, raw: string): ReturnType<typeof detectAndRespondToPrompt> {
  lastTickRaw = raw;
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(WT, pollerState(tool), tool, clean, clean.split('\n'), undefined, raw);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  lastTickRaw = '';
  vi.clearAllMocks();
  mockLogger.withContext.mockReturnValue(mockLogger);
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  clearEnterFallbacks();
  clearAllPollerStates();
  clearAllAutoYesStates();
  resetAntigravityPermissionReceiptsForTests();
});

afterEach(() => {
  db.close();
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  clearEnterFallbacks();
  clearAllPollerStates();
  clearAllAutoYesStates();
  resetAntigravityPermissionReceiptsForTests();
  if (tmp !== null) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

// ---------------------------------------------------------------------------
// Reading the rows of live captures
// ---------------------------------------------------------------------------

describe('[#3822] each tool reads its own permission rows', () => {
  it.each(DIALOGS)('$tool: $rel', ({ tool, rel, effects }) => {
    const prompt = parse(tool, fixture(rel));
    expect(prompt.options.map((option) => readOptionEffect(option.label, tool))).toEqual(effects);
    // A caller that does not name the tool reads every table and agrees.
    expect(prompt.options.map((option) => readOptionEffect(option.label))).toEqual(effects);

    const once = prompt.options[effects.indexOf('allow-once')];
    expect(resolveAutoAnswerWithPolicy(prompt, undefined, tool)).toEqual({
      answer: String(once.number),
      suppressedBy: null,
    });
  });

  it.each(MODE_PICKERS)('$tool: every row of $rel is a mode change', ({ tool, rel }) => {
    const prompt = parse(tool, fixture(rel));
    expect(new Set(prompt.options.map((option) => readOptionEffect(option.label, tool)))).toEqual(
      new Set(['mode-change']),
    );
  });

  it('covers the tools with a captured numbered permission dialog, and no other', () => {
    expect([...OPTION_EFFECT_TOOLS].sort()).toEqual(['antigravity', 'claude', 'codex', 'command-code', 'copilot']);
  });
});

// ---------------------------------------------------------------------------
// Positive: the allow-once number, wherever the cursor is
// ---------------------------------------------------------------------------

describe('[#3822] the allow-once row is answered by its number, wherever the cursor is', () => {
  it('agy: the live dialog drawn with the cursor on `4. No` is answered 1 (was 4)', () => {
    const prompt = parse('antigravity', fixture('fixtures/antigravity-live-2364/dialog-bash-wrapped-highlight-4.txt'));
    expect(prompt.options.find((option) => option.isDefault)?.number).toBe(4);
    expect(resolveAutoAnswer(prompt, undefined, 'antigravity')).toBe('1');
  });

  it.each([
    // [tool, capture, cursor marker, the row the cursor is moved to, what that row does]
    ['claude', 'fixtures/canary/permission-dialog.raw.txt', '❯', 2, 'mode-change'],
    ['claude', 'unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt', '❯', 2, 'allow-persistent'],
    ['claude', 'unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt', '❯', 3, 'deny'],
    ['codex', 'unit/lib/detection/fixtures/codex-live-1628/approval-run-command.txt', '›', 2, 'allow-persistent'],
    ['command-code', 'fixtures/command-code-live-2250/dialog-create-file.txt', '❯', 2, 'mode-change'],
    ['command-code', 'fixtures/command-code-live-2250/dialog-shell-command.txt', '❯', 2, 'allow-persistent'],
    ['copilot', 'unit/lib/detection/fixtures/copilot-live-1885/permission-dialog.txt', '❯', 2, 'allow-persistent'],
  ] as const)('%s: %s, cursor %s moved to row %s (%s), is answered 1', (tool, rel, marker, to, effect) => {
    const prompt = parse(tool, withCursorMoved(rel, marker, 1, to));
    const cursor = prompt.options.find((option) => option.isDefault);
    // The control is real: the parser puts the default on the moved row.
    expect(cursor?.number).toBe(to);
    expect(readOptionEffect(cursor!.label, tool)).toBe(effect);
    expect(resolveAutoAnswerWithPolicy(prompt, undefined, tool)).toEqual({ answer: '1', suppressedBy: null });
  });

  it.each([
    ['antigravity', 'fixtures/antigravity-live-2364/dialog-bash-wrapped-six.txt'],
    ['codex', 'unit/lib/detection/fixtures/codex-live-1628/approval-run-command.txt'],
    ['claude', 'fixtures/canary/permission-dialog.raw.txt'],
  ] as const)('%s: the same labels in another order, cursor on row 1, answer the allow-once row', (tool, rel) => {
    const labels = labelsOf(tool, rel);
    const reordered = [...labels.slice(1), labels[0]];
    expect(resolveAutoAnswer(promptFrom(reordered, 0), undefined, tool)).toBe(String(reordered.length));
    expect(resolveAutoAnswer(promptFrom([labels[1], labels[0], ...labels.slice(2)], 0), undefined, tool)).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// Negative: no single allow-once row → nothing is answered
// ---------------------------------------------------------------------------

describe('[#3822] a permission dialog with no single allow-once row is not answered', () => {
  it.each(MODE_PICKERS)('$tool: $rel (modes only)', ({ tool, rel }) => {
    expect(resolveAutoAnswerWithPolicy(parse(tool, fixture(rel)), undefined, tool)).toEqual({
      answer: null,
      suppressedBy: 'allow-once-unidentified',
    });
  });

  it.each([
    ['antigravity', 'fixtures/antigravity-live-2364/dialog-bash-wrapped-six.txt'],
    ['claude', 'fixtures/canary/permission-dialog.raw.txt'],
    ['command-code', 'fixtures/command-code-live-2250/dialog-shell-command.txt'],
    ['codex', 'unit/lib/detection/fixtures/codex-live-1628/approval-apply-patch.txt'],
  ] as const)('%s: the labels of %s without the allow-once row', (tool, rel) => {
    const prompt = promptFrom(labelsOf(tool, rel).slice(1), 0);
    expect(resolveAutoAnswerWithPolicy(prompt, undefined, tool)).toEqual({
      answer: null,
      suppressedBy: 'allow-once-unidentified',
    });
    expect(selectAllowOnceOption(prompt.options, tool)).toEqual({ kind: 'unidentified', allowOnceCount: 0 });
  });

  it('two rows that read as allow-once: neither is guessed', () => {
    const [once, persistent, deny] = labelsOf('claude', 'fixtures/canary/permission-dialog.raw.txt');
    const prompt = promptFrom([once, persistent, once, deny], 0);
    expect(resolveAutoAnswerWithPolicy(prompt, undefined, 'claude')).toEqual({
      answer: null,
      suppressedBy: 'allow-once-unidentified',
    });
    expect(selectAllowOnceOption(prompt.options, 'claude')).toEqual({ kind: 'unidentified', allowOnceCount: 2 });
  });

  it('a contract cannot bring it back: the base rules withhold before the policy is read', () => {
    const prompt = parse('codex', fixture(MODE_PICKERS[0].rel));
    expect(
      resolveAutoAnswerWithPolicy(prompt, { mode: 'allow-listed', allowPromptTypes: ['multiple_choice'], denyPatterns: [] }, 'codex'),
    ).toEqual({ answer: null, suppressedBy: 'allow-once-unidentified' });
  });
});

// ---------------------------------------------------------------------------
// Negative controls: what keeps the pre-#3822 reading
// ---------------------------------------------------------------------------

describe('[#3822] controls: the default-row reading stays where no table applies', () => {
  const agyLabels = () => labelsOf('antigravity', 'fixtures/antigravity-live-2364/dialog-bash-oneline.txt');

  it.each(['gemini', 'opencode', 'opencode-v2', 'vibe-local'] as const)(
    '%s has no table: the default row is answered as before',
    (tool) => {
      expect(resolveAutoAnswer(promptFrom(agyLabels(), 2), undefined, tool)).toBe('3');
      expect(readOptionEffect('Yes', tool)).toBe('unknown');
    },
  );

  it('a numbered list none of whose rows is a permission row keeps the default (or row 1)', () => {
    const labels = ['On-premises deployment', 'Cloud-managed platform', 'Kubernetes'];
    expect(resolveAutoAnswer(promptFrom(labels, 1), undefined, 'claude')).toBe('2');
    expect(selectAllowOnceOption(promptFrom(labels).options, 'claude')).toEqual({ kind: 'not-a-permission-dialog' });
  });

  it('a `No` row alone does not make a permission dialog: codex\'s trust dialog keeps its reading', () => {
    const prompt = parse('codex', fixture('fixtures/codex-dialogs-0155/dialog-trust-directory.txt'));
    expect(prompt.options.map((option) => readOptionEffect(option.label, 'codex'))).toEqual(['unknown', 'deny']);
    expect(selectAllowOnceOption(prompt.options, 'codex')).toEqual({ kind: 'not-a-permission-dialog' });
    expect(resolveAutoAnswerWithPolicy(prompt, undefined, 'codex')).toEqual({ answer: '1', suppressedBy: null });
  });

  it('yes/no, a checkbox list and a typed allow-once row keep their own rules', () => {
    expect(
      resolveAutoAnswer(
        { type: 'yes_no', question: 'Proceed?', options: ['yes', 'no'], status: 'pending' },
        undefined,
        'claude',
      ),
    ).toBe('y');
    expect(resolveAutoAnswer({ ...promptFrom(['Yes', 'No']), multiSelect: true }, undefined, 'claude')).toBeNull();
    const typed = promptFrom(['Yes', 'No']);
    typed.options[0] = { ...typed.options[0], requiresTextInput: true };
    expect(resolveAutoAnswerWithPolicy(typed, undefined, 'claude')).toEqual({ answer: null, suppressedBy: null });
  });
});

// ---------------------------------------------------------------------------
// The poller sends the allow-once number, and records the withholding
// ---------------------------------------------------------------------------

describe('[#3822] the poller', () => {
  it('claude: the live dialog with the cursor on `Yes, allow all edits` is answered 1', async () => {
    expect(await tick('claude', withCursorMoved('fixtures/canary/permission-dialog.raw.txt', '❯', 1, 2))).toBe(
      'responded',
    );
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(sendPromptAnswer).toHaveBeenCalledWith(expect.objectContaining({ answer: '1' }));
  });

  it('agy: the dialog with the cursor on `4. No`, with its hook receipt, is answered 1', async () => {
    recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', Date.now());
    const raw = fixture('fixtures/antigravity-live-2364/dialog-bash-wrapped-highlight-4.txt');
    const clean = stripBoxDrawing(stripAnsi(raw));
    expect(
      await detectAndRespondToPrompt(WT, pollerState('antigravity'), 'antigravity', clean, clean.split('\n'), 'antigravity'),
    ).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledWith(expect.objectContaining({ answer: '1' }));
  });

  it('codex: the permission-mode picker gets no key, recorded as allow-once-unidentified', async () => {
    expect(await tick('codex', fixture(MODE_PICKERS[0].rel))).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'codex')).toMatchObject({
      reason: 'allow-once-unidentified',
      promptType: 'multiple_choice',
    });
  });

  it('negative: the live dialog as drawn (cursor on 1. Yes) is answered 1 as before', async () => {
    expect(await tick('claude', fixture('fixtures/canary/permission-dialog.raw.txt'))).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledWith(expect.objectContaining({ answer: '1' }));
    expect(getLastPolicySuppression(WT, 'claude')).toBeNull();
  });
});
