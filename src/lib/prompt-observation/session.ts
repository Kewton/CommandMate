/**
 * Observe one session from the `current-output` payload of one capture
 * (Issue #3755): {@link buildPromptObservation} with the two server-side facts
 * the payload does not carry — the session generation and the contract's
 * Auto-Yes policy — looked up the way the poller looks them up.
 *
 * @module lib/prompt-observation/session
 */

import { getAgentEventGenerationStartedAt } from '@/lib/session/agent-event-state';
import { getSessionAutoYesPolicyEntry } from '@/lib/polling/auto-yes-policy';
import { forgetScreenAppearance, noteScreenAppearance } from './appearance';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { buildPromptObservation, type ObservationPayload } from './observe';
import type { PromptObservation } from './types';

/** The resolved target the payload was built for. */
export interface ObservedTarget {
  cliToolId: CLIToolType;
  /** Undefined for a request that named no instance (the primary). */
  instanceId?: string;
  resolvedBy?: string | null;
}

/**
 * @param now - Epoch ms of the observation; defaults to now
 */
export function observeSession(
  worktreeId: string,
  target: ObservedTarget,
  payload: ObservationPayload,
  now: number = Date.now()
): PromptObservation {
  // The poller's own lookup (Issue #3724: policy and task id in one read).
  const { policy, taskId } = getSessionAutoYesPolicyEntry(worktreeId, target.cliToolId, target.instanceId);
  const instance = { worktreeId, cliToolId: target.cliToolId, instanceId: target.instanceId ?? target.cliToolId };
  return buildPromptObservation({
    ...instance,
    resolvedBy: target.resolvedBy ?? null,
    payload,
    sessionGeneration: getAgentEventGenerationStartedAt(worktreeId, target.cliToolId, target.instanceId),
    contract: { policy, taskId },
    appearance: {
      note: (fingerprint) => noteScreenAppearance(instance, fingerprint, now),
      forget: () => forgetScreenAppearance(instance),
    },
    now,
  });
}
