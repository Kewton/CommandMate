/**
 * Issue #2609 — codex's tool-call approval FORM is a dialog on every path that
 * reads it, not just on the status path.
 *
 * The defect: on a Browser use approval (`Field 1/1`, footer
 * `enter to submit | esc to cancel`) the status API said `waiting` /
 * `prompt_detected` and listed the three options, while `detectCodexDialog`
 * returned null because its entry gate only knew `press enter to
 * confirm/select`. `/prompt-response` reads that null as "the prompt is gone"
 * (`prompt_no_longer_active`, exit 99 for `respond`), and the Auto-Yes gate as
 * `unclassified-frame`.
 *
 * What this file pins:
 *  - the two readings now agree on the reported frame, on both spellings the
 *    detector is handed (as captured, and box-stripped as Auto-Yes sees it);
 *  - `1. Allow` and `3. Cancel` go out as those digits, and nothing resolves to
 *    `2. Always allow` unless 2 is what was sent;
 *  - the footer row is what vouches — erase or reword it, quote it in prose, or
 *    leave the block answered above a working turn, and the verdict is null.
 *
 * The fixture is the frame as the Issue quoted it (see its README): text, no
 * ANSI. `detectCodexDialog` reads the ANSI-stripped spelling, so that is the
 * input its verdict is a function of.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

// The keystrokes are the assertion. Everything above tmux is the real code:
// the poller, the dialog gate, the resolver and `sendPromptAnswer`.
const capturePane = vi.fn(async (_session: string, _lines?: number) => '');
const sendKeys = vi.fn(async (_session: string, _keys: string, _enter?: boolean) => {});
const sendSpecialKeys = vi.fn(async (_session: string, _keys: string[]) => {});
vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: (session: string, lines?: number) => capturePane(session, lines),
  sendKeys: (session: string, keys: string, enter?: boolean) => sendKeys(session, keys, enter),
  sendSpecialKeys: (session: string, keys: string[]) => sendSpecialKeys(session, keys),
}));

vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: (id: string) => `mcbd-codex-${id}`, name: 'Codex' }),
    }),
  },
}));

const warn = vi.fn();
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const mockLogger: Record<string, unknown> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: (...args: unknown[]) => warn(...(args as [])),
      error: vi.fn(),
      withContext: vi.fn(() => mockLogger),
    };
    return mockLogger;
  },
}));

import { runMigrations } from '@/lib/db/db-migrations';
import {
  buildDetectPromptOptions,
  stripAnsi,
  stripBoxDrawing,
  CODEX_SELECTION_LIST_PATTERN,
  CODEX_FORM_SUBMIT_FOOTER_PATTERN,
} from '@/lib/detection/cli-patterns';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import {
  AUTO_YES_DIALOG_GATE_ENV_VAR,
  evaluateAutoYesDialogGate,
  evaluateDialogPresence,
  judgePromptResponse,
} from '@/lib/polling/auto-yes-dialog-gate';
import { resolveAutoAnswer } from '@/lib/polling/auto-yes-resolver';
import {
  clearPolicySuppressions,
  getLastPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { PromptAnswerResolutionError, resolvePromptAnswer } from '@/lib/prompt-answer-semantic';
import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import type { DialogVerdict } from '@/lib/detection/tools/types';
import type { MultipleChoicePromptData } from '@/types/models';

const FIXTURE = path.resolve(
  __dirname,
  '../../../fixtures/codex-browser-use-2609/approval-form-browser-use.txt',
);
const FORM = readFileSync(FIXTURE, 'utf8');
const FOOTER = 'enter to submit | esc to cancel';
const WORKTREE_ID = 'wt-2609';

/** The spelling the Auto-Yes poller judges: `captureAndCleanOutput`, exactly. */
function asAutoYesSees(raw: string): string {
  return stripBoxDrawing(stripAnsi(raw));
}

/** `detectDialog` through the registry, i.e. with the context `detect.ts` builds. */
function dialogOf(raw: string): DialogVerdict | null {
  return getToolStatusDetector('codex').detectDialog(normalizeFrame(raw));
}

/** What `/prompt-response` parses before it verifies. */
function promptOf(raw: string) {
  return detectPrompt(asAutoYesSees(raw), buildDetectPromptOptions('codex'));
}

function choicesOf(raw: string): MultipleChoicePromptData {
  const data = promptOf(raw).promptData;
  if (data?.type !== 'multiple_choice') throw new Error('not a multiple-choice prompt');
  return data;
}

/** Replace the footer row, and fail loudly if it is not there to replace. */
function withFooter(raw: string, footer: string): string {
  const rows = raw.split('\n');
  const index = rows.findIndex(row => row.trim() === FOOTER);
  if (index < 0) throw new Error('fixture lost its footer row');
  rows[index] = footer === '' ? '' : `  ${footer}`;
  return rows.join('\n');
}

