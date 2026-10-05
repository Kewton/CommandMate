/**
 * API Route: POST /api/worktrees/[id]/prompt-response
 * Send response to CLI tool prompt detected from terminal output
 * This is a lightweight endpoint that doesn't require a database message ID
 *
 * Issue #3171: the stages live in this directory's modules — the request's
 * validation (`request-validation`), the structured decision
 * (`structured-decision`), the re-verification of the screen
 * (`frame-verification`), the answer's resolution (`answer-resolution`) and the
 * send with what follows it (`answer-delivery`). This file only runs them in
 * order; a route module may export nothing but its HTTP methods (#1946).
 */

import { NextRequest, NextResponse } from 'next/server';
import { readJsonObjectBody } from '@/lib/api/read-json-body';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { isCliToolType, type CLIToolType } from '@/lib/cli-tools/types';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { checkSessionOwnership, foreignSessionErrorBody } from '@/lib/cli-tools/session-ownership';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { logger, type PromptResponseContext } from './context';
import { validatePromptResponseRequest, type PromptResponseRequest } from './request-validation';
import { answerViaStructuredDecision } from './structured-decision';
import { verifyPromptOnScreen } from './frame-verification';
import { resolveAnswerToSend } from './answer-resolution';
import { finishAnsweredPrompt, sendResolvedAnswer } from './answer-delivery';

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

    const parsed = await readJsonObjectBody<PromptResponseRequest>(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const validated = validatePromptResponseRequest(body);
    if ('response' in validated) return validated.response;
    const request = validated.value;
    const { cliToolParam, instanceId } = request;

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

    // Issue #2865: a same-named session another CommandMate server created is
    // never answered, on either the structured or the keystroke path below.
    const ownedSessionName = cliTool.getSessionName(id, instanceId);
    const ownership = await checkSessionOwnership(ownedSessionName, worktree.path);
    if (ownership.verdict === 'foreign') {
      return NextResponse.json(foreignSessionErrorBody(ownedSessionName, ownership.sessionPath), { status: 409 });
    }

    // Check if session is running (Issue #868: per-instance)
    const running = await cliTool.isRunning(id, instanceId);
    if (!running) {
      return NextResponse.json(
        { error: `${cliTool.name} session is not running` },
        { status: 400 }
      );
    }

    const ctx: PromptResponseContext = { id, db, cliToolId, instanceId };

    // Issue #1898: answer the approval the agent is actually holding, before
    // going anywhere near the pane.
    const structuredResponse = await answerViaStructuredDecision(ctx, request);
    if (structuredResponse) return structuredResponse;

    // Get session name for the CLI tool (Issue #868: per-instance)
    const sessionName = cliTool.getSessionName(id, instanceId);

    // Issue #161: Re-verify that a prompt is still active before sending keys.
    const verification = await verifyPromptOnScreen(ctx, request, sessionName);
    if ('response' in verification) return verification.response;
    const verified = verification.value;

    // Issues #1681 / #1726 / #2522 / #2755: resolve the answer to the input
    // sent, refusing it with nothing sent when it cannot be right.
    const resolution = resolveAnswerToSend(ctx, request, verified);
    if ('response' in resolution) return resolution.response;

    const sendFailure = await sendResolvedAnswer(ctx, request, sessionName, resolution.value, verified.verifiedFrame);
    if (sendFailure) return sendFailure;

    return finishAnsweredPrompt(ctx, verified.promptCheck, resolution.value);
  } catch (error: unknown) {
    logger.error('failed-to-respond-to-prompt:', { error: error instanceof Error ? error.message : String(error) });
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
