/**
 * The observation half of `waiting-episode-binding` (Issue #3798): the
 * observers' starts, the dating of a captured frame, and the plan of tables
 * O-1 / O-2. Split out of `waiting-episode-binding` (Issue #3892), which
 * re-exports all of it and carries the plan out (`commitWaitingObservation`).
 *
 * @module lib/session/waiting-episode-binding-observation
 */

import { AsyncLocalStorage } from 'async_hooks';
import { buildCompositeKey, COMPOSITE_KEY_SEPARATOR } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { promptScreenKey } from '@/lib/detection/prompt-screen-key';
import type { ScreenReading } from '@/lib/detection/waiting-screen-reading';
import type { CaptureFrameMeta } from '@/lib/session/cli-session';
import { generationStartedAt, toGenerationRef } from '@/lib/session/agent-event-turn';
import { generationOf, resolveEpisodeBinding } from '@/lib/session/waiting-episode-binding-resolve';
import {
  getEpisodeVersion,
  getLastClosedEpisode,
  getWaitingEpisodeRecord,
  snapshotEpisodeVersions,
  type EpisodeBinding,
  type EpisodeKeyParts,
  type GenerationRef,
  type NewEpisode,
  type WaitingCloseReason,
  type WaitingEpisodeId,
  type WaitingEpisodeRecord,
} from '@/lib/session/waiting-episode-state';
import { sameGeneration } from '@/lib/session/waiting-episode-verdict';
import { getOrInitGlobal } from '../global-state';

/** Where `cli-session` reports a frame's source to the observer it runs for (Issue #3798). */
function frameMetaSink(): AsyncLocalStorage<(meta: CaptureFrameMeta) => void> {
  return getOrInitGlobal('__captureFrameMetaSink', () => new AsyncLocalStorage<(meta: CaptureFrameMeta) => void>());
}

// =============================================================================
// Observations (design §2.4 規則 3・4・5, tables O-1 / O-2)
// =============================================================================

/** The observers whose readings go through {@link planWaitingObservation}. */
export type WaitingObserverKind = 'status-probe' | 'response-checker' | 'auto-yes-poller';

/**
 * What an observer fixed before its first `await` (design §2.5): the
 * generation and the instance's episode version. A plan made against a later
 * state than this is refused (I5 (b)).
 */
export interface ObservationStart {
  generation: GenerationRef;
  version: number;
}

/** One observer's reading of one frame (design §2.2). */
export interface WaitingObservation {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
  observer: WaitingObserverKind;
  start: ObservationStart;
  reading: ScreenReading;
  /**
   * When the frame read was fetched (the cached capture's own start for a
   * frame served from the cache; {@link captureFrameTime}). 0 for a
   * reading with no frame (a session that is gone, a reply recorded), which
   * reads as "before any close" (design §2.6).
   */
  frameCapturedAt: number;
  /**
   * The frame was fetched by this observer's own capture, after its
   * {@link ObservationStart} — its source is `fetched`, not the cache or a
   * fetch joined in flight (an unknown source does not count). A close the start
   * already saw (the version has not moved since) then cannot be newer than
   * the frame, whatever the millisecond clocks say, and I6 does not apply.
   */
  frameFetchedAfterStart?: boolean;
  /**
   * A confirmation the observer is about to act on as new: the response
   * poller's prompt that passes the dedup (planned against the state as it is
   * now, I5 (d)).
   */
  freshPrompt?: boolean;
  /** The Auto-Yes poller's last answer (PR 3). Absent until then. */
  lastAnswer?: { episodeId: WaitingEpisodeId; screenKey: string } | null;
  /** Epoch ms; defaults to now. */
  now?: number;
}

export type ObservationAction = 'opened' | 'kept' | 'rebound' | 'replaced' | 'closed' | 'ignored';

/** Why an observation changed nothing. */
export type ObservationIgnoredReason =
  | 'generation'
  | 'version'
  | 'stale-frame'
  | 'nothing-open'
  | 'not-this-observer'
  | 'unknown-frame';

