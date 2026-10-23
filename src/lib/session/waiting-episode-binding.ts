/**
 * Which turn a waiting episode belongs to, and what the turn transitions do to
 * it (Issue #3798).
 *
 * The episode store (`waiting-episode-state`) knows when a wait began and what
 * it is bound to; the turn model (`agent-event-turn`) knows how each delivery
 * moved the instance's turn. This module joins the two:
 *
 *  - {@link resolveEpisodeBinding} decides what a new episode is bound to, from
 *    the turn model as it stands (design §2.4 規則 1). It is registered with the
 *    store, so an episode `observeWaitingEdge` opens is bound like any other.
 *  - {@link applyTurnOutcomesToEpisode} is the T table (design §2.4): what a
 *    transition's outcome does to the open episode. It runs in the synchronous
 *    step that recorded the delivery (`recordAgentEvent`'s end,
 *    `beginAgentEventGeneration`, the two `report*Pending`, the duplicate-window
 *    restore) and never after an `await`, so a closer that resumes later
 *    cannot reach a wait that opened meanwhile (design §2.5).
 *  - {@link captureLegacyStopTarget} / {@link settleLegacyStop} are the one
 *    closer that cannot be synchronous: `/api/hooks/claude-done` names no
 *    session and awaits a capture and a log before it is done (design 規則 6).
 *  - {@link planWaitingObservation} / {@link commitWaitingObservation} are the
 *    tables O-1 and O-2 (design §2.4 規則 3・4・5): what one observer's reading
 *    of a frame does to the open episode. The three observers — the status
 *    probe, the response poller and the Auto-Yes poller — fix an
 *    {@link ObservationStart} before their first `await` and are refused when
 *    the episode moved meanwhile (I5 (b)), or when the frame was fetched
 *    before the close of the very confirmation it shows (I6).
 *
 * The store is a leaf and does not import this module; this module registers
 * itself with the store and with the turn model through `globalThis` when it is
 * loaded. `agent-event-state` imports it, and so does every module that calls
 * the observation functions — the resolver is registered by the import that
 * uses it, not by a transitive one (design R2-10, PR 1a review P3-2).
 *
 * Design: `docs/design/issue-3798-waiting-episode.md`.
 *
 * @module lib/session/waiting-episode-binding
 */

import { AsyncLocalStorage } from 'async_hooks';
import { buildCompositeKey, COMPOSITE_KEY_SEPARATOR } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { promptScreenKey } from '@/lib/detection/prompt-screen-key';
import type { ScreenReading } from '@/lib/detection/waiting-screen-reading';
import type { CaptureFrameMeta } from '@/lib/session/cli-session';
import { createLogger } from '@/lib/logger';
import {
  currentGeneration,
  generationStartedAt,
  getAgentTurn,
  liveDecisionCount,
  registerTurnOutcomeSink,
  toGenerationRef,
  type TurnTransitionOutcome,
} from '@/lib/session/agent-event-turn';
import {
  closeEpisode,
  getEpisodeVersion,
  getLastClosedEpisode,
  getWaitingEpisodeRecord,
  openEpisode,
  rebindEpisode,
  registerEpisodeBindingResolver,
  replaceEpisode,
  snapshotEpisodeVersions,
  updateEpisodeKind,
  type EpisodeBinding,
  type EpisodeKeyParts,
  type GenerationRef,
  type NewEpisode,
  type WaitingCloseReason,
  type WaitingEpisodeId,
  type WaitingEpisodeRecord,
} from '@/lib/session/waiting-episode-state';
import { getOrInitGlobal } from '../global-state';

const logger = createLogger('waiting-episode-binding');

declare global {
  // eslint-disable-next-line no-var
  var __waitingHookStopGeneration: Map<string, GenerationRef> | undefined;
}

/**
 * compositeKey -> the generation in which a structured `stop` was last
 * applied. While it names the current generation, the agent's own hook speaks
 * for the end of its turns and `claude-done` does not close (規則 6).
 */
/** Where `cli-session` reports a frame's source to the observer it runs for (Issue #3798). */
function frameMetaSink(): AsyncLocalStorage<(meta: CaptureFrameMeta) => void> {
  return getOrInitGlobal('__captureFrameMetaSink', () => new AsyncLocalStorage<(meta: CaptureFrameMeta) => void>());
}

const hookStopGeneration = getOrInitGlobal('__waitingHookStopGeneration', () => new Map<string, GenerationRef>());

