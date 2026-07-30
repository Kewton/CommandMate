/**
 * Issue #1547: the Auto-Yes poller must obey the execution contract's autoYes
 * policy before it answers a prompt on the agent's behalf.
 *
 * These tests drive the real `detectAndRespondToPrompt` against a real migrated
 * database and a real Claude permission frame, and assert on whether
 * `sendPromptAnswer` was called — the only observable that matters, since that is
 * the keystroke the agent receives. Asserting the resolver's return value instead
 * would leave the wiring itself unverified, which is the whole of this Issue.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async () => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (...args: unknown[]) => sendPromptAnswer(...(args as [])),
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
      getTool: () => ({ getSessionName: (id: string) => `claude-${id}`, name: 'Claude' }),
    }),
  },
}));

const warn = vi.fn();
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warn(...(args as [])),
    error: vi.fn(),
  }),
}));

import { createTask, updateTaskStatus, type Task, type TaskStatus } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { clearAutoYesPolicyCache, invalidateSessionAutoYesPolicy } from '@/lib/polling/auto-yes-policy';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';

const WORKTREE_ID = 'wt-1547';
const FRAME = buildClaude1000RowPermissionFrame();

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

function seedTask(autoYes: string, overrides: { status?: TaskStatus; instanceId?: string | null } = {}): Task {
  return createTask(db, {
    worktreeId: WORKTREE_ID,
    cliToolId: 'claude',
    instanceId: overrides.instanceId ?? null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: a task
goal: do the thing
scope:
  allow: ["src/**"]
${autoYes}`,
      'task.yaml'
    ),
    status: overrides.status ?? 'running',
  });
}

function suppressionWarnings(): Array<Record<string, unknown>> {
  return warn.mock.calls
    .filter(([action]) => action === 'poller:auto-yes-suppressed-by-policy')
    .map(([, data]) => data as Record<string, unknown>);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  clearAutoYesPolicyCache();
  sendPromptAnswer.mockClear();
  warn.mockClear();
});

afterEach(() => {
  db.close();
});

describe('detectAndRespondToPrompt under an autoYes policy', () => {
  it('sanity: the fixture is a prompt the poller answers when nothing constrains it', async () => {
    // Premise for every suppression assertion below. Without it a broken
    // detector would make them all pass for the wrong reason.
    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', FRAME)).toBe(
      'responded'
    );
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(suppressionWarnings()).toHaveLength(0);
  });

  it('answers exactly as before when no task governs the session (regression)', async () => {
    seedTask("autoYes:\n  mode: 'off'\n", { status: 'pending' });

    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', FRAME)).toBe(
      'responded'
    );
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('answers when the contract declares no autoYes block (regression)', async () => {
    seedTask('');

    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', FRAME)).toBe(
      'responded'
    );
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it("sends no keystroke under mode: 'off'", async () => {
    seedTask("autoYes:\n  mode: 'off'\n");

    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', FRAME)).toBe(
      'no_answer'
    );
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(suppressionWarnings()).toEqual([
      expect.objectContaining({ reason: 'mode-off', mode: 'off', promptType: 'multiple_choice' }),
    ]);
  });

  it("sends no keystroke for a multiple_choice prompt under mode: 'safe'", async () => {
    seedTask('autoYes:\n  mode: safe\n');

    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', FRAME)).toBe(
      'no_answer'
    );
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(suppressionWarnings()).toEqual([
      expect.objectContaining({ reason: 'type-not-allowed' }),
    ]);
  });

  it('sends no keystroke when a deny pattern matches the prompt', async () => {
    seedTask("autoYes:\n  mode: allow-listed\n  allowPromptTypes: [multiple_choice]\n  denyPatterns: ['useVirtualKeyboard']\n");

    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', FRAME)).toBe(
      'no_answer'
    );
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(suppressionWarnings()).toEqual([
      expect.objectContaining({ reason: 'deny-pattern', pattern: 'useVirtualKeyboard' }),
    ]);
  });

  it('answers an allow-listed prompt type no deny pattern matches', async () => {
    seedTask("autoYes:\n  mode: allow-listed\n  allowPromptTypes: [multiple_choice]\n  denyPatterns: ['^never-matches$']\n");

    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', FRAME)).toBe(
      'responded'
    );
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('keeps suppressing while the prompt stays on screen', async () => {
    // The poller's duplicate guard only remembers prompts it *answered*, so a
    // suppressed prompt is re-evaluated every poll. It must not leak through on
    // a later pass.
    seedTask("autoYes:\n  mode: 'off'\n");
    const state = pollerState();

    for (let poll = 0; poll < 5; poll++) {
      expect(await detectAndRespondToPrompt(WORKTREE_ID, state, 'claude', FRAME)).toBe('no_answer');
    }
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('returns to answering once the task reaches a terminal state', async () => {
    const task = seedTask("autoYes:\n  mode: 'off'\n");
    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', FRAME)).toBe(
      'no_answer'
    );

    updateTaskStatus(db, task.id, 'succeeded');
    invalidateSessionAutoYesPolicy(`${WORKTREE_ID}:claude`);

    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', FRAME)).toBe(
      'responded'
    );
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it("does not let another instance's contract suppress this session", async () => {
    seedTask("autoYes:\n  mode: 'off'\n", { instanceId: 'claude-2' });

    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', FRAME)).toBe(
      'responded'
    );
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('suppresses the targeted alias instance', async () => {
    seedTask("autoYes:\n  mode: 'off'\n", { instanceId: 'claude-2' });
    const state = pollerState();
    state.instanceId = 'claude-2';

    expect(
      await detectAndRespondToPrompt(WORKTREE_ID, state, 'claude', FRAME, undefined, 'claude-2')
    ).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });
});