/** What {@link commitWaitingObservation} will do, decided without writing anything. */
export interface WaitingObservationPlan {
  observation: WaitingObservation;
  action: ObservationAction;
  /** The episode open when planned — the one kept, rebound, replaced or closed. */
  episodeId: WaitingEpisodeId | null;
  /** The wait's `since` once committed (null when it is not waiting). */
  since: number | null;
  /** opened / replaced. */
  next: NewEpisode | null;
  /** rebound. */
  binding: EpisodeBinding | null;
  /** closed, and the old episode of replaced. */
  closeReason: WaitingCloseReason | null;
  ignoredBecause: ObservationIgnoredReason | null;
  at: number;
}

/** Fix the observer's start (design §2.5). Read-only. */
export function startWaitingObservation(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): ObservationStart {
  return {
    generation: generationOf({ worktreeId, cliToolId, instanceId }),
    version: getEpisodeVersion(worktreeId, cliToolId, instanceId),
  };
}

/** The starts of every instance of one worktree, fixed at one moment. */
export interface WorktreeObservationStarts {
  startFor(cliToolId: CLIToolType, instanceId?: string): ObservationStart;
}

/**
 * Fix the start of every instance of a worktree at once (design §2.5): the
 * status routes call it before `listSessions()`, so a session that started —
 * and opened a wait — after the list was taken is not closed as gone by a
 * probe that did not see it. Instances that have no version or generation yet
 * are fixed at 0 / none.
 */
export function startWorktreeWaitingObservations(worktreeId: string): WorktreeObservationStarts {
  const prefix = `${worktreeId}${COMPOSITE_KEY_SEPARATOR}`;
  const versions = snapshotEpisodeVersions(worktreeId);
  const generations = new Map<string, number>();
  for (const [key, at] of generationStartedAt) {
    if (key.startsWith(prefix)) generations.set(key, at);
  }
  return {
    startFor(cliToolId, instanceId) {
      const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
      return { generation: toGenerationRef(generations.get(key) ?? null), version: versions.get(key) ?? 0 };
    },
  };
}

/** When the frame an observer just read was fetched, and whether it fetched it itself. */
export interface CapturedFrameTime {
  /** {@link WaitingObservation.frameCapturedAt}. */
  frameCapturedAt: number;
  /** {@link WaitingObservation.frameFetchedAfterStart}. */
  frameFetchedAfterStart: boolean;
}

/**
 * When the frame a scraper just read was fetched (design §2.2
 * `frameCapturedAt`), from `meta` — what the capture reported for that one
 * frame ({@link captureObservedFrame}). A frame served from the cache, or
 * joined to a fetch already in flight, is as old as that fetch, and is never
 * one this observer fetched itself — even when that fetch started in the very
 * millisecond the observer asked. Only a frame the capture fetched itself,
 * starting at or after `requestedAt` (the moment the observer asked, after its
 * start), counts as fetched after the start. A frame nothing was reported for
 * (a capture module a test replaced) is dated 0, before any close (design
 * §2.6): it opens no wait I6 would hold back, and closes no `screen`.
 */
export function captureFrameTime(meta: CaptureFrameMeta | null, requestedAt: number): CapturedFrameTime {
  if (meta === null) return { frameCapturedAt: 0, frameFetchedAfterStart: false };
  return {
    frameCapturedAt: Math.min(meta.fetchStartedAt, requestedAt),
    frameFetchedAfterStart: meta.source === 'fetched' && meta.fetchStartedAt >= requestedAt,
  };
}

/**
 * Run one capture for an observer and date the frame it returns (Issue #3798):
 * `cli-session` reports where THIS call's frame came from through an async
 * context set up here, so another capture of the same session running at the
 * same time — a different number of lines, a different text — cannot stand in
 * for it.
 */
export async function captureObservedFrame<T>(
  capture: () => Promise<T>
): Promise<{ frame: T; frameTime: CapturedFrameTime }> {
  const reported: { meta: CaptureFrameMeta | null } = { meta: null };
  const requestedAt = Date.now();
  const frame = await frameMetaSink().run((meta) => {
    reported.meta = meta;
  }, capture);
  return { frame, frameTime: captureFrameTime(reported.meta, requestedAt) };
}

function screenBinding(generation: GenerationRef, originTurnId: string | null): EpisodeBinding {
  return { kind: 'screen', generation, originTurnId };
}

function sameBinding(a: EpisodeBinding, b: EpisodeBinding): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'turn':
      return a.turnId === (b as typeof a).turnId;
    case 'dialog-only':
      return a.recordTurnId === (b as typeof a).recordTurnId;
    default:
      return true;
  }
}

