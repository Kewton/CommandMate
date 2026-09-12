/**
 * `POST /send` resolves through the one shared resolver (Issue #2491).
 *
 * ## What was wrong
 *
 * #2487 taught `resolveSessionTarget` that a tool-named instance id declares its
 * tool with or without a roster row (the #868 primary anchor), so
 * `--instance antigravity --agent command-code` is a contradiction and not a
 * request for an ad-hoc session. `POST /api/worktrees/:id/send` never saw that
 * rule: it was the last route still resolving through `resolveInstanceCliTool`,
 * whose chain takes the explicit tool whenever the roster has no row. The same
 * body therefore answered 201 and started `mcbd-command-code-<wt>-antigravity`
 * — a session nothing that names the instance alone ever reads.
 *
 * The CLI cannot reach that door (`send` / `ask` / `respond` resolve against
 * `/resolve-target` first and exit 2), and the Web UI reads both halves off the
 * same roster row, so the callers that could hit it are the ones that build the
 * body themselves: scripts, Skills, anything driving the HTTP API.
 *
 * ## What this pins
 *
 * The conflict, and — with more tests than the conflict itself — the six ways
 * resolution must NOT change. A route swapped onto a different resolver is only
 * correct if the requests that worked yesterday resolve to the same tool and the
 * same instance today, so the negative controls are the point: an ad-hoc id with
 * an explicit tool (the `--register` flow), a tool-named id on its own, a
 * request naming neither, and a request that agrees with the roster.
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

/**
 * One fake per tool the matrix targets. Recorded rather than asserted inline so
 * every case can ask the same question of every tool: "did anything start or
 * type into a session?" — which is what "tmux セッションは立たない" means at this
 * layer, the tool object being the only door to tmux this route has (#1922 §4 D4).
 */
const started: Array<{ tool: string; worktreeId: string; worktreePath: string; instanceId?: string }> = [];
const sent: Array<{ tool: string; worktreeId: string; message: string; instanceId?: string }> = [];

function fakeTool(id: string, name: string, command: string) {
  return class {
    id = id;
    name = name;
    command = command;
    async isInstalled() { return true; }
    async isRunning() { return false; }
    async startSession(worktreeId: string, worktreePath: string, instanceId?: string) {
      started.push({ tool: id, worktreeId, worktreePath, instanceId });
    }
    async sendMessage(worktreeId: string, message: string, instanceId?: string) {
      sent.push({ tool: id, worktreeId, message, instanceId });
    }
    async killSession() {}
    getSessionName(worktreeId: string, instanceId?: string) {
      return !instanceId || instanceId === id
        ? `mcbd-${id}-${worktreeId}`
        : `mcbd-${id}-${worktreeId}-${instanceId}`;
    }
  };
}

