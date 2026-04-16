/**
 * Assistant Session API endpoint
 * DELETE /api/assistant/session?conversationId=...&cliToolId=...
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType } from '@/lib/cli-tools/types';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  deleteAssistantSessionState,
  getAssistantConversationById,
  getRunningAssistantExecutionByConversation,
  updateAssistantConversation,
} from '@/lib/db';
import { getRepositoryById } from '@/lib/db/db-repository';
import { stopAssistantConversationPolling } from '@/lib/polling/assistant-conversation-poller';
import { savePendingAssistantResponseForConversation } from '@/lib/assistant/conversation-response-saver';
import { getAssistantConversationSession } from '@/lib/assistant/conversation-session';
import { hasSession } from '@/lib/tmux/tmux';
import { createLogger } from '@/lib/logger';
import { cancelAssistantExecutionProcess } from '@/lib/assistant/non-interactive-process-registry';
import { isAssistantNonInteractiveTool } from '@/lib/assistant/tool-capabilities';
import { reconcileAssistantConversationExecution } from '@/lib/assistant/non-interactive-execution-reconciler';

const logger = createLogger('api/assistant/session');

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const conversationId = searchParams.get('conversationId');
    const cliToolId = searchParams.get('cliToolId');

    if (!conversationId || typeof conversationId !== 'string') {
      return NextResponse.json({ error: 'Invalid conversationId parameter' }, { status: 400 });
    }

    if (!cliToolId || !isCliToolType(cliToolId)) {
      return NextResponse.json({ error: 'Invalid cliToolId parameter' }, { status: 400 });
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

      const runningExecution = getRunningAssistantExecutionByConversation(db, conversationId);
      const killed = runningExecution ? cancelAssistantExecutionProcess(conversationId) : false;

      updateAssistantConversation(db, conversationId, {
        status: 'stopped',
        lastStoppedAt: new Date(),
      });

      logger.info('conversation:stopped', { conversationId, cliToolId, killed });
      return NextResponse.json({ success: true, killed });
    }

    stopAssistantConversationPolling(conversationId, cliToolId);
    await savePendingAssistantResponseForConversation(db, conversationId, cliToolId);

    const { cliTool, sessionName, worktreeId } = getAssistantConversationSession(cliToolId, conversationId);
    const sessionExists = await hasSession(sessionName);
    const killed = sessionExists ? await cliTool.killSession(worktreeId) : false;

    deleteAssistantSessionState(db, conversationId);
    updateAssistantConversation(db, conversationId, {
      status: 'stopped',
      lastStoppedAt: new Date(),
    });

    logger.info('session:stopped', { conversationId, cliToolId, sessionName, killed });

    return NextResponse.json({ success: true, killed });
  } catch (error) {
    logger.error('session-api-error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to stop assistant session' },
      { status: 500 },
    );
  }
}
