/**
 * The tool-policy fields a `send` write carries before its message (Issue #4449),
 * split out of `send.ts` (Issue #4128).
 */

import { sendOriginFieldsFor } from '../utils/send-origin';
import type { RelayEndpointArg } from './relays';

/**
 * Issue #4449: what a write this send makes before its message tells the server about
 * the send it is for — who sends (`origin`, for a tool the policy may restrict) and the
 * session its `--reply-to` relay answers into (`replyTo`), and that it arms Auto-Yes on the
 * same target later (`autoYes`, I1' of #4449: the grant is refused for antigravity from
 * every origin, a send from a terminal is not, so the first write has to know). The write
 * route judges them with the tool it writes and refuses with the send's 409 (exit 33),
 * writing nothing. Empty when there is nothing to judge, so such a body is what it always
 * was; `autoYes` only rides with an origin, as a tool the policy never restricts is
 * refused nothing.
 */
export function writePolicyFields(
  tool: string | undefined,
  replyTo: RelayEndpointArg | undefined,
  autoYes: boolean | undefined
): Record<string, unknown> {
  const origin = sendOriginFieldsFor(tool);
  return {
    ...origin,
    ...(replyTo ? { replyTo: { worktreeId: replyTo.worktreeId, instanceId: replyTo.instanceId } } : {}),
    ...(autoYes && origin.origin !== undefined ? { autoYes: true } : {}),
  };
}
