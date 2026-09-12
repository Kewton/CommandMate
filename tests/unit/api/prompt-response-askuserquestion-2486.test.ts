/**
 * `POST /prompt-response` answers Claude Code 2.1.268's AskUserQuestion picker
 * with a tab row and a preview pane (Issue #2486).
 *
 * The Issue's server log: `prompt-response-refused … reason:
 * prompt_no_longer_active, vouched: false` while the picker was open on screen
 * and `wait --on-prompt agent` had just exited 10 for it. The frames are the live
 * captures in `tests/fixtures/claude-live-2486/`; nothing in the detection layer
 * is stubbed, so the route acts on exactly what `detectPrompt`,
 * `evaluateDialogPresence` and claude's `detectDialog` conclude.
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

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

// The structured path declines for claude (no decision ids), and no hook
// payload is held: the KEYSTROKE path — the one the Issue refused on — is under
// test.
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
        name: 'Claude',
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: (id: string) => `claude-${id}`,
      }),
    })),
  },
}));

const FRAMES = path.resolve(__dirname, '../../fixtures/claude-live-2486');
const REPLIES = path.resolve(__dirname, '../../fixtures/claude-idle-numbered-list-2457');

function frame(name: string): string {
  return readFileSync(path.join(FRAMES, `${name}.txt`), 'utf8');
}

function createRequest(worktreeId: string, body: Record<string, unknown>): NextRequest {
  return new Request(`http://localhost:3000/api/worktrees/${worktreeId}/prompt-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const WT = 'test-wt';
const SESSION = `claude-${WT}`;

async function respond(raw: string, answer: string) {
  const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
  vi.mocked(captureSessionOutputFresh).mockResolvedValue(raw);
  const response = await promptResponse(createRequest(WT, { answer }), {
    params: Promise.resolve({ id: WT }),
  });
  return { status: response.status, data: await response.json() };
}

describe('[#2486] POST /prompt-response on an AskUserQuestion picker', () => {
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
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
    vi.clearAllMocks();
  });

  it.each([
    // The Issue's screen. Option 1 is highlighted, so the picker gets #807's
    // net-zero nudge and Enter — the keys the Issue's Enter workaround implies.
    ['tabs-preview-q1', '1', ['Down', 'Up', 'Enter']],
    ['tabs-preview-q1', '2', ['Down', 'Enter']],
    ['preview-q1', '1', ['Down', 'Up', 'Enter']],
    ['tabs-q1', '1', ['Down', 'Up', 'Enter']],
    // Question 2 and the review screen: the rest of the Issue's walk.
    ['tabs-preview-q2', '1', ['Down', 'Up', 'Enter']],
    ['tabs-preview-review', '1', ['Enter']],
    // The cursor sits on 2, and the options are the picker's — not the pane's
    // own `1. Merge / 2. Pray` — so "1" is one step up.
    ['preview-numbered-q1-cursor-on-2', '1', ['Up', 'Enter']],
  ] as const)('%s: respond "%s" is sent as %j', async (name, answer, keys) => {
    const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux/tmux');
    const { status, data } = await respond(frame(name), answer);

    expect(status).toBe(200);
    expect(data).toMatchObject({ success: true, answer });
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
    expect(sendSpecialKeys).toHaveBeenCalledWith(SESSION, [...keys]);
    // Never the digit as text: the picker is cursor-driven.
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('names an open picker it cannot verify instead of calling it gone', async () => {
    // The pane caught without its bottom border: the picker's footer is on
    // screen, so the generic parser still finds it, but the dialog rule declines
    // a half-drawn box. That used to read `prompt_no_longer_active`.
    const raw = frame('tabs-preview-q1')
      .split('\n')
      .filter(row => !/^\s*└─+┘\s*$/.test(row.replace(/\x1b\[[0-9;]*m/g, '')))
      .join('\n');
    const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux/tmux');
    const { data } = await respond(raw, '1');

    expect(data).toEqual({
      success: false,
      reason: 'unsupported_dialog_layout',
      message: expect.stringContaining('AskUserQuestion picker is on screen'),
      answer: '1',
    });
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('still says prompt_no_longer_active for a reply, exactly as #2457 pinned it', async () => {
    const raw = readFileSync(path.join(REPLIES, 'reply-numbered-list-repaint.txt'), 'utf8');
    const { sendSpecialKeys } = await import('@/lib/tmux/tmux');
    const { data } = await respond(raw, '1');

    expect(data).toEqual({ success: false, reason: 'prompt_no_longer_active', answer: '1' });
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('still says prompt_no_longer_active once the picker has been answered', async () => {
    const { sendSpecialKeys } = await import('@/lib/tmux/tmux');
    const { data } = await respond(frame('tabs-preview-answered-idle'), '1');

    expect(data).toEqual({ success: false, reason: 'prompt_no_longer_active', answer: '1' });
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });
});
