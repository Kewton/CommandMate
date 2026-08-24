/**
 * `respond <id> 3` on an opencode permission dialog reaches nothing
 * (Issue #2033, 受入条件 1).
 *
 * `commandmate respond` posts to THIS route (`src/cli/commands/respond.ts`
 * [DR2-06]), so the acceptance condition — "neither the `3` nor the Enter
 * arrives, and an error comes back with a reason code" — is a statement about
 * this handler, not only about `sendPromptAnswer`.
 *
 * ## Why `detectPrompt` is mocked into saying "multiple_choice"
 *
 * Because today it never would, and that is the whole point. opencode declares
 * `hasNumberedDialogs: false`, so the generic numbered-list inference is already
 * refused upstream, and `evaluateAutoYesDialogGate` refuses the Auto-Yes path on
 * top of it. Those are the two guards that were holding the line while
 * `sendPromptAnswer` itself still classified opencode as a tool that "accepts
 * 'N' + Enter as text". Mocking the detector reproduces exactly one thing: a
 * caller that got PAST the upstream guards. The refusal asserted below has to
 * come from the sender's own rules, which is what Issue #2033 is for.
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
import { ANSWER_MODE_KEYS_REASON } from '@/lib/prompt-answer-sender';
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
vi.mock('@/lib/detection/prompt-detector', () => ({
  detectPrompt: vi.fn().mockReturnValue({ isPrompt: false, cleanContent: '' }),
}));
// Issue #1898's structured path answers the approval over opencode's own API and
// returns before any keystroke. Declined here so the KEYSTROKE path — the one
// Issue #2033 is about — is the path under test.
vi.mock('@/lib/hooks/structured-decision-response', () => ({
  answerStructuredDecision: vi.fn().mockResolvedValue({
    kind: 'not-applicable',
    reason: 'no-pending-decision',
  }),
}));
vi.mock('@/lib/session/agent-event-state', () => ({ getAskUserQuestion: vi.fn(() => null) }));

// NOT mocked, deliberately: `@/lib/detection/cli-patterns` is where every tool
// module reads its measured patterns from (`OPENCODE_PERMISSION_PATTERN`), so a
// stub with three exports would leave `detectDialog` matching against undefined
// and the guard would answer `null` for reasons that have nothing to do with the
// frame.

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: () => ({
        name: 'OpenCode',
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: (id: string) => `mcbd-opencode-${id}`,
      }),
    })),
  },
}));

const PERMISSION_FRAME = readFileSync(
  path.resolve(__dirname, '../lib/detection/fixtures/opencode-live-1893/permission-bash.txt'),
  'utf8',
);

function createRequest(worktreeId: string, answer: string): NextRequest {
  return new Request(`http://localhost:3000/api/worktrees/${worktreeId}/prompt-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer, cliTool: 'opencode' }),
  }) as unknown as NextRequest;
}

describe('[#2033] POST /api/worktrees/:id/prompt-response on an opencode permission dialog', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: 'test-wt',
      name: 'Test Worktree',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'opencode',
    };
    upsertWorktree(db, worktree);

    vi.clearAllMocks();

    const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
    const { detectPrompt } = await import('@/lib/detection/prompt-detector');
    vi.mocked(captureSessionOutputFresh).mockResolvedValue(PERMISSION_FRAME);
    vi.mocked(detectPrompt).mockReturnValue({
      isPrompt: true,
      promptData: {
        type: 'multiple_choice',
        question: 'Allow?',
        options: [
          { number: 1, label: 'Allow once', isDefault: true, requiresTextInput: false },
          { number: 2, label: 'Allow always', isDefault: false, requiresTextInput: false },
          { number: 3, label: 'Reject', isDefault: false, requiresTextInput: false },
        ],
        status: 'pending',
      },
      cleanContent: 'Allow?',
    });
  });

  it('refuses `3` with a reason code and sends nothing to the pane', async () => {
    const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux/tmux');

    const response = await promptResponse(createRequest('test-wt', '3'), {
      params: Promise.resolve({ id: 'test-wt' }),
    });
    const data = await response.json();

    // A refusal, not a transport failure: the operator has to be able to tell
    // "nothing was typed" from "a key may have landed".
    expect(response.status).toBe(200);
    expect(data.success).toBe(false);
    expect(data.reason).toBe(ANSWER_MODE_KEYS_REASON);
    expect(data.message).toMatch(/permission/);

    // 受入条件, literally: not the `3`, and not the Enter after it.
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('does not resume polling or record an answered prompt for a refused response', async () => {
    const { startPolling } = await import('@/lib/polling/response-poller');

    await promptResponse(createRequest('test-wt', '3'), {
      params: Promise.resolve({ id: 'test-wt' }),
    });

    expect(startPolling).not.toHaveBeenCalled();
  });
});
