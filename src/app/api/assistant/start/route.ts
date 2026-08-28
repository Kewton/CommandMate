/**
 * Assistant Start API endpoint
 * POST /api/assistant/start
 *
 * Starts or resumes a Home Assistant Chat conversation session.
 *
 * ## The install check goes through the tool, not around it (Issue #2022)
 *
 * This route used to answer "is the CLI installed?" itself and compose its own
 * 503 body. That is the shape #2009 removed from `POST /api/worktrees/:id/send`:
 * a second gate, sitting in front of the tools' own refusals, which made the ONE
 * seam that reports a failed start to a phone unreachable. Assistant Chat was
 * the last copy, and it is why a missing `claude` left the Home screen showing
 * an error and every subscribed device silent.
 *
 * The check is now `assertToolStartable`, which asks the same tool object and
 * throws `SessionStartUnavailableError` through
 * `lib/cli-tools/start-availability` — the single line in the repository that
 * calls the notifier. The 503 is preserved by mapping that code in the catch
 * below, exactly as the send route does.
 *
 * ### Why it was付け替え and not simply deleted
 *
 * The Issue proposed deleting the check outright, on the reading that
 * `cliTool.startSession()` further down would then take over and #2009's seam
 * would fire. Measured on this tree, that call is unreachable:
 *
 *   1. `if (!isAssistantNonInteractiveTool(cliToolId))` → 400, so only
 *      `NON_INTERACTIVE_TOOLS` (`claude` / `codex` / `antigravity`, see
 *      `lib/assistant/tool-capabilities`) survives past the top of the handler;
 *   2. the branch below tests the SAME predicate, which is therefore always true
 *      for a surviving input, and returns from inside it.
 *
 * So no input reaches `startSession()`, and deleting the check would have made
 * start answer `status: 'ready'` for a tool that is not installed — the real
 * failure surfacing later as a `spawn` ENOENT inside
 * `lib/assistant/non-interactive-runner`, which is a *message* failure, not a
 * start one. The acceptance criterion ("a missing CLI rings on start") would
 * have been left unmet by the deletion it asked for.
 *
 * ### The unreachable interactive branch is kept
 *
 * Deliberately, and pinned by `tests/unit/api/assistant-start-install-2022`:
 * interactive Assistant Chat is still implemented by five live siblings
 * (`/api/assistant/conversation`, `current-output`, `session`, `terminal`, and
 * `lib/polling/assistant-conversation-poller`), and removing only this half
 * would leave that mode startable from nowhere while the other five kept
 * serving it. What is fixed here instead is the thing that misled the Issue: the
 * deadness is now stated, and the guard test fails the moment
 * `NON_INTERACTIVE_TOOLS` narrows and the branch comes back to life.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType } from '@/lib/cli-tools/types';
import { getDbInstance } from '@/lib/db/db-instance';
import { getRepositoryById } from '@/lib/db/db-repository';
import {
  createAssistantConversation,
  createAssistantMessage,
  deleteAssistantSessionState,
  getAssistantConversationByRepositoryAndCliTool,
  getRunningAssistantExecutionByConversation,
  updateAssistantSessionState,
  updateAssistantConversation,
} from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { hasSession } from '@/lib/tmux/tmux';
import { buildAssistantStartupSnapshot, buildGlobalContext } from '@/lib/assistant/context-builder';
import { getAssistantConversationSession } from '@/lib/assistant/conversation-session';
import { getAssistantChatFailureTarget } from '@/lib/assistant/assistant-chat-subject';
import { assertToolStartable } from '@/lib/cli-tools/start-availability';
import {
  isSessionStartUnavailableError,
  SESSION_START_UNAVAILABLE_CODE,
} from '@/lib/session/session-start-error';
import { pollAssistantConversation } from '@/lib/polling/assistant-conversation-poller';
import { createLogger } from '@/lib/logger';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { getAssistantExecutionMode, isAssistantNonInteractiveTool } from '@/lib/assistant/tool-capabilities';
import { reconcileAssistantConversationExecution } from '@/lib/assistant/non-interactive-execution-reconciler';

const logger = createLogger('api/assistant/start');

export async function POST(req: NextRequest) {
  try {
    const { cliToolId, repositoryId } = await req.json();

    if (!cliToolId || typeof cliToolId !== 'string' || !isCliToolType(cliToolId)) {
      return NextResponse.json({ error: 'Invalid cliToolId parameter' }, { status: 400 });
    }

    if (!isAssistantNonInteractiveTool(cliToolId)) {
      return NextResponse.json(
        { error: `Assistant Chat supports only claude and codex (got '${cliToolId}')` },
        { status: 400 },
      );
    }

    if (!repositoryId || typeof repositoryId !== 'string') {
      return NextResponse.json({ error: 'Invalid repositoryId parameter' }, { status: 400 });
    }

    const db = getDbInstance();
    const repository = getRepositoryById(db, repositoryId);
    if (!repository) {
      return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
    }

    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);

    // Issue #2022: ask the tool, and let its refusal travel — the mapping to 503
    // is in the catch. Runs BEFORE the conversation is created on purpose: a
    // refused start must not leave a `stopped` conversation row behind, because
    // `GET /api/assistant/conversation` would hand it to `AssistantChatPanel`,
    // which renders a chat instead of the Start screen the user never got past.
    await assertToolStartable(cliTool, getAssistantChatFailureTarget(repository));

    let conversation = getAssistantConversationByRepositoryAndCliTool(db, repositoryId, cliToolId);
    if (!conversation) {
      conversation = createAssistantConversation(db, {
        repositoryId,
        cliToolId,
        workingDirectory: repository.path,
        executionMode: getAssistantExecutionMode(cliToolId),
        status: 'stopped',
      });
    }

    if (isAssistantNonInteractiveTool(cliToolId)) {
      reconcileAssistantConversationExecution(db, conversation.id);
      const syncedConversation = getAssistantConversationByRepositoryAndCliTool(db, repositoryId, cliToolId);
      conversation = syncedConversation ?? conversation;

      if (getRunningAssistantExecutionByConversation(db, conversation.id)) {
        return NextResponse.json(
          { error: 'Conversation already has a running execution' },
          { status: 409 },
        );
      }

      const snapshotTakenAt = new Date();
      const contextSnapshot = buildAssistantStartupSnapshot(cliToolId, db, snapshotTakenAt);
      conversation = updateAssistantConversation(db, conversation.id, {
        executionMode: 'non_interactive',
        workingDirectory: repository.path,
        status: 'ready',
        contextSentAt: snapshotTakenAt,
        contextSnapshot,
      }) ?? conversation;

      logger.info('conversation:ready', {
        conversationId: conversation.id,
        cliToolId,
        repositoryId,
      });

      return NextResponse.json({
        success: true,
        conversation,
        executionMode: 'non_interactive',
        resumeAvailable: Boolean(conversation.resumeSessionId),
      });
    }

    // Unreachable on this tree — the 400 above admits only non-interactive tools
    // and the branch that just returned tests the same predicate. Kept, and why,
    // in the module docblock (Issue #2022). If it ever runs again, a failed
    // launch lands in the catch below and is mapped there like any other.
    const { worktreeId, sessionName } = getAssistantConversationSession(cliToolId, conversation.id);
    const sessionExists = await hasSession(sessionName);

    await cliTool.startSession(worktreeId, repository.path);

    if (!sessionExists) {
      try {
        const startupOutput = await captureSessionOutput(worktreeId, cliToolId, 10000);
        const startupLines = startupOutput.split('\n');
        let startupLineCount = startupLines.length;
        while (startupLineCount > 0 && startupLines[startupLineCount - 1].trim() === '') {
          startupLineCount--;
        }
        updateAssistantSessionState(db, conversation.id, startupLineCount);
      } catch {
        // Ignore baseline capture failures and rely on later saves.
      }
    }

    const now = new Date();
    let contextSentAt = conversation.contextSentAt ?? null;
    if (!sessionExists) {
      const context = buildGlobalContext(cliToolId, db);
      await cliTool.sendMessage(worktreeId, context);
      contextSentAt = now;
      deleteAssistantSessionState(db, conversation.id);
      createAssistantMessage(db, {
        conversationId: conversation.id,
        role: 'system',
        content: 'New assistant session started',
        messageType: 'session_boundary',
        timestamp: now,
      });
    }

    conversation = updateAssistantConversation(db, conversation.id, {
      executionMode: 'interactive',
      workingDirectory: repository.path,
      sessionName,
      status: 'running',
      lastStartedAt: now,
      contextSentAt,
    }) ?? conversation;

    pollAssistantConversation(conversation.id, cliToolId);

    logger.info('session:started', {
      conversationId: conversation.id,
      cliToolId,
      sessionName,
      repositoryId,
    });

    return NextResponse.json({
      success: true,
      conversation,
      executionMode: 'interactive',
      resumeAvailable: false,
    });
  } catch (error) {
    // Issue #2022: the CLI is not installed. 503, as this route has always
    // answered — the request was well formed and the server is healthy, the
    // machine is simply missing the binary — and `code` is the stable token the
    // send route already publishes for the same condition.
    //
    // The BODY changes: it is now the tool's own sentence ("Claude Code is not
    // installed. Please install it first.") rather than this route's
    // `CLI tool 'claude' is not installed`. Authored text either way — a display
    // name and a fixed clause, never captured output — and `AssistantChatPanel`
    // renders `data.error` verbatim, so the reader gains the remedy and loses
    // the internal tool id they could not act on.
    if (isSessionStartUnavailableError(error)) {
      logger.info('start:unavailable', { error: error.message });
      return NextResponse.json(
        { error: error.message, code: SESSION_START_UNAVAILABLE_CODE },
        { status: 503 },
      );
    }
    logger.error('start-api-error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to start assistant session' },
      { status: 500 },
    );
  }
}
