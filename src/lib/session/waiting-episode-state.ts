/**
 * When each agent instance started waiting, and the one place that edge is
 * observed (Issue #1786).
 *
 * `isWaitingForResponse` is a level, and every question the display Issues ask
 * is about the *edge*: #1787 wants "waiting for how long", #1788 wants to push a
 * WebSocket frame the instant it flips, #1790 wants to fire a push notification
 * on the same instant and not on the 200 polls that follow. A level cannot
 * answer any of those, and three surfaces each keeping their own "was it waiting
 * last time?" would be three chances to disagree about when a wait began.
 *
 * So the edge is detected exactly once, here, by {@link observeWaitingEdge}, and
 * everything else either reads {@link getWaitingEpisode} or subscribes with
 * {@link onWaitingTransition}. The observers are `worktree-status-helper`, on
 * the list API's per-instance probe — it passes the *composed* verdict (scraper
 * OR structured), so a wait that only the agent's own events can see opens an
 * episode exactly like one the screen scraper read — and `response-checker`
 * (#1790), which opens the episode for a prompt it saved and closes it when it
 * records a reply.
 *
 * Issue #3798 added the agent's own turn transitions as closers: a `stop` that
 * ended the turn an episode belongs to closes it in the same synchronous step
 * that records the stop (`waiting-episode-binding`), so a tool whose reply
 * arrives on a hook closes its wait with no browser open. That needs each
 * episode to carry an identity and the turn it belongs to; see "identity and
 * attribution" below.
 *
 * ## Where #1788 / #1790 plug in
 *
 * `onWaitingTransition(listener)` — the listener receives every false→true and
 * true→false crossing, with the instance it belongs to, the episode's `since`
 * and its {@link WaitingKind}. #1788 broadcasts it (`broadcastToWorktree`),
 * #1790 decides whether to send a push. Neither needs to touch this module's
 * internals, and neither can move the timestamps the other reports.
 *
 * Listeners are called synchronously, inside the request that observed the edge,
 * because the point of the seam is immediacy. A listener that throws is
 * contained: this store is on the list API's hot path, and a broken notification
 * sink must not take the status read down with it.
 *
 * In-memory (via `globalThis`, per Issue #1736 — see the note in
 * `agent-event-state`) rather than SQLite, for the same reason the structured
 * state is: it describes a live tmux session, and a wait does not outlive the
 * server process that observed it.
 *
 * @module lib/session/waiting-episode-state
 */

import { buildCompositeKey, COMPOSITE_KEY_SEPARATOR } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import type { WaitingKind } from '@/lib/session/waiting-kind';
import { getOrInitGlobal } from '../global-state';

const logger = createLogger('waiting-episode-state');

/**
 * Reached through `globalThis` and not through the module scope, for the reason
 * spelled out at length in `agent-event-state`: under `next dev` each route
 * handler is bundled separately, and a module-scoped `Map` would give the writer
 * and the reader one map each — a failure that produces no error and no warning,
 * only a field that is always null.
 */
declare global {
  // eslint-disable-next-line no-var
  var __sessionWaitingEpisodes: Map<string, WaitingEpisode> | undefined;
  // eslint-disable-next-line no-var
  var __sessionWaitingTransitionListeners: Set<WaitingTransitionListener> | undefined;
  // eslint-disable-next-line no-var
  var __sessionWaitingEpisodeMeta: WeakMap<WaitingEpisode, WaitingEpisodeMeta> | undefined;
  // eslint-disable-next-line no-var
  var __sessionWaitingEpisodeVersions: Map<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __sessionWaitingEpisodeLastClosed: Map<string, LastClosedEpisode> | undefined;
  // eslint-disable-next-line no-var
  var __sessionWaitingEpisodeSeq: { value: number; nonce: string } | undefined;
  // eslint-disable-next-line no-var
  var __sessionWaitingEpisodeListeners: Set<WaitingEpisodeTransitionListener> | undefined;
  // eslint-disable-next-line no-var
  var __sessionWaitingEpisodeBindingResolver: EpisodeBindingResolver | undefined;
}

