/**
 * API Route: POST /api/worktrees/:id/send
 * Sends a user message to a CLI tool (Claude/Codex/Gemini) for a specific worktree
 *
 * Flow:
 * 1. Validate worktree exists
 * 2. Validate request body (content required)
 * 3. Validate CLI tool (defaults to claude)
 * 4. Ensure CLI tool session is running
 * 5. Save pending assistant response (Issue #53)
 * 6. Send message to CLI tool
 * 7. Create user message in database
 * 8. Start polling for response
 *
 * Issue #3957: a body naming `relayId` (a relay opened with `bind: true`)
 * reserves that relay before step 4, records its input boundary right before
 * the first key, and answers `sendOutcome` (`sent` / `not_sent` / `unknown`)
 * on every response after the reservation — see `lib/relay/relay-bind`.
 *
 * Issue #4011: a send with no bound relay answers `sendOutcome` too, on a
 * failure recorded as this request's attempt — by the send service, or by this
 * route before it (another server's session, a start still coming up or
 * failed: `not_sent`) — so the CLI can say whether it may be sent again. A 400
 * (the body, `--model`) records none and is answered as before; so is its 201.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readJsonObjectBody } from '@/lib/api/read-json-body';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { probeRunningSessionHookUrl } from '@/lib/cli-tools/base';
import { sendUserMessage } from '@/lib/session/send-user-message';
import { PROMPT_WAITING_CODE } from '@/lib/session/prompt-waiting-guard';
import type { SendAttemptReason, SendAttemptState } from '@/lib/session/send-attempt-types';
import { recordSendAttempt } from '@/lib/session/send-attempt-state';
import { isSessionStartTimeoutError } from '@/lib/session/session-start-error';
import { settleSessionLaunch } from '@/lib/session/session-launch-flight';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { currentGeneration } from '@/lib/session/agent-event-turn';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import { checkSessionOwnership, foreignSessionErrorBody } from '@/lib/cli-tools/session-ownership';
import type { RelaySendOutcome } from '@/lib/relay/relay-bind';
import { evaluateRelayAfterSend } from '@/lib/relay/relay-delivery';
import { resolveRespondAgent, validateSendRequest, type SendMessageRequest } from './send-request';
import {
  judgeTurnOpenAtSend,
  readTurnAtInput,
  reportsTurns,
  reserveRelayForSend,
  type RouteRelayState,
  type SendMessageResponse,
  type TurnAtInput,
} from './send-relay';
import {
  answerSessionStartTimeout,
  refuseModelOnRunningSession,
  startSessionForSend,
} from './send-session-start';
import { resolveSendImagePath } from './send-image-path';
import { answerSendFailure } from './send-failure';

const logger = createLogger('api/send');

// Issue #4055: the request's validation (`send-request.ts`), the relay and turn
// reading (`send-relay.ts`), the session start (`send-session-start.ts`), the
// image path (`send-image-path.ts`) and the failed send's answer
// (`send-failure.ts`) live beside this file; this one keeps POST and the order.

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const relay: RouteRelayState = { binding: null, attempt: null, sent: null };
  const response = await handleSend(request, context, relay);
  const { binding } = relay;
  if (!binding) {
    // Issue #4011: whether it may be sent again does not depend on a relay.
    // Only a failure recorded as this request's attempt says it; a 400 that
    // records none (validation, `--model`) is answered as before.
    if (relay.sent || relay.attempt === null) return response;
    return withBody(response, { sendOutcome: unboundSendOutcome(relay.attempt) });
  }

  // Issue #3957: every answer after the reservation settles the relay and says
  // what the CLI may do with it — withdraw it only on `not_sent`.
  const sendOutcome = binding.finish(
    relay.sent
      ? { kind: 'sent', ...relay.sent }
      : { kind: 'failed', attempt: relay.attempt }
  );
  if (sendOutcome === 'sent') evaluateRelayAfterSend(binding.relayId);
  return withBody(response, { relayId: binding.relayId, sendOutcome });
}

/**
 * Issue #4011: what a failed send with no bound relay says about resending —
 * `not_sent` only when the attempt was recorded as nothing typed; a submit
 * it confirmed whose answer then failed is `unknown`, as for a bound send.
 */
function unboundSendOutcome(attempt: SendAttemptState): RelaySendOutcome {
  return attempt === 'not-sent' ? 'not_sent' : 'unknown';
}

/** The route's answer with `extra` added to its JSON body, status kept. */
async function withBody(response: Response, extra: Record<string, unknown>): Promise<NextResponse> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Every answer of this route is JSON; an unreadable one keeps its status.
  }
  return NextResponse.json({ ...body, ...extra }, { status: response.status });
}

