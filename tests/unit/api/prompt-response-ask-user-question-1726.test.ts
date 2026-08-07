/**
 * `POST /api/worktrees/[id]/prompt-response` judging an answer against the
 * agent's own options (Issue #1726).
 *
 * Every refusal below asserts that **nothing reached tmux**. That is the point
 * of the feature rather than a detail of it: on a cursor-navigated picker the
 * damage is done by the Enter that follows a rejected keystroke, which selects
 * whatever is highlighted (#1681), so a check that ran after the send would be
 * no check at all.
 *
 * The last group is the one that keeps this honest — a session with no hooks, or
 * a screen the payload does not describe, has to behave exactly as it did before
 * this Issue.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: () => ({
        name: 'Claude',
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: (id: string) => `claude-${id}`,
      }),
    })),
  },
}));

import { POST as promptResponse } from '@/app/api/worktrees/[id]/prompt-response/route';
import { captureSessionOutputFresh } from '@/lib/session/cli-session';
import { sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import {
  clearAgentStopEvents,
  recordAskUserQuestion,
} from '@/lib/session/agent-event-state';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';
import { CANARY_ASKUSERQUESTION_TASK_PANEL } from '../../fixtures/canary/askuserquestion-task-panel';

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
}));

const WT = 'test-wt';

const SPEC: AskUserQuestionSpec = {
  promptId: 'prompt-1',
  questions: [
    {
      question: 'Which task would you like to start with?',
      header: 'First task',
      multiSelect: false,
      choices: [
        { label: 'Clear desk', description: 'Start by clearing the desk surface.' },
        { label: 'Sort papers', description: 'Start by sorting through the papers.' },
        { label: 'Wrangle cables', description: 'Start by wrangling and organizing the cables.' },
      ],
    },
  ],
};

function request(body: Record<string, unknown>): NextRequest {
  return new Request(`http://localhost:3000/api/worktrees/${WT}/prompt-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function respond(body: Record<string, unknown>) {
  const response = await promptResponse(request(body), {
    params: Promise.resolve({ id: WT }),
  });
  return response.json();
}

/** Nothing at all was typed into the pane. */
function expectNothingSent(): void {
  expect(sendKeys).not.toHaveBeenCalled();
  expect(sendSpecialKeys).not.toHaveBeenCalled();
}

let db: Database.Database;

beforeEach(async () => {
  vi.clearAllMocks();
  clearAgentStopEvents();

  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  const worktree: Worktree = {
    id: WT,
    name: 'Test Worktree',
    path: '/path/to/test',
    repositoryPath: '/path/to/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);

  // The live picker with the task panel overlaid — detection runs for real.
  vi.mocked(captureSessionOutputFresh).mockResolvedValue(CANARY_ASKUSERQUESTION_TASK_PANEL);
});

describe('with the agent’s options known (Issue #1726)', () => {
  beforeEach(() => {
    recordAskUserQuestion(WT, 'claude', undefined, SPEC);
  });

  it('sends a number the picker offers', async () => {
    const data = await respond({ answer: '2' });

    expect(data.success).toBe(true);
    expect(sendSpecialKeys).toHaveBeenCalled();
  });

  it('refuses an out-of-range number without sending anything', async () => {
    const data = await respond({ answer: '99' });

    expect(data).toMatchObject({ success: false, reason: 'answer_out_of_range' });
    expectNothingSent();
  });

  it('refuses the phantom option number the 2026-08-06 incident produced', async () => {
    // A task panel reading `7 tasks (…)` was collected as option 7. With the
    // agent's own list in hand, 6 is simply not an option on this screen.
    const data = await respond({ answer: '6' });

    expect(data).toMatchObject({ success: false, reason: 'answer_out_of_range' });
    expectNothingSent();
  });

  it('resolves an option label to its number', async () => {
    const data = await respond({ answer: 'Sort papers' });

    expect(data).toMatchObject({
      success: true,
      answer: '2',
      resolved: { via: 'semantic', optionNumber: 2, optionLabel: 'Sort papers' },
    });
    expect(sendSpecialKeys).toHaveBeenCalled();
  });

  it('refuses yes/no rather than letting it arrive as a selection', async () => {
    // Issue #1681: typed text is not a selection on this picker — the Enter
    // after it takes whatever is highlighted, so `no` could approve.
    const data = await respond({ answer: 'no' });

    expect(data).toMatchObject({ success: false, reason: 'unresolvable_answer' });
    expectNothingSent();
  });

  it('refuses free text that matches no label', async () => {
    const data = await respond({ answer: 'something else entirely' });

    expect(data).toMatchObject({ success: false, reason: 'unresolvable_answer' });
    expectNothingSent();
  });

  it('never echoes the answer back in the refusal message (SEC-003)', async () => {
    const data = await respond({ answer: '<script>alert(1)</script>' });

    expect(data.success).toBe(false);
    expect(data.message).not.toContain('script');
  });

  it('still selects the default with --default', async () => {
    const data = await respond({ useDefault: true });

    expect(data).toMatchObject({
      success: true,
      answer: '1',
      resolved: { via: 'default', optionNumber: 1, optionLabel: 'Clear desk' },
    });
  });

  it('records the agent’s own label in the audit trail', async () => {
    await respond({ answer: '3' });

    const row = db
      .prepare(`SELECT prompt_data FROM chat_messages WHERE message_type = 'prompt' LIMIT 1`)
      .get() as { prompt_data: string } | undefined;

    expect(row).toBeDefined();
    const promptData = JSON.parse(row!.prompt_data);
    expect(promptData.question).toBe('Which task would you like to start with?');
    expect(promptData.options[2]).toMatchObject({
      number: 3,
      label: 'Wrangle cables',
      description: 'Start by wrangling and organizing the cables.',
    });
  });
});

describe('without the agent’s options (Issue #1726)', () => {
  it('accepts an out-of-range number exactly as it did before', async () => {
    // The unconfigured machine, and every non-Claude tool. This Issue must not
    // narrow what those sessions accept — the screen is the only authority there
    // and this server cannot second-guess it.
    const data = await respond({ answer: '99' });

    expect(data.success).toBe(true);
    expect(sendSpecialKeys).toHaveBeenCalled();
  });

  it('accepts free text exactly as it did before', async () => {
    const data = await respond({ answer: 'anything at all' });

    expect(data.success).toBe(true);
    expect(sendKeys).toHaveBeenCalled();
  });

  it('does not judge a screen the payload does not describe', async () => {
    // The question in flight is not the one on the pane, so the option list is
    // not vouched for and the pre-#1726 path runs.
    recordAskUserQuestion(WT, 'claude', undefined, {
      promptId: 'other',
      questions: [
        {
          question: 'Which editor do you prefer?',
          header: 'Editor',
          multiSelect: false,
          choices: [{ label: 'Vim', description: null }],
        },
      ],
    });

    const data = await respond({ answer: '99' });

    expect(data.success).toBe(true);
  });

  it('does not judge a call recorded against a different instance', async () => {
    recordAskUserQuestion(WT, 'claude', 'claude-2', SPEC);

    const data = await respond({ answer: '99' });

    expect(data.success).toBe(true);
  });
});
