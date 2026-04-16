/**
 * Assistant Messages API
 * GET /api/assistant/messages?conversationId=...
 * DELETE /api/assistant/messages?conversationId=...
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  archiveAllAssistantMessages,
  archiveAssistantMessagesFrom,
  getAssistantConversationById,
  getAssistantMessages,
  getAssistantMessageById,
  getRunningAssistantExecutionByConversation,
  updateAssistantConversation,
} from '@/lib/db';
import { getRepositoryById } from '@/lib/db/db-repository';
import { savePendingAssistantResponseForConversation } from '@/lib/assistant/conversation-response-saver';
import { isAssistantNonInteractiveTool } from '@/lib/assistant/tool-capabilities';
import { reconcileAssistantConversationExecution } from '@/lib/assistant/non-interactive-execution-reconciler';
import { createLogger } from '@/lib/logger';

const DEFAULT_LIMIT = 200;
const logger = createLogger('api/assistant/messages');

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const conversationId = searchParams.get('conversationId');

  if (!conversationId || typeof conversationId !== 'string') {
    return NextResponse.json({ error: 'Invalid conversationId parameter' }, { status: 400 });
  }

  const db = getDbInstance();
  const conversation = getAssistantConversationById(db, conversationId);
  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const repository = getRepositoryById(db, conversation.repositoryId);
  if (!repository) {
    return NextResponse.json({ error: 'Conversation repository not found' }, { status: 404 });
  }

  if (isAssistantNonInteractiveTool(conversation.cliToolId)) {
    reconcileAssistantConversationExecution(db, conversationId);
  } else if (conversation.status === 'running') {
    await savePendingAssistantResponseForConversation(db, conversationId, conversation.cliToolId);
  }

  const messages = getAssistantMessages(db, conversationId, { limit: DEFAULT_LIMIT })
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return NextResponse.json({
    conversationId,
    messages,
  });
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const conversationId = searchParams.get('conversationId');
    const fromMessageId = searchParams.get('fromMessageId');

    if (!conversationId || typeof conversationId !== 'string') {
      return NextResponse.json({ error: 'Invalid conversationId parameter' }, { status: 400 });
    }

    const db = getDbInstance();
    const conversation = getAssistantConversationById(db, conversationId);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    if (isAssistantNonInteractiveTool(conversation.cliToolId)) {
      reconcileAssistantConversationExecution(db, conversationId);
    }

    if (getRunningAssistantExecutionByConversation(db, conversationId)) {
      return NextResponse.json(
        { error: 'Cannot clear history while a run is in progress' },
        { status: 409 },
      );
    }

    let archivedCount = 0;
    if (fromMessageId) {
      const target = getAssistantMessageById(db, fromMessageId);
      if (!target || target.conversationId !== conversationId) {
        return NextResponse.json({ error: 'Message not found' }, { status: 404 });
      }
      archivedCount = archiveAssistantMessagesFrom(
        db,
        conversationId,
        target.timestamp.getTime(),
      );
    } else {
      archivedCount = archiveAllAssistantMessages(db, conversationId);
    }

    updateAssistantConversation(db, conversationId, {
      resumeSessionId: null,
    });

    logger.info('messages:cleared', { conversationId, archivedCount, fromMessageId });

    return NextResponse.json({ success: true, archivedCount });
  } catch (error) {
    logger.error('messages-delete-error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to clear assistant messages' },
      { status: 500 },
    );
  }
}
