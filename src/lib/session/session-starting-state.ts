/**
 * Which agent sessions are still starting (Issue #3179).
 *
 * `isRunning` is tmux's `has-session`, and every tool's `launchSession` creates
 * the tmux session BEFORE it types the launch command — so from that moment the
 * screen saw a "running" session whose pane held nothing but a shell prompt and
 * the launch line. That frame matches no tool's rule, falls to the detector's
 * floor (`running` / `default`) and raised `isUnclassifiedActive`, which drew the
 * Navigate pad; the trust dialog the launch answers by itself was drawn as a
 * selection list or a prompt; and the composer's stop button lit up red.
 *
 * This module is the missing fact: "a launch of this (worktree, tool, instance)
 * is in progress, and began at T". It is written by `beginAgentSession` (every
 * tool's creation path goes through it) and cleared by `BaseCLITool.startSession`
 * in a `finally`, success and failure alike — which also covers the
 * `relaunchIfToolExited` path, because that reuses `startSession`.
 *
 * ## The escape hatches
 *
 * A starting display that never ends would hide a stuck launch, which is worse
 * than the defect it fixes. So the record stops answering when:
 *
 *  - the launch returned or threw (`clearSessionStarting`);
 *  - it is older than the tool's readiness wait plus a grace period
 *    (`getSessionStartingMaxMs`) — several tools only log when that wait runs
 *    out and carry on, so time is the only signal there is;
 *  - a dialog has stayed on screen for longer than the launch takes to answer
 *    the ones it knows about (`SESSION_STARTING_PROMPT_GRACE_MS`) — a login or
 *    an unknown dialog, which a human has to see. Once released this way the
 *    record stays released for the rest of the launch, so the display does not
 *    flicker back when the dialog is answered.
 *
 * A server restart drops the map, and the screen shows the raw pane — harmless.
 *
 * In memory and on `globalThis` for the reason every shared map in this
 * subsystem is (#1736): the writer (`POST /send`) and the readers
 * (`/current-output`, the WebSocket streamer, `GET /api/worktrees`) are
 * different route bundles under `next dev`.
 *
 * @module lib/session/session-starting-state
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import type { StatusDetectionResult } from '@/lib/detection/status-detector';
import {
  SESSION_STARTING_PROMPT_GRACE_MS,
  getSessionStartingMaxMs,
} from '@/config/session-starting-config';

/** One launch in progress. */
interface SessionStartingRecord {
  cliToolId: CLIToolType;
  /** Epoch ms the launch began. */
  since: number;
  /** Epoch ms a dialog was first seen in the current unbroken run, or null. */
  promptSeenAt: number | null;
  /** Set once a dialog outlived the grace; the record then stops answering. */
  released: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __sessionStartingRecords: Map<string, SessionStartingRecord> | undefined;
}

const records = globalThis.__sessionStartingRecords ??
  (globalThis.__sessionStartingRecords = new Map<string, SessionStartingRecord>());

/**
 * Record that a launch of this instance began.
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - Tool being launched
 * @param instanceId - Instance (defaults to the primary)
 * @param at - Epoch ms; defaults to now
 */
export function markSessionStarting(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  at: number = Date.now(),
): void {
  records.set(buildCompositeKey(worktreeId, cliToolId, instanceId), {
    cliToolId,
    since: at,
    promptSeenAt: null,
    released: false,
  });
}

/**
 * Forget the launch of this instance. Idempotent, and never throws: it runs in
 * `startSession`'s `finally`, where an exception would replace the launch's own
 * error — an id `buildCompositeKey` refuses could never have been recorded.
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - Tool that was launched
 * @param instanceId - Instance (defaults to the primary)
 */
export function clearSessionStarting(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): void {
  try {
    records.delete(buildCompositeKey(worktreeId, cliToolId, instanceId));
  } catch {
    // Nothing was recorded under an id that does not compose into a key.
  }
}

/** The record's start time while it still answers, else null (dropping an expired one). */
function activeSince(key: string, record: SessionStartingRecord | undefined, now: number): number | null {
  if (record === undefined || record.released) return null;
  if (now - record.since > getSessionStartingMaxMs(record.cliToolId)) {
    records.delete(key);
    return null;
  }
  return record.since;
}

/**
 * When this instance's launch began, or null when it is not starting (no
 * launch, already finished, past its time bound, or released by a dialog).
 *
 * Read-only apart from dropping an expired record.
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - Tool
 * @param instanceId - Instance (defaults to the primary)
 * @param now - Epoch ms; defaults to now
 */
export function getSessionStartingSince(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  now: number = Date.now(),
): number | null {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  return activeSince(key, records.get(key), now);
}

/**
 * {@link getSessionStartingSince}, fed what the current frame shows.
 *
 * A dialog on screen (a prompt, a selection list, any `waiting` verdict) starts
 * a dwell; one that outlives {@link SESSION_STARTING_PROMPT_GRACE_MS} is a
 * dialog the launch is not going to answer, and the record is released so the
 * screen shows it. A frame with no dialog resets the dwell.
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - Tool
 * @param instanceId - Instance (defaults to the primary)
 * @param dialogVisible - Whether the frame shows a dialog
 * @param now - Epoch ms; defaults to now
 * @returns The launch's start time while it is still shown as starting, else null
 */
export function observeSessionStartingFrame(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  dialogVisible: boolean,
  now: number = Date.now(),
): number | null {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const record = records.get(key);
  const since = activeSince(key, record, now);
  if (since === null || record === undefined) return null;
  if (!dialogVisible) {
    record.promptSeenAt = null;
    return since;
  }
  record.promptSeenAt ??= now;
  if (now - record.promptSeenAt >= SESSION_STARTING_PROMPT_GRACE_MS) {
    record.released = true;
    return null;
  }
  return since;
}

/**
 * The verdict published for a frame under a launch in progress (Issue #3179).
 *
 * `running` with the `starting` reason: the session exists and is busy, and no
 * dialog, selection list or unclassified overlay is on it for anybody to drive.
 * `positive` because the launch record is an observation this server made, not
 * a pattern that failed to match. The raw verdict is not consulted beyond its
 * `confidence`; reading anything else off it is what this replaces.
 *
 * @param raw - What the detector said about the frame
 * @returns The neutral verdict for the same frame
 */
export function startingStatusResult(
  raw: StatusDetectionResult,
): StatusDetectionResult {
  return {
    ...raw,
    status: 'running',
    reason: STATUS_REASON.STARTING,
    hasActivePrompt: false,
    promptDetection: { ...raw.promptDetection, isPrompt: false, promptData: undefined },
    evidence: 'positive',
  };
}

/** Drop every record. For tests. */
export function resetSessionStartingState(): void {
  records.clear();
}
