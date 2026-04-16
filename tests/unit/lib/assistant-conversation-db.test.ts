import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRepository } from '@/lib/db/db-repository';
import {
  createAssistantConversation,
  createAssistantExecution,
  createAssistantMessage,
  deleteAssistantSessionState,
  getAssistantConversationById,
  getLatestAssistantExecutionByConversation,
  getRunningAssistantExecutionByConversation,
  getAssistantConversationByRepositoryAndCliTool,
  getAssistantMessages,
  getAssistantSessionState,
  updateAssistantConversation,
  updateAssistantExecution,
  updateAssistantMessageStatus,
  updateAssistantSessionState,
} from '@/lib/db';

describe('assistant-conversation-db', () => {
  let db: Database.Database;
  let repositoryId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    repositoryId = createRepository(db, {
      name: 'repo-alpha',
      path: '/tmp/repo-alpha',
      cloneSource: 'local',
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  it('creates and reloads a conversation by repository and tool', () => {
    const conversation = createAssistantConversation(db, {
      repositoryId,
      cliToolId: 'codex',
      workingDirectory: '/tmp/repo-alpha',
      status: 'stopped',
    });

    const byId = getAssistantConversationById(db, conversation.id);
    const bySelector = getAssistantConversationByRepositoryAndCliTool(db, repositoryId, 'codex');

    expect(byId?.id).toBe(conversation.id);
    expect(bySelector?.id).toBe(conversation.id);
    expect(bySelector?.workingDirectory).toBe('/tmp/repo-alpha');
  });

  it('stores delivery status and chronological messages', () => {
    const conversation = createAssistantConversation(db, {
      repositoryId,
      cliToolId: 'codex',
      workingDirectory: '/tmp/repo-alpha',
      executionMode: 'non_interactive',
      status: 'ready',
    });

    const userMessage = createAssistantMessage(db, {
      conversationId: conversation.id,
      role: 'user',
      content: 'hello',
      messageType: 'normal',
      deliveryStatus: 'pending',
      timestamp: new Date('2026-04-14T10:00:00.000Z'),
    });
    updateAssistantMessageStatus(db, userMessage.id, 'sent');

    createAssistantMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: 'hi',
      messageType: 'normal',
      timestamp: new Date('2026-04-14T10:00:01.000Z'),
    });

    const messages = getAssistantMessages(db, conversation.id);

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('hi');
    expect(messages[1].deliveryStatus).toBe('sent');
  });

  it('tracks and deletes assistant session state', () => {
    const conversation = createAssistantConversation(db, {
      repositoryId,
      cliToolId: 'codex',
      workingDirectory: '/tmp/repo-alpha',
      status: 'running',
    });

    updateAssistantSessionState(db, conversation.id, 42, 'message-1');
    expect(getAssistantSessionState(db, conversation.id)).toEqual({
      conversationId: conversation.id,
      lastCapturedLine: 42,
      inProgressMessageId: 'message-1',
    });

    deleteAssistantSessionState(db, conversation.id);
    expect(getAssistantSessionState(db, conversation.id)).toBeNull();
  });

  it('stores and updates assistant executions', () => {
    const conversation = createAssistantConversation(db, {
      repositoryId,
      cliToolId: 'codex',
      workingDirectory: '/tmp/repo-alpha',
      executionMode: 'non_interactive',
      status: 'ready',
    });

    const execution = createAssistantExecution(db, {
      conversationId: conversation.id,
      cliToolId: 'codex',
      status: 'running',
      commandLine: 'codex exec --json',
      promptText: 'hello',
      startedAt: new Date('2026-04-14T10:00:00.000Z'),
    });

    expect(getRunningAssistantExecutionByConversation(db, conversation.id)?.id).toBe(execution.id);

    updateAssistantExecution(db, execution.id, {
      status: 'completed',
      stdoutText: 'stdout',
      finalMessageText: 'assistant reply',
      finishedAt: new Date('2026-04-14T10:00:02.000Z'),
    });
    updateAssistantConversation(db, conversation.id, {
      lastExecutionId: execution.id,
      resumeSessionId: 'resume-1',
    });

    const reloadedConversation = getAssistantConversationById(db, conversation.id);
    const latestExecution = getLatestAssistantExecutionByConversation(db, conversation.id);

    expect(reloadedConversation?.lastExecutionId).toBe(execution.id);
    expect(reloadedConversation?.resumeSessionId).toBe('resume-1');
    expect(latestExecution?.status).toBe('completed');
    expect(latestExecution?.finalMessageText).toBe('assistant reply');
  });
});
