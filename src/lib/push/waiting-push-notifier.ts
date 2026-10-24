/**
 * Send a push notification when an agent starts waiting, and one reminder if it
 * is still waiting later (Issue #1790).
 *
 * ## Why this subscribes rather than detects
 *
 * The prompt notification used to be raised from one line inside the response
 * poller, which made it inherit every one of that poller's boundaries: it only
 * runs when a send-family API or Auto-Yes started it, it stops itself on the
 * first prompt of a turn, it gives up after `MAX_POLLING_DURATION`, and it can
 * only see waits the screen scraper classified as `isPrompt`. A wait that began
 * after a `tmux` keystroke, a second prompt in the same turn, a wait that only
 * the agent's own hook events reported, and a selection list were all silently
 * unnotifiable.
 *
 * #1786 made the waiting edge observable exactly once, in
 * `waiting-episode-state`, and #1788 already subscribes to it for the WebSocket
 * frame. This module is the same subscription for push — it captures no pane,
 * runs no detector, and keeps no "was it waiting last time?" of its own.
 *
 * ## The poller still notifies, and that is deliberate
 *
 * Contrary to the Issue's premise, the edge is *not* observed by a background
 * process: when #1790 was written, `observeWaitingEdge`'s only caller was
 * `worktree-status-helper`, on the worktree list / detail API probe (Issue
 * #3798 added the agent's own turn transitions as closers, not as openers). So
 * the edge fires when a client is
 * looking, and moving push onto it *alone* would have swapped one blind spot
 * (no poller) for a worse one (nobody has the app open — the very situation a
 * phone notification is for). The poller therefore keeps its call, and
 * `response-checker` opens the same episode through `observeWaitingEdge` so both
 * producers name the wait identically; `shouldSendWaitingPush` then collapses
 * them to one notification. See the commit message for the measurement.
 *
 * ## Escalation
 *
 * There is no existing server-side sweep over waiting sessions to ride on, so
 * this keeps a small interval of its own. It exists only while some wait is
 * outstanding — created on the first open episode, cleared when the last one
 * closes — so an install with nothing waiting has no timer, and one that never
 * configured VAPID never even gets that far.
 *
 * ## Holding a wait that has not named itself
 *
 * The edge fires once, and for a dialog drawn between two probes it fires
 * before anything on the pane can be classified — so #2156's `AskUserQuestion`
 * arrived here as `unclassified` and was announced as "check the terminal"
 * although the app could answer it. The kind is refreshed in place afterwards
 * and that refresh is deliberately not an edge, so the fix is on this side:
 * an unnamed wait is held for {@link CLASSIFICATION_GRACE_MS} and then sent
 * under whatever the episode is called at that point. One notification either
 * way — no correction push, and nothing at all if the wait ended meanwhile.
 *
 * ## Which wait is which (Issue #3798)
 *
 * A wait is its episode's id, not its `since`: two waits can share a `since`,
 * and the episode store can put a new wait in place of an old one in one step
 * (`replaced`). So this subscribes with `onWaitingEpisodeTransition`, which
 * says which of the three happened, and every re-read of the store — the end of
 * a classification hold, the end of an Auto-Yes hold, the reminder — compares
 * the id it reads with `getWaitingEpisodeRecord`. A replacement drops the old
 * wait's timers and hold and starts the new wait's from scratch, and sends no
 * resolution: nobody stopped waiting. A pending wait that came without an id
 * (a test driving {@link handleWaitingTransition} with the #1786 shape) is
 * compared by `since`, as before.
 *
 * Everything here is advisory: a failure must not disturb the status read that
 * observed the edge (`emit` contains listener throws) nor the poller.
 *
 * @module lib/push/waiting-push-notifier
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { createLogger } from '@/lib/logger';
import {
  getWaitingEpisodeRecord,
  onWaitingEpisodeTransition,
  type WaitingEpisodeRecord,
  type WaitingEpisodeTransition,
  type WaitingTransition,
} from '@/lib/session/waiting-episode-state';
import type { WaitingKind } from '@/lib/session/waiting-kind';
import { getPushEscalationSettings } from './escalation-settings';
import {
  AUTO_YES_ANSWER_GRACE_MS,
  autoYesHoldEndsAt,
  forgetAutoYesHold,
  decideAndLogPromptPush,
  isPromptPushSuppressed,
  isSameWait,
} from './prompt-push-gate';
import { notifyPushSubscribers } from './push-sender';
import { notifyPromptResolved } from './resolution-push-notifier';
import { isPushConfigured } from './vapid';
import { getOrInitGlobal } from '../global-state';

const logger = createLogger('push/waiting-notifier');

/** How often outstanding waits are re-checked. Minute granularity is enough. */
export const ESCALATION_TICK_MS = 60_000;

