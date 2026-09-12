/**
 * `POST /prompt-response` answers Command Code's `AskUserQuestion` (Issue #2522).
 *
 * Issue #2521 left this route with nothing to do for the screen: the detectors
 * produced no `promptData`, so PromptPanel's Submit and `commandmate respond`
 * both answered `prompt_no_longer_active` while the question was plainly up.
 *
 * The three things this pins, all on real captures with nothing in the detection
 * layer stubbed:
 *
 *  1. **the fresh frame is what is answered.** The route re-captures before
 *     sending (#161) and 確定仕様 C says the reading must run on that capture as
 *     CAPTURED — the screen is anchored on a rule row `stripBoxDrawing` blanks,
 *     and the route cleans its frame before handing it to the generic parser;
 *  2. **one answer advances one operation** (確定仕様 D). `submitMode:
 *     'answer_only'` means the digit goes and no Enter follows it, so the next
 *     question or the Review tab is not confirmed by the same keystroke;
 *  3. **the two refusals are told apart** (確定仕様 B). A question screen that
 *     could not be read is `unsupported_dialog_layout` and sends nothing; a
 *     screen the question has LEFT is the older `prompt_no_longer_active`.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as promptResponse } from '@/app/api/worktrees/[id]/prompt-response/route';
import type { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
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
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => {
      if (mockDb) { mockDb.close(); mockDb = null; }
    },
  };
});

// The tmux transport, and the ONLY thing between the route and the terminal:
// every key the route decides to send lands in one of these two spies.
vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
}));

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/hooks/structured-decision-response', () => ({
  answerStructuredDecision: vi.fn().mockResolvedValue({
    kind: 'not-applicable',
    reason: 'no-pending-decision',
  }),
}));
vi.mock('@/lib/session/agent-event-state', () => ({ getAskUserQuestion: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: () => ({
        name: 'Command Code',
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: (id: string, instanceId?: string) =>
          `cm-${id}-${instanceId ?? 'command-code'}`,
      }),
    })),
  },
}));

const DIR_2521 = path.resolve(__dirname, '../../fixtures/command-code-askuserquestion-2521');
const DIR_2522 = path.resolve(__dirname, '../../fixtures/command-code-askuserquestion-2522');
const LIVE_DIR = path.resolve(__dirname, '../../fixtures/command-code-live-2250');

const REPORTED = readFileSync(
  path.join(DIR_2521, 'askuserquestion-wrapped-1530-200x1000.txt'),
  'utf8',
);
const f2522 = (name: string): string => readFileSync(path.join(DIR_2522, name), 'utf8');
/** A Command Code pane with no dialog on it at all: the question has been answered. */
const IDLE = readFileSync(path.join(LIVE_DIR, 'turn-done-1490.txt'), 'utf8');

const WT = 'wt-2522-respond';
const SESSION = `cm-${WT}-command-code`;

