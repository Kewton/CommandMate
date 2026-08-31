/**
 * Issue #1829: the Auto-Yes poller must not answer codex's own launch dialogs.
 *
 * The base rules answer the *default* option of any multiple choice, and every
 * codex launch dialog defaults to option 1:
 *
 *   Hooks need review  -> 1. Review hooks    (measured: AUTO-YES ANSWER "1")
 *   Update available   -> 1. Update now      (measured: AUTO-YES ANSWER "1")
 *   Do you trust …     -> 1. Yes, continue
 *
 * `CodexTool.waitForReady` answers the same three screens deliberately and
 * differently — `'3'` declines the hooks review rather than trusting the
 * operator's `~/.codex/config.toml` (Issue #1760), and it answers the update
 * dialog by the operator's own policy rather than running `npm install -g
 * @openai/codex` unasked (Issue #890, made configurable by Issue #2068) — and
 * it only watches during `startSession`. The poller
 * runs on its own 2s phase forever, so whichever of the two sees the dialog
 * first decides. Both #1760 and #890 are undone whenever that is the poller.
 *
 * These tests drive the real `detectAndRespondToPrompt` over the real 0.148.0
 * pane captures and assert on `sendPromptAnswer` — the keystroke the agent
 * actually receives — because asserting on the resolver would leave the wiring,
 * which is the whole Issue, unverified.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import fs from 'fs';
import path from 'path';
import {
  CODEX_APPROVAL_PANE,
  CODEX_HOOKS_DETAIL_PANE,
  CODEX_HOOKS_LIST_PANE,
  CODEX_HOOKS_RESIDUAL_PLUS_PROMPT,
  CODEX_HOOKS_REVIEW_PANE,
  CODEX_HOOKS_STUCK_PANE,
  CODEX_TRUST_DIALOG_PANE,
  CODEX_UPDATE_DIALOG_PANE,
} from '../../fixtures/codex-hooks-review-0148';
import {
  CODEX_UPDATE_DIALOG_ENV_VAR,
  CODEX_UPDATE_DIALOG_POLICIES,
} from '@/config/codex-update-dialog-config';

/**
 * The same dialog as `CODEX_UPDATE_DIALOG_PANE`, captured live from codex-cli
 * 0.149.1 rather than written out (Issue #2068). Kept alongside the synthetic
 * one because this guard's whole job is to hold on the frame a real session
 * produces, scrollback and all.
 */
const CODEX_UPDATE_DIALOG_LIVE = fs.readFileSync(
  path.join(process.cwd(), 'tests/fixtures/codex-update-dialog-2068/update-dialog-01491.txt'),
  'utf-8'
);

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

const WORKTREE_ID = 'wt-1829';

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