/** The O-1 verdict before the preconditions (design §2.4 表 O-1). */
type O1Verdict =
  | { action: 'opened'; binding: EpisodeBinding }
  | { action: 'kept' }
  | { action: 'rebound'; binding: EpisodeBinding }
  | { action: 'replaced'; binding: EpisodeBinding };

/** Whether the Auto-Yes poller answered this episode and the screen now shows another confirmation (R1-7, PR 3). */
function answeredThenAnother(obs: WaitingObservation, episode: WaitingEpisodeRecord, k: string | null): boolean {
  return (
    obs.freshPrompt === true &&
    obs.lastAnswer != null &&
    obs.lastAnswer.episodeId === episode.episodeId &&
    k !== null &&
    k !== obs.lastAnswer.screenKey
  );
}

/** Table O-1: a `waiting` reading on the instance's episode (or none). */
function verdictForWaiting(
  obs: WaitingObservation,
  episode: WaitingEpisodeRecord | null,
  humanHeld: boolean,
  c: EpisodeBinding,
  k: string | null,
  current: GenerationRef
): O1Verdict {
  if (episode === null) return { action: 'opened', binding: c };
  const binding = episode.binding;
  // The row below the table: a binding of another generation is replaced (P3-2).
  if (!sameGeneration(binding.generation, current)) return { action: 'replaced', binding: c };

  if (humanHeld) {
    if (binding.kind === 'screen') return { action: 'kept' };
    return { action: 'rebound', binding: screenBinding(current, binding.kind === 'turn' ? binding.turnId : null) };
  }

  switch (binding.kind) {
    case 'turn': {
      const stillOpen = c.kind === 'turn' && c.turnId === binding.turnId;
      if (stillOpen) return answeredThenAnother(obs, episode, k) ? { action: 'replaced', binding: c } : { action: 'kept' };
      if (c.kind === 'turn') return { action: 'replaced', binding: c };
      // T has ended (stop, screen evidence, the 30-minute stale bound — R2-3):
      // only another confirmation replaces it.
      return obs.freshPrompt === true && k !== null && k !== episode.promptScreenKey
        ? { action: 'replaced', binding: c }
        : { action: 'kept' };
    }
    case 'dialog-only':
      if (c.kind === 'turn') return { action: 'rebound', binding: c };
      if (c.kind === 'dialog-only' && c.recordTurnId !== binding.recordTurnId) return { action: 'replaced', binding: c };
      return { action: 'kept' };
    case 'unattributed':
      if (c.kind === 'unattributed') {
        return answeredThenAnother(obs, episode, k) ? { action: 'replaced', binding: c } : { action: 'kept' };
      }
      if (c.kind === 'dialog-only') return { action: 'rebound', binding: c };
      // c = turn(N): the wait turned out to be N's when it shows the same confirmation (R2-4).
      return k !== null && k === episode.promptScreenKey
        ? { action: 'rebound', binding: c }
        : { action: 'replaced', binding: c };
    case 'screen':
      return c.kind === 'turn' && c.turnId === binding.originTurnId
        ? { action: 'rebound', binding: c }
        : { action: 'replaced', binding: c };
    default:
      binding satisfies never;
      return { action: 'kept' };
  }
}

/** Table O-2: the closing side. Null when the reading closes nothing. */
function closeReasonFor(
  obs: WaitingObservation,
  episode: WaitingEpisodeRecord
): WaitingCloseReason | null {
  const { reading } = obs;
  if (reading.kind === 'gone') return 'session-gone';
  if (reading.kind !== 'not-waiting') return null;
  switch (obs.observer) {
    case 'status-probe':
      return 'screen-cleared';
    case 'response-checker':
      return 'response-recorded';
    case 'auto-yes-poller':
      // A screen only after a frame fetched since it became one (R3-1, P3-1);
      // any other wait only when the poller answered it (PR 3, 規則 3).
      if (episode.binding.kind === 'screen') {
        return obs.frameCapturedAt > Math.max(episode.openedAt, episode.boundAt) ? 'screen-cleared' : null;
      }
      return obs.lastAnswer != null && obs.lastAnswer.episodeId === episode.episodeId ? 'poller-answered' : null;
    default:
      obs.observer satisfies never;
      return null;
  }
}

