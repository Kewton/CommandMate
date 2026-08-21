/**
 * In-memory record of the last `tool_input` this server had to normalise
 * (Issue #1902).
 *
 * `readPermissionToolInput` turns copilot's string `tool_input` into an object
 * so the request can be adjudicated at all. That is a rewrite of what the agent
 * sent, and the design policy's discoverability rule (§7 of
 * `docs/design/multi-agent-state-architecture.md`) is that a judgement or an
 * automatic action which only exists in the server log does not exist: an
 * operator has to be able to read *"the tool_input was a string, so it was read
 * as a patch"* out of the CLI.
 *
 * So the same record `permission-decision-service` acts on is kept here per
 * session and published by `buildCurrentOutput` as
 * `structuredEvents.toolInputNormalization` — which is what `capture --json`
 * prints verbatim and what `wait` polls.
 *
 * Exposure only: nothing reads this back to decide anything. The decision uses
 * the normalisation carried on the payload itself, not this record.
 *
 * The module is a near-copy of `polling/auto-yes-suppression-state` on purpose;
 * that similarity is the convention for a per-session diagnostic, and the
 * `globalThis` indirection is load-bearing for the same reason it is there
 * (#1736): the writer is `/api/hooks/permission-request` and the reader is
 * `/api/worktrees/:id/current-output`, which `next dev` bundles separately and
 * would otherwise give a private copy of this map each.
 *
 * @module lib/hooks/tool-input-normalization-state
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { ToolInputNormalization } from './tool-input-normalization';

/** What was normalised, for which tool call, and when. */
export interface ToolInputNormalizationRecord extends ToolInputNormalization {
  /** `tool_name` of the call whose input was rewritten (`Edit` in #1902). */
  toolName: string;
  /** Epoch ms of the request that was normalised. */
  at: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __toolInputNormalizations: Map<string, ToolInputNormalizationRecord> | undefined;
}

/** compositeKey -> the most recent normalisation for that session. */
const lastNormalizations = globalThis.__toolInputNormalizations ??
  (globalThis.__toolInputNormalizations = new Map<string, ToolInputNormalizationRecord>());

/**
 * Record that `instanceId`'s last permission request arrived in a shape this
 * server had to rewrite before it could judge it.
 *
 * Recorded for every verdict, not only for allows: the operator's question is
 * "why did this get adjudicated the way it did", and suppressing the record on
 * the suppressed path would remove the answer exactly when it is asked.
 *
 * @param at - Epoch ms; defaults to now. Overridable so tests are deterministic.
 */
export function recordToolInputNormalization(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  normalization: ToolInputNormalization,
  toolName: string,
  at: number = Date.now()
): void {
  lastNormalizations.set(buildCompositeKey(worktreeId, cliToolId, instanceId), {
    ...normalization,
    toolName,
    at,
  });
}

/**
 * @returns The last normalisation for this session, or null — the ordinary case
 *   for every tool but copilot, and for copilot sessions that have not edited a
 *   file yet.
 */
export function getLastToolInputNormalization(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): ToolInputNormalizationRecord | null {
  return lastNormalizations.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/** Drop every recorded normalisation. Test seam. */
export function clearToolInputNormalizations(): void {
  lastNormalizations.clear();
}
