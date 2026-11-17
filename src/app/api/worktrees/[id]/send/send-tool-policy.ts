/**
 * The tool policy at the routes that type into a session (Issue #4437):
 * `POST /send`, `/respond`, `/prompt-response` and `/prompt-response/strict`.
 *
 * The body may say who started the request (`origin`, written by the CLI from
 * its own environment). The routes read it here, ask the pure table
 * (`lib/tool-policy/policy`) under the declaration as stated (`CM_ANTIGRAVITY_USAGE`,
 * no credentials read), and answer a refusal with one 409 body before anything is
 * typed or started. The origin is the caller's claim and is not verified: this is
 * a guard against accidental use, not a guarantee of compliance with the terms.
 *
 * Lives beside the send route (the first of the four); the other three import it.
 *
 * @module app/api/worktrees/[id]/send/send-tool-policy
 */

import { NextResponse } from 'next/server';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  decideToolPolicy,
  parseSendOrigin,
  TOOL_POLICY_DENIED,
  TOOL_POLICY_DENIED_MESSAGE,
  USAGE_DECLARATION_ENV,
  type SendOrigin,
  type ToolOperation,
  type ToolPolicyDecision,
} from '@/lib/tool-policy/policy';
import { readUsageDeclaration } from '@/lib/tool-policy/declaration';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/tool-policy');

/** The 400 for an `origin` that is not a string (an unknown string is `unknown`, never 400). */
export const ORIGIN_FIELD_INVALID = 'origin must be a string';

/** The longest `originEvidence` kept; longer is cut. */
export const ORIGIN_EVIDENCE_MAX_CHARS = 128;

/** A refusal of the table. */
export type DeniedToolPolicy = Extract<ToolPolicyDecision, { allowed: false }>;

/**
 * What a refusal's `policy` says. `unlock` is the one way past it: the server's
 * declaration (human decision Q5 on #4437 — the environment only, not an API).
 */
export interface ToolPolicyDetail {
  tool: CLIToolType;
  operation: ToolOperation;
  origin: SendOrigin;
  reason: DeniedToolPolicy['reason'];
  declaration: DeniedToolPolicy['declaration'];
  links: { terms: string; faq: string };
  unlock: string;
}

/** The sentence `policy.unlock` carries. */
export const TOOL_POLICY_UNLOCK_HINT =
  `Set ${USAGE_DECLARATION_ENV}=api-key (or ${USAGE_DECLARATION_ENV}=enterprise) on the server and restart it, `
  + 'if you use Antigravity with an API key or an enterprise plan.';

/** `policy` of a refusal's body. */
export function toolPolicyDetail(decision: DeniedToolPolicy): ToolPolicyDetail {
  return {
    tool: decision.tool,
    operation: decision.operation,
    origin: decision.origin,
    reason: decision.reason,
    declaration: decision.declaration,
    links: { terms: decision.links.terms, faq: decision.links.faq },
    unlock: TOOL_POLICY_UNLOCK_HINT,
  };
}

/**
 * The body's `origin`: missing → `legacy` (the web UI, the CLI before #4437), a
 * known one as it is, any other string → `unknown`; anything else is the 400.
 */
export function readBodyOrigin(value: unknown): { ok: true; origin: SendOrigin } | { ok: false; error: string } {
  const origin = parseSendOrigin(value);
  if (origin === 'invalid') return { ok: false, error: ORIGIN_FIELD_INVALID };
  return { ok: true, origin };
}

/** The body's `originEvidence`, for the log only: a string, cut to its bound; else null. */
export function readOriginEvidence(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, ORIGIN_EVIDENCE_MAX_CHARS) : null;
}

/**
 * Ask the table for this request; the refusal (logged), or null when it may go
 * on. The declaration is read here, as stated.
 */
export function findToolPolicyDenial(input: {
  tool: CLIToolType;
  operation: ToolOperation;
  origin: SendOrigin;
  originEvidence?: unknown;
  worktreeId: string;
  instanceId?: string;
}): DeniedToolPolicy | null {
  const decision = decideToolPolicy({
    tool: input.tool,
    operation: input.operation,
    origin: input.origin,
    declaration: readUsageDeclaration(),
  });
  if (decision.allowed) return null;
  logger.info('tool-policy-denied', {
    worktreeId: input.worktreeId,
    instanceId: input.instanceId ?? input.tool,
    tool: decision.tool,
    operation: decision.operation,
    origin: decision.origin,
    originEvidence: readOriginEvidence(input.originEvidence),
  });
  return decision;
}

/** The 409 body: `{ error, code: TOOL_POLICY_DENIED, policy, sendOutcome: 'not_sent' }`. */
export function toolPolicyDeniedBody(decision: DeniedToolPolicy): {
  error: string;
  code: typeof TOOL_POLICY_DENIED;
  policy: ToolPolicyDetail;
  sendOutcome: 'not_sent';
} {
  return {
    error: TOOL_POLICY_DENIED_MESSAGE,
    code: TOOL_POLICY_DENIED,
    policy: toolPolicyDetail(decision),
    sendOutcome: 'not_sent',
  };
}

/** The 409 of a refusal, with `extra` in front of the body (the strict route's `strictRespond`). */
export function toolPolicyDeniedResponse(
  decision: DeniedToolPolicy,
  extra: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json({ ...extra, ...toolPolicyDeniedBody(decision) }, { status: 409 });
}
