/**
 * Assistant Terminal API endpoint
 * POST /api/assistant/terminal
 *
 * Sends a user message to a conversation-backed tmux session.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType } from '@/lib/cli-tools/types';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  createAssistantMessage,
  getAssistantConversationById,
  getRunningAssistantExecutionByConversation,
  updateAssistantMessageStatus,
} from '@/lib/db';
import { getRepositoryById } from '@/lib/db/db-repository';
import { hasSession } from '@/lib/tmux/tmux';
import { getAssistantConversationSession } from '@/lib/assistant/conversation-session';
import { savePendingAssistantResponseForConversation } from '@/lib/assistant/conversation-response-saver';
import { createLogger } from '@/lib/logger';
import { isAssistantNonInteractiveTool } from '@/lib/assistant/tool-capabilities';
import { reconcileAssistantConversationExecution } from '@/lib/assistant/non-interactive-execution-reconciler';
import { startNonInteractiveAssistantExecution } from '@/lib/assistant/non-interactive-runner';

const logger = createLogger('api/assistant/terminal');

const MAX_COMMAND_LENGTH = 10000;

export async function POST(req: NextRequest) {
  try {
    const { cliToolId, conversationId, command } = await req.json();

    if (!cliToolId || typeof cliToolId !== 'string' || !isCliToolType(cliToolId)) {
      return NextResponse.json({ error: 'Invalid cliToolId parameter' }, { status: 400 });
    }

    if (!isAssistantNonInteractiveTool(cliToolId)) {
      return NextResponse.json(
        { error: `Assistant Chat supports only claude and codex (got '${cliToolId}')` },
        { status: 400 },
      );
    }

    if (!conversationId || typeof conversationId !== 'string') {
      return NextResponse.json({ error: 'Invalid conversationId parameter' }, { status: 400 });
    }

    if (!command || typeof command !== 'string' || command.length > MAX_COMMAND_LENGTH) {
      return NextResponse.json({ error: 'Invalid command parameter' }, { status: 400 });
    }

    const db = getDbInstance();
    const conversation = getAssistantConversationById(db, conversationId);
    if (!conversation || conversation.cliToolId !== cliToolId) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const repository = getRepositoryById(db, conversation.repositoryId);
    if (!repository) {
      return NextResponse.json({ error: 'Conversation repository not found' }, { status: 404 });
    }

    if (isAssistantNonInteractiveTool(cliToolId)) {
      reconcileAssistantConversationExecution(db, conversationId);

      const latestConversation = getAssistantConversationById(db, conversationId);
      if (!latestConversation || latestConversation.cliToolId !== cliToolId) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }

      if (latestConversation.status !== 'ready') {
        return NextResponse.json(
          { error: 'Conversation must be started before sending a message' },
          { status: 409 },
        );
      }

      if (getRunningAssistantExecutionByConversation(db, conversationId)) {
        return NextResponse.json(
          { error: 'Conversation already has a running execution' },
          { status: 409 },
        );
      }

      const now = new Date();
      const userMessage = createAssistantMessage(db, {
        conversationId,
        role: 'user',
        content: command,
        messageType: 'normal',
        deliveryStatus: 'pending',
        timestamp: now,
      });

      try {
        const { executionId } = await startNonInteractiveAssistantExecution({
          db,
          conversationId,
          cliToolId,
          repository,
          userMessageId: userMessage.id,
          userMessage: command,
        });
        return NextResponse.json({ success: true, messageId: userMessage.id, executionId });
      } catch (error) {
        updateAssistantMessageStatus(db, userMessage.id, 'failed');
        throw error;
      }
    }

    if (conversation.status !== 'running') {
      return NextResponse.json({ error: 'Conversation session is not running' }, { status: 409 });
    }

    const { cliTool, worktreeId, sessionName } = getAssistantConversationSession(cliToolId, conversationId);
    if (!await hasSession(sessionName)) {
      return NextResponse.json({ error: 'Session not found. Start the session first.' }, { status: 404 });
    }

    await savePendingAssistantResponseForConversation(db, conversationId, cliToolId);

    const now = new Date();
    const userMessage = createAssistantMessage(db, {
      conversationId,
      role: 'user',
      content: command,
      messageType: 'normal',
      deliveryStatus: 'pending',
      timestamp: now,
    });

    try {
      await cliTool.sendMessage(worktreeId, command);
      updateAssistantMessageStatus(db, userMessage.id, 'sent');
      return NextResponse.json({ success: true, messageId: userMessage.id });
    } catch (error) {
      updateAssistantMessageStatus(db, userMessage.id, 'failed');
      throw error;
    }
  } catch (error) {
    logger.error('terminal-api-error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to send command to terminal' },
      { status: 500 },
    );
  }
}