/** compositeKey -> the wait currently in progress for that instance. */
const episodes = getOrInitGlobal('__sessionWaitingEpisodes', () => new Map<string, WaitingEpisode>());

/** Subscribers to the edge. See the module docblock. */
const listeners = getOrInitGlobal('__sessionWaitingTransitionListeners', () => new Set<WaitingTransitionListener>());

/** One uninterrupted stretch of waiting by one agent instance. */
export interface WaitingEpisode {
  /**
   * Epoch ms the wait began.
   *
   * Fixed when the episode opens and never moved while it lasts — a value that
   * crept forward on every poll would make "waiting for 12 minutes" unreadable,
   * which is the whole reason #1787 asked for it.
   */
  since: number;
  /** The most recent classification of this wait. May change mid-episode. */
  kind: WaitingKind | null;
}

// =============================================================================
// Issue #3798: identity and attribution
// =============================================================================
//
// `since` is a time, and two waits can share one (the same millisecond, or a
// structured `at` reused by the next prompt). Everything that has to tell one
// wait from another — the turn transition that ends it, a closer that comes
// back from an `await`, the push gate's hold — needs an identity that is not a
// time, and needs to know which turn the wait belongs to. That is kept here,
// beside the episode and not on it: `getWaitingEpisode` and the transition the
// listeners receive keep the shape #1786 published (the suites compare them
// whole), and the new facts are read through `getWaitingEpisodeRecord` and
// `onWaitingEpisodeTransition`. Design: `docs/design/issue-3798-waiting-episode.md`.

/** Unique within the process; carries no time (Issue #3798). */
export type WaitingEpisodeId = string;

/** The generation an episode belongs to. "None opened" is not spelled null. */
export type GenerationRef = { kind: 'opened'; at: number } | { kind: 'none' };

/** Which wait the episode opened as (design §2.2). */
export type EpisodeBinding =
  /** A wait inside turn `turnId`; that turn's end may close it. */
  | { kind: 'turn'; generation: GenerationRef; turnId: string }
  /** A dialog the agent reported before any turn was open (a dialog-only record with live decisions). */
  | { kind: 'dialog-only'; generation: GenerationRef; recordTurnId: string; sessionId: string | null }
  /** Seen with no open turn and no dialog record; `lastClosedTurnId` is what had last ended then. */
  | { kind: 'unattributed'; generation: GenerationRef; lastClosedTurnId: string | null }
  /** A screen only a person drives (survey, picker, trust). Not ended by a turn's end. */
  | { kind: 'screen'; generation: GenerationRef; originTurnId: string | null };

/** Who opened an episode. `legacy-edge` is `observeWaitingEdge`, whose caller is not named. */
export type WaitingObserver =
  | 'status-probe'
  | 'response-checker'
  | 'auto-yes-poller'
  | 'turn-transition'
  | 'legacy-stop'
  | 'legacy-edge';

export type WaitingCloseReason =
  | 'turn-stop'
  | 'turn-session-end'
  | 'turn-superseded'
  | 'decision-settled'
  | 'generation'
  | 'screen-cleared'
  | 'session-gone'
  | 'response-recorded'
  | 'poller-answered'
  | 'legacy-stop';

/** The facts an episode carries besides `since` and `kind`. */
interface WaitingEpisodeMeta {
  episodeId: WaitingEpisodeId;
  /** When the episode was opened (or put in place by a replacement). */
  openedAt: number;
  /** When `binding` last changed; `openedAt` until a rebind. */
  boundAt: number;
  binding: EpisodeBinding;
  openedBy: WaitingObserver;
  promptScreenKey: string | null;
}

