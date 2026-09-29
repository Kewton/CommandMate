/**
 * Issue #2995: a frame Auto-Yes leaves alone is WARNed about once, not on every
 * 2s tick.
 *
 * The UAT case (`dev-reports/uat/2026-09-29-2991-2976/` F-2): an agent's reply
 * carrying `1. Yes / 2. No` stays on a static pane, the dialog gate (#1928,
 * #2984) correctly withholds the answer, and the poller printed
 * `poller:auto-yes-skipped-unclassified-frame` 35 times in 69 seconds. These
 * tests drive the real `detectAndRespondToPrompt` several times with ONE poller
 * state, the way `pollAutoYes` does, and count the WARN lines.
 *
 * What must not move: the suppression record (`capture --json` / `cmate wait`
 * read it) is written on every tick, and nothing is ever sent.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
const debug = vi.fn();
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const mockLogger: Record<string, unknown> = {
      debug: (...args: unknown[]) => debug(...(args as [])),
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
import { AUTO_YES_DIALOG_GATE_ENV_VAR } from '@/lib/polling/auto-yes-dialog-gate';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';

const WORKTREE_ID = 'wt-2995';
const EVENT = 'poller:auto-yes-skipped-unclassified-frame';

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'claude',
    instanceId: 'claude',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** An agent's reply with a numbered list and a question: no tool vouches for it (#1928). */
function replyWithList(options: string[]): string {
  return [
    '⏺ Here are the options:',
    '',
    ...options.map((label, i) => `  ${i + 1}. ${label}`),
    '',
    '  Which one do you want?',
  ].join('\n');
}

const REPLY_A = replyWithList(['Yes', 'No']);
const REPLY_B = replyWithList(['Keep the old schema', 'Run the migration', 'Abort']);
const NO_PROMPT = '⏺ Done. All tests pass.';

function warnCount(): number {
  return warn.mock.calls.filter(([action]) => action === EVENT).length;
}

function debugCount(): number {
  return debug.mock.calls.filter(([action]) => action === EVENT).length;
}

async function tick(state: AutoYesPollerState, frame: string): Promise<string> {
  return detectAndRespondToPrompt(WORKTREE_ID, state, 'claude', frame);
}

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

describe('[#2995] a static unanswered frame is WARNed once', () => {
  it('prints one WARN over several ticks of the same frame, the rest at debug', async () => {
    const state = pollerState();
    for (let i = 0; i < 5; i++) {
      expect(await tick(state, REPLY_A)).toBe('no_answer');
    }

    expect(warnCount()).toBe(1);
    expect(debugCount()).toBe(4);
  });

  it('still records the suppression on every tick and sends nothing', async () => {
    const state = pollerState();
    for (let i = 0; i < 3; i++) {
      clearPolicySuppressions();
      await tick(state, REPLY_A);
      const suppression = getLastPolicySuppression(WORKTREE_ID, 'claude');
      expect(suppression).not.toBeNull();
      expect(suppression!.reason).toBe('unclassified-frame');
    }

    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('WARNs again when a different prompt replaces the frame', async () => {
    const state = pollerState();
    await tick(state, REPLY_A);
    await tick(state, REPLY_A);
    expect(await tick(state, REPLY_B)).toBe('no_answer');
    expect(await tick(state, REPLY_B)).toBe('no_answer');

    expect(warnCount()).toBe(2);
  });

  it('WARNs again when the same frame comes back after a tick with no prompt', async () => {
    const state = pollerState();
    await tick(state, REPLY_A);
    expect(await tick(state, NO_PROMPT)).toBe('no_prompt');
    await tick(state, REPLY_A);

    expect(warnCount()).toBe(2);
  });

  it('keeps the throttle per poller: another instance still gets its own WARN', async () => {
    await tick(pollerState(), REPLY_A);
    await tick(pollerState(), REPLY_A);

    expect(warnCount()).toBe(2);
  });
});
