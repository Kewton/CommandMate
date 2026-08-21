/**
 * In-memory record of the last permission this server adjudicated *on the
 * agent's behalf* (Issue #1898).
 *
 * Every hook tool is adjudicated inside the request it is blocked on, so the
 * agent learns the verdict by getting an answer. opencode is adjudicated over a
 * connection nobody is holding: CommandMate reads `permission.asked` off the
 * SSE stream, decides, and POSTs the reply back. That is an automatic action
 * taken while no human was looking, and the design policy's discoverability
 * rule (§7 of `docs/design/multi-agent-state-architecture.md`) is that such an
 * action which exists only in the server log does not exist — an operator has
 * to be able to read *"Auto-Yes answered `once` and the dialog is gone"* out of
 * the CLI.
 *
 * So the outcome is kept here per session and published by `buildCurrentOutput`
 * as `structuredEvents.permissionDecision`, which is what `capture --json`
 * prints verbatim and what `wait` polls.
 *
 * Exposure only, exactly like `./tool-input-normalization-state` (#1902):
 * nothing reads this back to decide anything. Whether a dialog is open is
 * `getStructuredPromptWaiting`'s answer, and it is reached through the event
 * record rather than through this map.
 *
 * The `globalThis` indirection is load-bearing for the same reason it is
 * everywhere else in this subsystem (#1736): the writer is the opencode ingest
 * (or `/api/worktrees/:id/auto-yes`) and the reader is
 * `/api/worktrees/:id/current-output`, which `next dev` bundles separately and
 * would otherwise give a private copy of this map each.
 *
 * @module lib/hooks/permission-decision-state
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';

/** What happened to one approval this server adjudicated. */
export interface PermissionDecisionRecord {
  /** The agent's own id for the dialog (`per_…`), or null when it has none. */
  decisionId: string | null;
  /** `tool_name` the approval was judged as, or null. */
  toolName: string | null;
  /** What the adjudicator answered: `allow`, or null for a no-decision. */
  behavior: 'allow' | null;
  /** Why — verbatim from `resolvePermissionRequest`, e.g. `auto-yes-disabled`. */
  reason: string;
  /** Whether the verdict actually reached the agent. False for every abstain. */
  delivered: boolean;
  /**
   * Whether this delivery retired the prompt-waiting record.
   *
   * False on every source whose `permissionReplyReleasesPrompt` capability is
   * false, even for a delivered allow: there the dialog is on a screen only the
   * scraper can see, so the verdict is not evidence that it closed.
   */
  releasedPrompt: boolean;
  /** What prompted the adjudication — the live frame, or a policy re-check. */
  trigger: PermissionDecisionTrigger;
  /**
   * Epoch ms the approval was raised (`PendingDecision.askedAt`), not the
   * instant the verdict was written. On the re-check path those differ by
   * however long the dialog sat there, which is the number an operator asking
   * "how long was this worker stuck" actually wants.
   */
  at: number;
}

/**
 * Why this approval was adjudicated when it was.
 *
 * - `event` — it arrived on the stream and was judged on the spot.
 * - `policy-recheck` — it was already pending and the policy changed under it
 *   (#1898-2: Auto-Yes switched on while a dialog was up). Worth telling apart,
 *   because the second one answers a dialog a human has been staring at.
 */
export type PermissionDecisionTrigger = 'event' | 'policy-recheck';

declare global {
  // eslint-disable-next-line no-var
  var __permissionDecisions: Map<string, PermissionDecisionRecord> | undefined;
}

/** compositeKey -> the most recent adjudication for that session. */
const lastDecisions = globalThis.__permissionDecisions ??
  (globalThis.__permissionDecisions = new Map<string, PermissionDecisionRecord>());

/**
 * Record how one approval was adjudicated.
 *
 * Recorded for every verdict, not only for allows — the operator's question is
 * "why is this worker sitting on a dialog", and suppressing the record on the
 * abstain path would remove the answer exactly when it is asked.
 */
export function recordPermissionDecision(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  record: PermissionDecisionRecord
): void {
  lastDecisions.set(buildCompositeKey(worktreeId, cliToolId, instanceId), record);
}

/**
 * @returns The last adjudication for this session, or null — the ordinary case
 *   for every tool CommandMate does not adjudicate for, and for an opencode
 *   session that has not asked for anything yet.
 */
export function getLastPermissionDecision(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): PermissionDecisionRecord | null {
  return lastDecisions.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/** Drop every recorded adjudication. Test seam. */
export function clearPermissionDecisions(): void {
  lastDecisions.clear();
}
