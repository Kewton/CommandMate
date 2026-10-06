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
 * The rule: when the agent's hooks speak for the pane (source kind `hooks`)
 * and the tool is one whose hook turns the screen may not end
 * ({@link screenMayCloseHookTurn} — codex, where a frame of a live 0.160.0 turn
 * read `ready`, `tests/fixtures/codex-mid-turn-3337/`), a turn the hooks opened
 * ends at the agent's own `Stop`. Only two things end it without the `Stop`,
 * because they say the `Stop` is not coming:
 *
 *  - `stale` — nothing heard for `TURN_STALE_AFTER_MS`, applied by the turn
 *    record itself;
 *  - a frame that shows the turn was abandoned (codex's `■ Conversation
 *    interrupted`).
 *
 * Every other case is not held, as before #3337: a source with no hooks
 * (`scraper`), a pull source (`sse`), and a hooks tool with no policy (Claude
 * and the rest), whose turns the screen still closes.
 *
 * @module lib/session/hook-turn-hold
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { screenMayCloseHookTurn, screenShowsAbandonedHookTurn } from '@/lib/detection/turn-abandoned';
import { describeAgentEventSource } from '@/lib/hooks/sources/define-source';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import type { AgentEventSourceKind } from '@/lib/hooks/sources/types';
import { getStructuredSessionState, type StructuredSessionState } from '@/lib/session/agent-event-state';

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
  return sourceKind !== 'hooks' || screenMayCloseHookTurn(cliToolId, output);
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
 * True when the source is `hooks`, the tool's policy keeps the screen from
 * ending the turn on this frame ({@link screenMayEndTurn}), and its turn record
 * publishes `running` (open, current generation, not stale, no dialog — a dialog
 * is `waiting`, which is the send path's to judge).
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

/**
 * The turn record's verdict as this frame lets it be published (Issue #3377).
 *
 * `getStructuredSessionState`, except that a `running` is dropped (null — the
 * frame decides) when the hooks speak for the pane and the frame shows the
 * turn was abandoned (codex's `■ Conversation interrupted`). That is the frame
 * this module already lets the screen end the turn on, and the one the list
 * already reads as not processing (`hookTurnHoldsPane` does not hold it).
 * Without this, `capture --json` kept publishing `running` until
 * `SCRAPER_COMPLETION_POLLS` such frames had closed the record — ~3 s on
 * 2026-10-06 while the list said not processing.
 *
 * Only what is PUBLISHED changes: the record still closes on the third frame,
 * as before. Every other frame — a misread mid-turn frame included — keeps the
 * hooks' `running` (#3337), and a tool with no policy (Claude and the rest) is
 * untouched.
 *
 * Read by `buildCurrentOutput` and the list's `foldHookTurn`.
 *
 * @param sourceKind - `structuredEvents.source.kind` for the pane
 * @param output - The pane as captured
 */
export function structuredStateForFrame(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  sourceKind: AgentEventSourceKind,
  output: string,
  now: number = Date.now()
): StructuredSessionState | null {
  const state = getStructuredSessionState(worktreeId, cliToolId, instanceId, now);
  if (
    state?.status === 'running' &&
    sourceKind === 'hooks' &&
    screenShowsAbandonedHookTurn(cliToolId, output)
  ) {
    return null;
  }
  return state;
}