function createRequest(body: Record<string, unknown>): NextRequest {
  return new Request(`http://localhost:3000/api/worktrees/${WT}/prompt-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cliTool: 'command-code', ...body }),
  }) as unknown as NextRequest;
}

async function respond(raw: string, body: Record<string, unknown>) {
  const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
  vi.mocked(captureSessionOutputFresh).mockResolvedValue(raw);
  const response = await promptResponse(createRequest(body), {
    params: Promise.resolve({ id: WT }),
  });
  return { status: response.status, data: await response.json() };
}

async function keystrokes() {
  const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux/tmux');
  return {
    text: vi.mocked(sendKeys).mock.calls,
    special: vi.mocked(sendSpecialKeys).mock.calls,
  };
}

beforeEach(async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  const worktree: Worktree = {
    id: WT,
    name: 'Test Worktree',
    path: '/path/to/test',
    repositoryPath: '/path/to/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'command-code',
  };
  upsertWorktree(db, worktree);
  vi.clearAllMocks();
});

describe('[#2522] answering the question screen', () => {
  it('sends the default option as a digit, with no Enter after it', async () => {
    const { status, data } = await respond(REPORTED, { answer: '1' });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.answer).toBe('1');

    const keys = await keystrokes();
    // 確定仕様 D: exactly one keystroke. The `false` is `sendKeys`'s own
    // "do not append Enter"; `answer_only` is what suppresses the second call
    // the text arm would otherwise make after `TUI_TEXT_INPUT_WAIT_MS`.
    expect(keys.text).toEqual([[SESSION, '1', false]]);
    expect(keys.special).toEqual([]);
  });

  it('sends a NON-default option the same way', async () => {
    // The half that a "press Enter on the highlighted row" implementation gets
    // wrong: option 2 is not the one the `❯` is on.
    const { data } = await respond(REPORTED, { answer: '2' });

    expect(data.success).toBe(true);
    const keys = await keystrokes();
    expect(keys.text).toEqual([[SESSION, '2', false]]);
    expect(keys.special).toEqual([]);
  });

  it('resolves --default against the option the cursor is actually on', async () => {
    const { data } = await respond(REPORTED, { useDefault: true });

    expect(data.success).toBe(true);
    expect(data.answer).toBe('1');
    expect(data.resolved).toMatchObject({ via: 'default', optionNumber: 1 });
  });

  it('stores the question and the answer in the chat history', async () => {
    await respond(REPORTED, { answer: '3' });

    const db = (await import('@/lib/db/db-instance')).getDbInstance();
    const rows = db
      .prepare(`SELECT content, prompt_data FROM chat_messages WHERE worktree_id = ?`)
      .all(WT) as Array<{ content: string; prompt_data: string | null }>;

    expect(rows).toHaveLength(1);
    const promptData = JSON.parse(rows[0].prompt_data ?? 'null') as {
      question: string;
      options: Array<{ number: number; requiresTextInput?: boolean }>;
    };
    expect(promptData.question).toBe(
      'Approve proceeding from the plan into worktree creation and dispatch?',
    );
    expect(promptData.options).toHaveLength(4);
    expect(promptData.options[3].requiresTextInput).toBe(true);
  });

  it('answers the FRESH capture, not the one the status API published', async () => {
    // #161's race, and the reason the reading has to run on the route's own
    // capture: the screen may have moved on between the two, and the options
    // resolved against must be the ones on the pane NOW.
    const first = await respond(REPORTED, { answer: '1' });
    expect(first.data.success).toBe(true);
    expect((await keystrokes()).text).toEqual([[SESSION, '1', false]]);

    vi.clearAllMocks();
    const second = await respond(f2522('question-description-on-last-option.txt'), {
      useDefault: true,
    });
    // A different screen, so a different option list — and `--default` resolves
    // against THAT one, naming the label it actually selected.
    expect(second.data.success).toBe(true);
    expect(second.data.resolved).toMatchObject({
      via: 'default',
      optionNumber: 1,
      optionLabel: 'develop',
    });
  });

  it('refuses a number aimed at the free-text row, and sends no key', async () => {
    // 確定仕様 D: `Type something...` is a TextInput in the TUI. `--default` on a
    // screen whose `❯` rests there would otherwise send a digit that selects
    // nothing — and, with the Enter suppressed, report success for a no-op.
    const { status, data } = await respond(f2522('question-default-on-free-text.txt'), {
      useDefault: true,
    });

    expect(status).toBe(200);
    expect(data.success).toBe(false);
    expect(data.reason).toBe('unresolvable_answer');
    expect(data.message).toContain('free-text field');

    const keys = await keystrokes();
    expect(keys.text).toEqual([]);
    expect(keys.special).toEqual([]);
  });

  it('refuses the same row named by its number', async () => {
    const { data } = await respond(f2522('question-default-on-free-text.txt'), { answer: '3' });

    expect(data.success).toBe(false);
    expect(data.reason).toBe('unresolvable_answer');
    expect((await keystrokes()).text).toEqual([]);
  });

  it('still answers the ordinary options on that same screen', async () => {
    const { data } = await respond(f2522('question-default-on-free-text.txt'), { answer: '2' });

    expect(data.success).toBe(true);
    expect((await keystrokes()).text).toEqual([[SESSION, '2', false]]);
  });

  it('sends the operator’s TEXT for the free-text row unchanged', async () => {
    // What PromptPanel and `respond <id> "<text>"` actually do for this row: the
    // answer is the text, not the number, and the guard above is about digits.
    const { data } = await respond(f2522('question-default-on-free-text.txt'), {
      answer: 'Fix the flaky test first',
    });

    expect(data.success).toBe(true);
    expect((await keystrokes()).text).toEqual([
      [SESSION, 'Fix the flaky test first', false],
      [SESSION, '', true],
    ]);
  });
});

describe('[#2522] the two refusals, told apart', () => {
  it.each([
    ['a region past the reader cap', 'unsupported-region-too-tall.txt'],
    ['a gap in the numbering', 'unsupported-missing-number.txt'],
    ['a multi-select checkbox list', 'unsupported-multi-select-checkboxes.txt'],
  ])('%s refuses with unsupported_dialog_layout and sends nothing', async (_label, name) => {
    const { status, data } = await respond(f2522(name), { answer: '1' });

    expect(status).toBe(200);
    expect(data.success).toBe(false);
    expect(data.reason).toBe('unsupported_dialog_layout');
    expect(data.message).toContain('no key was sent');

    const keys = await keystrokes();
    expect(keys.text).toEqual([]);
    expect(keys.special).toEqual([]);
  });

  it('an idle pane is still prompt_no_longer_active', async () => {
    const { status, data } = await respond(IDLE, { answer: '1' });

    expect(status).toBe(200);
    expect(data.success).toBe(false);
    expect(data.reason).toBe('prompt_no_longer_active');

    const keys = await keystrokes();
    expect(keys.text).toEqual([]);
    expect(keys.special).toEqual([]);
  });

  it('records nothing in the chat history for either refusal', async () => {
    await respond(f2522('unsupported-region-too-tall.txt'), { answer: '1' });
    await respond(IDLE, { answer: '1' });

    const db = (await import('@/lib/db/db-instance')).getDbInstance();
    const rows = db.prepare(`SELECT id FROM chat_messages WHERE worktree_id = ?`).all(WT);
    expect(rows).toHaveLength(0);
  });
});

describe('[#2522] the existing Command Code dialogs are untouched', () => {
  it.each([
    ['dialog-shell-command.txt'],
    ['dialog-create-file.txt'],
    ['dialog-kill-task-1490.txt'],
    ['dialog-shell-1490.txt'],
  ])('%s still answers through the generic parser, with its Enter', async (name) => {
    // The four permission dialogs have no tab strip, so the new reading declines
    // them and they keep the `answer_then_enter` behaviour #2250 measured.
    const raw = readFileSync(path.join(LIVE_DIR, name), 'utf8');
    const { data } = await respond(raw, { answer: '1' });

    expect(data.success).toBe(true);
    const keys = await keystrokes();
    expect(keys.text).toEqual([
      [SESSION, '1', false],
      [SESSION, '', true],
    ]);
  });
});
