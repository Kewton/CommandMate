import type Database from 'better-sqlite3';
import {
  getAssistantConversationById,
  getRunningAssistantExecutionByConversation,
  listRunningAssistantExecutions,
  updateAssistantConversation,
  updateAssistantExecution,
} from '@/lib/db';
import { getAssistantExecutionProcessByConversation } from './non-interactive-process-registry';

export function reconcileAssistantConversationExecution(
  db: Database.Database,
  conversationId: string,
): void {
  const conversation = getAssistantConversationById(db, conversationId);
  if (!conversation) {
    return;
  }

  const runningExecution = getRunningAssistantExecutionByConversation(db, conversationId);
  const registeredProcess = getAssistantExecutionProcessByConversation(conversationId);

  if (!runningExecution || registeredProcess) {
    return;
  }

  updateAssistantExecution(db, runningExecution.id, {
    status: 'failed',
    finishedAt: new Date(),
    stderrText: [
      runningExecution.stderrText ?? '',
      '[Execution reconciled after process registry loss]',
    ].filter(Boolean).join('\n'),
  });

  updateAssistantConversation(db, conversationId, {
    status: 'ready',
  });
}

export function reconcileAllAssistantExecutions(db: Database.Database): void {
  const runningExecutions = listRunningAssistantExecutions(db);
  for (const execution of runningExecutions) {
    reconcileAssistantConversationExecution(db, execution.conversationId);
  }
}