/** What one outcome did to the open episode. */
export interface EpisodeEffect {
  outcome: TurnTransitionOutcome['kind'];
  action: 'closed' | 'rebound' | 'none';
  episodeId: WaitingEpisodeId | null;
  reason?: WaitingCloseReason;
}

function sameGeneration(a: GenerationRef, b: GenerationRef): boolean {
  if (a.kind === 'none' || b.kind === 'none') return a.kind === b.kind;
  return a.at === b.at;
}

function generationOf(parts: EpisodeKeyParts): GenerationRef {
  return toGenerationRef(currentGeneration(buildCompositeKey(parts.worktreeId, parts.cliToolId, parts.instanceId)));
}

/**
 * What an episode opening now is bound to (design §2.4 規則 1).
 *
 * Read from the fenced, aged turn record — the same reading `getAgentTurn`
 * gives every other reader — with the live decisions counted without retiring
 * the expired ones, so deciding a binding writes nothing a transition would
 * later read differently.
 */
export function resolveEpisodeBinding(parts: EpisodeKeyParts, at: number): EpisodeBinding {
  const generation = generationOf(parts);
  const turn = getAgentTurn(parts.worktreeId, parts.cliToolId, parts.instanceId, at);
  if (turn === null) return { kind: 'unattributed', generation, lastClosedTurnId: null };
  if (turn.closedAt === null && turn.openedAt !== null) {
    return { kind: 'turn', generation, turnId: turn.turnId };
  }
  if (turn.closedAt === null && liveDecisionCount(turn, at) > 0) {
    return { kind: 'dialog-only', generation, recordTurnId: turn.turnId, sessionId: turn.sessionId };
  }
  // A closed turn, or a record holding no live decision (an `idle_prompt`
  // display record, or a forecast whose 20 s ran out).
  return { kind: 'unattributed', generation, lastClosedTurnId: turn.turnId };
}

/** The T table's verdict for one outcome on one open episode. */
type Verdict =
  | { action: 'close'; reason: WaitingCloseReason }
  | { action: 'rebind'; binding: EpisodeBinding }
  | { action: 'none' }
  /** A combination the table says cannot occur (※1 / ※5). Left alone, and logged. */
  | { action: 'unmatched' };

const NONE: Verdict = { action: 'none' };
const close = (reason: WaitingCloseReason): Verdict => ({ action: 'close', reason });

/** The previous record's turn id, for the D and F columns. Null for `none`. */
function previousTurnId(previous: Extract<TurnTransitionOutcome, { previous: unknown }>['previous']): string | null {
  return previous.kind === 'none' ? null : previous.turnId;
}

/** T1–T5: a turn opened. */
function verdictForOpened(
  outcome: Extract<TurnTransitionOutcome, { kind: 'opened' }>,
  binding: EpisodeBinding
): Verdict {
  const { previous, turnId: n, event } = outcome;
  const asTurnN: EpisodeBinding = { kind: 'turn', generation: outcome.generation, turnId: n };
  if (binding.kind === 'screen') return NONE;
  if (binding.kind === 'turn' && binding.turnId === n) return { action: 'unmatched' }; // ※1

  const p = previousTurnId(previous);
  const tookOverRecord = previous.kind === 'dialog-only' || previous.kind === 'display-only';
  // D: the record this turn took over (R3-4). Only T2 / T3 / T4 have one (※5).
  const isD = binding.kind === 'dialog-only' && binding.recordTurnId === p;

  // T5 (R1-9): a turn replaced while it was open ends every wait but a screen's.
  if (previous.kind === 'open-same-session' || previous.kind === 'open-other-session') {
    return isD ? { action: 'unmatched' } : close('turn-superseded');
  }
  // T4 (R2-4): a prompt ends them too; the turn model drops every decision here.
  if (event === 'user_prompt_submit') return close('turn-superseded');

  if (binding.kind === 'turn') return close('turn-superseded');
  if (binding.kind === 'dialog-only') {
    if (!isD) return close('turn-superseded');
    return tookOverRecord ? { action: 'rebind', binding: asTurnN } : { action: 'unmatched' }; // T1: ※5
  }
  // unattributed — F: nothing opened between the wait and this turn (R2-4).
  return binding.lastClosedTurnId === p ? { action: 'rebind', binding: asTurnN } : close('turn-superseded');
}

