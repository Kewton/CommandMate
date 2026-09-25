/**
 * The hook POST is what opens Auto-Yes's gate on an agy dialog (Issue #2849).
 *
 * `POST /api/hooks/permission-request` records that agy asked about a tool call;
 * `detectPromptOnCleanFrame`, handed the worktree and instance it answers for,
 * reads a real agy approval dialog as a prompt only while that record is fresh.
 * The two halves are unit-tested on their own (`antigravity-permission-receipts`,
 * `antigravity-receipt-gate-2849`); what is checked here is that the route
 * writes under the key the gate reads, for every way a request can arrive.
 *
 * Real SQLite and the real route; tmux, WebSocket and the conversation logger are
 * absent because neither half touches them.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { resetAntigravityPermissionReceiptsForTests } from '@/lib/polling/antigravity-permission-receipts';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import {
  detectPromptOnCleanFrame,
  type AntigravityReceiptScope,
} from '@/lib/polling/response-checker';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database | null): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database | null) => {
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

// `response-checker` reaches for these at import time; nothing here is under test.
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  isSessionRunning: vi.fn(),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/conversation-logger', () => ({
  recordClaudeConversation: vi.fn(async () => {}),
}));

const AGY_FIXTURE = path.join(process.cwd(), 'tests/fixtures/hooks/antigravity/pre-tool-use.json');
const CLAUDE_FIXTURE = path.join(process.cwd(), 'tests/fixtures/hooks/claude/permission-request.json');
/** A real, open agy approval dialog: `Do you want to proceed?` and four options. */
const DIALOG = readFileSync(
  path.join(process.cwd(), 'tests/fixtures/antigravity-live-2364/dialog-bash-oneline.txt'),
  'utf8',
);

const WT = 'wt-receipt-2849';
const WT_PATH = process.cwd();
const ONE_HOUR_MS = 3_600_000;

const PRIMARY: AntigravityReceiptScope = { worktreeId: WT };
const SECOND: AntigravityReceiptScope = { worktreeId: WT, instanceId: 'antigravity-2' };

let db: Database.Database | null = null;

const asReq = (req: Request) => req as unknown as NextRequest;

function agyPayload(toolName = 'run_command'): Record<string, unknown> {
  const base = JSON.parse(readFileSync(AGY_FIXTURE, 'utf8')) as Record<string, unknown>;
  return { ...base, toolCall: { name: toolName, args: { CommandLine: 'echo hello' } } };
}

async function postJson(body: unknown, query: string) {
  const { POST } = await import('@/app/api/hooks/permission-request/route');
  const response = await POST(
    asReq(
      new Request(`http://localhost/api/hooks/permission-request${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ),
  );
  return { status: response.status, body: await response.json() };
}

const agyQuery = (instanceId: string, worktreeId = WT): string =>
  `?tool=antigravity&worktreeId=${worktreeId}&instanceId=${instanceId}`;

/** Is the open dialog a prompt, for the caller that answers `scope`'s frame? */
const isAnswerable = (scope: AntigravityReceiptScope): boolean =>
  detectPromptOnCleanFrame(
    stripBoxDrawing(stripAnsi(DIALOG)),
    'antigravity',
    undefined,
    DIALOG,
    scope,
  ).isPrompt;

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  clearAllAutoYesStates();
  clearPolicySuppressions();
  resetAntigravityPermissionReceiptsForTests();

  upsertWorktree(db, {
    id: WT,
    name: 'feature/2849',
    path: WT_PATH,
    repositoryPath: WT_PATH,
    repositoryName: 'fixture',
  });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  db = null;
  clearAllAutoYesStates();
  clearPolicySuppressions();
  resetAntigravityPermissionReceiptsForTests();
});

describe('[#2849] the hook POST opens the gate for the instance it names', () => {
  it('leaves an open agy dialog unanswerable until agy has asked', async () => {
    expect(isAnswerable(PRIMARY)).toBe(false);

    const { status } = await postJson(agyPayload(), agyQuery('antigravity'));

    expect(status).toBe(200);
    expect(isAnswerable(PRIMARY)).toBe(true);
  });

  it('records for the primary whether the URL names it or leaves it out', async () => {
    const { status } = await postJson(agyPayload(), `?tool=antigravity&worktreeId=${WT}`);

    expect(status).toBe(200);
    expect(isAnswerable(PRIMARY)).toBe(true);
  });

  it("keeps a second instance's question from vouching for the primary's dialog", async () => {
    await postJson(agyPayload(), agyQuery('antigravity-2'));

    expect(isAnswerable(SECOND)).toBe(true);
    expect(isAnswerable(PRIMARY)).toBe(false);
  });

  it("keeps another worktree's question from vouching for this one", async () => {
    upsertWorktree(db as Database.Database, {
      id: 'wt-elsewhere-2849',
      name: 'feature/elsewhere',
      path: WT_PATH,
      repositoryPath: WT_PATH,
      repositoryName: 'fixture',
    });

    await postJson(agyPayload(), agyQuery('antigravity', 'wt-elsewhere-2849'));

    expect(isAnswerable(PRIMARY)).toBe(false);
    expect(isAnswerable({ worktreeId: 'wt-elsewhere-2849' })).toBe(true);
  });
});

describe('[#2849] the record does not depend on how the question was answered', () => {
  it('is written when Auto-Yes is off and the route abstains', async () => {
    const { body } = await postJson(agyPayload(), agyQuery('antigravity'));

    expect(body).toEqual({ decision: 'ask' });
    expect(isAnswerable(PRIMARY)).toBe(true);
  });

  it('is written when Auto-Yes is on', async () => {
    setAutoYesEnabled(WT, 'antigravity', true, ONE_HOUR_MS);

    const { status } = await postJson(agyPayload(), agyQuery('antigravity'));

    expect(status).toBe(200);
    expect(isAnswerable(PRIMARY)).toBe(true);
  });
});

describe('[#2849] requests that are not a question about a tool call leave no record', () => {
  it('a payload naming no tool', async () => {
    const base = JSON.parse(readFileSync(AGY_FIXTURE, 'utf8')) as Record<string, unknown>;

    const { status } = await postJson({ ...base, toolCall: {} }, agyQuery('antigravity'));

    expect(status).toBe(200);
    expect(isAnswerable(PRIMARY)).toBe(false);
  });

  it('a request that resolves to no worktree', async () => {
    const { status } = await postJson(agyPayload(), agyQuery('antigravity', 'wt-that-was-deleted'));

    expect(status).toBe(200);
    expect(isAnswerable(PRIMARY)).toBe(false);
    expect(isAnswerable({ worktreeId: 'wt-that-was-deleted' })).toBe(false);
  });

  it("another tool's request", async () => {
    const claude = JSON.parse(readFileSync(CLAUDE_FIXTURE, 'utf8')) as Record<string, unknown>;

    const { status } = await postJson(
      { ...claude, cwd: WT_PATH, tool_input: { command: 'echo hello' } },
      `?tool=claude&worktreeId=${WT}&instanceId=claude`,
    );

    expect(status).toBe(200);
    expect(isAnswerable(PRIMARY)).toBe(false);
  });
});
