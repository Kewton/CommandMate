/**
 * Unit Tests: startNonInteractiveAssistantExecution
 * Issue #1344: a failure while starting the execution (or while finalizing it in
 * the 'close' handler) must not leave the conversation stuck in 'running'.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRepository, type Repository } from '@/lib/db/db-repository';
import {
  createAssistantConversation,
  getAssistantConversationById,
  getAssistantMessages,
  getLatestAssistantExecutionByConversation,
  getRunningAssistantExecutionByConversation,
  createAssistantMessage,
} from '@/lib/db';
import { getAssistantExecutionProcessByConversation } from '@/lib/assistant/non-interactive-process-registry';
import { startNonInteractiveAssistantExecution } from '@/lib/assistant/non-interactive-runner';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// The prompt builder walks the repository (git status, file reads); the runner's
// failure handling does not depend on the prompt contents.
vi.mock('@/lib/assistant/non-interactive-prompt-builder', () => ({
  buildNonInteractivePrompt: vi.fn(() => 'PROMPT'),
}));

const { parseCodexStructuredOutput } = vi.hoisted(() => ({
  parseCodexStructuredOutput: vi.fn(() => ({ finalMessage: 'done', resumeSessionId: 'session-1' })),
}));
vi.mock('@/lib/assistant/non-interactive-output-parser', () => ({
  parseClaudeStructuredOutput: vi.fn(),
  parseAntigravityPlainOutput: vi.fn(),
  parseCodexStructuredOutput,
}));

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
}));

class FakeChild extends EventEmitter {
  pid = 4242;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

describe('startNonInteractiveAssistantExecution (Issue #1344)', () => {
  let db: Database.Database;
  let repository: Repository;
  let conversationId: string;
  let userMessageId: string;
  let child: FakeChild;

  const startExecution = () =>
    startNonInteractiveAssistantExecution({
      db,
      conversationId,
      cliToolId: 'codex',
      repository,
      userMessageId,
      userMessage: 'hello',
    });

  beforeEach(() => {
    vi.clearAllMocks();
    parseCodexStructuredOutput.mockReturnValue({ finalMessage: 'done', resumeSessionId: 'session-1' });

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    repository = createRepository(db, {
      name: 'repo-alpha',
      path: '/tmp/repo-alpha',
      cloneSource: 'local',
    });

    conversationId = createAssistantConversation(db, {
      repositoryId: repository.id,
      cliToolId: 'codex',
      workingDirectory: repository.path,
      executionMode: 'non_interactive',
      status: 'ready',
    }).id;

    userMessageId = createAssistantMessage(db, {
      conversationId,
      role: 'user',
      content: 'hello',
      messageType: 'normal',
      deliveryStatus: 'pending',
      timestamp: new Date(),
    }).id;

    child = new FakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
  });

  afterEach(() => {
    db.close();
  });

  describe('startup failure (path 1: unprotected, reconciler cannot heal it)', () => {
    it('rolls the conversation back to ready when stdin.write throws', async () => {
      child.stdin.write.mockImplementation(() => {
        throw new Error('write EPIPE');
      });

      await expect(startExecution()).rejects.toThrow('write EPIPE');

      // The whole point of the fix: the terminal route requires 'ready', so a
      // conversation left in 'running' can never be messaged again.
      expect(getAssistantConversationById(db, conversationId)?.status).toBe('ready');
      expect(getLatestAssistantExecutionByConversation(db, conversationId)?.status).toBe('failed');
      expect(getRunningAssistantExecutionByConversation(db, conversationId)).toBeNull();
    });

    it('marks the user message failed and records the error on the execution', async () => {
      child.stdin.write.mockImplementation(() => {
        throw new Error('write EPIPE');
      });

      await expect(startExecution()).rejects.toThrow('write EPIPE');

      const messages = getAssistantMessages(db, conversationId);
      expect(messages.find((message) => message.id === userMessageId)?.deliveryStatus).toBe('failed');
      expect(getLatestAssistantExecutionByConversation(db, conversationId)?.stderrText).toContain(
        'write EPIPE',
      );
    });

    it('kills the child and unregisters it so no stdin-blocked process is left behind', async () => {
      child.stdin.write.mockImplementation(() => {
        throw new Error('write EPIPE');
      });

      await expect(startExecution()).rejects.toThrow('write EPIPE');

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(getAssistantExecutionProcessByConversation(conversationId)).toBeNull();
    });

    it('does not let the killed child close-handler overwrite the rollback', async () => {
      child.stdin.write.mockImplementation(() => {
        throw new Error('write EPIPE');
      });

      await expect(startExecution()).rejects.toThrow('write EPIPE');
      const executionId = getLatestAssistantExecutionByConversation(db, conversationId)?.id;

      // SIGTERM makes the child emit 'close'; that handler must not re-run the
      // terminal transition for an execution the rollback already finalized.
      child.emit('close', null);

      expect(getLatestAssistantExecutionByConversation(db, conversationId)?.id).toBe(executionId);
      expect(getLatestAssistantExecutionByConversation(db, conversationId)?.stderrText).toContain(
        'write EPIPE',
      );
      expect(getAssistantConversationById(db, conversationId)?.status).toBe('ready');
    });
  });

  describe('close handler failure (path 2: reconciler heals it, but only later)', () => {
    it('finalizes the conversation when output parsing throws', async () => {
      parseCodexStructuredOutput.mockImplementation(() => {
        throw new Error('parse boom');
      });

      await startExecution();
      expect(getAssistantConversationById(db, conversationId)?.status).toBe('running');

      child.emit('close', 0);

      expect(getAssistantConversationById(db, conversationId)?.status).toBe('ready');
      expect(getLatestAssistantExecutionByConversation(db, conversationId)?.status).toBe('failed');
      expect(getAssistantExecutionProcessByConversation(conversationId)).toBeNull();
    });
  });

  describe('happy path', () => {
    it('stores the assistant reply and returns the conversation to ready', async () => {
      const { executionId } = await startExecution();

      expect(child.stdin.write).toHaveBeenCalledWith('PROMPT');
      expect(child.stdin.end).toHaveBeenCalled();
      expect(getAssistantConversationById(db, conversationId)?.status).toBe('running');

      child.stdout.emit('data', '{"type":"item.completed"}');
      child.emit('close', 0);

      const conversation = getAssistantConversationById(db, conversationId);
      expect(conversation?.status).toBe('ready');
      expect(conversation?.resumeSessionId).toBe('session-1');

      const execution = getLatestAssistantExecutionByConversation(db, conversationId);
      expect(execution?.id).toBe(executionId);
      expect(execution?.status).toBe('completed');

      const messages = getAssistantMessages(db, conversationId);
      expect(messages.some((message) => message.role === 'assistant' && message.content === 'done')).toBe(true);
      expect(messages.find((message) => message.id === userMessageId)?.deliveryStatus).toBe('sent');
    });
  });
});
