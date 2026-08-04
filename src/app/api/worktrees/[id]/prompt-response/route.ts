/**
 * API Route: POST /api/worktrees/[id]/prompt-response
 * Send response to CLI tool prompt detected from terminal output
 * This is a lightweight endpoint that doesn't require a database message ID
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById, recordAnsweredPrompt } from '@/lib/db';
import { broadcastMessage } from '@/lib/ws-server';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { isCliToolType, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutputFresh } from '@/lib/session/cli-session';
import { detectPrompt, type PromptDetectionResult } from '@/lib/detection/prompt-detector';
import { stripAnsi, stripBoxDrawing, buildDetectPromptOptions } from '@/lib/detection/cli-patterns';
import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { resolvePromptAnswer, PromptAnswerResolutionError, type AnswerResolution } from '@/lib/prompt-answer-semantic';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import type { PromptType, SubmitMode } from '@/types/models';
import { isValidSubmitMode } from '@/types/models';
import { createLogger } from '@/lib/logger';
import { startPolling } from '@/lib/polling/response-poller';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/prompt-response');

interface PromptResponseRequest {
  answer?: string;
  /** Issue #1681: explicitly select the prompt's default option (`respond --default`). */
  useDefault?: boolean;
  cliTool?: string;
  /** Issue #868: target a specific agent instance (defaults to the primary). */
  instanceId?: string;
  /** Issue #287: Prompt type from client-side detection (fallback when promptCheck fails) */
  promptType?: PromptType;
  /** Issue #287: Default option number from client-side detection (fallback when promptCheck fails) */
  defaultOptionNumber?: number;
  /** Issue #616: Submit mode from client-side detection (fallback when promptCheck fails) */
  submitMode?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    if (!isValidWorktreeId(id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    const body: PromptResponseRequest = await req.json();
    const { answer, cliTool: cliToolParam, instanceId: instanceParam, promptType: bodyPromptType, defaultOptionNumber: bodyDefaultOptionNumber, submitMode: bodySubmitMode } = body;
    const useDefault = body.useDefault === true;

    // Issue #616: Allowlist validation for submitMode
    const validSubmitMode: SubmitMode | undefined =
      isValidSubmitMode(bodySubmitMode) ? bodySubmitMode : undefined;

    // Validation (Issue #1681: exactly one of answer / useDefault)
    if (!answer && !useDefault) {
      return NextResponse.json(
        { error: 'answer is required' },
        { status: 400 }
      );
    }
    if (answer && useDefault) {
      return NextResponse.json(
        { error: 'answer and useDefault are mutually exclusive' },
        { status: 400 }
      );
    }

    if (cliToolParam && !isCliToolType(cliToolParam)) {
      return NextResponse.json(
        { error: `Invalid cliTool: '${cliToolParam}'` },
        { status: 400 }
      );
    }

    // Issue #868: validate the optional instance selector (embedded in session name).
    if (instanceParam !== undefined && !isValidInstanceId(instanceParam)) {
      return NextResponse.json(
        { error: 'Invalid instanceId parameter' },
        { status: 400 }
      );
    }
    const instanceId = instanceParam;

    const db = getDbInstance();

    // Get worktree to verify it exists
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
        { status: 404 }
      );
    }

    // Determine CLI tool ID
    const cliToolId: CLIToolType = (cliToolParam && isCliToolType(cliToolParam))
      ? cliToolParam
      : (worktree.cliToolId || 'claude');

    // Get CLI tool instance from manager
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);

    // Check if session is running (Issue #868: per-instance)
    const running = await cliTool.isRunning(id, instanceId);
    if (!running) {
      return NextResponse.json(
        { error: `${cliTool.name} session is not running` },
        { status: 400 }
      );
    }

    // Get session name for the CLI tool (Issue #868: per-instance)
    const sessionName = cliTool.getSessionName(id, instanceId);

    // Issue #161: Re-verify that a prompt is still active before sending keys.
    // This prevents a race condition where the prompt disappears between
    // detection (in current-output API) and sending (here), causing "1" to
    // be typed at the Claude user input prompt instead of a tool permission prompt.
    let promptCheck: PromptDetectionResult | null = null;
    try {
      const currentOutput = await captureSessionOutputFresh(id, cliToolId, undefined, instanceId);
      const cleanOutput = stripAnsi(currentOutput);
      const promptOptions = buildDetectPromptOptions(cliToolId);
      promptCheck = detectPrompt(stripBoxDrawing(cleanOutput), promptOptions);

      if (!promptCheck.isPrompt) {
        return NextResponse.json({
          success: false,
          reason: 'prompt_no_longer_active',
          answer: answer ?? '',
        });
      }
    } catch {
      // If capture fails, proceed with caution - don't block manual responses
      logger.warn('failed-to-verify-prompt');
    }

    // Issue #1681: resolve semantic yes/no answers (and --default) to a concrete
    // option number BEFORE sending. On cursor-navigated menus a raw "no" + Enter
    // degrades into selecting the highlighted default option, so unresolvable
    // answers are refused without sending anything.
    let resolution: AnswerResolution;
    try {
      resolution = resolvePromptAnswer({
        answer,
        useDefault,
        promptData: promptCheck?.promptData,
        fallbackPromptType: bodyPromptType,
      });
    } catch (error: unknown) {
      if (error instanceof PromptAnswerResolutionError) {
        return NextResponse.json({
          success: false,
          reason: 'unresolvable_answer',
          message: error.message,
          answer: answer ?? '',
        });
      }
      throw error;
    }

    // Send answer to tmux
    // Issue #287 Bug2: Uses shared sendPromptAnswer() to unify logic
    // with auto-yes-manager.ts, including fallback handling.
    try {
      await sendPromptAnswer({
        sessionName,
        answer: resolution.input,
        cliToolId,
        promptData: promptCheck?.promptData,
        fallbackPromptType: bodyPromptType,
        fallbackDefaultOptionNumber: bodyDefaultOptionNumber,
        fallbackSubmitMode: validSubmitMode,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return NextResponse.json(
        { error: `Failed to send answer to tmux: ${errorMessage}` },
        { status: 500 }
      );
    }

    // Issue #1548: a person answered. Attributed to the instance that was asked
    // — `instanceId` is undefined for the primary, which `getActiveTaskForInstance`
    // expects to be named by the tool id.
    //
    // Caveat: the browser-side Auto-Yes fallback (`useAutoYes`) posts here too,
    // and is recorded as human. It only runs when the server poller is absent,
    // which is also when nothing else would record the answer at all — an
    // over-count is preferable to a gap in the log.
    applyEventToActiveTask(db, id, cliToolId, instanceId ?? cliToolId, 'prompt_answered_human', {
      promptType: promptCheck?.promptData?.type,
    });

    // Issue #1685: persist question/options/answer for the audit trail. Skipped
    // when the pre-send capture failed (promptCheck null) — there is nothing
    // trustworthy to record. Shares the useAutoYes attribution caveat above.
    if (promptCheck?.isPrompt && promptCheck.promptData) {
      try {
        // Issue #1681 resolved semantic answers to a concrete input before
        // sending — record what actually reached the terminal.
        const record = recordAnsweredPrompt(db, {
          worktreeId: id,
          cliToolId,
          instanceId: instanceId ?? cliToolId,
          promptData: promptCheck.promptData,
          answer: resolution.input,
          answeredBy: 'human',
          content: promptCheck.rawContent || promptCheck.cleanContent,
        });
        broadcastMessage(record.created ? 'message' : 'message_updated', {
          worktreeId: id,
          message: record.message,
        });
      } catch (recordError) {
        // Audit persistence must never fail a response that already reached tmux.
        logger.warn('prompt-audit-record-failed', {
          error: recordError instanceof Error ? recordError.message : String(recordError),
        });
      }
    }

    // The prompt poller normally stops while waiting for input. Resume response
    // persistence and independently push the TUI redraw after this interaction.
    startPolling(id, cliToolId, instanceId);
    void broadcastTerminalSnapshotAfterInteraction(id, cliToolId, instanceId);

    return NextResponse.json({
      success: true,
      answer: resolution.input,
      // Issue #1681: audit trail — which option a semantic/default answer selected.
      ...(resolution.resolved ? { resolved: resolution.resolved } : {}),
    });
  } catch (error: unknown) {
    logger.error('failed-to-respond-to-prompt:', { error: error instanceof Error ? error.message : String(error) });
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