async function handleSend(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  relay: RouteRelayState
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    const db = getDbInstance();

    // Check if worktree exists
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
        { status: 404 }
      );
    }

    // Parse request body
    const parsed = await readJsonObjectBody<SendMessageRequest>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    const validated = validateSendRequest(db, id, body);
    if (!validated.ok) return validated.response;
    const { trimmedContent, requestedCliToolId, instanceId, target } = validated.value;
    const cliToolId = target.cliToolId;

    const reserved = reserveRelayForSend(db, body.relayId, {
      worktreeId: id,
      cliToolId,
      targetInstanceId: target.instanceId,
      instanceId,
    });
    if (!reserved.ok) return reserved.response;
    relay.binding = reserved.value;

    // Get CLI tool instance from manager
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);

    // Issue #2009: the install check that used to sit here was a SECOND gate.
    // Every one of the seven tools already refuses to launch when its binary is
    // missing, and this copy ran first — so the tools' own refusals were
    // unreachable from this route, and with them the one seam that reports a
    // failed start to a phone (`BaseCLITool.startSession`). Removing the copy
    // leaves one gate, and it is the one that notifies.
    //
    // The 503 is preserved below by mapping SESSION_START_UNAVAILABLE, and the
    // body is now the tool's own wording — which for copilot carries its install
    // hint (#1907) that this route's fixed sentence used to discard.
    //
    // One behaviour deliberately changes: a tool whose binary is not on the
    // server's PATH but whose tmux session is already RUNNING is no longer
    // refused. `isRunning` is positive evidence that the agent is alive, and
    // `which` failing (a server started from a shell without the nvm PATH, say)
    // says nothing about whether it can be typed into.

    // Issue #2865: a same-named session another CommandMate server created (its
    // `#{session_path}` is not this worktree's directory) is neither typed into
    // nor adopted, and no session of our own is started over it.
    const sessionName = cliTool.getSessionName(id, instanceId);
    const ownership = await checkSessionOwnership(sessionName, worktree.path);
    // Issue #3759: the attempts this route refuses before the send service are
    // recorded too, so `lastSend` names the latest one.
    const sendAttemptInstance = { worktreeId: id, cliToolId, instanceId: instanceId ?? cliToolId };
    // Issue #4011: the same record is this request's attempt, so `sendOutcome`
    // answers `not_sent` for it whether or not a relay is bound.
    const recordNotSent = (reason: SendAttemptReason): void => {
      recordSendAttempt(sendAttemptInstance, { state: 'not-sent', reason, content: trimmedContent });
      relay.attempt = 'not-sent';
    };
    if (ownership.verdict === 'foreign') {
      recordNotSent('foreign-session');
      return NextResponse.json(foreignSessionErrorBody(sessionName, ownership.sessionPath), { status: 409 });
    }

    // Check if CLI tool session is running.
    //
    // Issue #3981 (R4): a launch of this session another request has in
    // progress is waited out first. Its pane exists before its launch line is
    // typed, so `isRunning` read in that window says "running" for seven tools
    // (this send would then type into the shell) and, for claude on a pane that
    // fails the health check, "not running" (this send would start it again and
    // kill the first launch's pane). A launch that began while `isRunning` was
    // being read is waited out and the answer read again. This route never holds
    // the input lock, so the wait is never refused — but it is bounded by the
    // launch's start budget, and a launch that outlives it is answered as the
    // slow start it is: not-sent, 503 SESSION_STARTING (review P3-1).
    let running: boolean;
    try {
      await settleSessionLaunch(sessionName, cliTool.name);
      running = await cliTool.isRunning(id, instanceId);
      if (running && (await settleSessionLaunch(sessionName, cliTool.name))) {
        running = await cliTool.isRunning(id, instanceId);
      }
    } catch (error: unknown) {
      if (!isSessionStartTimeoutError(error)) throw error;
      recordNotSent('session-starting');
      return answerSessionStartTimeout(error.message, cliTool, id, instanceId);
    }

    const modelRefusal = refuseModelOnRunningSession(body.model, cliToolId, running);
    if (modelRefusal) return modelRefusal;

    // Start CLI tool session if not running
    if (!running) {
      const started = await startSessionForSend({
        db,
        cliTool,
        cliToolId,
        worktreeId: id,
        worktreePath: worktree.path,
        instanceId,
        model: body.model,
        recordNotSent,
      });
      if (!started.ok) return started.response;
    } else {
      // Issue #2433: the session is already up, so `startSession()` — and with it
      // #2429's check that the pane's `CM_HOOK_URL` still names THIS server — is
      // skipped. That skip is the whole defect: a pane raised by a server on
      // another port keeps posting its lifecycle events there, `wait` holds for
      // #1975's full 60 s on every turn, and nothing on any surface says why.
      // #2429 hung the check off the adopt path, which for the three tools that
      // carry `CM_HOOK_URL` on the launch line (antigravity / command-code /
      // gemini) requires `hasSession()` to be true and false at once, so it never
      // ran. Here it is reachable, and here is where it matters: this is the
      // branch that keeps typing into the mispointed pane.
      //
      // Not awaited, and it does not gate the send. The session is NOT restarted
      // — it may be mid-turn — so the answer changes nothing about the message
      // below; and after the first send to a given pane the probe is a `Set`
      // lookup, so the per-send `capture-pane` count is unchanged.
      probeRunningSessionHookUrl(cliTool, id, instanceId);
    }

    const image = resolveSendImagePath(body.imagePath, worktree.path);
    if (!image.ok) return image.response;
    const absoluteImagePath = image.value;

    // Issue #1028: Delegate the send + history-recording flow to the shared
    // sendUserMessage service so manual sends and Timer-fired sends (executeTimer)
    // record identically in chat_messages / Message History.
    const sendStartedAt = Date.now();
    // Issue #3957: whether a turn was open when the body started going in,
    // read at that moment (`onInputStart` runs inside the sender's
    // `noteInputStart`). A generation change during the send is "not known".
    const generationKey = buildCompositeKey(id, cliToolId, instanceId);
    const generationBefore = currentGeneration(generationKey);
    relay.binding?.begin(generationBefore);
    let turnAtInput: TurnAtInput | null = null;
    // Issue #3945: this request's own attempt, as the service recorded it.
    let ownAttempt: { state: SendAttemptState; reason: string } | null = null;
    const respondAgent = resolveRespondAgent(db, id, requestedCliToolId, instanceId);

    const result = await sendUserMessage(db, {
      worktreeId: id,
      content: trimmedContent,
      cliToolId,
      instanceId,
      respondAgent,
      absoluteImagePath,
      // Issue #576: copilot /model switch (antigravity model is applied at
      // session start above, not mid-session).
      copilotModel: cliToolId === 'copilot' ? body.model : undefined,
      // Issue #1737: `commandmate send --ignore-structured-prompt`.
      ignoreStructuredPromptGuard: body.ignoreStructuredPromptGuard === true,
      onAttempt: (attempt) => {
        ownAttempt = attempt;
        relay.attempt = attempt.state;
      },
      onInputStart: () => {
        turnAtInput = readTurnAtInput(id, cliToolId, instanceId);
      },
      // Issue #3957: the relay's boundary, required — a refusal stops the send.
      inputBoundary: relay.binding?.hooks(),
    });

    if (!result.ok) {
      // Issue #1708: the session is sitting on a prompt, so nothing was sent.
      // 409 rather than 500 — the request was well formed and the server is
      // healthy; the session is simply in a state that cannot accept a message.
      // The stable `code` is what the CLI branches on (a bare 409 would be
      // reported as "Unexpected HTTP status: 409", which says nothing).
      if (result.stage === 'prompt_waiting') {
        return NextResponse.json(
          { error: result.error, code: PROMPT_WAITING_CODE },
          { status: 409 }
        );
      }
      return answerSendFailure(result, {
        cliTool,
        worktreeId: id,
        instanceId,
        model: body.model,
        sendAttemptInstance,
        ownAttempt,
        sendStartedAt,
        trimmedContent,
        // Issue #4063: only Command Code shows a plan review. Its primary —
        // no instance, or the tool's own id (#868) — is reached by a bare
        // `respond` only when it is the worktree default; otherwise the
        // sentence names `--agent command-code`, by `respondAgentFor`'s rule.
        planReviewRespondAgent:
          cliToolId === 'command-code'
            ? resolveRespondAgent(db, id, cliToolId, instanceId === cliToolId ? undefined : instanceId)
            : undefined,
      });
    }

    const generationAfter = currentGeneration(generationKey);
    relay.sent = { messageId: result.message.id, generationAfter };
    const turnOpenAtSend = judgeTurnOpenAtSend(
      turnAtInput,
      generationBefore,
      generationAfter,
      reportsTurns(cliToolId),
    );
    const sent: SendMessageResponse =
      turnOpenAtSend !== undefined ? { ...result.message, turnOpenAtSend } : result.message;
    return NextResponse.json(sent, { status: 201 });
  } catch (error: unknown) {
    logger.error('error-sending-message:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    );
  }
}
