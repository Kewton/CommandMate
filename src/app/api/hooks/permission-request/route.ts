/**
 * API Route: POST /api/hooks/permission-request (Issue #1724).
 *
 * Auto-Yes v2's receiver. Claude blocks on this response before it draws an
 * approval dialog, which makes it the opposite of `/api/hooks/agent-event` in
 * every way that matters: that one is fire-and-forget and always answers 202,
 * this one is synchronous and its body is obeyed. They are separate routes for
 * that reason — merging them would put a decision path behind a handler whose
 * whole contract is "accept everything, tell the caller nothing".
 *
 * ## What the body can be
 *
 * - `{}` — no decision. The spike (#1721 D5) measured this as landing in the
 *   ordinary TUI approval flow, i.e. exactly the behaviour of a machine without
 *   this feature. It is the answer to every uncertainty.
 * - `{"hookSpecificOutput":{"hookEventName":"PermissionRequest",
 *   "decision":{"behavior":"allow"}}}` — run it without asking.
 *
 * `deny` is never emitted; see `lib/hooks/permission-decision-service`.
 *
 * ## Status codes
 *
 * A 4xx is safe — Claude treats any hook failure as fail-open and shows the
 * dialog — so validation errors are reported honestly rather than disguised as
 * no-decision. The one case that deliberately answers 200 + `{}` is a request
 * that names no worktree: a hook left configured after a worktree was removed
 * is a normal state, and, as on the agent-event route, a distinguishable
 * response would turn this endpoint into a probe for which worktrees exist.
 *
 * Authentication is the middleware's (this path is not in
 * `AUTH_EXCLUDED_PATHS`), matching `/api/hooks/agent-event`.
 *
 * ## Which tool is being answered (Issue #1759)
 *
 * The two bodies above are *Claude's* spellings, and this route no longer
 * writes them itself: it produces a {@link Verdict} and hands it to the tool's
 * {@link AgentEventSource}. That matters more here than on the event route,
 * because the differences are not cosmetic —
 *
 *  - antigravity reads `{}` as a **denial** and stops the tool call outright
 *    (#1757 P10), so "no decision" cannot be spelled the same way there;
 *  - opencode has no response body to write into at all, and waits **with no
 *    timeout** for a reply that has to arrive as a separate `POST` (#1758
 *    §5.5.3, 10m19s measured).
 *
 * Both of those turn "abstain, which is safe" into "stop the session in
 * silence". `describeAbstain` is why the log says so.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isCliToolType, isValidInstanceId } from '@/lib/cli-tools/types';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import { resolveWorktreeByCwd, validateHookCwd } from '@/lib/hooks/agent-event-service';
import {
  PERMISSION_DECISION_SLOW_MS,
  resolvePermissionRequest,
  type PermissionDecision,
} from '@/lib/hooks/permission-decision-service';
import {
  answerPendingDecision,
  describeAbstain,
  getAgentEventSource,
  type PendingDecision,
  type Verdict,
} from '@/lib/hooks/sources';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/hooks-permission-request');

/** No decision to report. Byte-for-byte what the spike returned for D5. */
const NO_DECISION_BODY = {} as const;

const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });

