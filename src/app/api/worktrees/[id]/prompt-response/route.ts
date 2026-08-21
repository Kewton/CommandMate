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
import { getAskUserQuestion } from '@/lib/session/agent-event-state';
import { answerStructuredDecision } from '@/lib/hooks/structured-decision-response';
import {
  applyAskUserQuestion,
  resolveAskUserQuestionAnswer,
} from '@/lib/session/ask-user-question-prompt';
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

    // Issue #1898: answer the approval the agent is actually holding, before
    // going anywhere near the pane.
    //
    // `respond` has only ever been able to press a key, so a dialog the
    // detectors cannot read was unanswerable — which on opencode is every
    // approval: `wait` reported it (exit 10) and told the operator to run
    // `respond`, and `respond` then answered `prompt_no_longer_active`. The
    // structured layer knows the decision by id and can reply to it over the
    // agent's own API.
    //
    // Declines to `not-applicable` for every source with no decision identity
    // and for every session holding no approval, which is where the keystroke
    // path below carries on unchanged. The id is never taken from the caller —
    // see the module comment for why that closes DR4-003 by construction.
    const structuredDecision = await answerStructuredDecision({
      worktreeId: id,
      cliToolId,
      instanceId,
      answer,
      useDefault,
    });
    if (structuredDecision.kind === 'refused') {
      logger.info('prompt-response-refused', {
        worktreeId: id,
        cliToolId,
        instanceId,
        reason: structuredDecision.reason,
      });
      return NextResponse.json({
        success: false,
        reason: structuredDecision.reason,
        message: structuredDecision.message,
        answer: answer ?? '',
      });
    }
    if (structuredDecision.kind === 'answered') {
      const { option, decisionId, delivered } = structuredDecision;
      // Issue #1548: a person answered, attributed exactly as the keystroke
      // path attributes it.
      applyEventToActiveTask(db, id, cliToolId, instanceId ?? cliToolId, 'prompt_answered_human', {
        promptType: 'multiple_choice',
      });
      startPolling(id, cliToolId, instanceId);
      void broadcastTerminalSnapshotAfterInteraction(id, cliToolId, instanceId);
      return NextResponse.json({
        success: delivered,
        answer: String(option.number),
        ...(delivered ? {} : { reason: 'decision_not_delivered' }),
        resolved: {
          via: 'structured-decision',
          optionNumber: option.number,
          optionLabel: option.label,
          decisionId,
        },
      });
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

    // Issue #1726: replace the screen-parsed options with the ones the agent
    // itself reported for this `AskUserQuestion`, when the payload can be lined
    // up against this exact screen. `applyAskUserQuestion` answers null for
    // everything it cannot vouch for — the confirmation screen, any other
    // prompt, any session with no hooks — and the pre-#1726 path then runs
    // unchanged.
    const askUserQuestion = getAskUserQuestion(id, cliToolId, instanceId);
    const structuredPromptData =
      promptCheck?.promptData && askUserQuestion
        ? applyAskUserQuestion(promptCheck.promptData, askUserQuestion.spec)
        : null;
    const effectivePromptData = structuredPromptData ?? promptCheck?.promptData;

    // With the agent's own option list in hand, an answer can be judged before
    // any key is sent: a number outside the list cannot be right, and a word
    // that matches no label cannot be resolved. This is where `respond <id> no`
    // stops being able to arrive as an approval (Issue #1681) — typed text is
    // not a selection on a cursor-navigated picker, the Enter after it takes
    // whatever is highlighted.
    let effectiveAnswer = answer;
    let structuredResolution: AnswerResolution['resolved'];
    if (structuredPromptData && !useDefault && answer !== undefined) {
      const checked = resolveAskUserQuestionAnswer(structuredPromptData, answer);
      if (!checked.ok) {
        logger.info('prompt-response-refused', {
          worktreeId: id,
          cliToolId,
          instanceId,
          reason: checked.reason,
        });
        return NextResponse.json({
          success: false,
          reason: checked.reason,
          message: checked.message,
          answer,
        });
      }
      effectiveAnswer = checked.input;
      structuredResolution = checked.resolved;
    }

    // Issue #1681: resolve semantic yes/no answers (and --default) to a concrete
    // option number BEFORE sending. On cursor-navigated menus a raw "no" + Enter
    // degrades into selecting the highlighted default option, so unresolvable
    // answers are refused without sending anything.
    let resolution: AnswerResolution;
    try {
      resolution = resolvePromptAnswer({
        answer: effectiveAnswer,
        useDefault,
        promptData: effectivePromptData,
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
        promptData: effectivePromptData,
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
      promptType: effectivePromptData?.type,
    });

    // Issue #1685: persist question/options/answer for the audit trail. Skipped
    // when the pre-send capture failed (promptCheck null) — there is nothing
    // trustworthy to record. Shares the useAutoYes attribution caveat above.
    if (promptCheck?.isPrompt && effectivePromptData) {
      try {
        // Issue #1681 resolved semantic answers to a concrete input before
        // sending — record what actually reached the terminal. Issue #1726: with
        // the agent's own labels, so the audit trail says which choice was made
        // rather than which line the pane happened to be showing.
        const record = recordAnsweredPrompt(db, {
          worktreeId: id,
          cliToolId,
          instanceId: instanceId ?? cliToolId,
          promptData: effectivePromptData,
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
      // Issue #1681: audit trail — which option a semantic/default answer
      // selected. Issue #1726 adds the label match against the agent's own
      // options, which resolves before `resolvePromptAnswer` ever sees the
      // answer and therefore has to be merged in here.
      ...(structuredResolution ?? resolution.resolved
        ? { resolved: structuredResolution ?? resolution.resolved }
        : {}),
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
