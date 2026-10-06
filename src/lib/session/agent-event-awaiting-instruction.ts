/**
 * The agent's own "I am waiting for instructions" (Issue #1786).
 *
 * Split out of `agent-event-state` (Issue #3375), which re-exports the public
 * names and applies the transition from `recordAgentEvent`.
 *
 * @module lib/session/agent-event-awaiting-instruction
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { AgentEventRecord } from '@/lib/session/agent-event-record';
import { generationStartedAt } from '@/lib/session/agent-event-turn';
import { getOrInitGlobal } from '../global-state';

// The maps below live on `globalThis`; see the note above `declare global` in
// `agent-event-state` for why (Issue #1736).
declare global {
  // eslint-disable-next-line no-var
  var __agentEventAwaitingInstruction: Map<string, AwaitingInstructionRecord> | undefined;
}

/** compositeKey -> the agent's own "I am waiting for instructions" (#1786). */
export const awaitingInstruction = getOrInitGlobal('__agentEventAwaitingInstruction', () => new Map<string, AwaitingInstructionRecord>());

/** The agent's own report that it is sitting at the composer (Issue #1786). */
export interface AwaitingInstructionRecord {
  /** Epoch ms the `Notification(idle_prompt)` was received. */
  at: number;
  /** `Notification.message` — the agent's own line, or null. Display only. */
  message: string | null;
}

/**
 * The third state: "this turn is over and nobody has told me what to do next"
 * (Issue #1786).
 *
 * | event                             | effect on awaiting_instruction |
 * |-----------------------------------|--------------------------------|
 * | `notification(idle_prompt)`       | **set**                        |
 * | `user_prompt_submit`              | release                        |
 * | `session_start` / `session_end`   | release                        |
 * | everything else                   | unchanged                      |
 *
 * It is a boolean beside the status rather than a fifth `SessionStatus`, because
 * `idle_prompt` already maps to `ready` (`agentEventToSessionStatus`) and
 * `ready` means "you can send a message" everywhere in this codebase — the
 * sidebar, `deriveCliStatus`, `getNextAction`, `commandmate wait`. Widening that
 * vocabulary to carry "and it is *asking* you to" would have every consumer of
 * the four values re-decide what they mean; the boolean asks nothing of anyone
 * who does not want it.
 *
 * `stop` deliberately does NOT set it. `Stop` fires when the turn ends, which is
 * most of the time the agent has simply finished a step of its own plan;
 * `Notification(idle_prompt)` is Claude's separate, later "waiting for your
 * input" signal, and using the turn boundary instead would mark every
 * intermediate stop as a request for instructions.
 *
 * `pre_tool_use` / `post_tool_use` / `notification(permission_prompt)` leave it
 * alone, and that is not a gap: a tool call or a dialog can only happen inside a
 * turn, and the turn's own `user_prompt_submit` has already released it. Adding
 * them would only paper over a `UserPromptSubmit` that never arrived — and an
 * operator whose `UserPromptSubmit` hook is missing has no `Notification` hook
 * either, so there would be nothing to release.
 *
 * There is deliberately no age bound here, unlike every other state in this
 * module. Those bound the damage of an event that may never arrive (a lost
 * `Stop`, a dialog answered with no event to say so). This one is released by
 * events that cannot be missed while the fact is still true: typing into the
 * composer — from the app or straight into the tmux pane — raises
 * `UserPromptSubmit`, and ending the session raises `SessionEnd`. An agent that
 * has been idle for six hours genuinely is still awaiting instructions, and
 * expiring the flag would erase the notification #1790 exists to send. The
 * generation fence in {@link isAwaitingInstruction} still applies, so the flag
 * never survives the process that reported it.
 */
export function applyAwaitingInstructionTransition(key: string, record: AgentEventRecord): void {
  switch (record.event) {
    case 'notification':
      if (record.detail === 'idle_prompt') {
        awaitingInstruction.set(key, { at: record.at, message: record.message ?? null });
      }
      return;
    case 'user_prompt_submit':
    case 'session_start':
    case 'session_end':
      awaitingInstruction.delete(key);
      return;
    case 'stop':
    case 'pre_tool_use':
    case 'post_tool_use':
      return;
    default:
      // exhaustive check: a new AgentEventType must decide its transition here
      record.event satisfies never;
      return;
  }
}

/**
 * The agent's own "waiting for your input", or null (Issue #1786).
 *
 * Fenced by generation like the rest of this module: an `idle_prompt` from the
 * Claude process that used to live in this pane is not this one's.
 */
export function getAwaitingInstruction(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): AwaitingInstructionRecord | null {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const record = awaitingInstruction.get(key);
  if (!record) return null;

  const generation = generationStartedAt.get(key);
  if (generation !== undefined && record.at < generation) return null;

  return record;
}

/** {@link getAwaitingInstruction} as the boolean the list API publishes. */
export function isAwaitingInstruction(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): boolean {
  return getAwaitingInstruction(worktreeId, cliToolId, instanceId) !== null;
}
