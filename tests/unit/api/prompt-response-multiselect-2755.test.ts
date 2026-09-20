/**
 * `POST /prompt-response` answers a CHECKBOX question (Issue #2755 確定仕様 5).
 *
 * The route already re-captures the pane before sending (#161) and reads
 * Command Code's question screen off that capture (#2522). What #2755 adds is
 * a second answer SHAPE and one policy change:
 *
 *  - the answer may be a SET — `answers: [1, 3]`, or `answer: "1,3"` for
 *    `commandmate respond`, which has one positional argument;
 *  - and for that shape only, a verification that fails means **send nothing**.
 *    Every other answer on this route keeps the #1699 policy of carrying on
 *    when the capture fails, because blocking it takes away the operator's only
 *    way out. A checkbox answer cannot: it is delivered as toggles computed
 *    against the boxes ticked right now, so sent blind it unticks as readily as
 *    it ticks.
 *
 * Nothing in the detection layer is stubbed. The keys the route decides to send
 * land in the two tmux spies and are asserted as argument lists.
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

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
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

const DIR_2753 = path.resolve(__dirname, '../../fixtures/command-code-askuserquestion-2753');
const DIR_2522 = path.resolve(__dirname, '../../fixtures/command-code-askuserquestion-2522');
const LIVE_DIR = path.resolve(__dirname, '../../fixtures/command-code-live-2250');

/** The reported capture: five checkbox options, `3` ticked, `❯` on option 1. */
const CHECKBOX = readFileSync(path.join(DIR_2753, 'multiselect-answered-tabs.txt'), 'utf8');
/** A SINGLE-select question on the same tool. */
const SINGLE = readFileSync(path.join(DIR_2522, 'question-flat-short.txt'), 'utf8');
/** A pane with no dialog on it: the question has been answered. */
const IDLE = readFileSync(path.join(LIVE_DIR, 'turn-done-1490.txt'), 'utf8');

/** The Review page the confirm row opens, so a happy path can complete. */
const REVIEW = [
  '# Command Code v1.54.1',
  '',
  '─'.repeat(200),
  '',
  '✔ Update scope | ● Review',
  '',
  '1. How far should this update go?',
  '   Regenerate the map images, Update the desktop page too',
  '',
  '❯ 1. Submit',
  '  2. Cancel',
  '',
  '← to go back and edit',
  '',
].join('\n');

const WT = 'wt-2755-multiselect';
const SESSION = `cm-${WT}-command-code`;