/** T9–T11: a stop with no turn open. */
function verdictForStopWithoutTurn(
  outcome: Extract<TurnTransitionOutcome, { kind: 'stop-without-turn' }>,
  binding: EpisodeBinding
): Verdict {
  const { previous } = outcome;
  const p = previousTurnId(previous);
  switch (previous.kind) {
    case 'closed':
      // T9: B (R1-2) and F (R2-1).
      if (binding.kind === 'turn' && binding.turnId === p) return close('turn-stop');
      if (binding.kind === 'unattributed' && binding.lastClosedTurnId === p) return close('turn-stop');
      if (binding.kind === 'dialog-only' && binding.recordTurnId === p) return { action: 'unmatched' }; // ※5
      return NONE;
    case 'dialog-only':
      // T10: D, F and G.
      if (binding.kind === 'dialog-only' && binding.recordTurnId === p) return close('turn-stop');
      if (binding.kind === 'unattributed') return close('turn-stop');
      return NONE;
    case 'display-only':
    case 'none':
      // T11: D (R3-4) and F.
      if (binding.kind === 'dialog-only' && binding.recordTurnId === p) return close('turn-stop');
      if (binding.kind === 'unattributed' && binding.lastClosedTurnId === p) return close('turn-stop');
      return NONE;
    default:
      // An open turn is `stopped` / `stop-rejected`, never this outcome.
      return { action: 'unmatched' };
  }
}

/** Rows that close a binding of another generation (the I column). */
const CLOSES_OTHER_GENERATION: ReadonlySet<TurnTransitionOutcome['kind']> = new Set([
  'opened',
  'stopped',
  'stop-without-turn',
  'session-ended',
]);

/** The T table (design §2.4): one outcome on the open episode. */
export function verdictForOutcome(
  outcome: TurnTransitionOutcome,
  binding: EpisodeBinding,
  current: GenerationRef
): Verdict {
  if (outcome.kind === 'generation-fenced') {
    // T19 / T20 (R2-8): a session start in the same process keeps a screen.
    if (outcome.source === 'session-start' && binding.kind === 'screen') {
      return sameGeneration(binding.generation, outcome.generation)
        ? NONE
        : { action: 'rebind', binding: { ...binding, generation: outcome.generation } };
    }
    return sameGeneration(binding.generation, outcome.generation) ? NONE : close('generation');
  }

  if (!sameGeneration(binding.generation, current)) {
    return CLOSES_OTHER_GENERATION.has(outcome.kind) ? close('generation') : NONE;
  }

  switch (outcome.kind) {
    case 'opened':
      return verdictForOpened(outcome, binding);
    case 'restored':
      // T7: a wait opened under the discarded turn belongs to the one put back.
      return binding.kind === 'turn' && binding.turnId === outcome.discardedTurnId
        ? { action: 'rebind', binding: { ...binding, turnId: outcome.restoredTurnId } }
        : NONE;
    case 'stopped':
      // T8.
      return binding.kind === 'turn' && binding.turnId === outcome.turnId ? close('turn-stop') : NONE;
    case 'stop-without-turn':
      return verdictForStopWithoutTurn(outcome, binding);
    case 'session-ended':
      // T13.
      return binding.kind === 'turn' && binding.turnId === outcome.turnId ? close('turn-session-end') : NONE;
    case 'decision-opened':
      // T15 / T16 (R3-6): a dialog the hook reported for a wait the screen showed first.
      return outcome.recordKind === 'dialog-only' && binding.kind === 'unattributed'
        ? {
            action: 'rebind',
            binding: { kind: 'dialog-only', generation: current, recordTurnId: outcome.recordTurnId, sessionId: null },
          }
        : NONE;
    case 'decision-answered': {
      // T17 / T18 (R3-3): an explicit answer that left nothing pending.
      if (outcome.before === 0 || outcome.remaining > 0) return NONE;
      const bound =
        (binding.kind === 'turn' && binding.turnId === outcome.recordTurnId) ||
        (binding.kind === 'dialog-only' && binding.recordTurnId === outcome.recordTurnId);
      return bound ? close('decision-settled') : NONE;
    }
    case 'continued':
    case 'stop-rejected':
    case 'session-end-rejected':
    case 'none':
      // T6, T12, T14, T21.
      return NONE;
    default:
      outcome satisfies never;
      return NONE;
  }
}

/** Mark that the agent's own hook reported a stop in this generation (規則 6). */
function noteHookStop(key: string, outcome: TurnTransitionOutcome): void {
  if (outcome.kind === 'stopped' || outcome.kind === 'stop-without-turn') {
    hookStopGeneration.set(key, outcome.generation);
  }
}

