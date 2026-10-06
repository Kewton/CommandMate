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
 * ## Whose record it is (Issue #3195)
 *
 * The key is (worktree, tool, instance), and a key outlives a launch: kill a
 * launch mid-way and start the instance again, and the killed `startSession`
 * is still in its readiness wait (agy: up to 30 s) while the new one writes
 * the same key. When the old one finished, its `finally` deleted the new
 * launch's record and the new "starting" display ended early.
 *
 * So every launch carries a token. `startSession` issues one
 * ({@link issueSessionStartingToken}) and runs `launchSession` inside
 * {@link runWithSessionStartingToken}; `markSessionStarting`, reached from
 * `beginAgentSession` anywhere below that call, picks it up from the
 * `AsyncLocalStorage`, and the `finally` clears with it — a record written
 * under another token is left alone. A second mark under the same token (codex's
 * `relaunchIntoSamePane`) rewrites the same launch's record, so the `finally`
 * still clears it. A mark never replaces a record of a LATER launch (tokens
 * only grow), so a killed launch that re-marks on its way out cannot take the
 * key back from its successor. `clearSessionStarting` without a token — the
 * kill-session route — drops the record whoever wrote it.
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

import { AsyncLocalStorage } from 'node:async_hooks';
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
  /** The launch that wrote it (Issue #3195); only that launch's `finally` clears it. */
  token: number;
  /** Epoch ms the launch began. */
  since: number;
  /** Epoch ms a dialog was first seen in the current unbroken run, or null. */
  promptSeenAt: number | null;
  /** Set once a dialog outlived the grace; the record then stops answering. */
  released: boolean;
}

/** globalThis slots typed without `declare global { var }` (npm-publish-check.ts precedent) */
const globalStore = globalThis as typeof globalThis & {
  __sessionStartingRecords?: Map<string, SessionStartingRecord>;
  __sessionStartingTokenSeq?: { last: number };
  __sessionStartingTokenScope?: AsyncLocalStorage<number>;
};

const records = (globalStore.__sessionStartingRecords ??= new Map<string, SessionStartingRecord>());

/** On `globalThis` like the map, so tokens keep growing across route bundles. */
const tokenSeq = (globalStore.__sessionStartingTokenSeq ??= { last: 0 });

const tokenScope = (globalStore.__sessionStartingTokenScope ??= new AsyncLocalStorage<number>());

/**
 * A token for a launch about to begin (Issue #3195). Strictly greater than
 * every token issued before it.
 */
export function issueSessionStartingToken(): number {
  tokenSeq.last += 1;
  return tokenSeq.last;
}

/**
 * Run a launch under its token, so a `markSessionStarting` anywhere below it
 * records the launch as this token's (Issue #3195).
 *
 * @param token - From {@link issueSessionStartingToken}
 * @param fn - The launch
 */
export function runWithSessionStartingToken<T>(token: number, fn: () => T): T {
  return tokenScope.run(token, fn);
}

/**
 * Record that a launch of this instance began.
 *
 * Under the launch's token: the one {@link runWithSessionStartingToken} is
 * running, or a fresh one outside any. A record of a later launch is kept —
 * this call is then a launch that was already superseded (Issue #3195).
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - Tool being launched
 * @param instanceId - Instance (defaults to the primary)
 * @param at - Epoch ms; defaults to now
 * @returns The token the record was written under, or null when it was not written
 */
export function markSessionStarting(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  at: number = Date.now(),
): number | null {
  const token = tokenScope.getStore() ?? issueSessionStartingToken();
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const existing = records.get(key);
  if (existing !== undefined && existing.token > token) return null;
  records.set(key, {
    cliToolId,
    token,
    since: at,
    promptSeenAt: null,
    released: false,
  });
  return token;
}

/**
 * Forget the launch of this instance. Idempotent, and never throws: it runs in
 * `startSession`'s `finally`, where an exception would replace the launch's own
 * error — an id `buildCompositeKey` refuses could never have been recorded.
 *
 * With a token, only that launch's record is dropped — a launch that was
 * killed and replaced must not end its successor's display (Issue #3195).
 * Without one (kill-session), the record is dropped whoever wrote it.
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - Tool that was launched
 * @param instanceId - Instance (defaults to the primary)
 * @param token - The launch's token; omit to drop any launch's record
 */
export function clearSessionStarting(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  token?: number,
): void {
  try {
    const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
    if (token !== undefined && records.get(key)?.token !== token) return;
    records.delete(key);
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
