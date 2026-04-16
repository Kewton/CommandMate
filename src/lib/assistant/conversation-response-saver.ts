/**
 * Persists completed assistant responses for Home Assistant Chat conversations.
 */

import type Database from 'better-sqlite3';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { extractResponse } from '@/lib/polling/response-checker';
import { cleanCliResponse } from '@/lib/assistant-response-saver';
import {
  createAssistantMessage,
  getAssistantSessionState,
  updateAssistantSessionState,
  type AssistantMessage,
} from '@/lib/db';
import { getAssistantConversationWorktreeId } from './conversation-session';
import { createLogger } from '@/lib/logger';
import { stripAnsi } from '@/lib/detection/cli-patterns';

const logger = createLogger('assistant/conversation-response-saver');

const SESSION_OUTPUT_BUFFER_SIZE = 10000;

interface CodexExtractionResult {
  response: string;
  lineCount: number;
}

function isCodexTransientStatus(content: string): boolean {
  const normalized = content.trim();
  return (
    /^•\s+Working\s+\(\d+s\s+•\s+esc to interrupt\)$/i.test(normalized) ||
    /^•\s+Thinking\s+\(\d+s\s+•\s+esc to interrupt\)$/i.test(normalized) ||
    /^•\s+Running/i.test(normalized)
  );
}

function extractCodexConversationResponse(
  output: string,
  lastCapturedLine: number
): CodexExtractionResult | null {
  const rawLines = output.split('\n');
  let trimmedLength = rawLines.length;
  while (trimmedLength > 0 && rawLines[trimmedLength - 1].trim() === '') {
    trimmedLength--;
  }

  const lines = rawLines.slice(0, trimmedLength);
  const promptIndices: number[] = [];

  for (let i = Math.max(0, lastCapturedLine); i < lines.length; i++) {
    const cleanLine = stripAnsi(lines[i]).trimEnd();
    if (/^›(?:\s+.*)?$/.test(cleanLine)) {
      promptIndices.push(i);
    }
  }

  if (promptIndices.length < 2) {
    return null;
  }

  const startPromptIndex = promptIndices[promptIndices.length - 2];
  const endPromptIndex = promptIndices[promptIndices.length - 1];
  const response = stripAnsi(lines.slice(startPromptIndex + 1, endPromptIndex).join('\n')).trim();

  if (!response) {
    return {
      response: '',
      lineCount: endPromptIndex,
    };
  }

  if (isCodexTransientStatus(response)) {
    return null;
  }

  return {
    response,
    lineCount: endPromptIndex,
  };
}

export async function savePendingAssistantResponseForConversation(
  db: Database.Database,
  conversationId: string,
  cliToolId: CLIToolType,
  timestamp: Date = new Date()
): Promise<AssistantMessage | null> {
  try {
    const sessionState = getAssistantSessionState(db, conversationId);
    const lastCapturedLine = sessionState?.lastCapturedLine ?? 0;
    const worktreeId = getAssistantConversationWorktreeId(conversationId);
    const output = await captureSessionOutput(worktreeId, cliToolId, SESSION_OUTPUT_BUFFER_SIZE);
    const codexResult = cliToolId === 'codex'
      ? extractCodexConversationResponse(output, lastCapturedLine)
      : null;
    const result = codexResult
      ? {
          response: codexResult.response,
          isComplete: true,
          lineCount: codexResult.lineCount,
          bufferReset: false,
        }
      : extractResponse(output, lastCapturedLine, cliToolId);

    if (!result || !result.isComplete) {
      return null;
    }

    if (!result.bufferReset && result.lineCount <= lastCapturedLine) {
      return null;
    }

    const cleanedResponse = cleanCliResponse(result.response, cliToolId);
    if (!cleanedResponse || cleanedResponse.trim() === '' || cleanedResponse === '[No content]') {
      updateAssistantSessionState(db, conversationId, result.lineCount);
      return null;
    }

    const message = createAssistantMessage(db, {
      conversationId,
      role: 'assistant',
      content: cleanedResponse,
      messageType: 'normal',
      timestamp,
    });

    updateAssistantSessionState(db, conversationId, result.lineCount);

    return message;
  } catch (error) {
    logger.debug('save:skipped', {
      conversationId,
      cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