function applyVerdict(
  parts: EpisodeKeyParts,
  episode: WaitingEpisodeRecord,
  outcome: TurnTransitionOutcome,
  verdict: Verdict,
  at: number
): EpisodeEffect {
  const base = { outcome: outcome.kind, episodeId: episode.episodeId };
  if (verdict.action === 'close') {
    const closed = closeEpisode(parts, episode.episodeId, verdict.reason, at);
    if (closed) {
      logger.info('waiting-episode-closed-by-turn', {
        worktreeId: parts.worktreeId,
        cliToolId: parts.cliToolId,
        instanceId: parts.instanceId ?? parts.cliToolId,
        episodeId: episode.episodeId,
        outcome: outcome.kind,
        reason: verdict.reason,
      });
    }
    return { ...base, action: closed ? 'closed' : 'none', ...(closed ? { reason: verdict.reason } : {}) };
  }
  if (verdict.action === 'rebind') {
    const rebound = rebindEpisode(parts, episode.episodeId, verdict.binding, at);
    if (rebound) {
      logger.debug('waiting-episode-rebound', {
        worktreeId: parts.worktreeId,
        instanceId: parts.instanceId ?? parts.cliToolId,
        episodeId: episode.episodeId,
        outcome: outcome.kind,
        binding: verdict.binding.kind,
      });
    }
    return { ...base, action: rebound ? 'rebound' : 'none' };
  }
  if (verdict.action === 'unmatched') {
    logger.warn('waiting-episode-unmatched', {
      worktreeId: parts.worktreeId,
      instanceId: parts.instanceId ?? parts.cliToolId,
      episodeId: episode.episodeId,
      outcome: outcome.kind,
      binding: episode.binding.kind,
    });
  }
  return { ...base, action: 'none' };
}

/**
 * Apply a delivery's transition outcomes to the instance's open episode
 * (Issue #3798, design §2.4 T table), in order.
 *
 * Called in the synchronous step that produced the outcomes. Never throws: the
 * turn has been recorded already, and a failure here must not cost the hook
 * its answer (design §2.6). An episode it leaves open is still closed by the
 * screen observers.
 *
 * @param at - Epoch ms of the change; defaults to now
 */
