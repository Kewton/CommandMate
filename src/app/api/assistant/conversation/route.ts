/**
 * Assistant Conversation API
 * GET /api/assistant/conversation?repositoryId=...&cliToolId=...
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType } from '@/lib/cli-tools/types';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  getAssistantConversationByRepositoryAndCliTool,
  updateAssistantConversation,
} from '@/lib/db';
import { getRepositoryById } from '@/lib/db/db-repository';
import { hasSession } from '@/lib/tmux/tmux';
import { getAssistantConversationSession } from '@/lib/assistant/conversation-session';
import { isAssistantNonInteractiveTool } from '@/lib/assistant/tool-capabilities';
import { reconcileAssistantConversationExecution } from '@/lib/assistant/non-interactive-execution-reconciler';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const repositoryId = searchParams.get('repositoryId');
  const cliToolId = searchParams.get('cliToolId');

  if (!repositoryId || typeof repositoryId !== 'string') {
    return NextResponse.json({ error: 'Invalid repositoryId parameter' }, { status: 400 });
  }

  if (!cliToolId || !isCliToolType(cliToolId)) {
    return NextResponse.json({ error: 'Invalid cliToolId parameter' }, { status: 400 });
  }

  const db = getDbInstance();
  const repository = getRepositoryById(db, repositoryId);
  if (!repository) {
    return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
  }

  const conversation = getAssistantConversationByRepositoryAndCliTool(db, repositoryId, cliToolId);
  if (!conversation) {
    return NextResponse.json({ conversation: null });
  }

  if (isAssistantNonInteractiveTool(cliToolId)) {
    reconcileAssistantConversationExecution(db, conversation.id);
    return NextResponse.json({
      conversation: getAssistantConversationByRepositoryAndCliTool(db, repositoryId, cliToolId),
    });
  }

  if (conversation.status === 'running') {
    const { sessionName } = getAssistantConversationSession(cliToolId, conversation.id);
    if (!await hasSession(sessionName)) {
      const synced = updateAssistantConversation(db, conversation.id, {
        status: 'stopped',
        lastStoppedAt: new Date(),
      });
      return NextResponse.json({ conversation: synced });
    }
  }

  return NextResponse.json({ conversation });
}