vi.mock('@/lib/cli-tools/antigravity', () => ({
  AntigravityTool: fakeTool('antigravity', 'Antigravity CLI', 'agy'),
}));
vi.mock('@/lib/cli-tools/command-code', () => ({
  CommandCodeTool: fakeTool('command-code', 'Command Code', 'commandcode'),
}));
vi.mock('@/lib/cli-tools/codex', () => ({
  CodexTool: fakeTool('codex', 'Codex CLI', 'codex'),
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

const WORKTREE_ID = 'demo-app-feature-2491';

function callSend(body: Record<string, unknown>) {
  const request = new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
  return sendMessage(request, { params: Promise.resolve({ id: WORKTREE_ID }) });
}

describe('POST /api/worktrees/:id/send - instance/tool contradictions (Issue #2491)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    vi.clearAllMocks();
    started.length = 0;
    sent.length = 0;

    // The worktree default is codex, so any case that silently fell back to the
    // worktree would be visible as codex rather than as the tool under test.
    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Send conflict',
      path: '/path/to/demo-app',
      repositoryPath: '/path/to/repo',
      repositoryName: 'demo-app',
      cliToolId: 'codex',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  describe('the reproduction: a tool-named instance id with no roster row', () => {
    it('refuses `{instanceId: antigravity, cliToolId: command-code}` with 400 instance_tool_conflict', async () => {
      const response = await callSend({
        content: 'hello',
        instanceId: 'antigravity',
        cliToolId: 'command-code',
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.code).toBe('instance_tool_conflict');
      expect(body.instanceId).toBe('antigravity');
      expect(body.rosterCliTool).toBe('antigravity');
      expect(body.requestedCliTool).toBe('command-code');
      // The declaration is the #868 anchor, not a roster row, so the message
      // must not offer to "update the instance's roster entry" — there is none.
      expect(body.primaryAnchor).toBe(true);
      expect(body.error).toContain('primary instance of antigravity');
      expect(body.error).not.toContain('roster entry');
    });

    it('starts nothing and types nowhere', async () => {
      await callSend({ content: 'hello', instanceId: 'antigravity', cliToolId: 'command-code' });

      expect(started).toEqual([]);
      expect(sent).toEqual([]);
      const { startClaudeSession, sendMessageToClaude } = await import('@/lib/session/claude-session');
      expect(startClaudeSession).not.toHaveBeenCalled();
      expect(sendMessageToClaude).not.toHaveBeenCalled();
    });

    it('records no message, so a refused send leaves no history of having happened', async () => {
      await callSend({ content: 'hello', instanceId: 'antigravity', cliToolId: 'command-code' });

      const rows = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE worktree_id = ?')
        .get(WORKTREE_ID) as { count: number };
      expect(rows.count).toBe(0);
    });
  });

  describe('negative controls: what must still resolve exactly as before', () => {
    it('sends to an ad-hoc instance id with an explicit tool (the --register flow)', async () => {
      const response = await callSend({ content: 'hello', instanceId: 'codex-3', cliToolId: 'codex' });

      expect(response.status).toBe(201);
      expect(started).toEqual([
        { tool: 'codex', worktreeId: WORKTREE_ID, worktreePath: '/path/to/demo-app', instanceId: 'codex-3' },
      ]);
      expect(sent).toEqual([
        { tool: 'codex', worktreeId: WORKTREE_ID, message: 'hello', instanceId: 'codex-3' },
      ]);
    });

    it('sends to a tool-named instance id given on its own (the #868 anchor)', async () => {
      const response = await callSend({ content: 'hello', instanceId: 'antigravity' });

      expect(response.status).toBe(201);
      expect(started.map((s) => s.tool)).toEqual(['antigravity']);
      expect(sent.map((s) => s.tool)).toEqual(['antigravity']);
    });

    it('sends when the explicit tool agrees with the tool-named instance id', async () => {
      const response = await callSend({
        content: 'hello',
        instanceId: 'antigravity',
        cliToolId: 'antigravity',
      });

      expect(response.status).toBe(201);
      expect(started.map((s) => s.tool)).toEqual(['antigravity']);
    });

    it('falls back to the worktree default when neither instance nor tool is named', async () => {
      const response = await callSend({ content: 'hello' });

      expect(response.status).toBe(201);
      expect(started).toEqual([
        { tool: 'codex', worktreeId: WORKTREE_ID, worktreePath: '/path/to/demo-app', instanceId: undefined },
      ]);
      const message = await response.json();
      expect(message.cliToolId).toBe('codex');
    });

    it('falls back to the worktree default for an ad-hoc id with no tool signal at all', async () => {
      const response = await callSend({ content: 'hello', instanceId: 'helper-2' });

      expect(response.status).toBe(201);
      expect(started).toEqual([
        { tool: 'codex', worktreeId: WORKTREE_ID, worktreePath: '/path/to/demo-app', instanceId: 'helper-2' },
      ]);
    });

    it('still rejects an unknown cliToolId with the fixed error text, not a conflict', async () => {
      const response = await callSend({ content: 'hello', cliToolId: 'not-a-tool' });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Invalid CLI tool ID');
      expect(body.code).toBeUndefined();
      expect(started).toEqual([]);
    });
  });

  describe('the roster contradiction #1629 already refused', () => {
    beforeEach(() => {
      setAgentInstances(db, WORKTREE_ID, [
        { id: 'antigravity', cliTool: 'command-code', alias: 'Renamed', order: 0 },
      ]);
    });

    it('keeps answering 400, now with a machine-readable code', async () => {
      const response = await callSend({
        content: 'hello',
        instanceId: 'antigravity',
        cliToolId: 'codex',
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.code).toBe('instance_tool_conflict');
      expect(body.rosterCliTool).toBe('command-code');
      expect(body.requestedCliTool).toBe('codex');
      // A roster row CAN be updated, so this message says so and carries no
      // primaryAnchor flag — the two conflicts stay distinguishable.
      expect(body.primaryAnchor).toBeUndefined();
      expect(body.error).toContain("update the instance's roster entry");
      expect(started).toEqual([]);
    });

    it('lets the roster outrank the id itself when no tool is requested', async () => {
      // `antigravity` names a tool, but the roster says this instance is backed
      // by command-code. The roster wins; the anchor is only consulted when the
      // roster has nothing to say.
      const response = await callSend({ content: 'hello', instanceId: 'antigravity' });

      expect(response.status).toBe(201);
      expect(started.map((s) => s.tool)).toEqual(['command-code']);
    });
  });
});