function createRequest(body: Record<string, unknown>): NextRequest {
  return new Request(`http://localhost:3000/api/worktrees/${WT}/prompt-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cliTool: 'command-code', ...body }),
  }) as unknown as NextRequest;
}

async function respond(raw: string | Error, body: Record<string, unknown>) {
  const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
  if (raw instanceof Error) vi.mocked(captureSessionOutputFresh).mockRejectedValue(raw);
  else vi.mocked(captureSessionOutputFresh).mockResolvedValue(raw);
  const response = await promptResponse(createRequest(body), {
    params: Promise.resolve({ id: WT }),
  });
  return { status: response.status, data: await response.json() };
}

async function keystrokes() {
  const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux/tmux');
  return {
    text: vi.mocked(sendKeys).mock.calls,
    special: vi.mocked(sendSpecialKeys).mock.calls.map((call) => call[1]),
  };
}

/**
 * Script the two read-backs the send arm takes after its own keystrokes.
 *
 * The first is the pane after the toggles (which must show the requested set),
 * the second is the pane after the confirm row.
 */
async function scriptPane(afterToggle: string, afterConfirm: string): Promise<void> {
  const { capturePane } = await import('@/lib/tmux/tmux');
  vi.mocked(capturePane)
    .mockResolvedValueOnce(afterToggle)
    .mockResolvedValueOnce(afterConfirm);
}

/** The reported capture with a different set of boxes ticked. */
function withTicks(ticked: readonly number[]): string {
  return CHECKBOX.split('\n')
    .map((line) => {
      const match = /^(\s*(?:❯|\s)\s*)([1-9])\. \[[ xX✔]\] (.*)$/.exec(line);
      if (!match) return line;
      const box = ticked.includes(Number(match[2])) ? '[x]' : '[ ]';
      return `${match[1]}${match[2]}. ${box} ${match[3]}`;
    })
    .join('\n');
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

describe('[#2755] the route accepts a selection set', () => {
  it('answers `answers: [1, 3]` by toggling the difference and confirming twice', async () => {
    // The capture has `3` ticked already, so ticking {1,3} is one keystroke —
    // and pressing `3` would have turned the human's own box off.
    await scriptPane(withTicks([1, 3]), REVIEW);
    const { status, data } = await respond(CHECKBOX, { answers: [1, 3] });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.answer).toBe('1,3');

    const keys = await keystrokes();
    expect(keys.special).toEqual([
      ['1'],
      // five options, cursor on 1 → five Downs to reach `Submit`, then the
      // Enter that opens the Review page, then the Enter that sends.
      ['Down', 'Down', 'Down', 'Down', 'Down', 'Enter'],
      ['Enter'],
    ]);
    expect(keys.text).toEqual([]);
  });

  it('accepts the comma string `commandmate respond` sends', async () => {
    await scriptPane(withTicks([1, 3]), REVIEW);
    const { status, data } = await respond(CHECKBOX, { answer: '1,3' });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.answer).toBe('1,3');
    expect((await keystrokes()).special[0]).toEqual(['1']);
  });

  it('normalises order and duplicates before anything is sent', async () => {
    await scriptPane(withTicks([1, 3]), REVIEW);
    const { data } = await respond(CHECKBOX, { answer: '3,1,3' });

    expect(data.success).toBe(true);
    expect(data.answer).toBe('1,3');
  });

  it('tells a one-item checkbox answer from a single-select one', async () => {
    // 確定仕様 5: `answers: [2]` and `answer: "2"` must not be confused. The
    // field itself is what says which, and on a checkbox payload the digit is
    // a TOGGLE followed by the two-stage confirm — not "the answer is 2".
    await scriptPane(withTicks([2, 3]), REVIEW);
    const { data } = await respond(CHECKBOX, { answers: [2, 3] });

    expect(data.success).toBe(true);
    const keys = await keystrokes();
    expect(keys.special[0]).toEqual(['2']);
    expect(keys.special).toHaveLength(3);
    // A single-select answer on this tool is one `sendKeys` and no Enter
    // (#2574). Nothing of that shape happened here.
    expect(keys.text).toEqual([]);
  });
});

describe('[#2755] the route refuses with nothing sent', () => {
  it('rejects a number that is not on the screen with 400', async () => {
    const { status, data } = await respond(CHECKBOX, { answer: '1,9' });

    expect(status).toBe(400);
    expect(data.error).toContain('Invalid choice: 9');
    expect(await keystrokes()).toEqual({ text: [], special: [] });
  });

  it('rejects a list aimed at a SINGLE-select prompt with 400', async () => {
    const { status, data } = await respond(SINGLE, { answer: '1,3' });

    expect(status).toBe(400);
    expect(data.error).toContain('takes one option');
    expect(await keystrokes()).toEqual({ text: [], special: [] });
  });

  it('rejects a malformed list with 400', async () => {
    const { status } = await respond(CHECKBOX, { answer: '1,,3' });
    expect(status).toBe(400);
    expect(await keystrokes()).toEqual({ text: [], special: [] });
  });

  it('rejects `answers` that is not a list of option numbers with 400', async () => {
    for (const answers of [[], ['1'], [0], [1.5]]) {
      const { status } = await respond(CHECKBOX, { answers });
      expect(status, JSON.stringify(answers)).toBe(400);
    }
    expect(await keystrokes()).toEqual({ text: [], special: [] });
  });

  it('refuses when the pane could not be re-read, unlike every other answer', async () => {
    // The #1699 exception, and the reason for it: the toggles are computed
    // against the boxes that are ticked RIGHT NOW. A blind send unticks.
    const { data } = await respond(new Error('no server running'), { answers: [1, 3] });

    expect(data.success).toBe(false);
    expect(data.reason).toBe('multi_select_unverified');
    expect(data.message).toContain('could not be re-read');
    expect(await keystrokes()).toEqual({ text: [], special: [] });
  });

  it('refuses when the question has gone', async () => {
    // The route's own re-verification gets here first and answers
    // `prompt_no_longer_active`, which is the same promise — nothing was sent —
    // with the reason code `respond` already knows how to retry on.
    const { data } = await respond(IDLE, { answers: [1, 3] });

    expect(data.success).toBe(false);
    expect(data.reason).toBe('prompt_no_longer_active');
    expect(await keystrokes()).toEqual({ text: [], special: [] });
  });

  it('refuses a ONE-item set when the screen changed to a single-select question', async () => {
    // The tabs walk from one question to the next with no event at the
    // transition, so the screen genuinely can change shape between the payload
    // being drawn and Submit being pressed. `answers: [1]` is the shape that
    // would otherwise be indistinguishable from a single-select `answer: "1"` —
    // and the difference matters, because on a checkbox screen that number is
    // a toggle and here it is a confirm.
    const { status, data } = await respond(SINGLE, { answers: [1] });

    expect(status).toBe(400);
    expect(data.error).toContain('takes one option');
    expect(await keystrokes()).toEqual({ text: [], special: [] });
  });

  it('does not press the confirm row when the toggles did not take', async () => {
    // The read-back shows the boxes unchanged: the keystroke was swallowed.
    await scriptPane(CHECKBOX, REVIEW);
    const { data } = await respond(CHECKBOX, { answers: [1, 3] });

    expect(data.success).toBe(false);
    expect(data.reason).toBe('multi_select_not_committed');
    const keys = await keystrokes();
    expect(keys.special).toEqual([['1']]);
    expect(keys.special.flat()).not.toContain('Enter');
  });
});

describe('[#2755] the pre-existing answer shapes are untouched', () => {
  it('still refuses `yes` on a checkbox payload, with nothing sent', async () => {
    const { data } = await respond(CHECKBOX, { answer: 'yes' });

    expect(data.success).toBe(false);
    expect(data.reason).toBe('unresolvable_answer');
    expect(await keystrokes()).toEqual({ text: [], special: [] });
  });

  it('still refuses `--default` on a checkbox payload, with nothing sent', async () => {
    const { data } = await respond(CHECKBOX, { useDefault: true });

    expect(data.success).toBe(false);
    expect(data.reason).toBe('unresolvable_answer');
    expect(await keystrokes()).toEqual({ text: [], special: [] });
  });

  it('answers a single-select question exactly as #2522 / #2574 left it', async () => {
    const { status, data } = await respond(SINGLE, { answer: '2' });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const keys = await keystrokes();
    expect(keys.text).toEqual([[SESSION, '2', false]]);
    expect(keys.special).toEqual([]);
  });
});
