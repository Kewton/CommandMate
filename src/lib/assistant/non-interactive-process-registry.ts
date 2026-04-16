import type { ChildProcessWithoutNullStreams } from 'child_process';

interface RegisteredExecution {
  executionId: string;
  conversationId: string;
  process: ChildProcessWithoutNullStreams;
  cancellationRequested: boolean;
}

const executionsById = new Map<string, RegisteredExecution>();
const executionIdsByConversation = new Map<string, string>();

export function registerAssistantExecutionProcess(
  executionId: string,
  conversationId: string,
  process: ChildProcessWithoutNullStreams,
): void {
  const entry: RegisteredExecution = {
    executionId,
    conversationId,
    process,
    cancellationRequested: false,
  };

  executionsById.set(executionId, entry);
  executionIdsByConversation.set(conversationId, executionId);
}

export function unregisterAssistantExecutionProcess(executionId: string): void {
  const entry = executionsById.get(executionId);
  if (!entry) {
    return;
  }

  executionIdsByConversation.delete(entry.conversationId);
  executionsById.delete(executionId);
}

export function getAssistantExecutionProcess(executionId: string): RegisteredExecution | null {
  return executionsById.get(executionId) ?? null;
}

export function getAssistantExecutionProcessByConversation(
  conversationId: string,
): RegisteredExecution | null {
  const executionId = executionIdsByConversation.get(conversationId);
  if (!executionId) {
    return null;
  }

  return executionsById.get(executionId) ?? null;
}

export function isAssistantExecutionCancellationRequested(executionId: string): boolean {
  return executionsById.get(executionId)?.cancellationRequested ?? false;
}

export function cancelAssistantExecutionProcess(conversationId: string): boolean {
  const entry = getAssistantExecutionProcessByConversation(conversationId);
  if (!entry) {
    return false;
  }

  entry.cancellationRequested = true;

  if (entry.process.killed) {
    return false;
  }

  return entry.process.kill('SIGTERM');
}
