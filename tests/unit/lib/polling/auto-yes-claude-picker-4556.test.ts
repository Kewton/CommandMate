/**
 * Issue #4556 I4: Auto-Yes must not answer claude 2.1.330's `/model` / `/effort` pickers.
 *
 * On 2.1.329+ the `/model` footer reads `s to use this session only · Enter to save ·
 * Esc to cancel`. Before the fix the #1495 guard (`Enter to set as default`) missed it,
 * the numbered model list was read as a multiple_choice prompt, and an Auto-Yes answer
 * there (number key or Enter) saves the pick as the default for new sessions.
 *
 * Driven through the real poller entry `detectAndRespondToPrompt` with only the
 * transport stubbed (same harness as auto-yes-live-region-3183.test.ts). A genuine
 * claude permission dialog is the positive control: it is still answered.
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
import type { PromptData } from '@/types/models';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string; promptData?: PromptData }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) => sendPromptAnswer(params as { answer: string; promptData?: PromptData }),
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn(async () => '') }));
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
vi.mock('@/lib/logger', () => {
  const logger = (): Record<string, unknown> => {
    const self: Record<string, unknown> = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    self.withContext = () => self;
    return self;
  };
  return { createLogger: logger };
});

import { detectAndRespondToPrompt, clearAllPollerStates, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { POLLING_INTERVAL_MS, clearAllAutoYesStates } from '@/lib/auto-yes-state';
import { upsertWorktree } from '@/lib/db';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';

const WT = 'wt-4556-claude-picker';
const ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

const PICKERS = [
  ['/model 2.1.330', 'tests/fixtures/claude-picker-footer-4556/claude-2.1.330-model.raw.txt'],
  ['/effort 2.1.330', 'tests/fixtures/claude-picker-footer-4556/claude-2.1.330-effort.raw.txt'],
  ['/model 2.1.286', 'tests/fixtures/claude-effort-picker-3052/claude-2.1.286-model.raw.txt'],
  ['/effort 2.1.286', 'tests/fixtures/claude-effort-picker-3052/claude-2.1.286-effort.raw.txt'],
] as const;

const PERMISSION_DIALOG = 'tests/unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt';

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'claude',
    instanceId: 'claude',
    consecutiveErrors: 0,
    currentInterval: POLLING_INTERVAL_MS,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** One poller tick over `raw`, exactly as `pollAutoYes` hands it over. */
async function tick(raw: string): Promise<string> {
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(WT, pollerState(), 'claude', clean, clean.split('\n'), undefined, raw);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: 'claude-picker-4556',
    path: '/tmp/claude-picker-4556',
    branch: 'fix/4556',
    repositoryPath: '/tmp/claude-picker-4556-repo',
    repositoryName: 'claude-picker-4556-repo',
    cliToolId: 'claude',
  });
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  sendPromptAnswer.mockClear();
});

afterEach(() => {
  db.close();
});

describe('[#4556 I4] Auto-Yes does not answer claude\'s /model and /effort pickers', () => {
  it.each(PICKERS)('%s: no answer is sent', async (_name, file) => {
    const result = await tick(read(file));
    expect(result).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('positive control: a genuine claude permission dialog is still answered', async () => {
    expect(await tick(read(PERMISSION_DIALOG))).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });
});
