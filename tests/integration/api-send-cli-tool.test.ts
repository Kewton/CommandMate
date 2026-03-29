/**
 * API Routes Integration Tests - Send Message with CLI Tool Support
 * Tests the /api/worktrees/:id/send endpoint with multi-CLI tool support
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST as sendMessage } from '@/app/api/worktrees/[id]/send/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, getMessages, upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

// Mock CLI tool modules
vi.mock('@/lib/session/claude-session', () => ({
  startClaudeSession: vi.fn(),
  isClaudeRunning: vi.fn(() => Promise.resolve(false)),
  sendMessageToClaude: vi.fn(),
  isClaudeInstalled: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@/lib/cli-tools/codex', () => ({
  CodexTool: class {
    id = 'codex';
    name = 'Codex CLI';
    command = 'codex';
    async isInstalled() { return true; }
    async isRunning() { return false; }
    async startSession() {}
    async sendMessage() {}
    async killSession() {}
    getSessionName(id: string) { return `mcbd-codex-${id}`; }
  }
}));

vi.mock('@/lib/cli-tools/gemini', () => ({
  GeminiTool: class {
    id = 'gemini';
    name = 'Gemini CLI';
    command = 'gemini';
    async isInstalled() { return true; }
    async isRunning() { return false; }
    async startSession() {}
    async sendMessage() {}
    async killSession() {}
    getSessionName(id: string) { return `mcbd-gemini-${id}`; }
  }
}));

vi.mock('@/lib/cli-tools/copilot', () => ({
  CopilotTool: class {
    id = 'copilot';
    name = 'Copilot';
    command = 'gh';
    async isInstalled() { return true; }
    async isRunning() { return false; }
    async startSession() {}
    async sendMessage() {}
    async sendModelCommand() {}
    async killSession() {}
    getSessionName(id: string) { return `mcbd-copilot-${id}`; }
  }
}));

// Declare mock function type
declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

// Mock the database instance
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

describe('POST /api/worktrees/:id/send - CLI Tool Support', () => {
  let db: Database.Database;

  beforeEach(async () => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    runMigrations(db);

    // Set mock database
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  describe('Default behavior (Claude)', () => {
    it('should use claude tool by default when no cliToolId specified', async () => {
      // Create test worktree (cli_tool_id defaults to 'claude')
      const worktree: Worktree = {
        id: 'test-worktree',
        name: 'Test',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test message' }),
      });

      const response = await sendMessage(request as unknown as import('next/server').NextRequest, { params: { id: 'test-worktree' } });

      expect(response.status).toBe(201);

      // Verify Claude session was used
      const { startClaudeSession, sendMessageToClaude } = await import('@/lib/session/claude-session');
      expect(startClaudeSession).toHaveBeenCalledWith({
        worktreeId: 'test-worktree',
        worktreePath: '/path/to/test',
      });
      expect(sendMessageToClaude).toHaveBeenCalledWith('test-worktree', 'Test message');
    });
  });

  describe('Codex tool support', () => {
    it('should use codex tool when worktree has cliToolId=codex', async () => {
      // Create test worktree with codex
      const worktree: Worktree = {
        id: 'codex-worktree',
        name: 'Codex Test',
        path: '/path/to/codex-test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'codex',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/codex-worktree/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test codex message' }),
      });

      const response = await sendMessage(request as unknown as import('next/server').NextRequest, { params: { id: 'codex-worktree' } });

      expect(response.status).toBe(201);

      // Verify message was created
      const data = await response.json();
      expect(data).toHaveProperty('id');
      expect(data.content).toBe('Test codex message');
      expect(data.role).toBe('user');
    });

    it('should support cliToolId override in request body', async () => {
      // Create test worktree with claude (default)
      const worktree: Worktree = {
        id: 'test-override',
        name: 'Test Override',
        path: '/path/to/test-override',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/test-override/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test message',
          cliToolId: 'codex',  // Override to use codex
        }),
      });

      const response = await sendMessage(request as unknown as import('next/server').NextRequest, { params: { id: 'test-override' } });

      expect(response.status).toBe(201);
    });
  });

  describe('Gemini tool support', () => {
    it('should use gemini tool when worktree has cliToolId=gemini', async () => {
      // Create test worktree with gemini
      const worktree: Worktree = {
        id: 'gemini-worktree',
        name: 'Gemini Test',
        path: '/path/to/gemini-test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'gemini',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/gemini-worktree/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test gemini message' }),
      });

      const response = await sendMessage(request as unknown as import('next/server').NextRequest, { params: { id: 'gemini-worktree' } });

      expect(response.status).toBe(201);

      // Verify message was created
      const data = await response.json();
      expect(data).toHaveProperty('id');
      expect(data.content).toBe('Test gemini message');
      expect(data.role).toBe('user');
    });
  });

  describe('Image path validation (Issue #474)', () => {
    it('should reject URL schemes in imagePath (SSRF prevention)', async () => {
      const worktree: Worktree = {
        id: 'test-ssrf',
        name: 'Test SSRF',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
      };
      upsertWorktree(db, worktree);

      for (const scheme of ['file:///etc/passwd', 'http://evil.com', 'https://evil.com', 'ftp://evil.com', 'data:text/html,<script>']) {
        const request = new Request('http://localhost:3000/api/worktrees/test-ssrf/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'Test', imagePath: scheme }),
        });

        const response = await sendMessage(request as unknown as import('next/server').NextRequest, { params: { id: 'test-ssrf' } });
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toContain('URL schemes are not allowed');
      }
    });

    it('should reject path traversal in imagePath', async () => {
      const worktree: Worktree = {
        id: 'test-traversal',
        name: 'Test Traversal',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/test-traversal/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test', imagePath: '../../../etc/passwd' }),
      });

      const response = await sendMessage(request as unknown as import('next/server').NextRequest, { params: { id: 'test-traversal' } });
      expect(response.status).toBe(400);
    });

    it('should reject imagePath outside .commandmate/attachments/', async () => {
      const worktree: Worktree = {
        id: 'test-prefix',
        name: 'Test Prefix',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/test-prefix/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test', imagePath: '.commandmate/other/xxx.png' }),
      });

      const response = await sendMessage(request as unknown as import('next/server').NextRequest, { params: { id: 'test-prefix' } });
      // Path validation catches this as invalid (either symlink check or whitelist check)
      expect(response.status).toBe(400);
    });
  });

  describe('Model parameter (Issue #576)', () => {
    it('should reject model with invalid characters', async () => {
      const worktree: Worktree = {
        id: 'test-model-invalid',
        name: 'Test Model',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'copilot',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/test-model-invalid/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test', model: 'model; rm -rf /' }),
      });

      const response = await sendMessage(request as unknown as import('next/server').NextRequest, { params: { id: 'test-model-invalid' } });
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('model');
    });

    it('should reject model exceeding max length', async () => {
      const worktree: Worktree = {
        id: 'test-model-long',
        name: 'Test Model Long',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'copilot',
      };
      upsertWorktree(db, worktree);

      const longModel = 'a'.repeat(129);
      const request = new Request('http://localhost:3000/api/worktrees/test-model-long/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test', model: longModel }),
      });

      const response = await sendMessage(request as unknown as import('next/server').NextRequest, { params: { id: 'test-model-long' } });
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('model');
    });

    it('should reject model with control characters', async () => {
      const worktree: Worktree = {
        id: 'test-model-ctrl',
        name: 'Test Model Ctrl',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'copilot',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/test-model-ctrl/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test', model: 'gpt-4\x00' }),
      });

      const response = await sendMessage(request as unknown as import('next/server').NextRequest, { params: { id: 'test-model-ctrl' } });
      expect(response.status).toBe(400);
    });

    it('should reject model when cliToolId is not copilot', async () => {
      const worktree: Worktree = {
        id: 'test-model-claude',
        name: 'Test Model Claude',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/test-model-claude/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test', model: 'gpt-5-mini', cliToolId: 'claude' }),
      });

      const response = await sendMessage(request as unknown as import('next/server').NextRequest, { params: { id: 'test-model-claude' } });
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('copilot');
    });

    it('should accept valid model name for copilot', async () => {
      const worktree: Worktree = {
        id: 'test-model-valid',
        name: 'Test Model Valid',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'copilot',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/test-model-valid/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test message', model: 'gpt-5-mini' }),
      });

      const response = await sendMessage(request as unknown as import('next/server').NextRequest, { params: { id: 'test-model-valid' } });
      // Should succeed (201) or at least not be 400
      // Note: might be 500 if copilot session fails to start in test env, but not 400
      expect(response.status).not.toBe(400);
    });
  });

  describe('Error handling', () => {
    it('should return 400 for invalid cliToolId', async () => {
      const worktree: Worktree = {
        id: 'test-invalid',
        name: 'Test Invalid',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/test-invalid/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test message',
          cliToolId: 'invalid-tool',  // Invalid tool
        }),
      });

      const response = await sendMessage(request as unknown as import('next/server').NextRequest, { params: { id: 'test-invalid' } });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('Invalid CLI tool');
    });

    it('should preserve an existing user message if resend fails', async () => {
      const worktree: Worktree = {
        id: 'test-send-failure',
        name: 'Test Send Failure',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'codex',
      };
      upsertWorktree(db, worktree);

      const originalMessage = createMessage(db, {
        worktreeId: 'test-send-failure',
        role: 'user',
        content: 'Retry me',
        messageType: 'normal',
        timestamp: new Date('2026-03-01T00:00:00Z'),
        cliToolId: 'codex',
      });

      const { CLIToolManager } = await import('@/lib/cli-tools/manager');
      const tool = CLIToolManager.getInstance().getTool('codex');
      vi.spyOn(tool, 'sendMessage').mockRejectedValueOnce(new Error('send failed'));

      const request = new Request('http://localhost:3000/api/worktrees/test-send-failure/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Retry me',
          cliToolId: 'codex',
        }),
      });

      const response = await sendMessage(
        request as unknown as import('next/server').NextRequest,
        { params: { id: 'test-send-failure' } }
      );

      expect(response.status).toBe(500);

      const messages = getMessages(db, 'test-send-failure', { limit: 10, cliToolId: 'codex' });
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe(originalMessage.id);
      expect(messages[0].content).toBe('Retry me');
    });
  });
});