/** An open episode with everything known about it. A snapshot: writing to it changes nothing. */
export interface WaitingEpisodeRecord extends WaitingEpisode, WaitingEpisodeMeta {}

/** The last episode that ended for one instance (closed, or replaced). */
export interface LastClosedEpisode {
  at: number;
  promptScreenKey: string | null;
}

/** compositeKey parts, as every write takes them. */
export interface EpisodeKeyParts {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** The agent instance; undefined/`cliToolId` both mean the primary. */
  instanceId?: string;
}

/** A crossing with its identity — what `onWaitingEpisodeTransition` delivers. */
export interface WaitingEpisodeTransition extends WaitingTransition {
  cause: 'opened' | 'closed' | 'replaced';
  /** The episode now open (opened / replaced), or null (closed). */
  episodeId: WaitingEpisodeId | null;
  /** The episode that ended (closed / replaced), or null (opened). */
  previousEpisodeId: WaitingEpisodeId | null;
  closeReason: WaitingCloseReason | null;
}

export type WaitingEpisodeTransitionListener = (transition: WaitingEpisodeTransition) => void;

/**
 * Decides the binding of an episode `observeWaitingEdge` opens. Registered by
 * `waiting-episode-binding`, which reads the turn model; this module imports
 * neither, so the store stays a leaf of the graph.
 */
export type EpisodeBindingResolver = (parts: EpisodeKeyParts, at: number) => EpisodeBinding;

const metas = getOrInitGlobal('__sessionWaitingEpisodeMeta', () => new WeakMap<WaitingEpisode, WaitingEpisodeMeta>());
const versions = getOrInitGlobal('__sessionWaitingEpisodeVersions', () => new Map<string, number>());
const lastClosed = getOrInitGlobal('__sessionWaitingEpisodeLastClosed', () => new Map<string, LastClosedEpisode>());
const episodeSeq = getOrInitGlobal('__sessionWaitingEpisodeSeq', () => ({
  value: 0,
  nonce: Math.random().toString(36).slice(2, 10),
}));
const episodeListeners = getOrInitGlobal(
  '__sessionWaitingEpisodeListeners',
  () => new Set<WaitingEpisodeTransitionListener>()
);

/** The binding used when no resolver is registered: nothing is known. */
const UNKNOWN_BINDING: EpisodeBinding = {
  kind: 'unattributed',
  generation: { kind: 'none' },
  lastClosedTurnId: null,
};

function nextEpisodeId(): WaitingEpisodeId {
  episodeSeq.value += 1;
  return `wep-${episodeSeq.nonce}-${episodeSeq.value}`;
}

function keyOf(parts: EpisodeKeyParts): string {
  return buildCompositeKey(parts.worktreeId, parts.cliToolId, parts.instanceId);
}

function bumpVersion(key: string): void {
  versions.set(key, (versions.get(key) ?? 0) + 1);
}

/** A crossing of the waiting edge, handed to every listener. */
export interface WaitingTransition {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** The agent instance; undefined/`cliToolId` both mean the primary. */
  instanceId: string | undefined;
  /** Which way it crossed: true = the wait began, false = it ended. */
  waiting: boolean;
  /** The episode's start, or null when the wait just ended. */
  since: number | null;
  /** The episode's kind, or null when the wait just ended. */
  kind: WaitingKind | null;
  /** Epoch ms the crossing was observed. */
  at: number;
}

export type WaitingTransitionListener = (transition: WaitingTransition) => void;

/**
 * Subscribe to waiting edges.
 *
 * @returns An unsubscribe function. Idempotent — calling it twice is harmless.
 */