/** A string field, or undefined when absent or of the wrong type. */
function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The adjudicator's verdict, in the transport-independent vocabulary
 * (Issue #1759).
 *
 * `resolvePermissionRequest` answers `allow` or "not allow", and how that
 * becomes bytes is the source's business (S6): Claude wants
 * `hookSpecificOutput.decision.behavior`, copilot wants
 * `hookSpecificOutput.permissionDecision`, antigravity wants a top-level
 * `decision`, and opencode wants a `POST` to a different URL. This route
 * produces the meaning and hands it over.
 *
 * `deny` is never produced; see `lib/hooks/permission-decision-service`.
 */
function toVerdict(decision: PermissionDecision): Verdict {
  return decision.behavior === 'allow' ? { kind: 'allowOnce' } : { kind: 'abstain' };
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return badRequest('Request body must be a JSON object');
    }
    const raw = body as Record<string, unknown>;
    const query = new URL(request.url).searchParams;

    // `type: "http"` posts the agent's payload verbatim, so the correlation
    // keys can only come from the URL the settings generator baked them into.
    const toolValue = readString(raw, 'tool') ?? query.get('tool') ?? undefined;
    if (toolValue === undefined || !isCliToolType(toolValue)) {
      return badRequest('tool must be a known CLI tool id');
    }
    const tool: CLIToolType = toolValue;

    const instanceParam = readString(raw, 'instanceId') ?? query.get('instanceId') ?? undefined;
    if (instanceParam !== undefined && !isValidInstanceId(instanceParam)) {
      return badRequest('instanceId must be a safe, bounded identifier');
    }

    const worktreeIdParam = readString(raw, 'worktreeId') ?? query.get('worktreeId') ?? undefined;

    const cwdSent = raw.cwd !== undefined;
    const cwd = validateHookCwd(raw.cwd);
    if (!cwd.ok && (cwdSent || worktreeIdParam === undefined)) {
      return badRequest(`cwd rejected: ${cwd.reason}`);
    }

    const db = getDbInstance();
    let worktree: Worktree | null = null;
    if (worktreeIdParam !== undefined) {
      worktree = getWorktreeById(db, worktreeIdParam) ?? null;
    } else if (cwd.ok) {
      worktree = resolveWorktreeByCwd(db, cwd.cwd);
    }

    if (!worktree) {
      logger.info('permission-request-unresolved-target', { tool, instanceId: instanceParam });
      return NextResponse.json(NO_DECISION_BODY, { status: 200 });
    }

    // Issue #1759: the payload is read in the sending tool's dialect (S7) and
    // the verdict is written back in it (S6). The adjudication in between —
    // `resolvePermissionRequest` — was already tool-independent and is
    // untouched.
    const source = getAgentEventSource(tool);
    const payload = source.parsePermissionRequest(raw);
    const decision = resolvePermissionRequest(
      { worktreeId: worktree.id, cliToolId: tool, instanceId: instanceParam ?? tool },
      payload
    );
    const verdict = toVerdict(decision);

    const ref = { worktreeId: worktree.id, cliToolId: tool, instanceId: instanceParam ?? tool };
    const pending: PendingDecision = {
      kind: 'permission',
      // A hook's identity *is* the request it arrived on, so the id is minted
      // here. `prompt_id` rides along when the payload carried one, which is
      // what correlates this with the `PreToolUse` that preceded it (D2).
      id: payload?.promptId ?? `req-${startedAt}-${payload?.toolName ?? 'unknown'}`,
      conversationId: payload?.sessionId ?? null,
      subject: {
        kind: 'permission',
        toolName: payload?.toolName ?? '',
        toolInput: payload?.toolInput ?? {},
      },
      raw,
      askedAt: startedAt,
    };

    // C3. Abstaining is free on Claude — #1721 D5 measured an empty reply as
    // indistinguishable from having no hook — and it is *not* free on opencode,
    // which waits with no timeout, or on antigravity, which reads the same
    // empty reply as a denial. A source that says so gets it said out loud,
    // because nothing else will: the session simply stops, which looks exactly
    // like an agent that is thinking.
    if (verdict.kind === 'abstain') {
      const abstain = describeAbstain(source);
      if (!abstain.safe) {
        logger.warn('permission-request-abstain-blocks-agent', {
          worktreeId: worktree.id,
          tool,
          instanceId: ref.instanceId,
          toolName: payload?.toolName ?? null,
          consequence: abstain.summary,
          blocksForMs: abstain.blocksForMs,
        });
      }
    }

    // C2. Whether this leaves through the body of the request the agent is
    // blocked on, or through a second HTTP call to the agent's own server, is
    // the source's business. This route writes whatever comes back.
    const responseBody = await answerPendingDecision(source, ref, pending, verdict);

    const elapsedMs = Date.now() - startedAt;
    const detail = {
      worktreeId: worktree.id,
      tool,
      instanceId: instanceParam ?? tool,
      toolName: payload?.toolName ?? null,
      promptId: payload?.promptId ?? null,
      behavior: decision.behavior,
      reason: decision.reason,
      suppressedBy: decision.suppressedBy,
      elapsedMs,
    };
    if (elapsedMs > PERMISSION_DECISION_SLOW_MS) {
      // The agent is blocked for exactly this long before its dialog appears.
      logger.warn('permission-request-slow', detail);
    } else {
      logger.info('permission-request-decided', detail);
    }

    return NextResponse.json(responseBody, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-processing-permission-request:', {
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    });
    // No decision rather than a 500 body: an unexpected failure here must cost
    // a dialog, never an approval and never a stuck agent.
    return NextResponse.json(NO_DECISION_BODY, { status: 200 });
  }
}