/**
 * How long a wait that has not named itself yet is held before it notifies
 * (Issue #2156).
 *
 * `AskUserQuestion` opens the episode before the pane carries anything the
 * screen scraper can read, so the *first* classification of that wait is
 * `unclassified` and the body would say "check the terminal" about a dialog the
 * app can answer. `waiting-episode-state` refreshes the kind in place on the
 * next probe and deliberately emits nothing for it (a wait that changes
 * character is still one wait), so the notifier only ever saw the provisional
 * verdict.
 *
 * Measured on the session in the Issue: the edge opened at 00:08:38.837 with no
 * usable classification and the next status probe refined it to `prompt` at
 * 00:08:44.863 — 6.03 s later; 8 s is that measurement plus one probe's jitter
 * and nothing more, because the hold is silence on the phone and it is meant to
 * buy exactly one reclassification.
 *
 * Only an unnamed wait pays it: `prompt` and `menu` are positive verdicts and
 * still notify on the edge itself.
 */
export const CLASSIFICATION_GRACE_MS = 8_000;

/** A wait that has been notified once and may still earn its reminder. */
interface PendingWait {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string | undefined;
  since: number;
  /** The episode's id (Issue #3798), or null when the edge did not carry one. */
  episodeId: string | null;
  kind: WaitingKind | null;
}

/**
 * The open episode, when it is still `wait` (Issue #3798): the same id, or —
 * for a wait that came without one — the same `since`. Null when the wait is
 * over or another one is open.
 */
function currentEpisodeOf(wait: PendingWait): WaitingEpisodeRecord | null {
  const episode = getWaitingEpisodeRecord(wait.worktreeId, wait.cliToolId, wait.instanceId);
  if (episode === null) return null;
  return isSameWait(episode, wait) ? episode : null;
}

/**
 * Reached through `globalThis` for the reason #1736 documented: under
 * `next dev` a module-scoped value is per-bundle, so a second copy of this
 * module would register a second listener and every wait would notify twice.
 */
declare global {
  // eslint-disable-next-line no-var
  var __waitingPushUnsubscribe: (() => void) | undefined;
  // eslint-disable-next-line no-var
  var __waitingPushPending: Map<string, PendingWait> | undefined;
  // eslint-disable-next-line no-var
  var __waitingPushEscalationTimer: ReturnType<typeof setInterval> | undefined;
  // eslint-disable-next-line no-var
  var __waitingPushGraceTimers: Map<string, ReturnType<typeof setTimeout>> | undefined;
  // eslint-disable-next-line no-var
  var __waitingPushAnswerGraceTimers: Map<string, ReturnType<typeof setTimeout>> | undefined;
}

const pending = getOrInitGlobal('__waitingPushPending', () => new Map<string, PendingWait>());

/** Composite key -> the timer holding that wait's first notification (#2156). */
const graceTimers = getOrInitGlobal('__waitingPushGraceTimers', () => new Map<string, ReturnType<typeof setTimeout>>());

/**
 * Composite key -> the timer that asks the gate again when its
 * `auto-yes-answering` hold ends (Issue #3757). Apart from {@link graceTimers}:
 * that one is the classification hold of #2156, this one the Auto-Yes hold.
 */
