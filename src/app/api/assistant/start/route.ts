/**
 * Assistant Start API endpoint
 * POST /api/assistant/start
 *
 * Starts or resumes a Home Assistant Chat conversation session.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType } from '@/lib/cli-tools/types';
import { getDbInstance } from '@/lib/db/db-instance';
import { getRepositoryById } from '@/lib/db/db-repository';
import {
  createAssistantConversation,
  createAssistantMessage,
  deleteAssistantSessionState,
  getAssistantConversationByRepositoryAndCliTool,
  getRunningAssistantExecutionByConversation,
  updateAssistantSessionState,
  updateAssistantConversation,
} from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { hasSession } from '@/lib/tmux/tmux';
import { buildAssistantStartupSnapshot, buildGlobalContext } from '@/lib/assistant/context-builder';
import { getAssistantConversationSession } from '@/lib/assistant/conversation-session';
import { pollAssistantConversation } from '@/lib/polling/assistant-conversation-poller';
import { createLogger } from '@/lib/logger';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { getAssistantExecutionMode, isAssistantNonInteractiveTool } from '@/lib/assistant/tool-capabilities';
import { reconcileAssistantConversationExecution } from '@/lib/assistant/non-interactive-execution-reconciler';

const logger = createLogger('api/assistant/start');

export async function POST(req: NextRequest) {
  try {
    const { cliToolId, repositoryId } = await req.json();

    if (!cliToolId || typeof cliToolId !== 'string' || !isCliToolType(cliToolId)) {
      return NextResponse.json({ error: 'Invalid cliToolId parameter' }, { status: 400 });
    }

    if (!isAssistantNonInteractiveTool(cliToolId)) {
      return NextResponse.json(
        { error: `Assistant Chat supports only claude and codex (got '${cliToolId}')` },
        { status: 400 },
      );
    }

    if (!repositoryId || typeof repositoryId !== 'string') {
      return NextResponse.json({ error: 'Invalid repositoryId parameter' }, { status: 400 });
    }

    const db = getDbInstance();
    const repository = getRepositoryById(db, repositoryId);
    if (!repository) {
      return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
    }

    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);
    if (!await cliTool.isInstalled()) {
      return NextResponse.json(
        { error: `CLI tool '${cliToolId}' is not installed` },
        { status: 503 },
      );
    }

    let conversation = getAssistantConversationByRepositoryAndCliTool(db, repositoryId, cliToolId);
    if (!conversation) {
      conversation = createAssistantConversation(db, {
        repositoryId,
        cliToolId,
        workingDirectory: repository.path,
        executionMode: getAssistantExecutionMode(cliToolId),
        status: 'stopped',
      });
    }

    if (isAssistantNonInteractiveTool(cliToolId)) {
      reconcileAssistantConversationExecution(db, conversation.id);
      const syncedConversation = getAssistantConversationByRepositoryAndCliTool(db, repositoryId, cliToolId);
      conversation = syncedConversation ?? conversation;

      if (getRunningAssistantExecutionByConversation(db, conversation.id)) {
        return NextResponse.json(
          { error: 'Conversation already has a running execution' },
          { status: 409 },
        );
      }

      const snapshotTakenAt = new Date();
      const contextSnapshot = buildAssistantStartupSnapshot(cliToolId, db, snapshotTakenAt);
      conversation = updateAssistantConversation(db, conversation.id, {
        executionMode: 'non_interactive',
        workingDirectory: repository.path,
        status: 'ready',
        contextSentAt: snapshotTakenAt,
        contextSnapshot,
      }) ?? conversation;

      logger.info('conversation:ready', {
        conversationId: conversation.id,
        cliToolId,
        repositoryId,
      });

      return NextResponse.json({
        success: true,
        conversation,
        executionMode: 'non_interactive',
        resumeAvailable: Boolean(conversation.resumeSessionId),
      });
    }

    const { worktreeId, sessionName } = getAssistantConversationSession(cliToolId, conversation.id);
    const sessionExists = await hasSession(sessionName);

    await cliTool.startSession(worktreeId, repository.path);

    if (!sessionExists) {
      try {
        const startupOutput = await captureSessionOutput(worktreeId, cliToolId, 10000);
        const startupLines = startupOutput.split('\n');
        let startupLineCount = startupLines.length;
        while (startupLineCount > 0 && startupLines[startupLineCount - 1].trim() === '') {
          startupLineCount--;
        }
        updateAssistantSessionState(db, conversation.id, startupLineCount);
      } catch {
        // Ignore baseline capture failures and rely on later saves.
      }
    }

    const now = new Date();
    let contextSentAt = conversation.contextSentAt ?? null;
    if (!sessionExists) {
      const context = buildGlobalContext(cliToolId, db);
      await cliTool.sendMessage(worktreeId, context);
      contextSentAt = now;
      deleteAssistantSessionState(db, conversation.id);
      createAssistantMessage(db, {
        conversationId: conversation.id,
        role: 'system',
        content: 'New assistant session started',
        messageType: 'session_boundary',
        timestamp: now,
      });
    }

    conversation = updateAssistantConversation(db, conversation.id, {
      executionMode: 'interactive',
      workingDirectory: repository.path,
      sessionName,
      status: 'running',
      lastStartedAt: now,
      contextSentAt,
    }) ?? conversation;

    pollAssistantConversation(conversation.id, cliToolId);

    logger.info('session:started', {
      conversationId: conversation.id,
      cliToolId,
      sessionName,
      repositoryId,
    });

    return NextResponse.json({
      success: true,
      conversation,
      executionMode: 'interactive',
      resumeAvailable: false,
    });
  } catch (error) {
    logger.error('start-api-error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to start assistant session' },
      { status: 500 },
    );
  }
}
