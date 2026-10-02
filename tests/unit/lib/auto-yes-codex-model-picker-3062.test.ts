/**
 * Issue #3062: Auto-Yes must not answer codex's `/model` picker (either stage).
 * A digit there is an immediate decision, so the base rules' default would pick
 * the model and the reasoning effort. The same frames stay answerable through
 * `/prompt-response`, and approval / trust / hooks screens are unchanged.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Issue #2865: the poller answers only a session created in the worktree's own
// directory. Ownership itself is covered by tests/unit/tmux/session-ownership.test.ts.
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import fs from 'fs';
import path from 'path';
import { stripAnsi, stripBoxDrawing, buildDetectPromptOptions } from '@/lib/detection/cli-patterns';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import { evaluateDialogPresence, judgePromptResponse } from '@/lib/polling/auto-yes-dialog-gate';
import {
  CODEX_APPROVAL_PANE,
  CODEX_HOOKS_LIST_PANE,
  CODEX_TRUST_DIALOG_PANE,
} from '../../fixtures/codex-hooks-review-0148';
let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) => sendPromptAnswer(params as { answer: string }),
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
      getTool: () => ({ getSessionName: (id: string) => `mcbd-codex-${id}`, name: 'Codex CLI' }),
    }),
  },
}));

const warn = vi.fn();
// `withContext` is part of the logger contract and `detectThinking` uses it —
// which Issue #1928 made reachable from this test, because the Auto-Yes dialog
// gate consults codex's own detector (and therefore its #1160 staleness guard)
// before an answer is sent. A mock missing a method the production path calls
// does not fail as "unmocked"; it throws inside the poller's catch and every
// assertion here reads `'error'`.
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

import {
  clearPolicySuppressions,
  getLastPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';

const WORKTREE_ID = 'wt-3062';

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

/** The one observable that matters: what key the agent received, if any. */
function answersSent(): string[] {
  return sendPromptAnswer.mock.calls.map(([params]) => params.answer);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  clearPolicySuppressions();
});

afterEach(() => {
  db.close();
  clearPolicySuppressions();
});


const fixture = (rel: string): string =>
  fs.readFileSync(path.join(process.cwd(), 'tests/fixtures', rel), 'utf-8');

/** What the poller is handed: ANSI and box drawing already removed. */
const clean = (frame: string): string => stripBoxDrawing(stripAnsi(frame));

const PICKERS = [
  ['0.157.1 stage 1', 'codex-dialogs-0157/model-picker.txt'],
  ['0.157.1 stage 2 (effort)', 'codex-dialogs-0157/model-picker-effort.txt'],
  ['0.159.3 stage 1', 'agent-health-picker-3053/codex-model.txt'],
] as const;

describe('Auto-Yes leaves the codex /model picker alone', () => {
  it.each(PICKERS)('%s: sends nothing and records why', async (_name, rel) => {
    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState(),
      'codex',
      clean(fixture(rel))
    );

    expect(result).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    const suppression = getLastPolicySuppression(WORKTREE_ID, 'codex');
    expect(suppression?.reason).toBe('unclassified-frame');
    expect(suppression?.promptType).toBe('multiple_choice');
  });

  it('warns once per frame', async () => {
    const state = pollerState();
    const frame = clean(fixture(PICKERS[0][1]));
    await detectAndRespondToPrompt(WORKTREE_ID, state, 'codex', frame);
    await detectAndRespondToPrompt(WORKTREE_ID, state, 'codex', frame);
    expect(
      warn.mock.calls.filter(([action]) => action === 'poller:auto-yes-skipped-model-picker')
    ).toHaveLength(1);
  });

  it.each(PICKERS)('%s: /prompt-response still accepts an answer', (_name, rel) => {
    resetDetectPromptCache();
    const frame = fixture(rel);
    const prompt = detectPrompt(clean(frame), buildDetectPromptOptions('codex'));
    expect(prompt.isPrompt).toBe(true);
    const presence = evaluateDialogPresence('codex', 'multiple_choice', frame);
    expect(presence.present).toBe(true);
    expect(judgePromptResponse(prompt, presence)).toBeNull();
  });
});

describe('negative controls', () => {
  it('still answers an approval dialog', async () => {
    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState(),
      'codex',
      CODEX_APPROVAL_PANE
    );
    expect(result).toBe('responded');
    expect(answersSent()).toEqual(['1']);
  });

  it('does not answer the trust dialog or the hooks list (unchanged: launch dialogs)', async () => {
    for (const pane of [CODEX_TRUST_DIALOG_PANE, CODEX_HOOKS_LIST_PANE]) {
      await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'codex', pane);
    }
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.some(([action]) => action === 'poller:auto-yes-skipped-model-picker')
    ).toBe(false);
  });

  it('a reply quoting the footer on a waiting screen neither suppresses nor answers', async () => {
    const rows = fixture('codex-dialogs-0157/idle.txt').split('\n');
    rows[992] = '• The picker closes with this row:';
    rows[993] = '  enter select · esc back';
    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState(),
      'codex',
      clean(rows.join('\n'))
    );
    expect(result).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WORKTREE_ID, 'codex')).toBeNull();
  });
});