describe('the poller leaves codex launch dialogs to CodexTool', () => {
  it('sends nothing to the hooks review dialog', async () => {
    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState(),
      'codex',
      CODEX_HOOKS_REVIEW_PANE
    );

    expect(result).toBe('no_answer');
    // Not "not 1" — nothing at all. Answering ANY option here confirms a
    // selection codex acts on instantly, and options 1 and 2 both do damage.
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('sends nothing to the update dialog — the #890 regression, restated', async () => {
    // "1" is `Update now`: npm install -g @openai/codex, which kills the codex
    // process the session is running in. Whatever `waitForReady` sends under
    // the operator's policy (Issue #2068), it is not the poller's to send.
    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState(),
      'codex',
      CODEX_UPDATE_DIALOG_PANE
    );

    expect(result).toBe('no_answer');
    expect(answersSent()).not.toContain('1');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('sends nothing to the LIVE 0.149.1 update dialog either', async () => {
    // Issue #2068: the same guard against the frame a real launch produces —
    // two launches of scrollback above the dialog, and the option row for the
    // dialog codex is actually waiting on at the bottom.
    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState(),
      'codex',
      CODEX_UPDATE_DIALOG_LIVE
    );

    expect(result).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('holds under every update-dialog policy, `ask` above all (Issue #2068)', async () => {
    // The acceptance condition of #2068: making the dialog answerable BY A
    // HUMAN must not make it answerable by the poller. `ask` is the dangerous
    // one — it is the policy under which the dialog is deliberately left up,
    // which is exactly the window in which an unguarded poller would send "1".
    for (const policy of CODEX_UPDATE_DIALOG_POLICIES) {
      vi.stubEnv(CODEX_UPDATE_DIALOG_ENV_VAR, policy);
      const result = await detectAndRespondToPrompt(
        WORKTREE_ID,
        pollerState(),
        'codex',
        CODEX_UPDATE_DIALOG_LIVE
      );
      expect(result).toBe('no_answer');
    }
    vi.unstubAllEnvs();

    expect(answersSent()).toEqual([]);
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('sends nothing to the directory trust dialog', async () => {
    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState(),
      'codex',
      CODEX_TRUST_DIALOG_PANE
    );

    expect(result).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('sends nothing to the hooks screens the dialog leads to', async () => {
    for (const pane of [CODEX_HOOKS_LIST_PANE, CODEX_HOOKS_DETAIL_PANE, CODEX_HOOKS_STUCK_PANE]) {
      await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'codex', pane);
    }
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('says why it went quiet, so a stalled `cmate wait` can report it', async () => {
    await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'codex', CODEX_HOOKS_REVIEW_PANE);

    const suppression = getLastPolicySuppression(WORKTREE_ID, 'codex');
    expect(suppression).not.toBeNull();
    expect(suppression!.reason).toBe('agent-launch-dialog');
    expect(suppression!.promptType).toBe('multiple_choice');
    expect(
      warn.mock.calls.some(([action]) => action === 'poller:auto-yes-skipped-launch-dialog')
    ).toBe(true);
  });
});

describe('the guard does not switch Auto-Yes off for codex', () => {
  it('still answers a genuine approval request', async () => {
    // The control. A guard that also swallowed this would "fix" Issue #1829 by
    // disabling the feature, and every Auto-Yes codex worker would stall.
    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState(),
      'codex',
      CODEX_APPROVAL_PANE
    );

    expect(result).toBe('responded');
    expect(answersSent()).toEqual(['1']);
  });

  it('still answers once a dismissed dialog is only scrollback above the prompt', async () => {
    // Issue #892's shape. A whole-frame guard would keep suppressing for as
    // long as the dialog text stayed in the 50-line capture window — i.e. for
    // the rest of the session, for every later prompt.
    const state = pollerState();
    await detectAndRespondToPrompt(WORKTREE_ID, state, 'codex', CODEX_HOOKS_RESIDUAL_PLUS_PROMPT);
    expect(sendPromptAnswer).not.toHaveBeenCalled(); // no prompt on that frame at all

    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      state,
      'codex',
      [CODEX_HOOKS_REVIEW_PANE, CODEX_HOOKS_LIST_PANE, '', CODEX_APPROVAL_PANE].join('\n')
    );
    expect(result).toBe('responded');
    expect(answersSent()).toEqual(['1']);
  });

  it('does not gag another CLI tool that prints the same words', async () => {
    // The anchors #1829 added are codex-scoped, and this is the control for it.
    //
    // Issue #1928 changed what this test has to feed in, without changing what
    // it proves. Auto-Yes now answers only where the tool's OWN `detectDialog`
    // vouched for the frame, so handing claude a pane drawn in codex's chrome no
    // longer answers anything — not because of #1829's anchors, but because it
    // is not a claude dialog. The wording is therefore re-rendered in claude's
    // chrome (`❯` cursor, `Esc to cancel · Tab to amend …` footer, measured in
    // `claude-live-1708/bash-approval-taskpanel.txt`): same words, claude's
    // dialog, and it must still be answered.
    const claudeDialogWithCodexWords = [
      '  Hooks need review',
      '  4 hooks are new or changed.',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Review hooks',
      '   2. Trust all and continue',
      "   3. Continue without trusting (hooks won't run)",
      '',
      ' Esc to cancel · Tab to amend · ctrl+e to explain',
    ].join('\n');

    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      { ...pollerState(), cliToolId: 'claude', instanceId: 'claude' },
      'claude',
      claudeDialogWithCodexWords
    );

    expect(result).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalled();
    // …and the reason it answered is not that #1829's guard was skipped for the
    // wrong reason: nothing was suppressed for claude at all.
    expect(getLastPolicySuppression(WORKTREE_ID, 'claude')).toBeNull();
  });
});