/** Why the old episode of a replacement ended. */
function replacedBecause(old: EpisodeBinding, next: EpisodeBinding, current: GenerationRef): WaitingCloseReason {
  if (!sameGeneration(old.generation, current)) return 'generation';
  return next.kind === 'turn' || next.kind === 'dialog-only' ? 'turn-superseded' : 'screen-cleared';
}

/**
 * Decide what one observation does to the instance's episode (design §2.4
 * 規則 3・4・5, tables O-1 / O-2 and preconditions 1–3). Reads the store and
 * the turn model; writes nothing.
 */
export function planWaitingObservation(obs: WaitingObservation): WaitingObservationPlan {
  const at = obs.now ?? Date.now();
  const parts: EpisodeKeyParts = { worktreeId: obs.worktreeId, cliToolId: obs.cliToolId, instanceId: obs.instanceId };
  const episode = getWaitingEpisodeRecord(obs.worktreeId, obs.cliToolId, obs.instanceId);
  const current = generationOf(parts);
  const base: WaitingObservationPlan = {
    observation: obs,
    action: 'ignored',
    episodeId: episode?.episodeId ?? null,
    since: obs.reading.kind === 'waiting' ? episode?.since ?? null : null,
    next: null,
    binding: null,
    closeReason: null,
    ignoredBecause: null,
    at,
  };
  const ignored = (because: ObservationIgnoredReason): WaitingObservationPlan => ({
    ...base,
    action: 'ignored',
    ignoredBecause: because,
  });

  // Precondition 1: the observer started in another generation.
  if (!sameGeneration(obs.start.generation, current)) return ignored('generation');
  const versionMoved =
    obs.start.version !== getEpisodeVersion(obs.worktreeId, obs.cliToolId, obs.instanceId) && obs.freshPrompt !== true;

  const { reading } = obs;
  if (reading.kind !== 'waiting') {
    // Table O-2.
    if (episode === null) return ignored('nothing-open');
    if (reading.kind === 'unknown') return ignored('unknown-frame');
    const reason = closeReasonFor(obs, episode);
    if (reason === null) return ignored('not-this-observer');
    if (versionMoved) return ignored('version');
    return { ...base, action: 'closed', closeReason: reason, since: null };
  }

  // Table O-1.
  const k = reading.promptData !== null ? promptScreenKey(reading.promptData) : null;
  // 規則 1: a person's screen is `screen` whatever the turn model says, with
  // the open turn as its origin.
  const resolved = resolveEpisodeBinding(parts, at);
  const c = reading.humanHeld
    ? screenBinding(current, resolved.kind === 'turn' ? resolved.turnId : null)
    : resolved;
  const verdict = verdictForWaiting(obs, episode, reading.humanHeld, c, k, current);
  if (verdict.action === 'kept') return { ...base, action: 'kept' };
  // Precondition 2 (I5 (b) / (d)) and 3 (I6).
  if (versionMoved) return ignored('version');
  const lastClosed = getLastClosedEpisode(obs.worktreeId, obs.cliToolId, obs.instanceId);
  const closedBeforeOwnFetch =
    obs.frameFetchedAfterStart === true &&
    obs.start.version === getEpisodeVersion(obs.worktreeId, obs.cliToolId, obs.instanceId);
  if (
    lastClosed !== null &&
    !closedBeforeOwnFetch &&
    obs.frameCapturedAt <= lastClosed.at &&
    (k === null || k === lastClosed.promptScreenKey)
  ) {
    return ignored('stale-frame');
  }

  if (verdict.action === 'rebound') {
    if (episode !== null && sameBinding(episode.binding, verdict.binding)) return { ...base, action: 'kept' };
    return { ...base, action: 'rebound', binding: verdict.binding };
  }
  const binding = verdict.binding;
  const structuredSince = reading.structuredSince;
  const since =
    verdict.action === 'opened' || episode === null
      ? structuredSince ?? at
      : structuredSince !== null && structuredSince > episode.since
        ? structuredSince
        : at;
  const next: NewEpisode = {
    since,
    kind: reading.waitingKind,
    binding,
    openedBy: obs.observer,
    promptScreenKey: k,
  };
  return {
    ...base,
    action: verdict.action,
    since,
    next,
    closeReason: verdict.action === 'replaced' && episode !== null ? replacedBecause(episode.binding, binding, current) : null,
  };
}
