/**
 * Assistant Current Output API endpoint
 * GET /api/assistant/current-output?conversationId=...&cliToolId=...
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType } from '@/lib/cli-tools/types';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  getAssistantConversationById,
  getLatestAssistantExecutionByConversation,
  getRunningAssistantExecutionByConversation,
  updateAssistantConversation,
} from '@/lib/db';
import { getRepositoryById } from '@/lib/db/db-repository';
import { capturePane, hasSession } from '@/lib/tmux/tmux';
import { getAssistantConversationSession } from '@/lib/assistant/conversation-session';
import { createLogger } from '@/lib/logger';
import { isAssistantNonInteractiveTool } from '@/lib/assistant/tool-capabilities';
import { reconcileAssistantConversationExecution } from '@/lib/assistant/non-interactive-execution-reconciler';

const logger = createLogger('api/assistant/current-output');

const DEFAULT_CAPTURE_LINES = 1000;

export async function GET(req: NextRequest) {
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
      const latestExecution = runningExecution ?? getLatestAssistantExecutionByConversation(db, conversationId);
      const output = [latestExecution?.stdoutText, latestExecution?.stderrText]
        .filter(Boolean)
        .join('\n')
        .trim();

      if (!runningExecution && conversation.status === 'running') {
        updateAssistantConversation(db, conversationId, {
          status: 'ready',
        });
      }

      return NextResponse.json({
        output,
        sessionActive: Boolean(runningExecution),
      });
    }

    const { sessionName } = getAssistantConversationSession(cliToolId, conversationId);
    const sessionActive = await hasSession(sessionName);
    if (!sessionActive) {
      if (conversation.status === 'running') {
        updateAssistantConversation(db, conversationId, {
          status: 'stopped',
          lastStoppedAt: new Date(),
        });
      }

      return NextResponse.json({ output: '', sessionActive: false });
    }

    const output = await capturePane(sessionName, DEFAULT_CAPTURE_LINES);
    return NextResponse.json({ output, sessionActive: true });
  } catch (error) {
    logger.error('current-output-api-error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to capture assistant output' },
      { status: 500 },
    );
  }
}
