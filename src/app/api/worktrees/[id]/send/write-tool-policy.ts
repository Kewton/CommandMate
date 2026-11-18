/**
 * The tool policy at the routes a send writes through BEFORE its message
 * (Issue #4449, the rest of #4437): `POST /instances/roles` (`send --register --role`),
 * `PUT /instances/roles` (`send --contract --role`) and `POST /tasks` (`send --contract`).
 *
 * The CLI used to ask `GET /tool-policy` first and write only when allowed. The ask and
 * the write were two requests: an ask that failed (a 500, a 404 from a server before
 * #4437) let the write go on, and a default target changed between them was written
 * under a verdict given for another tool. Here the write itself is refused, in the same
 * request and before anything is written, with the very 409 `POST /send` answers
 * (`TOOL_POLICY_DENIED`), or the one `POST /api/relays` answers
 * (`RELAY_TOOL_POLICY_DENIED`) for the relay `send --reply-to` opens before its message.
 *
 * The body may carry `origin` / `originEvidence` (as on `/send`) and `replyTo`
 * (`{ worktreeId, instanceId }`, the session the relay answers into). None of them →
 * nothing changes: the web UI and older CLIs write as before (`legacy` is a person).
 * The origin is the caller's claim and is not verified: a guard against accidental
 * use, not a guarantee of compliance with the Google Antigravity terms.
 *
 * Callers judge the tool they are about to write and write that one, with no `await`
 * between (I2 / I3 of #4449): {@link findWriteToolPolicyRefusal} is synchronous.
 *
 * @module app/api/worktrees/[id]/send/write-tool-policy
 */

import type Database from 'better-sqlite3';
import { isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import { resolveSessionTarget } from '@/lib/session/resolve-session-target';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { RELAY_TOOL_POLICY_DENIED, type SendOrigin } from '@/lib/tool-policy/policy';
import { readUsageDeclaration } from '@/lib/tool-policy/declaration';
import { findRelayToolPolicyDenial, RELAY_TOOL_POLICY_DENIED_MESSAGE } from '@/lib/relay/relay-policy';
import { findToolPolicyDenial, readBodyOrigin, toolPolicyDeniedBody, toolPolicyDetail } from './send-tool-policy';

/** The session a `send --reply-to` relay answers into (the relay's `from` end). */
export interface WriteReplyTo {
  worktreeId: string;
  instanceId: string;
}

/** What a write's body says about the send it is written for. */
export interface WriteToolPolicyRequest {
  origin: SendOrigin;
  originEvidence: unknown;
  replyTo: WriteReplyTo | null;
}

/** The 400 for a `replyTo` that is not `{ worktreeId, instanceId }`. */
export const REPLY_TO_FIELD_INVALID = 'replyTo must be { worktreeId, instanceId }';

/** Read `origin`, `originEvidence` and `replyTo` off a write's body; the 400's sentence when malformed. */
export function readWriteToolPolicyRequest(
  body: Record<string, unknown>,
): { ok: true; value: WriteToolPolicyRequest } | { ok: false; error: string } {
  const origin = readBodyOrigin(body.origin);
  if (!origin.ok) return origin;
  let replyTo: WriteReplyTo | null = null;
  if (body.replyTo !== undefined) {
    const value = body.replyTo as { worktreeId?: unknown; instanceId?: unknown } | null;
    if (
      value === null
      || typeof value !== 'object'
      || typeof value.worktreeId !== 'string'
      || value.worktreeId === ''
      || typeof value.instanceId !== 'string'
      || !isValidInstanceId(value.instanceId)
    ) {
      return { ok: false, error: REPLY_TO_FIELD_INVALID };
    }
    replyTo = { worktreeId: value.worktreeId, instanceId: value.instanceId };
  }
  return { ok: true, value: { origin: origin.origin, originEvidence: body.originEvidence, replyTo } };
}

/** The 409 body of a refused write: the send's or the relay's, as those routes give it. */
export type WriteToolPolicyRefusalBody = Record<string, unknown> & { code: string };

/**
 * Would the send this write is for be refused? The relay first (the CLI opens it before
 * the message), then the send to `tool`, as `GET /tool-policy` and `POST /send` decide.
 * Synchronous: the caller writes `tool` right after, with nothing in between.
 *
 * @returns The 409 body, or null when the write may go on
 */
export function findWriteToolPolicyRefusal(
  db: Database.Database,
  input: { worktreeId: string; tool: CLIToolType; instanceId?: string; request: WriteToolPolicyRequest },
): WriteToolPolicyRefusalBody | null {
  const { request } = input;
  if (request.replyTo !== null) {
    let from: CLIToolType | null = null;
    try {
      from = resolveSessionTarget(db, canonicalWorktreeId(request.replyTo.worktreeId), {
        instanceId: request.replyTo.instanceId,
      }).cliToolId;
    } catch {
      // Not resolvable here: opening the relay will say what is wrong with it.
    }
    const relayDenial = from === null
      ? null
      : findRelayToolPolicyDenial({ from, to: input.tool, declaration: readUsageDeclaration() });
    if (relayDenial) {
      return {
        error: RELAY_TOOL_POLICY_DENIED_MESSAGE,
        code: RELAY_TOOL_POLICY_DENIED,
        policy: { ...toolPolicyDetail(relayDenial.decision), endpoint: relayDenial.endpoint },
      };
    }
  }
  const denial = findToolPolicyDenial({
    tool: input.tool,
    operation: 'send',
    origin: request.origin,
    originEvidence: request.originEvidence,
    worktreeId: input.worktreeId,
    instanceId: input.instanceId ?? input.tool,
  });
  return denial ? toolPolicyDeniedBody(denial) : null;
}

/**
 * Thrown from inside a write's transaction when the policy refuses the tool it holds,
 * so the transaction rolls back with nothing written; the route answers 409 with `body`.
 */
export class WriteToolPolicyRefused extends Error {
  constructor(public readonly body: WriteToolPolicyRefusalBody) {
    super(String(body.error ?? body.code));
    this.name = 'WriteToolPolicyRefused';
  }
}
