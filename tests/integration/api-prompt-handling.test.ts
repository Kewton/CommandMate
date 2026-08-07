/**
 * API Routes Integration Tests - Prompt Handling
 * Tests the complete prompt detection and response flow
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST as respondToPrompt } from '@/app/api/worktrees/[id]/respond/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  upsertWorktree,
  createMessage,
  getMessageById,
  createTask,
  getTask,
  listTaskEvents,
} from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import type { Worktree } from '@/types/models';
import { answerablePromptOf } from '../helpers/prompt-type-guards';
import { buildStructuredPromptHistoryRecord } from '@/lib/session/structured-prompt';

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

// Mock tmux module. sendPromptAnswer (Issue #616) imports both sendKeys and
// sendSpecialKeys; provide both so multiple-choice answers don't throw
// "No sendSpecialKeys export" (Issue #1102).
vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  isClaudeRunning: vi.fn().mockResolvedValue(true),
}));

// Mock claude-session module
vi.mock('@/lib/session/claude-session', () => ({
  getSessionName: vi.fn((worktreeId: string) => `mcbd-${worktreeId}`),
  isClaudeRunning: vi.fn().mockResolvedValue(true),
}));

// Mock ws-server module
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: vi.fn(),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));

describe('POST /api/worktrees/:id/respond', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    // Create test worktree
    const worktree: Worktree = {
      id: 'test-worktree',
      name: 'test',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
    };
    upsertWorktree(db, worktree);

    // Clear all mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  describe('Responding to prompts', () => {
    it('should respond to a yes/no prompt with "yes"', async () => {
      // Create a prompt message
      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Do you want to proceed?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Do you want to proceed?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      // Send response
      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'yes',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: Promise.resolve({ id: 'test-worktree' }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.message).toBeDefined();
      expect(data.message.promptData.status).toBe('answered');
      expect(data.message.promptData.answer).toBe('yes');
      expect(data.message.promptData.answeredAt).toBeDefined();

      // Verify database was updated
      const updatedMessage = getMessageById(db, message.id);
      expect(updatedMessage).toBeDefined();
      expect(updatedMessage?.promptData?.status).toBe('answered');
      expect(answerablePromptOf(updatedMessage?.promptData)?.answer).toBe('yes');
    });

    it('should respond to a yes/no prompt with "no"', async () => {
      // Create a prompt message
      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Do you want to delete this file?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Do you want to delete this file?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      // Send response
      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'no',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: Promise.resolve({ id: 'test-worktree' }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.message.promptData.answer).toBe('no');
    });

    it('should send "y" to tmux when answering yes', async () => {
      const { sendKeys } = await import('@/lib/tmux/tmux');

      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'yes',
        }),
      });

      await respondToPrompt(request as unknown as import('next/server').NextRequest, { params: Promise.resolve({ id: 'test-worktree' }) });

      // Session name comes from the CLI tool (mcbd-<cliToolId>-<worktreeId>), and
      // the answer is sent first without Enter, then a separate Enter (Issue #616/#1102).
      expect(sendKeys).toHaveBeenCalledWith('mcbd-claude-test-worktree', 'y', false);
      expect(sendKeys).toHaveBeenCalledWith('mcbd-claude-test-worktree', '', true);
    });

    it('should send "n" to tmux when answering no', async () => {
      const { sendKeys } = await import('@/lib/tmux/tmux');

      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'no',
        }),
      });

      await respondToPrompt(request as unknown as import('next/server').NextRequest, { params: Promise.resolve({ id: 'test-worktree' }) });

      // Answer sent without Enter, then a separate Enter (Issue #616/#1102).
      expect(sendKeys).toHaveBeenCalledWith('mcbd-claude-test-worktree', 'n', false);
      expect(sendKeys).toHaveBeenCalledWith('mcbd-claude-test-worktree', '', true);
    });

    it('should broadcast updated message via WebSocket', async () => {
      const { broadcastMessage } = await import('@/lib/ws-server');

      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'yes',
        }),
      });

      await respondToPrompt(request as unknown as import('next/server').NextRequest, { params: Promise.resolve({ id: 'test-worktree' }) });

      expect(broadcastMessage).toHaveBeenCalledWith('message_updated', {
        worktreeId: 'test-worktree',
        message: expect.objectContaining({
          id: message.id,
          promptData: expect.objectContaining({
            status: 'answered',
            answer: 'yes',
          }),
        }),
      });
    });
  });

  describe('Error handling', () => {
    it('should return 400 if messageId is missing', async () => {
      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answer: 'yes',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: Promise.resolve({ id: 'test-worktree' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('messageId and answer are required');
    });

    it('should return 400 if answer is missing', async () => {
      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: 'some-id',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: Promise.resolve({ id: 'test-worktree' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('messageId and answer are required');
    });

    it('should return 404 if message not found', async () => {
      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: 'nonexistent-id',
          answer: 'yes',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: Promise.resolve({ id: 'test-worktree' }),
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe('Message not found');
    });

    it('should return 400 if message is not a prompt', async () => {
      // Create a normal message (not a prompt)
      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'user',
        content: 'Hello',
        messageType: 'normal',
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'yes',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: Promise.resolve({ id: 'test-worktree' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Message is not a prompt');
    });

    it('should return 400 if prompt already answered', async () => {
      // Create an already-answered prompt
      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'answered',
          answer: 'yes',
          answeredAt: new Date().toISOString(),
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'no',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: Promise.resolve({ id: 'test-worktree' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Prompt already answered');
    });

    it('should refuse a stored unclassified frame record (Issue #1738)', async () => {
      // #1708 writes this row into `chat_messages.prompt_data` — the same column
      // parsed prompts live in — so that a stall nobody could read still leaves a
      // trace for `capture --prompts`. It is an audit record, not a prompt: no
      // options were ever parsed, and answering it would type a string into the
      // pane on behalf of a dialog nobody read. Before #1738 the row fell past the
      // multiple_choice branch straight into the yes/no one.
      const { sendKeys } = await import('@/lib/tmux/tmux');
      vi.mocked(sendKeys).mockClear();

      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Unclassified interactive frame',
        messageType: 'prompt',
        promptData: {
          type: 'unclassified',
          status: 'unclassified',
          question: 'Unclassified interactive frame (running/default) held for 900s.',
          options: [],
          dwellSeconds: 900,
          sessionStatusReason: 'running/default',
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: message.id, answer: 'yes' }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: Promise.resolve({ id: 'test-worktree' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('never classified');
      // Nothing reached the terminal, and the audit row was left as it was.
      expect(sendKeys).not.toHaveBeenCalled();
      expect(getMessageById(db, message.id)?.promptData?.status).toBe('unclassified');
    });

    it('should refuse a stored structured prompt history record (Issue #1738)', async () => {
      // #1725's counterpart: the structured layer saw a dialog the scraper did
      // not. Same column, same `type: 'unclassified'`, same refusal.
      const { sendKeys } = await import('@/lib/tmux/tmux');
      vi.mocked(sendKeys).mockClear();

      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'A dialog is open',
        messageType: 'prompt',
        promptData: buildStructuredPromptHistoryRecord('test-worktree', {
          source: 'notification',
          message: 'Claude needs your permission to use Bash',
          toolName: 'Bash',
        }),
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: message.id, answer: '1' }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: Promise.resolve({ id: 'test-worktree' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      // Asserting the REASON, not just the 400: without the #1738 refusal this
      // row still 400s, but on `getAnswerInput` failing to parse an answer for a
      // prompt type it does not know — which is luck, not a decision.
      expect(data.error).toContain('never classified');
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it('should return 400 if answer is invalid', async () => {
      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'maybe',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: Promise.resolve({ id: 'test-worktree' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('Invalid answer');
    });
  });

  describe('Case insensitivity', () => {
    it('should accept "YES" as valid answer', async () => {
      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'YES',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: Promise.resolve({ id: 'test-worktree' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it('should accept "Y" as valid answer', async () => {
      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'Y',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: Promise.resolve({ id: 'test-worktree' }),
      });

      expect(response.status).toBe(200);
    });
  });

  /**
   * Issue #1548: this route is the human half of the prompt loop, and Phase 4
   * counts human interventions from these rows. The contract-less case matters
   * more than the contracted one — it is what every user without a contract
   * hits, and it must produce no rows at all.
   */
  describe('task events', () => {
    const seedPrompt = () =>
      createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Do you want to proceed?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Do you want to proceed?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

    const seedTask = (status: 'waiting_input' | 'succeeded') =>
      createTask(db, {
        worktreeId: 'test-worktree',
        cliToolId: 'claude',
        instanceId: null,
        contractPath: '.commandmate/tasks/t.yaml',
        contract: parseTaskContract(
          'version: 1\ntitle: t\ngoal: do it\nscope:\n  allow: ["src/**"]\n',
          'task.yaml'
        ),
        status,
      });

    const respond = async (messageId: string) =>
      respondToPrompt(
        new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId, answer: 'yes' }),
        }) as unknown as import('next/server').NextRequest,
        { params: Promise.resolve({ id: 'test-worktree' }) }
      );

    it('records prompt_answered_human against the waiting task', async () => {
      const task = seedTask('waiting_input');
      const message = seedPrompt();

      expect((await respond(message.id)).status).toBe(200);

      expect(getTask(db, task.id)?.status).toBe('running');
      expect(listTaskEvents(db, task.id).map((e) => [e.event, e.toStatus])).toEqual([
        ['prompt_answered_human', 'running'],
      ]);
    });

    it('answers normally and writes nothing when no contract is running', async () => {
      const message = seedPrompt();

      expect((await respond(message.id)).status).toBe(200);
      expect(getMessageById(db, message.id)?.promptData?.status).toBe('answered');
      expect(db.prepare('SELECT COUNT(*) AS n FROM task_events').get()).toEqual({ n: 0 });
    });

    it('leaves a closed task closed, without recording a phantom answer', async () => {
      const task = seedTask('succeeded');
      const message = seedPrompt();

      expect((await respond(message.id)).status).toBe(200);
      expect(getTask(db, task.id)?.status).toBe('succeeded');
      expect(listTaskEvents(db, task.id)).toHaveLength(0);
    });
  });
});
