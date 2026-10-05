/**
 * Whether the agent's own hooks hold a pane at `running` over what the screen
 * reads (Issue #3337).
 *
 * The one statement of the rule, read by both places that ask "is this pane
 * mid-turn": `buildCurrentOutput` (`capture --json`, the terminal stream) and
 * the relay's readiness check, which types a reply into the pane only when it
 * is not. Two copies of it is how a relay was free to type into a running codex
 * turn whose `capture --json` already said `running`.
 *
 * The rule: when the agent's hooks speak for the pane (source kind `hooks`), a
 * turn they opened ends at the agent's own `Stop`, not at a frame that looks
 * finished — a frame of a live codex 0.160.0 turn read `ready`
 * (`tests/fixtures/codex-mid-turn-3337/`). Only two things end it without the
 * `Stop`, because they say the `Stop` is not coming:
 *
 *  - `stale` — nothing heard for `TURN_STALE_AFTER_MS`, applied by the turn
 *    record itself;
 *  - a frame that shows the turn was abandoned
 *    ({@link frameShowsAbandonedTurn}: codex's `■ Conversation interrupted`).
 *
 * A source with no hooks (`scraper`) and a pull source (`sse`) are not held:
 * the screen speaks for them, as before.
 *
 * @module lib/session/hook-turn-hold
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { frameShowsAbandonedTurn } from '@/lib/detection/turn-abandoned';
import { describeAgentEventSource } from '@/lib/hooks/sources/define-source';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import type { AgentEventSourceKind } from '@/lib/hooks/sources/types';
import { getStructuredSessionState } from '@/lib/session/agent-event-state';

/**
 * Whether the screen may end a turn the agent has not ended.
 *
 * `buildCurrentOutput` passes this to `observeScraperCompletionEvidence` as its
 * `mayClose`.
 *
 * @param sourceKind - `structuredEvents.source.kind` for the pane
 * @param output - The pane as captured
 */
export function screenMayEndTurn(
  sourceKind: AgentEventSourceKind,
  cliToolId: CLIToolType,
  output: string
): boolean {
  return sourceKind !== 'hooks' || frameShowsAbandonedTurn(cliToolId, output);
}

/** The source kind speaking for this pane now — the same fold `capture --json` publishes. */
export function agentEventSourceKind(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  now: number = Date.now()
): AgentEventSourceKind {
  const source = getAgentEventSource(cliToolId);
  return describeAgentEventSource(
    source,
    source.liveness({ worktreeId, cliToolId, instanceId: instanceId ?? cliToolId }),
    now
  ).kind;
}

/**
 * Whether the hooks hold this pane at `running`, whatever the frame reads.
 *
 * True when the source is `hooks`, its turn record publishes `running` (open,
 * current generation, not stale, no dialog — a dialog is `waiting`, which is the
 * send path's to judge), and the frame does not show an abandoned turn.
 *
 * @param output - The pane as captured
 */
export function hookTurnHoldsPane(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  output: string,
  now: number = Date.now()
): boolean {
  const kind = agentEventSourceKind(worktreeId, cliToolId, instanceId, now);
  if (screenMayEndTurn(kind, cliToolId, output)) return false;
  return getStructuredSessionState(worktreeId, cliToolId, instanceId, now)?.status === 'running';
}
