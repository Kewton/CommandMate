/**
 * The wiring: Auto-Yes sends nothing for a frame no tool vouched for, and says
 * why (Issue #1928, 方針書 §4 D1 決定 4).
 *
 * `tests/unit/polling/auto-yes-dialog-gate.test.ts` proves the gate reaches the
 * right verdicts. This file proves the POLLER acts on them — it drives the real
 * `detectAndRespondToPrompt` and asserts on `sendPromptAnswer`, the keystroke the
 * agent actually receives, because asserting on the gate would leave the wiring
 * (which is the whole Issue) unverified. Same argument, same shape, as
 * `auto-yes-codex-launch-dialog-1829.test.ts`.
 *
 * The second half is the exposure. `#1924` landed
 * `AutoYesSuppressionReason.'unclassified-frame'` for exactly this position and
 * nothing produced it; a poller that goes quiet without a record is
 * indistinguishable from a hung worker, and `commandmate capture --json` /
 * `cmate wait` read `autoYes.lastSuppression` to tell the operator which it is.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

const LIVE_FIXTURES = path.resolve(__dirname, '../lib/detection/fixtures');

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
      getTool: () => ({ getSessionName: (id: string) => `mcbd-test-${id}`, name: 'Test CLI' }),
    }),
  },
}));

const warn = vi.fn();
// `withContext` is part of the logger contract and `detectThinking` uses it, so
// the detection layer the gate consults reaches it. A mock missing a method the
// production path calls does not fail as "unmocked": it throws inside the
// poller's catch and every assertion here would read `'error'`.
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

import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import {
  clearPolicySuppressions,
  getLastPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { AUTO_YES_DIALOG_GATE_ENV_VAR } from '@/lib/polling/auto-yes-dialog-gate';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WORKTREE_ID = 'wt-1928';

function pollerState(cliToolId: CLIToolType = 'claude'): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId,
    instanceId: cliToolId,
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** What `captureAndCleanOutput` hands `detectAndRespondToPrompt`. */
function paneOf(dir: string, name: string): string {
  return stripBoxDrawing(stripAnsi(readFileSync(path.join(LIVE_FIXTURES, dir, `${name}.txt`), 'utf8')));
}

/**
 * The #1896 shape, as an agent writes it: a numbered list in the ANSWER with a
 * question under it, no selection cursor and no dialog footer.
 *
 * `detectPrompt` reports `multiple_choice` for this (pinned in
 * `auto-yes-dialog-gate.test.ts`), which is why the poller used to type `1` at
 * it — on opencode that `1` was sent as a user utterance, and on any tool it is
 * an answer to a question nobody asked.
 */
const AGENT_WROTE_A_LIST = [
  '⏺ Here are the options:',
  '',
  '  1. On-premises (self-hosted) deployment',
  '  2. Cloud-managed platform',
  '  3. Containerized deployment with Kubernetes',
  '',
  '  Which one do you want?',
].join('\n');

const originalEnv = process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  clearPolicySuppressions();
  delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
});

afterEach(() => {
  db.close();
  clearPolicySuppressions();
  if (originalEnv === undefined) delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
  else process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = originalEnv;
});

describe('[#1928] a numbered list nobody vouched for is not answered', () => {
  it('sends nothing at all', async () => {
    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState(),
      'claude',
      AGENT_WROTE_A_LIST,
    );

    // Not "not 1" — nothing. The frame is prose; every option on it is a
    // sentence the agent wrote, so there is no safe key to send.
    expect(result).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('says why it went quiet, so a stalled `cmate wait` can report it', async () => {
    await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', AGENT_WROTE_A_LIST);

    const suppression = getLastPolicySuppression(WORKTREE_ID, 'claude');
    expect(suppression).not.toBeNull();
    // The value #1924 declared for this exact position. Until now nothing
    // produced it (`grep` found the enum member and no writer).
    expect(suppression!.reason).toBe('unclassified-frame');
    expect(suppression!.promptType).toBe('multiple_choice');
    // Not a policy verdict: no contract governs this session, and `mode: null`
    // is how the record says so.
    expect(suppression!.mode).toBeNull();
    expect(
      warn.mock.calls.some(([action]) => action === 'poller:auto-yes-skipped-unclassified-frame'),
    ).toBe(true);
  });

  it('is not a policy suppression, so a contract-less session is not blamed', async () => {
    await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', AGENT_WROTE_A_LIST);

    expect(
      warn.mock.calls.some(([action]) => action === 'poller:auto-yes-suppressed-by-policy'),
    ).toBe(false);
  });
});

describe('[#1928] the gate does not switch Auto-Yes off', () => {
  it('still answers a real claude permission dialog', async () => {
    // The control. A gate that also swallowed this would "fix" #1896 by
    // disabling the feature, and every Auto-Yes worker would stall on its first
    // approval.
    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState(),
      'claude',
      paneOf('claude-live-1708', 'bash-approval-taskpanel'),
    );

    expect(result).toBe('responded');
    expect(sendPromptAnswer.mock.calls.map(([p]) => p.answer)).toEqual(['1']);
    expect(getLastPolicySuppression(WORKTREE_ID, 'claude')).toBeNull();
  });

  it('still answers a real codex approval request', async () => {
    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState('codex'),
      'codex',
      paneOf('codex-live-1628', 'approval-run-command'),
    );

    expect(result).toBe('responded');
    expect(sendPromptAnswer.mock.calls.map(([p]) => p.answer)).toEqual(['1']);
  });

  it('still answers a real copilot permission dialog', async () => {
    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState('copilot'),
      'copilot',
      paneOf('copilot-live-1885', 'permission-dialog'),
    );

    expect(result).toBe('responded');
    expect(sendPromptAnswer.mock.calls.map(([p]) => p.answer)).toEqual(['1']);
  });

  it('leaves an ungated tool exactly as it was', async () => {
    // antigravity is `legacy` in the rollout table: its permission menu was
    // measured only well enough to answer (#999), and the repository holds no
    // live agy capture to write a dialog rule against. Gating it on a rule
    // inferred from another tool's frames is the mistake #1979 corrected.
    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState('antigravity'),
      'antigravity',
      AGENT_WROTE_A_LIST,
    );

    expect(result).toBe('responded');
    expect(getLastPolicySuppression(WORKTREE_ID, 'antigravity')).toBeNull();
  });

  it('can be put back to the pre-#1928 behaviour without a redeploy', async () => {
    process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = 'claude=legacy';

    const result = await detectAndRespondToPrompt(
      WORKTREE_ID,
      pollerState(),
      'claude',
      AGENT_WROTE_A_LIST,
    );

    // The escape hatch §13.1 asks for: an operator who sees the rollout misfire
    // gets the old behaviour back by flipping an env var, including the old
    // behaviour's bug.
    expect(result).toBe('responded');
    expect(getLastPolicySuppression(WORKTREE_ID, 'claude')).toBeNull();
  });
});
