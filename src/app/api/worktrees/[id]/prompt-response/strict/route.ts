/**
 * API Route: POST /api/worktrees/[id]/prompt-response/strict
 *
 * The strict `respond` (Issue #3756): answer a screen only when a fresh
 * capture still shows the kind the caller expects and the observation token
 * it presents (`commandmate prompt`) still verifies. The rules and their order
 * are `lib/prompt-observation/strict-respond`; this file validates the body,
 * resolves the session, refuses another server's session and records the
 * verdict.
 *
 * Its own endpoint, not a field on `/prompt-response`: a server that predates
 * this route ignores a field it does not know and would send the answer
 * unchecked, while a missing route is a 404 the CLI stops on.
 *
 * Body: `{ expectScreen, observation, answer, operationId, expectTarget?,
 * instanceId?, cliTool?, answeredBy? }`. Every verdict — answered (0), nothing
 * sent (40), sent but not confirmed (41) — is a 200 whose body is a
 * `StrictRespondResult`; 4xx is a request this route could not take at all.
 * Every body carries `strictRespond: 1`, which an older server's 404 does not.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readJsonObjectBody } from '@/lib/api/read-json-body';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isCliToolType, isValidInstanceId } from '@/lib/cli-tools/types';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { checkSessionOwnership, foreignSessionErrorBody } from '@/lib/cli-tools/session-ownership';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { resolveSessionTargetStrict } from '@/lib/session/resolve-session-target';
import { createLogger } from '@/lib/logger';
import { isPromptObservationKind, type PromptObservationKind } from '@/lib/prompt-observation/kinds';
import { respondStrictly } from '@/lib/prompt-observation/strict-respond';
import { createStrictRespondDeps, describeError, recordStrictAnswer } from '@/lib/session/strict-prompt-answer-io';
import { startPolling } from '@/lib/polling/response-poller';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';

const logger = createLogger('api/prompt-response-strict');

const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const ANSWERED_BY_PATTERN = /^[A-Za-z0-9_:/.@-]{1,160}$/;
const MAX_TOKEN_LENGTH = 200;
const MAX_ANSWER_LENGTH = 500;
const MAX_TARGET_LENGTH = 4096;

interface StrictRequestBody {
  expectScreen?: unknown;
  observation?: unknown;
  answer?: unknown;
  operationId?: unknown;
  expectTarget?: unknown;
  instanceId?: unknown;
  cliTool?: unknown;
  answeredBy?: unknown;
  useDefault?: unknown;
}

interface StrictRequest {
  expectScreen: PromptObservationKind;
  observation: string;
  answer: string;
  operationId: string;
  expectTarget: string | null;
  instanceId: string | undefined;
  cliTool: string | undefined;
  answeredBy: string;
}

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ strictRespond: 1, code, error }, { status });
}

/** The body checked field by field; the first failing check is the 400. */
function validate(body: StrictRequestBody): StrictRequest | NextResponse {
  if (body.useDefault !== undefined) {
    return refuse(400, 'default_not_allowed', 'The strict respond takes no default: name the option by its label.');
  }
  if (!isPromptObservationKind(body.expectScreen)) {
    return refuse(400, 'invalid_expect_screen', 'expectScreen must be a prompt observation kind');
  }
  if (typeof body.observation !== 'string' || body.observation === '' || body.observation.length > MAX_TOKEN_LENGTH) {
    return refuse(400, 'invalid_observation', 'observation must be the token `commandmate prompt` printed');
  }
  if (typeof body.answer !== 'string' || body.answer.trim() === '' || body.answer.length > MAX_ANSWER_LENGTH) {
    return refuse(400, 'invalid_answer', 'answer must be an option label (or a number on a numbered screen)');
  }
  if (typeof body.operationId !== 'string' || !OPERATION_ID_PATTERN.test(body.operationId)) {
    return refuse(400, 'invalid_operation_id', 'operationId must be 8-64 characters of [A-Za-z0-9_-]');
  }
  if (
    body.expectTarget !== undefined &&
    body.expectTarget !== null &&
    (typeof body.expectTarget !== 'string' || body.expectTarget.length > MAX_TARGET_LENGTH)
  ) {
    return refuse(400, 'invalid_expect_target', 'expectTarget must be a string');
  }
  if (body.instanceId !== undefined && (typeof body.instanceId !== 'string' || !isValidInstanceId(body.instanceId))) {
    return refuse(400, 'invalid_instance', 'Invalid instanceId');
  }
  if (body.cliTool !== undefined && (typeof body.cliTool !== 'string' || !isCliToolType(body.cliTool))) {
    return refuse(400, 'invalid_cli_tool', 'Invalid cliTool');
  }
  if (body.answeredBy !== undefined && (typeof body.answeredBy !== 'string' || !ANSWERED_BY_PATTERN.test(body.answeredBy))) {
    return refuse(400, 'invalid_answered_by', 'Invalid answeredBy');
  }
  return {
    expectScreen: body.expectScreen,
    observation: body.observation,
    answer: body.answer,
    operationId: body.operationId,
    expectTarget: typeof body.expectTarget === 'string' ? body.expectTarget : null,
    instanceId: body.instanceId as string | undefined,
    cliTool: body.cliTool as string | undefined,
    answeredBy: (body.answeredBy as string | undefined) ?? 'cli',
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    if (!isValidWorktreeId(id)) return refuse(400, 'invalid_worktree_id', 'Invalid worktree ID format');

    const parsed = await readJsonObjectBody<StrictRequestBody>(req);
    if (!parsed.ok) return parsed.response;
    const request = validate(parsed.body);
    if (request instanceof NextResponse) return request;

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) return refuse(404, 'worktree_not_found', `Worktree '${id}' not found`);

    // The resolution `current-output` makes, so the instance the token was
    // issued for is the instance it is verified against.
    const resolved = resolveSessionTargetStrict(db, id, {
      instanceId: request.instanceId,
      requestedCliTool: request.cliTool !== undefined && isCliToolType(request.cliTool) ? request.cliTool : undefined,
    });
    if (!resolved.ok) return refuse(400, 'instance_tool_conflict', resolved.error);
    const { cliToolId, instanceId, resolvedBy } = resolved.target;

    // Issue #2865: another server's session of the same name is never answered.
    const sessionName = resolveSessionName(cliToolId, id, instanceId);
    const ownership = await checkSessionOwnership(sessionName, worktree.path);
    if (ownership.verdict === 'foreign') {
      return NextResponse.json(
        { strictRespond: 1, ...foreignSessionErrorBody(sessionName, ownership.sessionPath) },
        { status: 409 }
      );
    }

    const target = { worktreeId: id, cliToolId, instanceId, sessionName, resolvedBy };
    const result = await respondStrictly(
      {
        worktreeId: id,
        sessionName,
        expectScreen: request.expectScreen,
        observationToken: request.observation,
        answer: request.answer,
        expectTarget: request.expectTarget,
        operationId: request.operationId,
      },
      createStrictRespondDeps(db, target)
    );
    recordStrictAnswer(db, target, result, request.answeredBy);
    if (result.keysSent > 0 && !result.replayed) {
      startPolling(id, cliToolId, instanceId);
      void broadcastTerminalSnapshotAfterInteraction(id, cliToolId, instanceId);
    }
    return NextResponse.json(result, { status: 200 });
  } catch (error: unknown) {
    logger.error('strict-prompt-response-failed', { error: describeError(error) });
    return refuse(500, 'internal_error', 'Internal server error');
  }
}
