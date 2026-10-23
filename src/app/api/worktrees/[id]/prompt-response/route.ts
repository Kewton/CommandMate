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
 *
 * Issue #3820: every response once the session is known to be running goes
 * through `ledger-record`, which writes it to the Auto-Yes confirmation ledger
 * and returns it unchanged.
 *
 * Issue #3821: the browser no longer answers for Auto-Yes. A request carrying
 * its `origin` (`auto-yes-browser`) — a tab loaded before this release — is
 * refused with 409 before any side effect (`reason: browser-auto-yes-retired`).
 * One sent by a tab loaded before #3820 added the `origin` carries none and
 * cannot be told from a person's; reloading the tab ends it. A person's answer
 * stops a poller tick under way and holds the poller off the instance for a
 * moment (`auto-yes-manual-answer`), and drops Auto-Yes's decision about the
 * prompt (`autoYesDecision`).
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
import { notePromptResponseInLedger } from './ledger-record';
import type { ValidatedPromptResponse } from './request-validation';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import { noteManualAnswerStarted } from '@/lib/polling/auto-yes-manual-answer';
import { AUTO_YES_BROWSER_ORIGIN } from '@/lib/prompt-response-body-builder';

/** Issue #3821: the `reason` of the 409 a browser Auto-Yes answer is refused with. */
const BROWSER_AUTO_YES_RETIRED_REASON = 'browser-auto-yes-retired';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  // Issue #3820: set once the session is known to be running, so the catch-all
  // records its 500 too.
  let ledger: { ctx: PromptResponseContext; request: ValidatedPromptResponse } | null = null;
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
    // Issue #3821: before the first side effect — read so far are only the
    // id's alias (`canonicalWorktreeId`) and the body; no worktree row, no
    // session, no structured decision, no keys, no ledger record.
    if (request.origin === AUTO_YES_BROWSER_ORIGIN) {
      return NextResponse.json(
        {
          error: 'Auto-Yes no longer answers from the browser; reload the page.',
          reason: BROWSER_AUTO_YES_RETIRED_REASON,
        },
        { status: 409 },
      );
    }
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
    ledger = { ctx, request };
    const noted = (response: NextResponse) => notePromptResponseInLedger(ctx, request, response);

    // Issue #3821: a person is answering. Before the first key or API call: a
    // poller tick already under way sends no further key, the next ticks leave
    // the screen to the person for a moment, and Auto-Yes's decision about the
    // prompt is dropped. Auto-Yes itself stays on.
    noteManualAnswerStarted(buildCompositeKey(id, cliToolId, instanceId));

    // Issue #1898: answer the approval the agent is actually holding, before
    // going anywhere near the pane.
    const structuredResponse = await answerViaStructuredDecision(ctx, request);
    if (structuredResponse) return noted(structuredResponse);

    // Get session name for the CLI tool (Issue #868: per-instance)
    const sessionName = cliTool.getSessionName(id, instanceId);

    // Issue #161: Re-verify that a prompt is still active before sending keys.
    const verification = await verifyPromptOnScreen(ctx, request, sessionName);
    if ('response' in verification) return noted(verification.response);
    const verified = verification.value;

    // Issues #1681 / #1726 / #2522 / #2755: resolve the answer to the input
    // sent, refusing it with nothing sent when it cannot be right.
    const resolution = resolveAnswerToSend(ctx, request, verified);
    if ('response' in resolution) return noted(resolution.response);

    const sendFailure = await sendResolvedAnswer(ctx, request, sessionName, resolution.value, verified.verifiedFrame);
    if (sendFailure) return noted(sendFailure);

    return noted(finishAnsweredPrompt(ctx, verified.promptCheck, resolution.value));
  } catch (error: unknown) {
    logger.error('failed-to-respond-to-prompt:', { error: error instanceof Error ? error.message : String(error) });
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    const failure = NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
    return ledger ? notePromptResponseInLedger(ledger.ctx, ledger.request, failure) : failure;
  }
}
