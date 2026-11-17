/**
 * Issue #4437: the tool policy refusal's response types, apart from `api-responses.ts`
 * (which re-exports them) so the CLI's HTTP client can name them without that module's
 * server-side imports. Types only; no imports.
 *
 * @module cli/types/tool-policy-responses
 */

/**
 * Issue #4437: `policy` of a tool policy refusal.
 * Mirrors: src/app/api/worktrees/[id]/send/send-tool-policy.ts ToolPolicyDetail.
 */
export interface ToolPolicyDetailResponse {
  tool: string;
  /** `send` | `ask` | `respond` | `relay`. */
  operation: string;
  /** The origin the server read: `terminal` | `session` | `agent` | `schedule` | `unknown` | `relay` | `legacy`. */
  origin: string;
  /** `ANTIGRAVITY_CONSUMER_TERMS`. */
  reason: string;
  /** `personal` while refused. */
  declaration: string;
  links: { terms: string; faq: string };
  /** The one way past it (the server's usage declaration). */
  unlock: string;
  /** Relay creation only: the refused end. */
  endpoint?: 'from' | 'to';
}

/**
 * Issue #4437: the 409 of a tool policy refusal — nothing was typed or started.
 * `code` is `TOOL_POLICY_DENIED` (send / ask / respond, strict included, which
 * also carries `strictRespond: 1`) or `RELAY_TOOL_POLICY_DENIED` (`POST /api/relays`,
 * no `sendOutcome`). The send route's body also carries `relayId` / `ask` when it named them.
 * Mirrors: src/app/api/worktrees/[id]/send/send-tool-policy.ts toolPolicyDeniedBody,
 * src/app/api/relays/route.ts POST 409.
 */
export interface ToolPolicyDeniedResponse {
  error: string;
  code: 'TOOL_POLICY_DENIED' | 'RELAY_TOOL_POLICY_DENIED';
  policy: ToolPolicyDetailResponse;
  sendOutcome?: 'not_sent';
}
