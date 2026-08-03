/**
 * API Routes Integration Tests - Instance-driven CLI tool resolution (Issue #1629)
 *
 * `send --instance <id>` used to resolve the CLI tool from `body.cliToolId ||
 * worktree.cliToolId || 'claude'` only, so a roster entry whose cliTool is codex
 * still started a Claude session under the codex-suffixed session name
 * (`mcbd-claude-<wt>-codex`). These tests pin the resolution order:
 *
 *   explicit cliToolId (--agent) > roster entry > instance-id-as-primary-anchor
 *   > worktree default > 'claude'
 *
 * and pin that an explicit cliToolId contradicting the roster is a 400 rather
 * than a silently mislabeled session.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST as sendMessage } from '@/app/api/worktrees/[id]/send/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, setAgentInstances } from '@/lib/db';
import type { Worktree } from '@/types/models';

// Claude is delegated to the session module by ClaudeTool.
vi.mock('@/lib/session/claude-session', () => ({
  startClaudeSession: vi.fn(),
  isClaudeRunning: vi.fn(() => Promise.resolve(false)),
  sendMessageToClaude: vi.fn(),
  isClaudeInstalled: vi.fn(() => Promise.resolve(true)),
}));

const codexStartSession = vi.fn(async (_worktreeId: string, _worktreePath: string, _instanceId?: string) => {});
const codexSendMessage = vi.fn(async (_worktreeId: string, _message: string, _instanceId?: string) => {});

vi.mock('@/lib/cli-tools/codex', () => ({
  CodexTool: class {
    id = 'codex';
    name = 'Codex CLI';
    command = 'codex';
    async isInstalled() { return true; }
    async isRunning() { return false; }
    async startSession(worktreeId: string, worktreePath: string, instanceId?: string) {
      return codexStartSession(worktreeId, worktreePath, instanceId);
    }
    async sendMessage(worktreeId: string, message: string, instanceId?: string) {
      return codexSendMessage(worktreeId, message, instanceId);
    }
    async killSession() {}
    getSessionName(id: string, instanceId?: string) {
      return !instanceId || instanceId === 'codex'
        ? `mcbd-codex-${id}`
        : `mcbd-codex-${id}-${instanceId}`;
    }
  }
}));

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;

  return {
    getDbInstance: () => {
      if (!mockDb) {
        throw new Error('Mock database not initialized');
      }
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

const WORKTREE_ID = 'demo-app-feature-greet-codex';

function buildRequest(body: Record<string, unknown>): import('next/server').NextRequest {
  return new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

function callSend(body: Record<string, unknown>) {
  return sendMessage(buildRequest(body), { params: Promise.resolve({ id: WORKTREE_ID }) });
}

describe('POST /api/worktrees/:id/send - instance-driven CLI tool resolution (Issue #1629)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    vi.clearAllMocks();

    // The reproduction case: the worktree default is claude, and the roster
    // declares a single `codex` instance backed by the codex CLI tool.
    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Greet (codex)',
      path: '/path/to/demo-app',
      repositoryPath: '/path/to/repo',
      repositoryName: 'demo-app',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('starts the roster instance\'s CLI tool when only instanceId is given', async () => {
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
    ]);

    const response = await callSend({ content: 'hello', instanceId: 'codex' });
    expect(response.status).toBe(201);

    const { startClaudeSession, sendMessageToClaude } = await import('@/lib/session/claude-session');
    expect(startClaudeSession).not.toHaveBeenCalled();
    expect(sendMessageToClaude).not.toHaveBeenCalled();
    expect(codexStartSession).toHaveBeenCalledWith(WORKTREE_ID, '/path/to/demo-app', 'codex');
    expect(codexSendMessage).toHaveBeenCalledWith(WORKTREE_ID, 'hello', 'codex');
  });

  it('resolves a non-primary roster instance to its CLI tool', async () => {
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 1 },
    ]);

    const response = await callSend({ content: 'review this', instanceId: 'codex-2' });
    expect(response.status).toBe(201);

    const { startClaudeSession } = await import('@/lib/session/claude-session');
    expect(startClaudeSession).not.toHaveBeenCalled();
    expect(codexStartSession).toHaveBeenCalledWith(WORKTREE_ID, '/path/to/demo-app', 'codex-2');
  });

  it('records the message against the resolved CLI tool, not the worktree default', async () => {
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
    ]);

    const response = await callSend({ content: 'hello', instanceId: 'codex' });
    const message = await response.json();

    expect(message.cliToolId).toBe('codex');
    expect(message.instanceId).toBe('codex');
  });

  it('rejects an explicit cliToolId that contradicts the roster', async () => {
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
    ]);

    const response = await callSend({ content: 'hello', cliToolId: 'claude', instanceId: 'codex' });
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toContain('codex');

    const { startClaudeSession } = await import('@/lib/session/claude-session');
    expect(startClaudeSession).not.toHaveBeenCalled();
    expect(codexStartSession).not.toHaveBeenCalled();
  });

  it('accepts an explicit cliToolId that agrees with the roster', async () => {
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
    ]);

    const response = await callSend({ content: 'hello', cliToolId: 'codex', instanceId: 'codex' });
    expect(response.status).toBe(201);
    expect(codexStartSession).toHaveBeenCalledWith(WORKTREE_ID, '/path/to/demo-app', 'codex');
  });

  it('treats an unregistered instance id that names a CLI tool as that tool\'s primary instance', async () => {
    // Empty roster: `codex` is still unambiguous because instanceId === cliToolId
    // is how the primary instance is anchored (Issue #868).
    const response = await callSend({ content: 'hello', instanceId: 'codex' });
    expect(response.status).toBe(201);

    const { startClaudeSession } = await import('@/lib/session/claude-session');
    expect(startClaudeSession).not.toHaveBeenCalled();
    expect(codexStartSession).toHaveBeenCalledWith(WORKTREE_ID, '/path/to/demo-app', 'codex');
  });

  it('falls back to the worktree default for an unregistered ad-hoc instance id', async () => {
    // `codex-2` is not in the roster and is not a CLI tool id, so there is no
    // signal beyond the worktree default. Unchanged legacy behavior.
    const response = await callSend({ content: 'hello', instanceId: 'codex-2' });
    expect(response.status).toBe(201);

    const { startClaudeSession } = await import('@/lib/session/claude-session');
    expect(startClaudeSession).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      worktreePath: '/path/to/demo-app',
      instanceId: 'codex-2',
    });
    expect(codexStartSession).not.toHaveBeenCalled();
  });

  it('honors an explicit cliToolId for an unregistered ad-hoc instance id', async () => {
    const response = await callSend({ content: 'hello', cliToolId: 'codex', instanceId: 'codex-2' });
    expect(response.status).toBe(201);
    expect(codexStartSession).toHaveBeenCalledWith(WORKTREE_ID, '/path/to/demo-app', 'codex-2');
  });
});