export function applyTurnOutcomesToEpisode(
  parts: EpisodeKeyParts,
  outcomes: readonly TurnTransitionOutcome[],
  at: number = Date.now()
): EpisodeEffect[] {
  const effects: EpisodeEffect[] = [];
  try {
    const key = buildCompositeKey(parts.worktreeId, parts.cliToolId, parts.instanceId);
    for (const outcome of outcomes) {
      noteHookStop(key, outcome);
      const episode = getWaitingEpisodeRecord(parts.worktreeId, parts.cliToolId, parts.instanceId);
      if (episode === null) {
        effects.push({ outcome: outcome.kind, action: 'none', episodeId: null });
        continue;
      }
      const verdict = verdictForOutcome(outcome, episode.binding, generationOf(parts));
      effects.push(applyVerdict(parts, episode, outcome, verdict, at));
    }
  } catch (error) {
    logger.warn('waiting-episode-turn-sync-failed', {
      worktreeId: parts.worktreeId,
      instanceId: parts.instanceId ?? parts.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return effects;
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

/**
 * Carry out a plan (design I5 (b)). Each write names the episode the plan was
 * made about, so a plan committed late changes nothing that moved since.
 *
 * @returns What was done — `ignored` also when the episode moved after the plan
 */
export function commitWaitingObservation(plan: WaitingObservationPlan): ObservationAction {
  const obs = plan.observation;
  const parts: EpisodeKeyParts = { worktreeId: obs.worktreeId, cliToolId: obs.cliToolId, instanceId: obs.instanceId };
  try {
    switch (plan.action) {
      case 'kept':
        if (plan.episodeId === null || obs.reading.kind !== 'waiting') return 'ignored';
        return updateEpisodeKind(parts, plan.episodeId, obs.reading.waitingKind) ? 'kept' : 'ignored';
      case 'opened':
        if (plan.next === null || getWaitingEpisodeRecord(obs.worktreeId, obs.cliToolId, obs.instanceId) !== null) {
          return 'ignored';
        }
        openEpisode(parts, plan.next, plan.at);
        return 'opened';
      case 'replaced':
        if (plan.next === null || plan.episodeId === null || plan.closeReason === null) return 'ignored';
        return replaceEpisode(parts, plan.episodeId, plan.next, plan.closeReason, plan.at) !== null
          ? 'replaced'
          : 'ignored';
      case 'rebound':
        if (plan.binding === null || plan.episodeId === null) return 'ignored';
        return rebindEpisode(parts, plan.episodeId, plan.binding, plan.at) ? 'rebound' : 'ignored';
      case 'closed':
        if (plan.episodeId === null || plan.closeReason === null) return 'ignored';
        return closeEpisode(parts, plan.episodeId, plan.closeReason, plan.at) ? 'closed' : 'ignored';
      case 'ignored':
        if (plan.ignoredBecause === 'version' || plan.ignoredBecause === 'stale-frame' || plan.ignoredBecause === 'generation') {
          logger.debug('waiting-observation-ignored', {
            worktreeId: obs.worktreeId,
            instanceId: obs.instanceId ?? obs.cliToolId,
            observer: obs.observer,
            reading: obs.reading.kind,
            because: plan.ignoredBecause,
          });
        }
        return 'ignored';
      default:
        plan.action satisfies never;
        return 'ignored';
    }
  } catch (error) {
    logger.warn('waiting-observation-failed', {
      worktreeId: obs.worktreeId,
      instanceId: obs.instanceId ?? obs.cliToolId,
      observer: obs.observer,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'ignored';
  }
}

/** {@link planWaitingObservation} and {@link commitWaitingObservation} in one step; the plan with what was done. */
export function observeWaiting(obs: WaitingObservation): WaitingObservationPlan {
  const plan = planWaitingObservation(obs);
  const action = commitWaitingObservation(plan);
  return action === plan.action ? plan : { ...plan, action };
}

// =============================================================================
// claude-done (design 規則 6)
// =============================================================================

/** What `claude-done` decided about when it arrived. */
export interface LegacyStopTarget {
  generation: GenerationRef;
  episodeId: WaitingEpisodeId | null;
}

/**
 * Fix the episode a legacy (`claude-done`) stop is about, before its first
 * capture `await` (design 規則 6). The body read before it cannot be helped: the
 * worktree id is in the body — a known limit (design §8).
 */
export function captureLegacyStopTarget(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): LegacyStopTarget {
  const parts = { worktreeId, cliToolId, instanceId };
  return {
    generation: generationOf(parts),
    episodeId: getWaitingEpisodeRecord(worktreeId, cliToolId, instanceId)?.episodeId ?? null,
  };
}

export type LegacyStopSettlement = 'closed' | 'target-gone' | 'hook-authority' | 'screen' | 'nothing-open';

/**
 * Close the episode a legacy stop was fixed on, if it is still the open one
 * (design 規則 6). Nothing when the hook reported a stop in this generation
 * (the hook speaks for the end of turns; closing again is the double close the
 * rule forbids), when another episode opened meanwhile, or for a screen only a
 * person drives.
 *
 * @param at - Epoch ms; defaults to now
 */
export function settleLegacyStop(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  target: LegacyStopTarget,
  at: number = Date.now()
): LegacyStopSettlement {
  try {
    const parts = { worktreeId, cliToolId, instanceId };
    const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
    const episode = getWaitingEpisodeRecord(worktreeId, cliToolId, instanceId);
    if (episode === null) return 'nothing-open';
    const current = generationOf(parts);
    if (
      target.episodeId === null ||
      episode.episodeId !== target.episodeId ||
      !sameGeneration(target.generation, current)
    ) {
      return 'target-gone';
    }
    const hookStop = hookStopGeneration.get(key);
    if (hookStop !== undefined && sameGeneration(hookStop, current)) return 'hook-authority';
    if (episode.binding.kind === 'screen') return 'screen';
    return closeEpisode(parts, episode.episodeId, 'legacy-stop', at) ? 'closed' : 'target-gone';
  } catch (error) {
    logger.warn('waiting-episode-legacy-stop-failed', {
      worktreeId,
      instanceId: instanceId ?? cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'nothing-open';
  }
}

/** Forget the hook-stop marks. Test seam, called by `clearAgentStopEvents`. */
export function clearWaitingEpisodeBindingState(): void {
  hookStopGeneration.clear();
}

registerEpisodeBindingResolver(resolveEpisodeBinding);
registerTurnOutcomeSink((parts, outcomes) => {
  applyTurnOutcomesToEpisode(parts, outcomes);
});
