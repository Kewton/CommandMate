import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type Database from 'better-sqlite3';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { Repository } from '@/lib/db/db-repository';
import { sanitizeEnvForChildProcess } from '@/lib/security/env-sanitizer';
import {
  createAssistantExecution,
  createAssistantMessage,
  getAssistantConversationById,
  getAssistantMessages,
  updateAssistantConversation,
  updateAssistantExecution,
  updateAssistantMessageStatus,
} from '@/lib/db';
import { buildNonInteractivePrompt } from './non-interactive-prompt-builder';
import {
  cancelAssistantExecutionProcess,
  isAssistantExecutionCancellationRequested,
  registerAssistantExecutionProcess,
  unregisterAssistantExecutionProcess,
} from './non-interactive-process-registry';
import {
  parseClaudeStructuredOutput,
  parseCodexStructuredOutput,
} from './non-interactive-output-parser';

const EXECUTION_TIMEOUT_MS = 15 * 60 * 1000;

function getCommandForTool(cliToolId: CLIToolType): string {
  return cliToolId;
}

function buildCommandArgs(cliToolId: CLIToolType, resumeSessionId?: string): string[] {
  switch (cliToolId) {
    case 'claude': {
      const base = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'];
      return resumeSessionId ? [...base, '--resume', resumeSessionId] : base;
    }
    case 'codex': {
      const autoFlags = ['--full-auto'];
      return resumeSessionId
        ? ['exec', 'resume', resumeSessionId, '--json', ...autoFlags]
        : ['exec', '--json', ...autoFlags];
    }
    default:
      return [];
  }
}

function parseExecutionOutput(cliToolId: CLIToolType, stdout: string) {
  if (cliToolId === 'claude') {
    return parseClaudeStructuredOutput(stdout);
  }

  return parseCodexStructuredOutput(stdout);
}

export async function startNonInteractiveAssistantExecution(params: {
  db: Database.Database;
  conversationId: string;
  cliToolId: CLIToolType;
  repository: Repository;
  userMessageId: string;
  userMessage: string;
}): Promise<{ executionId: string }> {
  const { db, conversationId, cliToolId, repository, userMessageId, userMessage } = params;
  const conversation = getAssistantConversationById(db, conversationId);
  if (!conversation) {
    throw new Error('Conversation not found');
  }

  const history = getAssistantMessages(db, conversationId, { limit: 50 })
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const promptText = buildNonInteractivePrompt({
    db,
    cliToolId,
    repository,
    messages: history,
    userMessage,
    conversation,
  });
  const args = buildCommandArgs(cliToolId, conversation.resumeSessionId);
  const command = getCommandForTool(cliToolId);
  const commandLine = `${command} ${args.join(' ')}`.trim();
  const startedAt = new Date();

  const execution = createAssistantExecution(db, {
    conversationId,
    cliToolId,
    status: 'queued',
    commandLine,
    promptText,
    resumeSessionIdBefore: conversation.resumeSessionId,
    startedAt,
  });

  const child = spawn(command, args, {
    cwd: repository.path,
    env: sanitizeEnvForChildProcess(),
    stdio: 'pipe',
  });

  const processEntry = child as ChildProcessWithoutNullStreams;
  registerAssistantExecutionProcess(execution.id, conversationId, processEntry);

  updateAssistantExecution(db, execution.id, {
    status: 'running',
    pid: child.pid ?? null,
    startedAt,
  });
  updateAssistantConversation(db, conversationId, {
    status: 'running',
    lastStartedAt: startedAt,
    lastExecutionId: execution.id,
  });
  updateAssistantMessageStatus(db, userMessageId, 'sent');

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout += chunk.toString();
    updateAssistantExecution(db, execution.id, { stdoutText: stdout });
  });

  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
    updateAssistantExecution(db, execution.id, { stderrText: stderr });
  });

  child.on('error', (error) => {
    unregisterAssistantExecutionProcess(execution.id);
    updateAssistantExecution(db, execution.id, {
      status: 'failed',
      stderrText: `${stderr}\n${error.message}`.trim(),
      finishedAt: new Date(),
    });
    updateAssistantMessageStatus(db, userMessageId, 'failed');
    updateAssistantConversation(db, conversationId, {
      status: 'ready',
    });
  });

  child.on('close', (exitCode) => {
    const cancelled = isAssistantExecutionCancellationRequested(execution.id);
    const finishedAt = new Date();
    unregisterAssistantExecutionProcess(execution.id);

    if (cancelled) {
      const latestConversation = getAssistantConversationById(db, conversationId);
      updateAssistantExecution(db, execution.id, {
        status: 'cancelled',
        stdoutText: stdout,
        stderrText: stderr,
        exitCode,
        finishedAt,
      });
      if (latestConversation?.status !== 'stopped') {
        updateAssistantConversation(db, conversationId, {
          status: 'ready',
          resumeSessionId: null,
        });
      }
      return;
    }

    const parsed = parseExecutionOutput(cliToolId, stdout);
    const completed = exitCode === 0 && parsed.finalMessage;

    updateAssistantExecution(db, execution.id, {
      status: completed ? 'completed' : 'failed',
      stdoutText: stdout,
      stderrText: stderr,
      finalMessageText: parsed.finalMessage,
      exitCode,
      resumeSessionIdAfter: parsed.resumeSessionId,
      finishedAt,
    });

    if (!completed) {
      updateAssistantMessageStatus(db, userMessageId, 'failed');
      updateAssistantConversation(db, conversationId, {
        status: 'ready',
        resumeSessionId: null,
      });
      return;
    }

    createAssistantMessage(db, {
      conversationId,
      role: 'assistant',
      content: parsed.finalMessage!,
      messageType: 'normal',
      timestamp: finishedAt,
    });

    updateAssistantConversation(db, conversationId, {
      status: 'ready',
      resumeSessionId: parsed.resumeSessionId ?? conversation.resumeSessionId ?? null,
      lastExecutionId: execution.id,
    });
  });

  child.stdin.write(promptText);
  child.stdin.end();

  const timeout = setTimeout(() => {
    cancelAssistantExecutionProcess(conversationId);
  }, EXECUTION_TIMEOUT_MS);

  child.on('close', () => {
    clearTimeout(timeout);
  });

  return { executionId: execution.id };
}