export function onWaitingTransition(listener: WaitingTransitionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribe to waiting edges with the episode's identity (Issue #3798).
 *
 * The same crossings `onWaitingTransition` delivers, in the same order, with
 * the cause, the episode ids and the close reason added.
 */
export function onWaitingEpisodeTransition(listener: WaitingEpisodeTransitionListener): () => void {
  episodeListeners.add(listener);
  return () => {
    episodeListeners.delete(listener);
  };
}

/** Notify subscribers, containing anything they throw. */
function emit(transition: WaitingEpisodeTransition): void {
  const { cause: _cause, episodeId: _id, previousEpisodeId: _prev, closeReason: _reason, ...plain } = transition;
  for (const listener of listeners) {
    try {
      listener(plain);
    } catch (error) {
      logListenerFailure(transition, error);
    }
  }
  for (const listener of episodeListeners) {
    try {
      listener(transition);
    } catch (error) {
      logListenerFailure(transition, error);
    }
  }
}

function logListenerFailure(transition: WaitingTransition, error: unknown): void {
  logger.error('waiting-transition-listener-failed', {
    worktreeId: transition.worktreeId,
    cliToolId: transition.cliToolId,
    instanceId: transition.instanceId ?? transition.cliToolId,
    waiting: transition.waiting,
    error: error instanceof Error ? error.message : String(error),
  });
}

/** What a new episode opens with. */
export interface NewEpisode {
  since: number;
  kind: WaitingKind | null;
  binding: EpisodeBinding;
  openedBy: WaitingObserver;
  promptScreenKey?: string | null;
}

/**
 * Open an episode (Issue #3798). Low-level: the caller has decided there is
 * none open and what it is bound to. Emits the opening edge.
 */
export function openEpisode(parts: EpisodeKeyParts, next: NewEpisode, at: number): WaitingEpisodeRecord {
  const key = keyOf(parts);
  const view: WaitingEpisode = { since: next.since, kind: next.kind };
  const meta: WaitingEpisodeMeta = {
    episodeId: nextEpisodeId(),
    openedAt: at,
    boundAt: at,
    binding: next.binding,
    openedBy: next.openedBy,
    promptScreenKey: next.promptScreenKey ?? null,
  };
  episodes.set(key, view);
  metas.set(view, meta);
  bumpVersion(key);
  emit({
    worktreeId: parts.worktreeId,
    cliToolId: parts.cliToolId,
    instanceId: parts.instanceId,
    waiting: true,
    since: view.since,
    kind: view.kind,
    at,
    cause: 'opened',
    episodeId: meta.episodeId,
    previousEpisodeId: null,
    closeReason: null,
  });
  return { ...view, ...meta };
}

/**
 * Close the open episode when it is still `expectedId` (Issue #3798). A closer
 * that names the episode it decided about cannot close a later one.
 *
 * @returns Whether an episode was closed
 */
export function closeEpisode(
  parts: EpisodeKeyParts,
  expectedId: WaitingEpisodeId,
  reason: WaitingCloseReason,
  at: number
): boolean {
  const key = keyOf(parts);
  const view = episodes.get(key);
  if (view === undefined) return false;
  const meta = metaOf(view);
  if (meta.episodeId !== expectedId) return false;
  episodes.delete(key);
  lastClosed.set(key, { at, promptScreenKey: meta.promptScreenKey });
  bumpVersion(key);
  emit({
    worktreeId: parts.worktreeId,
    cliToolId: parts.cliToolId,
    instanceId: parts.instanceId,
    waiting: false,
    since: null,
    kind: null,
    at,
    cause: 'closed',
    episodeId: null,
    previousEpisodeId: meta.episodeId,
    closeReason: reason,
  });
  return true;
}

/**
 * Put a new episode in place of `expectedId` as one operation (Issue #3798):
 * listeners hear a single opening edge for the new wait and no closing one
 * in between, so nothing reports "nobody is waiting" mid-swap.
 *
 * @returns The new episode, or null when `expectedId` is no longer open
 */
export function replaceEpisode(
  parts: EpisodeKeyParts,
  expectedId: WaitingEpisodeId,
  next: NewEpisode,
  reason: WaitingCloseReason,
  at: number
): WaitingEpisodeRecord | null {
  const key = keyOf(parts);
  const old = episodes.get(key);
  if (old === undefined) return null;
  const oldMeta = metaOf(old);
  if (oldMeta.episodeId !== expectedId) return null;
  lastClosed.set(key, { at, promptScreenKey: oldMeta.promptScreenKey });
  const view: WaitingEpisode = { since: next.since, kind: next.kind };
  const meta: WaitingEpisodeMeta = {
    episodeId: nextEpisodeId(),
    openedAt: at,
    boundAt: at,
    binding: next.binding,
    openedBy: next.openedBy,
    promptScreenKey: next.promptScreenKey ?? null,
  };
  episodes.set(key, view);
  metas.set(view, meta);
  bumpVersion(key);
  emit({
    worktreeId: parts.worktreeId,
    cliToolId: parts.cliToolId,
    instanceId: parts.instanceId,
    waiting: true,
    since: view.since,
    kind: view.kind,
    at,
    cause: 'replaced',
    episodeId: meta.episodeId,
    previousEpisodeId: oldMeta.episodeId,
    closeReason: reason,
  });
  return { ...view, ...meta };
}

/**
 * Change what the open episode `expectedId` is bound to (Issue #3798). Not an
 * edge: the wait goes on, so nothing is emitted and `since` stays.
 *
 * @returns Whether the episode was rebound
 */
export function rebindEpisode(
  parts: EpisodeKeyParts,
  expectedId: WaitingEpisodeId,
  binding: EpisodeBinding,
  at: number
): boolean {
  const key = keyOf(parts);
  const view = episodes.get(key);
  if (view === undefined) return false;
  const meta = metaOf(view);
  if (meta.episodeId !== expectedId) return false;
  meta.binding = binding;
  meta.boundAt = at;
  bumpVersion(key);
  return true;
}

/**
 * The meta of an episode in the map. An episode put there without one (a test
 * that wrote the map directly) is given an unattributed identity on first read.
 */
function metaOf(view: WaitingEpisode): WaitingEpisodeMeta {
  let meta = metas.get(view);
  if (meta === undefined) {
    meta = {
      episodeId: nextEpisodeId(),
      openedAt: view.since,
      boundAt: view.since,
      binding: UNKNOWN_BINDING,
      openedBy: 'legacy-edge',
      promptScreenKey: null,
    };
    metas.set(view, meta);
  }
  return meta;
}

/** The open episode with its identity and binding, or null (Issue #3798). */
export function getWaitingEpisodeRecord(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): WaitingEpisodeRecord | null {
  const view = episodes.get(buildCompositeKey(worktreeId, cliToolId, instanceId));
  if (view === undefined) return null;
  const meta = metaOf(view);
  return { since: view.since, kind: view.kind, ...meta, binding: meta.binding };
}

/** The instance's episode version: it moves on every open, close, replacement and rebind. */
export function getEpisodeVersion(worktreeId: string, cliToolId: CLIToolType, instanceId?: string): number {
  return versions.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? 0;
}

/** The last episode that ended for this instance, or null. */
export function getLastClosedEpisode(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): LastClosedEpisode | null {
  return lastClosed.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/** Install the binding resolver `observeWaitingEdge` uses. The last one wins. */
export function registerEpisodeBindingResolver(resolver: EpisodeBindingResolver): void {
  globalThis.__sessionWaitingEpisodeBindingResolver = resolver;
}

function resolveBinding(parts: EpisodeKeyParts, at: number): EpisodeBinding {
  const resolver = globalThis.__sessionWaitingEpisodeBindingResolver;
  if (resolver === undefined) return UNKNOWN_BINDING;
  try {
    return resolver(parts, at);
  } catch (error) {
    logger.warn('waiting-episode-binding-resolve-failed', {
      worktreeId: parts.worktreeId,
      cliToolId: parts.cliToolId,
      instanceId: parts.instanceId ?? parts.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return UNKNOWN_BINDING;
  }
}

export interface ObserveWaitingEdgeParams {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
  /** The composed verdict for this poll — scraper OR structured. */
  waiting: boolean;
  /** This poll's classification, or null. */
  kind?: WaitingKind | null;
  /**
   * The structured episode's own start, when one exists.
   *
   * Preferred over the observation time when an episode opens, because it is
   * when the human was actually blocked: the agent posts the event the moment
   * the dialog is drawn, while the scraper reads the pane through a 5 s capture
   * cache on a poll of its own. Only consulted at the edge — once an episode is
   * open its `since` is frozen.
   */
  structuredSince?: number | null;
  /** Epoch ms; defaults to now. */
  now?: number;
}

/**
 * Record this poll's waiting verdict and answer when the current wait began.
 *
 * The single writer of the edge, by design (Issue #1786). Idempotent for a
 * level that has not changed: repeated `waiting: true` polls return the same
 * `since` and emit nothing, so a listener hears one event per wait rather than
 * one per poll.
 *
 * Issue #3798: an episode opened here is bound by the registered resolver
 * (`waiting-episode-binding`), so the turn transitions can end it.
 *
 * @returns The episode's `since` while waiting, or null when it is not.
 */
export function observeWaitingEdge({
  worktreeId,
  cliToolId,
  instanceId,
  waiting,
  kind = null,
  structuredSince = null,
  now = Date.now(),
}: ObserveWaitingEdgeParams): number | null {
  const parts: EpisodeKeyParts = { worktreeId, cliToolId, instanceId };
  const key = keyOf(parts);
  const existing = episodes.get(key);

  if (!waiting) {
    if (existing === undefined) return null;
    closeEpisode(parts, metaOf(existing).episodeId, 'screen-cleared', now);
    return null;
  }

  if (existing !== undefined) {
    // A wait can change character without ending — a permission dialog answered
    // into a selection list is still one uninterrupted wait — so the kind is
    // refreshed while `since` stays put.
    existing.kind = kind;
    return existing.since;
  }

  const since = structuredSince ?? now;
  openEpisode(parts, { since, kind, binding: resolveBinding(parts, now), openedBy: 'legacy-edge' }, now);
  return since;
}

/**
 * @returns The wait in progress for this instance, or null when it is not
 *   waiting. Read-only: observing the edge is {@link observeWaitingEdge}'s job.
 */
export function getWaitingEpisode(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): WaitingEpisode | null {
  return episodes.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * Whether **any** instance in this worktree is still waiting (Issue #2001).
 *
 * The cross-device dismissal is keyed on the worktree, because that is what the
 * Service Worker `tag` names (`<worktreeId>:prompt`, `push-sender`): two agent
 * instances waiting in one worktree share a single notification card on the
 * phone. So one instance crossing the closing edge is not on its own a reason
 * to clear that card — the card is still telling the truth until the last of
 * them has been answered.
 *
 * The prefix test is exact rather than heuristic: `buildCompositeKey` puts the
 * worktree id first and rejects a worktree id containing
 * {@link COMPOSITE_KEY_SEPARATOR}, so no other worktree's key can start with
 * `<worktreeId>:`.
 */
export function hasOpenWaitingEpisode(worktreeId: string): boolean {
  const prefix = `${worktreeId}${COMPOSITE_KEY_SEPARATOR}`;
  for (const key of episodes.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Drop every episode. Test seam.
 *
 * CI runs with `fileParallelism: false`, so one process holds this map for the
 * whole suite: a test that opens an episode and does not clear it hands the next
 * file a session that is already waiting.
 */
export function clearWaitingEpisodes(): void {
  episodes.clear();
  versions.clear();
  lastClosed.clear();
}

/** Drop every subscriber. Test seam, paired with {@link clearWaitingEpisodes}. */
export function clearWaitingTransitionListeners(): void {
  listeners.clear();
  episodeListeners.clear();
}