const answerGraceTimers = getOrInitGlobal(
  '__waitingPushAnswerGraceTimers',
  () => new Map<string, ReturnType<typeof setTimeout>>(),
);

/**
 * The worktree's display name, for the notification title.
 *
 * Falls back to the id rather than dropping the notification: a database that
 * cannot answer is a reason to send a less readable title, not a reason to
 * leave the user waiting in silence.
 */
function resolveWorktreeName(worktreeId: string): string {
  try {
    return getWorktreeById(getDbInstance(), worktreeId)?.name ?? worktreeId;
  } catch {
    return worktreeId;
  }
}

/** Fan one waiting notification out. Never throws. */
async function sendWaitingPush(
  wait: PendingWait,
  escalated: boolean,
  now: number
): Promise<void> {
  const instanceId = wait.instanceId ?? wait.cliToolId;
  try {
    await notifyPushSubscribers(
      {
        worktreeId: wait.worktreeId,
        worktreeName: resolveWorktreeName(wait.worktreeId),
        kind: 'prompt',
        agentName: instanceId,
        instanceId,
        waitingKind: wait.kind,
        waitingSince: wait.since,
        waitingEpisodeId: wait.episodeId,
        escalated,
      },
      // The deciding tick's clock, not a fresh reading: the reminder's body
      // quotes the elapsed time this call was made on.
      now
    );
  } catch (error) {
    logger.warn('waiting-push-failed', {
      worktreeId: wait.worktreeId,
      instanceId,
      escalated,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Whether this classification is still provisional (Issue #2156).
 *
 * `unclassified` is what `deriveWaitingKind` returns for a frame the scraper
 * could not read at all, and a null kind is the same admission from a producer
 * that passed none — both mean "waiting, but nobody has said what for" and both
 * are the verdict that arrives first when a dialog is drawn between two probes.
 * `prompt` and `menu` are positive readings of the pane and are taken at once.
 */
function isUnnamedWait(kind: WaitingKind | null | undefined): boolean {
  return kind === null || kind === undefined || kind === 'unclassified';
}

/** Drop the hold on this wait without sending anything. */
function cancelGrace(key: string): void {
  const timer = graceTimers.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    graceTimers.delete(key);
  }
  const answerTimer = answerGraceTimers.get(key);
  if (answerTimer !== undefined) {
    clearTimeout(answerTimer);
    answerGraceTimers.delete(key);
  }
}

/**
 * The Auto-Yes gate, then the fan-out.
 *
 * In that order because `shouldSendWaitingPush` records the episode at the
 * moment it decides to send, so a notification dropped after the fan-out began
 * would still consume the episode's one slot — see `prompt-push-gate`.
 */
function gateAndSend(wait: PendingWait, now: number, recheck = false): void {
  const decision = decideAndLogPromptPush(
    {
      worktreeId: wait.worktreeId,
      cliToolId: wait.cliToolId,
      instanceId: wait.instanceId,
      waitingSince: wait.since,
      waitingEpisodeId: wait.episodeId,
      now,
    },
    { recheck },
  );
  if (decision.suppress) {
    // Issue #3757: "Auto-Yes is answering" is a hold, not a verdict. Ask again
    // when it ends; a wait Auto-Yes did answer is gone from the episode store
    // by then and nothing is sent.
    if (decision.reason === 'auto-yes-answering') holdForAutoYesAnswer(wait, now);
    return;
  }

  void sendWaitingPush(wait, false, now);
}

/**
 * Re-ask the gate for this wait when its `auto-yes-answering` hold ends
 * (Issue #3757). The edge fires once, so without this a wait Auto-Yes never
 * answered — a screen the poller cannot read and records nothing about — stayed
 * silent until the escalation reminder, ten minutes later.
 */
function holdForAutoYesAnswer(wait: PendingWait, now: number): void {
  const key = buildCompositeKey(wait.worktreeId, wait.cliToolId, wait.instanceId);
  const existing = answerGraceTimers.get(key);
  if (existing !== undefined) clearTimeout(existing);
  // From the gate's own origin, not `since` (Issue #3757 review), and past the
  // poller's session-wait tick (Issue #3791). Capped at the grace, so a clock
  // that went backwards cannot arm an overflowing timer, and a longer hold is
  // asked about again every grace: a poller stopped meanwhile ends it then
  // rather than at a tick that will not come.
  const holdEndsAt = autoYesHoldEndsAt(
    {
      worktreeId: wait.worktreeId,
      cliToolId: wait.cliToolId,
      instanceId: wait.instanceId,
      waitingSince: wait.since,
      waitingEpisodeId: wait.episodeId,
    },
    now,
  );
  const delay = Math.min(AUTO_YES_ANSWER_GRACE_MS, Math.max(0, holdEndsAt - now));
  const timer = setTimeout(() => {
    answerGraceTimers.delete(key);
    releaseAutoYesHold(key, wait);
  }, delay);
  // Never hold the process open for it, as with the other timers here.
  (timer as { unref?: () => void }).unref?.();
  answerGraceTimers.set(key, timer);
}

/**
 * The Auto-Yes hold ended: notify unless the wait is over or is another one
 * (Issue #3757). Read from the episode store, as {@link releaseHeldWait} does.
 */
function releaseAutoYesHold(key: string, wait: PendingWait): void {
  const held = pending.get(key);
  if (held === undefined || !isSameWait(held, wait)) return;

  const episode = currentEpisodeOf(held);
  if (episode === null) {
    pending.delete(key);
    // Issue #3776: this episode's hold only — the next one may hold already.
    forgetAutoYesHold(key, { since: held.since, episodeId: held.episodeId });
    stopEscalationTimerIfIdle();
    return;
  }

  const settled: PendingWait = { ...held, kind: episode.kind };
  pending.set(key, settled);
  gateAndSend(settled, Date.now(), true);
}

/**
 * The grace elapsed: send the held wait with whatever it is called *now*
 * (Issue #2156).
 *
 * The episode store is the authority here for the same reason it is in
 * {@link runEscalationTick}: it carries the classification every later probe
 * refined, and its absence is the wait having ended. Nothing is sent in that
 * case — a wait answered inside the grace never needed a notification, and
 * dropping it is the direction #1999/#2000 asked for rather than a correction
 * push chasing one that was already wrong.
 */
function releaseHeldWait(key: string): void {
  graceTimers.delete(key);

  const held = pending.get(key);
  // Gone means the closing edge dropped it, or a reminder already claimed it.
  if (held === undefined) return;

  const episode = currentEpisodeOf(held);
  if (episode === null) {
    pending.delete(key);
    stopEscalationTimerIfIdle();
    return;
  }

  // Written back so the reminder quotes the settled kind even if the episode is
  // gone by the time it runs.
  const settled: PendingWait = { ...held, kind: episode.kind };
  pending.set(key, settled);

  gateAndSend(settled, Date.now());
}

function startEscalationTimer(): void {
  if (globalThis.__waitingPushEscalationTimer !== undefined) return;

  const timer = setInterval(() => {
    runEscalationTick();
  }, ESCALATION_TICK_MS);
  // Never hold the process open for a reminder; the server exiting is a far
  // stronger signal than "someone might still be waiting".
  (timer as { unref?: () => void }).unref?.();

  globalThis.__waitingPushEscalationTimer = timer;
}

function stopEscalationTimerIfIdle(): void {
  if (pending.size > 0) return;
  const timer = globalThis.__waitingPushEscalationTimer;
  if (timer !== undefined) {
    clearInterval(timer);
    globalThis.__waitingPushEscalationTimer = undefined;
  }
}

/**
 * Handle one crossing of the waiting edge.
 *
 * Exported for tests, which drive it directly rather than through the
 * subscription so a failure points at this function and not at #1786's store.
 */
export function handleWaitingTransition(transition: WaitingTransition | WaitingEpisodeTransition): void {
  // Nothing downstream can do anything without VAPID keys, so an install
  // without push does not track waits, does not read the database and does not
  // start a timer — it is inert rather than merely quiet.
  if (!isPushConfigured()) return;

  const key = buildCompositeKey(transition.worktreeId, transition.cliToolId, transition.instanceId);
  const cause = 'cause' in transition ? transition.cause : null;

  if (!transition.waiting || transition.since === null) {
    // Issue #2156: a wait still inside its grace is answered, not notified.
    cancelGrace(key);
    pending.delete(key);
    stopEscalationTimerIfIdle();
    // Issue #2001: this is the moment the notification on every *other* device
    // stopped being true. It is the only edge that sees it — the poller closes
    // the episode here (`response-checker`) and so does the status probe
    // (`worktree-status-helper`), so hooking the edge covers both producers the
    // way #1790 already does for the opening one. Fire-and-forget: the notifier
    // never rejects, and the `void` keeps the synchronous listener contract
    // `emit` relies on.
    //
    // Issue #2057: what reaches here is bounded by `waiting-episode-state`,
    // which is in memory. A `waiting: false` poll on an instance this process
    // never saw waiting emits nothing at all, so a wait that ended while the
    // server was down produces no closing edge and no resolution — durable card
    // marks do not change that, and it is the limitation §6.2 of the design
    // note records rather than one this module can close.
    void notifyPromptResolved({
      worktreeId: transition.worktreeId,
      agentName: transition.instanceId ?? transition.cliToolId,
      at: transition.at,
    });
    return;
  }

  // Issue #3798: a new wait in place of the old one. The old wait's holds and
  // timers go — it is over — and no resolution is sent: nobody stopped
  // waiting, and the new wait's card is about to replace the old one anyway.
  if (cause === 'replaced') {
    const old = pending.get(key);
    cancelGrace(key);
    pending.delete(key);
    const previousEpisodeId = 'previousEpisodeId' in transition ? transition.previousEpisodeId : null;
    forgetAutoYesHold(key, { since: old?.since ?? transition.since, episodeId: previousEpisodeId ?? old?.episodeId });
  }

  const wait: PendingWait = {
    worktreeId: transition.worktreeId,
    cliToolId: transition.cliToolId,
    instanceId: transition.instanceId,
    since: transition.since,
    episodeId: episodeIdOf(transition),
    kind: transition.kind,
  };

  // Issue #1999: the wait is tracked and the reminder armed either way — only
  // the notification is gated. Dropping the wait from `pending` instead would
  // discard the escalation that makes the suppression safe, and the gate has to
  // run before `sendWaitingPush` because `shouldSendWaitingPush` records the
  // episode at the moment it decides to send.
  pending.set(key, wait);
  startEscalationTimer();

  // Issue #2156: a wait nobody has named yet is held for one probe interval so
  // it can notify under the kind it turns out to be, rather than under the
  // placeholder it opened with. A named wait notifies on the edge, as before.
  if (isUnnamedWait(wait.kind)) {
    cancelGrace(key);
    const timer = setTimeout(() => {
      releaseHeldWait(key);
    }, CLASSIFICATION_GRACE_MS);
    // Same reasoning as the escalation interval: never hold the process open.
    (timer as { unref?: () => void }).unref?.();
    graceTimers.set(key, timer);
    return;
  }

  gateAndSend(wait, transition.at);
}

/**
 * The id of the wait an opening edge is about (Issue #3798). The episode edge
 * carries it; an edge in the #1786 shape (a test calling
 * {@link handleWaitingTransition} directly) is matched to the open episode by
 * its `since`, read with `getWaitingEpisodeRecord`.
 */
function episodeIdOf(transition: WaitingTransition | WaitingEpisodeTransition): string | null {
  if ('episodeId' in transition) return transition.episodeId;
  const episode = getWaitingEpisodeRecord(transition.worktreeId, transition.cliToolId, transition.instanceId);
  return episode !== null && episode.since === transition.since ? episode.episodeId : null;
}

/**
 * Re-notify every wait that has outlived the threshold, once each.
 *
 * Exported so tests can advance a fake clock instead of a real minute.
 */
export function runEscalationTick(now: number = Date.now()): void {
  if (pending.size === 0) {
    stopEscalationTimerIfIdle();
    return;
  }

  const settings = getPushEscalationSettings();
  const thresholdMs = settings.thresholdMinutes * 60_000;

  for (const [key, wait] of Array.from(pending)) {
    // The episode store, not this map, is the authority on whether the wait is
    // still going: it is written by the status probe, so an answer given in
    // another tab — or a wait whose closing edge this module never saw — is
    // caught here even when `pending` still lists it.
    const episode = currentEpisodeOf(wait);
    if (episode === null) {
      pending.delete(key);
      continue;
    }

    if (!settings.enabled) continue;
    if (now - wait.since < thresholdMs) continue;

    // Issue #1999: the same gate, asked with `escalated`. It never suppresses a
    // reminder — the episode check above has already proved Auto-Yes did not
    // resolve this wait — but routing the reminder through it keeps the rule in
    // one place and puts the decision in the log next to the opening edge's.
    // The wait is left in `pending` if it ever does suppress, so a later tick
    // can reconsider rather than losing the reminder outright.
    if (
      isPromptPushSuppressed({
        worktreeId: wait.worktreeId,
        cliToolId: wait.cliToolId,
        instanceId: wait.instanceId,
        waitingSince: wait.since,
        waitingEpisodeId: wait.episodeId,
        escalated: true,
      })
    ) {
      continue;
    }

    // Dropped before sending, not after: the reminder is once per episode, and
    // an in-flight fan-out must not be able to earn a second one.
    pending.delete(key);
    void sendWaitingPush({ ...wait, kind: episode.kind ?? wait.kind }, true, now);
  }

  stopEscalationTimerIfIdle();
}

/**
 * Subscribe to the waiting edge.
 *
 * Idempotent by replacement, like #1788's broadcast: calling it again drops the
 * previous subscription rather than adding a second one, so a module evaluated
 * twice cannot double-notify.
 *
 * @returns The unsubscribe function (also reachable as
 *   {@link stopWaitingPushNotifier}).
 */
export function startWaitingPushNotifier(): () => void {
  stopWaitingPushNotifier();

  // Issue #3798: the episode edge, so a replacement is told from a new wait.
  const unsubscribe = onWaitingEpisodeTransition((transition) => {
    handleWaitingTransition(transition);
  });

  globalThis.__waitingPushUnsubscribe = unsubscribe;
  return unsubscribe;
}

/**
 * Drop the subscription, the outstanding waits and the timer. Safe when none is
 * active, and the seam a test uses to leave no interval behind (CI runs the
 * whole suite in one process).
 */
export function stopWaitingPushNotifier(): void {
  const existing = globalThis.__waitingPushUnsubscribe;
  if (existing) {
    existing();
    globalThis.__waitingPushUnsubscribe = undefined;
  }
  for (const timer of graceTimers.values()) clearTimeout(timer);
  graceTimers.clear();
  for (const timer of answerGraceTimers.values()) clearTimeout(timer);
  answerGraceTimers.clear();
  pending.clear();
  stopEscalationTimerIfIdle();
}

/** Whether a subscription is currently active. Test seam. */
export function isWaitingPushNotifierActive(): boolean {
  return globalThis.__waitingPushUnsubscribe !== undefined;
}

/** How many waits are awaiting their reminder. Test seam. */
export function pendingEscalationCount(): number {
  return pending.size;
}

/** How many waits are held waiting to be classified (#2156). Test seam. */
export function heldWaitCount(): number {
  return graceTimers.size;
}
