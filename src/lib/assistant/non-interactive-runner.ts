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
import { createLogger } from '@/lib/logger';
import { buildNonInteractivePrompt } from './non-interactive-prompt-builder';
import {
  cancelAssistantExecutionProcess,
  isAssistantExecutionCancellationRequested,
  registerAssistantExecutionProcess,
  unregisterAssistantExecutionProcess,
} from './non-interactive-process-registry';
import {
  parseAntigravityPlainOutput,
  parseClaudeStructuredOutput,
  parseCodexStructuredOutput,
} from './non-interactive-output-parser';

const logger = createLogger('assistant/non-interactive-runner');

const EXECUTION_TIMEOUT_MS = 15 * 60 * 1000;

function getCommandForTool(cliToolId: CLIToolType): string {
  switch (cliToolId) {
    // Issue #990 (Phase C): Antigravity's executable is `agy`, not the tool id.
    case 'antigravity':
      return 'agy';
    default:
      return cliToolId;
  }
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
    case 'antigravity': {
      // Issue #990 (Phase C): `agy -p` runs a single prompt non-interactively.
      // The prompt is delivered via stdin (see child.stdin.write below), and
      // --dangerously-skip-permissions auto-approves tool use to prevent the
      // process from hanging (mirrors claude bypassPermissions / codex --full-auto).
      // Antigravity print mode has no resumable session id, so resumeSessionId is unused.
      return ['-p', '--dangerously-skip-permissions'];
    }
    default:
      return [];
  }
}

function parseExecutionOutput(cliToolId: CLIToolType, stdout: string) {
  switch (cliToolId) {
    case 'claude':
      return parseClaudeStructuredOutput(stdout);
    case 'antigravity':
      return parseAntigravityPlainOutput(stdout);
    default:
      return parseCodexStructuredOutput(stdout);
  }
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

  let stdout = '';
  let stderr = '';

  // Issue #1344: only the first of the startup rollback / 'error' / 'close'
  // paths may write the terminal state. Without this a late event could flip a
  // conversation back to 'ready' while a newer execution is already running.
  let settled = false;

  const runSafely = (event: string, action: () => void): void => {
    try {
      action();
    } catch (error) {
      logger.error(event, {
        executionId: execution.id,
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Issue #1344: releases the conversation lock when a state transition throws.
  // The conversation would otherwise stay 'running' forever and the terminal
  // route (which requires 'ready') would reject every subsequent message.
  // Unregisters first so that the reconciler can still recover the conversation
  // if the DB writes below are what is failing.
  const finalizeAsFailed = (event: string, error: unknown): void => {
    settled = true;
    unregisterAssistantExecutionProcess(execution.id);

    const message = error instanceof Error ? error.message : String(error);
    logger.error(event, { executionId: execution.id, conversationId, error: message });

    runSafely('finalize-execution-failed', () => {
      updateAssistantExecution(db, execution.id, {
        status: 'failed',
        stderrText: `${stderr}\n${message}`.trim(),
        finishedAt: new Date(),
      });
    });
    runSafely('finalize-message-failed', () => {
      updateAssistantMessageStatus(db, userMessageId, 'failed');
    });
    runSafely('finalize-conversation-ready', () => {
      updateAssistantConversation(db, conversationId, { status: 'ready' });
    });
  };

  // The child is being discarded, so swallow its late 'error'/EPIPE events:
  // when the startup fails before the handlers below are wired up, nothing
  // would listen for them and Node rethrows them as uncaught exceptions.
  const stopStartedProcess = (): void => {
    runSafely('start-failure-detach-failed', () => {
      child.on('error', () => {});
      child.stdin.on('error', () => {});
    });
    runSafely('start-failure-kill-failed', () => {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    });
  };

  try {
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

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      updateAssistantExecution(db, execution.id, { stdoutText: stdout });
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
      updateAssistantExecution(db, execution.id, { stderrText: stderr });
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      unregisterAssistantExecutionProcess(execution.id);

      try {
        updateAssistantExecution(db, execution.id, {
          status: 'failed',
          stderrText: `${stderr}\n${error.message}`.trim(),
          finishedAt: new Date(),
        });
        updateAssistantMessageStatus(db, userMessageId, 'failed');
        updateAssistantConversation(db, conversationId, {
          status: 'ready',
        });
      } catch (handlerError) {
        finalizeAsFailed('error-handler-failed', handlerError);
      }
    });

    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;

      const cancelled = isAssistantExecutionCancellationRequested(execution.id);
      const finishedAt = new Date();
      unregisterAssistantExecutionProcess(execution.id);

      // Issue #1344 (2): parseExecutionOutput and createAssistantMessage can
      // throw. Without this catch neither the execution nor the conversation
      // reaches a terminal state. The reconciler heals the conversation on the
      // next API call (the process is unregistered above), but it stays locked
      // until then, so finalize it here instead.
      try {
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
      } catch (error) {
        finalizeAsFailed('close-handler-failed', error);
      }
    });

    child.stdin.write(promptText);
    child.stdin.end();
  } catch (error) {
    // Issue #1344 (1): the process is already registered, so the reconciler
    // ('running' execution with no registered process) never fires for it. Kill
    // the child — it would hang on stdin forever — and roll the conversation
    // back to 'ready' before handing the failure to the caller.
    finalizeAsFailed('execution-start-failed', error);
    stopStartedProcess();
    throw error;
  }

  const timeout = setTimeout(() => {
    cancelAssistantExecutionProcess(conversationId);
  }, EXECUTION_TIMEOUT_MS);

  child.on('close', () => {
    clearTimeout(timeout);
  });

  return { executionId: execution.id };
}