/**
 * The form left on screen after it was answered, with codex working under it.
 * The rows below the block are the shapes `codex-live-2310/turn-running.txt`
 * measured (0.153.2): the working line, the composer and the status bar.
 */
const ANSWERED_THEN_WORKING = [
  ...FORM.trimEnd().split('\n'),
  '',
  '• Working (7s • esc to interrupt)',
  '',
  '› Ask Codex to do anything',
  '',
  '  gpt-5.6-sol default · ~/share/work/github_kewton/commandmate',
  '',
].join('\n');

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'codex',
    instanceId: 'codex',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

const originalGateEnv = process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  capturePane.mockResolvedValue(FORM);
  clearPolicySuppressions();
  resetDetectPromptCache();
  delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
});

afterEach(() => {
  db.close();
  clearPolicySuppressions();
  if (originalGateEnv === undefined) delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
  else process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = originalGateEnv;
});

// ---------------------------------------------------------------------------
// The fixture is the reported frame. If this fails, nothing below means anything.
// ---------------------------------------------------------------------------

describe('[#2609] the fixture is the reported Browser use approval', () => {
  it('carries the question, the three options and the footer', () => {
    expect(FORM).toContain('Allow Browser use to access http://127.0.0.1:60311?');
    expect(FORM).toContain('› 1. Allow         Run the tool and continue.');
    expect(FORM).toContain('2. Always allow  Run the tool and remember this choice for future tool calls.');
    expect(FORM).toContain('3. Cancel        Cancel this tool call');
    expect(FORM.split('\n').map(row => row.trim())).toContain(FOOTER);
  });

  it('is outside the old footer whitelist, and inside the new footer row', () => {
    // Positive control for the defect: without both halves "the gate missed it"
    // is an untested claim about a regex.
    expect(CODEX_SELECTION_LIST_PATTERN.test(FORM)).toBe(false);
    // The new pattern is anchored to a whole row, and the rows it is handed are
    // trimmed (`findNumberedOptionBlock`'s footer), so that is what it is fed.
    const trimmedRows = FORM.split('\n').map(row => row.trim()).join('\n');
    expect(CODEX_FORM_SUBMIT_FOOTER_PATTERN.test(trimmedRows)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The defect: the status path and the send path disagreed.
// ---------------------------------------------------------------------------

describe('[#2609] status and the pre-send check agree on the form', () => {
  const spellings = [
    ['as captured', FORM],
    ['as Auto-Yes sees it', asAutoYesSees(FORM)],
  ] as const;

  it.each(spellings)('status is waiting / prompt_detected (%s)', (_label, frame) => {
    const result = detectSessionStatus(frame, 'codex');

    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(result.hasActivePrompt).toBe(true);
    expect(result.promptDetection.promptData?.type).toBe('multiple_choice');
  });

  it.each(spellings)('detectCodexDialog vouches for it as a numbered permission (%s)', (_label, frame) => {
    const dialog = dialogOf(frame);

    expect(dialog).not.toBeNull();
    expect(dialog!.kind).toBe('permission');
    expect(dialog!.answerMode).toBe('numbered');
    expect(dialog!.options).toHaveLength(3);
    expect(dialog!.options[0]).toMatch(/^Allow\s+Run the tool and continue\.$/);
    expect(dialog!.options[1]).toMatch(/^Always allow\s+Run the tool and remember/);
    expect(dialog!.options[2]).toMatch(/^Cancel\s+Cancel this tool call$/);
  });

  it('/prompt-response no longer refuses it as prompt_no_longer_active', () => {
    const prompt = promptOf(FORM);
    const presence = evaluateDialogPresence('codex', prompt.promptData?.type, FORM);

    expect(prompt.isPrompt).toBe(true);
    expect(presence.gated).toBe(true);
    expect(presence.present).toBe(true);
    expect(judgePromptResponse(prompt, presence)).toBeNull();
  });

  it('the Auto-Yes gate no longer calls it an unclassified frame', () => {
    const verdict = evaluateAutoYesDialogGate('codex', 'multiple_choice', asAutoYesSees(FORM));

    expect(verdict.gated).toBe(true);
    expect(verdict.allowed).toBe(true);
    expect(verdict.dialog?.answerMode).toBe('numbered');
  });

  it('the classic approval footer on the same rows is still vouched for (non-interference)', () => {
    const classic = withFooter(FORM, 'Press enter to confirm or esc to cancel');

    expect(dialogOf(classic)?.kind).toBe('permission');
    expect(judgePromptResponse(promptOf(classic), evaluateDialogPresence('codex', 'multiple_choice', classic)))
      .toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The answer lands on the option that was asked for.
// ---------------------------------------------------------------------------

describe('[#2609] 1. Allow and 3. Cancel are not confused with 2. Always allow', () => {
  it('the parser numbers the options as drawn and highlights only 1. Allow', () => {
    const data = choicesOf(FORM);

    expect(data.options.map(option => option.number)).toEqual([1, 2, 3]);
    expect(data.options[0].label).toMatch(/^Allow\b/);
    expect(data.options[1].label).toMatch(/^Always allow\b/);
    expect(data.options[2].label).toMatch(/^Cancel\b/);
    expect(data.options.filter(option => option.isDefault).map(option => option.number)).toEqual([1]);
  });

  it.each(['1', '3'])('respond %s types that digit, then Enter — no cursor arithmetic', async answer => {
    await sendPromptAnswer({
      sessionName: 'mcbd-codex-wt-2609',
      answer,
      cliToolId: 'codex',
      promptData: choicesOf(FORM),
      frame: FORM,
    });

    // The `numbered` verdict clears the #2033 guard, and codex takes the digit
    // as text: the only keys are the digit itself and the Enter after it.
    expect(sendKeys.mock.calls).toEqual([
      ['mcbd-codex-wt-2609', answer, false],
      ['mcbd-codex-wt-2609', '', true],
    ]);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('a yes/no answer is refused rather than mapped onto Always allow', () => {
    // No label here starts with "yes" or reads as a denial, so the semantic
    // resolver has nothing to pick — and must not fall back to a guess.
    for (const answer of ['yes', 'no']) {
      expect(() => resolvePromptAnswer({ answer, promptData: choicesOf(FORM) }))
        .toThrow(PromptAnswerResolutionError);
    }
  });

  it('Auto-Yes resolves to 1, the one-time Allow', () => {
    expect(resolveAutoAnswer(choicesOf(FORM))).toBe('1');
  });

  it('the Auto-Yes poller sends 1 and records no unclassified-frame suppression', async () => {
    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState(),
      'codex',
      asAutoYesSees(FORM),
    );

    expect(result).toBe('responded');
    expect(sendKeys.mock.calls[0]).toEqual(['mcbd-codex-wt-2609', '1', false]);
    expect(sendKeys.mock.calls.map(([, keys]) => keys)).not.toContain('2');
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WORKTREE_ID, 'codex')).toBeNull();
    expect(
      warn.mock.calls.some(([action]) => action === 'poller:auto-yes-skipped-unclassified-frame'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The footer row is load-bearing, and nothing else is admitted with it.
// ---------------------------------------------------------------------------

describe('[#2609] only the measured footer row vouches for the block', () => {
  const mutations = [
    ['the footer is erased', ''],
    ['the submit verb is reworded', 'enter to send | esc to cancel'],
    ['only the escape half is left', 'esc to cancel'],
    ['only the submit half is left', 'enter to submit'],
    ['the footer is quoted inside a sentence', `Codex will show "${FOOTER}" next.`],
  ] as const;

  it.each(mutations)('%s → no dialog, respond refuses, Auto-Yes suppresses', (_label, footer) => {
    const frame = withFooter(FORM, footer);
    const prompt = promptOf(frame);

    expect(dialogOf(frame)).toBeNull();
    expect(dialogOf(asAutoYesSees(frame))).toBeNull();
    if (prompt.isPrompt) {
      // The generic parser may still read three rows; the gate is what refuses.
      expect(judgePromptResponse(prompt, evaluateDialogPresence('codex', 'multiple_choice', frame)))
        .toEqual({ reason: 'prompt_no_longer_active' });
    }
    expect(evaluateAutoYesDialogGate('codex', 'multiple_choice', asAutoYesSees(frame)).allowed).toBe(false);
  });

  it('an agent reply that lists options and quotes the footer in prose is not a dialog', () => {
    const reply = [
      '• The approval form offers three choices:',
      '',
      '  1. Allow',
      '  2. Always allow',
      '  3. Cancel',
      '',
      `  and its footer reads "${FOOTER}".`,
      '',
    ].join('\n');

    expect(dialogOf(reply)).toBeNull();
    expect(evaluateAutoYesDialogGate('codex', 'multiple_choice', asAutoYesSees(reply)).allowed).toBe(false);
  });

  it('an answered form with codex working below it is scrollback, not a dialog', () => {
    // Positive control: the footer row is still inside the block's footer zone,
    // so it is the #1160 staleness guard that refuses here, not a missed match.
    expect(ANSWERED_THEN_WORKING.split('\n').map(row => row.trim())).toContain(FOOTER);

    expect(dialogOf(ANSWERED_THEN_WORKING)).toBeNull();
    expect(dialogOf(asAutoYesSees(ANSWERED_THEN_WORKING))).toBeNull();
    const status = detectSessionStatus(ANSWERED_THEN_WORKING, 'codex');
    expect(status.status).toBe('running');
    expect(status.hasActivePrompt).toBe(false);
  });

  it('the Auto-Yes poller sends nothing on a mutated footer and says why', async () => {
    const frame = asAutoYesSees(withFooter(FORM, 'enter to send | esc to cancel'));
    capturePane.mockResolvedValue(frame);

    const result = await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'codex', frame);

    expect(result).toBe('no_answer');
    expect(sendKeys).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WORKTREE_ID, 'codex')?.reason).toBe('unclassified-frame');
  });
});
