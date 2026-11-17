/**
 * Whether the tool policy lets Auto-Yes answer a tool (Issue #4436 I1b).
 *
 * A module of its own rather than part of `auto-yes-policy.ts` (the contract
 * lookup): the answering paths' tests mock that module wholesale, and this
 * verdict must hold under those mocks as well. Server-only: it reads the usage
 * declaration from `process.env`.
 *
 * @module lib/polling/auto-yes-tool-policy
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { decideToolPolicy, type ToolPolicyDecision } from '@/lib/tool-policy/policy';
import { readUsageDeclaration } from '@/lib/tool-policy/declaration';

/**
 * The tool policy's refusal of Auto-Yes answering for `cliToolId`, or null when
 * the tool may be answered (Issue #4436 I1b).
 *
 * The enable API refuses an antigravity grant without a usage declaration, but a
 * grant can be on without having passed it: kept on `globalThis` across a Hot
 * Reload, or armed by an older build. The answering paths — the poller's tick
 * (`validatePollingContext`) and the `PermissionRequest` hook
 * (`decidePermissionRequest`) — ask this before they use a grant, so such a grant
 * answers nothing however it came to be on. Read on every call (the declaration
 * is `process.env`, fixed for the life of the server); not cached.
 *
 * `auto-yes` is refused from every origin under `personal`; `legacy` is the
 * origin of the grant (the screen or an older CLI armed it).
 */
export function autoYesToolPolicyDenial(
  cliToolId: CLIToolType
): Extract<ToolPolicyDecision, { allowed: false }> | null {
  const decision = decideToolPolicy({
    tool: cliToolId,
    operation: 'auto-yes',
    origin: 'legacy',
    declaration: readUsageDeclaration(),
  });
  return decision.allowed ? null : decision;
}
