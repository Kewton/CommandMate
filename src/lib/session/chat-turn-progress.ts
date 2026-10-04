/**
 * Chat turn progress: the frames that carry the body of an open turn
 * (Issue #3215).
 *
 * Moved verbatim out of `current-output-builder`, which re-exports every name
 * it used to export, so an import from either module reads the same
 * declaration. The comments came along unedited: where one says "this file" or
 * "this module", it was written about `current-output-builder`.
 *
 * `publishChatTurnProgress` is exported for `buildCurrentOutput` and for
 * nothing else; it is not part of what `current-output-builder` re-exports.
 */

import type Database from 'better-sqlite3';
import {
  CHAT_TURN_PROGRESS_EVENT_TYPE,
  CHAT_TURN_PROGRESS_MIN_INTERVAL_MS,
  truncateChatTurnProgressBody,
  type ChatTurnProgressEvent,
} from '@/lib/realtime/types';
import { createLogger } from '@/lib/logger';
import type { CLIToolType } from '@/lib/cli-tools/types';

// Issue #3215: the name is the one these lines have always been logged under.
// It is what an operator greps for, so it did not move with the code.
const logger = createLogger('current-output-builder');

// ============================================================================
// Chat turn progress (Issue #2199)
// ============================================================================

/**
 * The instance one progress frame is about.
 *
 * `instanceId` is optional here and resolved on the way out, exactly as every
 * other function in this file treats it, so a caller cannot key the throttle on
 * `undefined` and the wire on `'claude'`.
 */
export interface ChatTurnProgressTarget {
  readonly worktreeId: string;
  readonly cliToolId: CLIToolType;
  readonly instanceId?: string;
}

/** What a tool's reader hands over. See {@link ChatTurnProgressSource}. */
export interface ChatTurnProgressDraft {
  /** The `requestId` the settled row will carry. */
  readonly turnKey: string;
  /** Markdown, as the agent wrote it. */
  readonly body: string;
  /** True when the reader could not reach the beginning of the turn. */
  readonly partial?: boolean;
}

/**
 * How the shared builder gets a body, and why it is a callback.
 *
 * The claude reader costs a 4 MiB file read and a JSONL parse, and the opencode
 * reader walks up to `MAX_OPENCODE_TURN_PARTS` parts through a Markdown
 * renderer. Neither is something to do on every poll tick and every SSE frame,
 * and passing a *value* would mean exactly that: the caller would have paid for
 * it before the throttle got a chance to say no. A callback moves the whole cost
 * behind {@link CHAT_TURN_PROGRESS_MIN_INTERVAL_MS}.
 *
 * Answering null means "nothing to show yet" — an open turn with no assistant
 * text, a session with no transcript. It is not an error and is not logged here.
 */
export type ChatTurnProgressSource = () =>
  | ChatTurnProgressDraft
  | null
  | Promise<ChatTurnProgressDraft | null>;

/** One instance's progress bookkeeping. */
interface ChatTurnProgressState {
  /** Monotonic, and never reset by a new turn — see {@link buildChatTurnProgress}. */
  version: number;
  /** When the source was last *asked*, which is what the throttle bounds. */
  askedAt: number;
  /** The last published turn key, or null before the first frame. */
  turnKey: string | null;
  /** The last published body, for the "nothing changed" check. */
  body: string | null;
  /** Issue #2248: the outcome already reported at info for this instance. */
  loggedOutcome: ChatTurnProgressOutcome | null;
  /** Issue #2248: the turn that outcome was reported for; null when unknown. */
  loggedTurnKey: string | null;
}

/** Issue #2248: what one tick of the progress publisher did. */
type ChatTurnProgressOutcome = 'published' | 'no-subscribers' | 'failed';

function newChatTurnProgressState(): ChatTurnProgressState {
  return {
    version: 0,
    askedAt: Number.NEGATIVE_INFINITY,
    turnKey: null,
    body: null,
    loggedOutcome: null,
    loggedTurnKey: null,
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __chatTurnProgressState: Map<string, ChatTurnProgressState> | undefined;
}

/**
 * On `globalThis` for the reason every shared map in this subsystem is (#1736):
 * under `next dev` the poller's bundle and the opencode subscription's bundle
 * would each get a private copy, and two producers throttling against two
 * different maps is no throttle at all.
 */
const chatTurnProgressState = (globalThis.__chatTurnProgressState ??= new Map<
  string,
  ChatTurnProgressState
>());

function chatTurnProgressKey(target: ChatTurnProgressTarget): string {
  return `${target.worktreeId}:${target.cliToolId}:${target.instanceId ?? target.cliToolId}`;
}

/** Forget every instance's progress bookkeeping. Test seam. */
export function resetChatTurnProgressState(): void {
  chatTurnProgressState.clear();
}

/**
 * Say once, at info, what happened to this instance's progress frames (Issue #2248).
 *
 * ## Why info, and why this file had none
 *
 * Every outcome here was `logger.debug`, including the two that mean the reader
 * is watching a blank space: a push that threw, and a room with no subscribers.
 * Issue #2248 was opened after a live session where the body reached the browser
 * — or did not — and the server logs could not answer which, because debug is
 * off in the builds people run. An unobservable push is a feature that can only
 * be debugged by reproducing it.
 *
 * ## Why once
 *
 * The publisher runs on EVERY poll tick of a generating session. Logging each
 * tick at info would put a line per second per agent into the operator's log and
 * make the level useless, so this collapses a run of identical ticks into its
 * first: the outcome and the turn it happened on are the identity, and a repeat
 * of the pair says nothing the first line did not.
 *
 * The consequences of that identity, both deliberate:
 *
 *  - **a new turn always logs**, because `turnKey` is part of the pair. That is
 *    the acceptance criterion — one info line per turn — and the reason
 *    `loggedTurnKey` exists at all rather than a bare boolean;
 *  - **a CHANGE of outcome always logs**, so "the subscriber left" and "it
 *    started failing" are both visible the tick they happen, without the
 *    steady state that follows repeating them.
 *
 * `no-subscribers` and `failed` carry no turn key — neither knows one; the first
 * returns before the source is asked and the second is why there is no frame —
 * so for them the pair is `(outcome, null)` and the run collapses to one line
 * until something else happens.
 */
function logChatTurnProgressOutcome(
  target: ChatTurnProgressTarget,
  outcome: ChatTurnProgressOutcome,
  turnKey: string | null,
  extra: Record<string, unknown> = {},
): void {
  const key = chatTurnProgressKey(target);
  const state = chatTurnProgressState.get(key) ?? newChatTurnProgressState();
  chatTurnProgressState.set(key, state);
  if (state.loggedOutcome === outcome && state.loggedTurnKey === turnKey) return;
  state.loggedOutcome = outcome;
  state.loggedTurnKey = turnKey;

  // Written out rather than interpolated: these strings are what an operator
  // greps the log for, and an interpolated name cannot be found in the source.
  const message =
    outcome === 'published'
      ? 'chat-turn-progress-published'
      : outcome === 'no-subscribers'
        ? 'chat-turn-progress-no-subscribers'
        : 'chat-turn-progress-failed';

  logger.info(message, {
    worktreeId: target.worktreeId,
    cliToolId: target.cliToolId,
    instanceId: target.instanceId ?? target.cliToolId,
    turnKey,
    ...extra,
  });
}

/**
 * Decide whether this instance has a new progress frame, and build it.
 *
 * The single generator both tools go through, on the same argument
 * {@link buildCurrentOutput} makes for the terminal payload: two producers of one
 * wire shape drift, and the drift is invisible because each of them is
 * individually correct. Three rules, in this order, and each of them is a way
 * this feature goes wrong if it is missing:
 *
 *  1. **Throttle.** At most one *ask* per {@link CHAT_TURN_PROGRESS_MIN_INTERVAL_MS}
 *     per instance. It gates the ask rather than the send because the source is
 *     the expensive half (see {@link ChatTurnProgressSource}); a gate on the send
 *     alone would re-read a 4 MiB transcript to discover it had not changed.
 *  2. **No-change suppression.** Same turn, same body → no frame. A reply that
 *     has stopped growing must not keep waking every subscribed browser.
 *  3. **Monotonic version**, per instance and NOT per turn. A client drops
 *     anything at or below what it has already rendered, and restarting the
 *     counter on a new turn would make the first frame of turn N+1 look stale
 *     against the last frame of turn N.
 *
 * The body is bounded by {@link truncateChatTurnProgressBody}, whose cut is
 * folded into `partial` together with the reader's own — see
 * {@link ChatTurnProgressEvent.partial} for why one flag answers both.
 *
 * Never throws: a source that throws is a turn with nothing to show, not a
 * broken poll tick.
 *
 * @param target - The instance
 * @param source - Asked only when the throttle allows it
 * @param now - Epoch ms; injected by the tests
 * @returns The frame to broadcast, or null when there is nothing new to say
 */
export async function buildChatTurnProgress(
  target: ChatTurnProgressTarget,
  source: ChatTurnProgressSource,
  now: number = Date.now(),
): Promise<ChatTurnProgressEvent | null> {
  const key = chatTurnProgressKey(target);
  const state = chatTurnProgressState.get(key) ?? newChatTurnProgressState();

  if (now - state.askedAt < CHAT_TURN_PROGRESS_MIN_INTERVAL_MS) return null;
  state.askedAt = now;
  chatTurnProgressState.set(key, state);

  let draft: ChatTurnProgressDraft | null;
  try {
    draft = await source();
  } catch {
    // The readers already promise never to throw; this is the belt for the
    // dynamic import that reaches them.
    return null;
  }
  if (!draft || draft.body.length === 0) return null;

  const bounded = truncateChatTurnProgressBody(draft.body);
  if (draft.turnKey === state.turnKey && bounded.body === state.body) return null;

  state.turnKey = draft.turnKey;
  state.body = bounded.body;
  state.version += 1;

  return {
    type: CHAT_TURN_PROGRESS_EVENT_TYPE,
    worktreeId: target.worktreeId,
    cliToolId: target.cliToolId,
    instanceId: target.instanceId ?? target.cliToolId,
    turnKey: draft.turnKey,
    body: bounded.body,
    partial: bounded.truncated || draft.partial === true,
    version: state.version,
    done: false,
  };
}

/**
 * Build a progress frame and push it to the worktree room.
 *
 * Subscribers are checked FIRST, before the throttle state is touched and long
 * before the source is asked, so a session nobody is watching costs one map
 * lookup per tick — the same bargain `broadcastTerminalSnapshot` strikes, and
 * the reason a 4 MiB transcript read does not happen for every claude session on
 * the machine.
 *
 * The `ws-server` import is dynamic so this module's *other* callers — the
 * `/current-output` route and `commandmate capture` — do not pull the WebSocket
 * server into their graph just by building a payload.
 *
 * Never throws; a failed push is a moment of staleness on a surface that has the
 * settled row coming anyway.
 *
 * @returns Whether a frame was broadcast
 */
export async function emitChatTurnProgress(
  target: ChatTurnProgressTarget,
  source: ChatTurnProgressSource,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const { broadcast, hasRoomSubscribers } = await import('@/lib/ws-server');
    if (!hasRoomSubscribers(target.worktreeId)) {
      // Issue #2248. Reported, not silent: "the body never reached the browser"
      // and "nobody was listening" look identical from a screenshot, and this is
      // the only place that can tell them apart.
      logChatTurnProgressOutcome(target, 'no-subscribers', null);
      return false;
    }

    const event = await buildChatTurnProgress(target, source, now);
    // Not logged: null is the throttle, an unchanged body, or a turn with no
    // text yet — the quiet, correct majority of ticks.
    if (!event) return false;

    broadcast(target.worktreeId, event);
    logChatTurnProgressOutcome(target, 'published', event.turnKey, {
      version: event.version,
      bodyLength: event.body.length,
      partial: event.partial,
    });
    return true;
  } catch (error) {
    logChatTurnProgressOutcome(target, 'failed', null, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Ask the tool that has a transcript for the body of its open turn (Issue #2199).
 *
 * claude only, and that is a statement about which tools have a *pull* reader
 * rather than a list to extend by hand. opencode's body arrives on its own SSE
 * stream and is published from `sources/opencode/history` at the moment a part
 * lands — polling for it here would be a second producer of the same frames.
 * codex and antigravity have neither, and stay on the indicator (#2197 / #2198).
 *
 * The reader is imported dynamically so `sources/claude/history` — and through
 * it `fs/promises`, the session-pointer latch and `user-turn-recorder` — stays
 * out of the module graph of the `/current-output` route and of `commandmate
 * capture`, both of which reach this file for a payload and nothing else.
 *
 * ## Which half the caller waits for (Issue #2248)
 *
 * The caller awaits the CHEAP half — the worktree row and "is anybody watching"
 * — and not the expensive one. That split is what `void` was protecting in the
 * first place: the 4 MiB transcript read, the JSONL parse, the render and the
 * broadcast still run detached, so no poll tick and no WebSocket snapshot waits
 * on them.
 *
 * What awaiting the prelude buys is the reason this Issue exists: the line that
 * says whether anybody received the frame is written while the tick it belongs
 * to is still the tick in progress. Left inside the detached half it landed
 * wherever the event loop happened to get to it, next to some unrelated
 * request's output, which is not a log an operator can read backwards.
 *
 * Never throws: `emitChatTurnProgress` swallows, and so does this.
 */
export async function publishChatTurnProgress(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): Promise<void> {
  if (cliToolId !== 'claude') return;
  const target: ChatTurnProgressTarget = { worktreeId, cliToolId, instanceId };
  try {
    // The slug the transcript directory is named after is a function of the
    // worktree's path, so the row is what makes the file findable at all. Read
    // before the throttle only because it is a single indexed lookup against a
    // connection this function was handed; everything expensive is behind the
    // gate.
    const { getWorktreeById } = await import('@/lib/db/worktree-db');
    const worktreePath = getWorktreeById(db, worktreeId)?.path;
    if (!worktreePath) return;

    // Issue #2248. Hoisted out of `emitChatTurnProgress` — which still makes the
    // same check for its other caller — so the answer, and the line that reports
    // it, are settled before this function returns. Costs one Map lookup on the
    // sessions nobody is watching, which is the bargain that was already being
    // struck one frame later.
    const { hasRoomSubscribers } = await import('@/lib/ws-server');
    if (!hasRoomSubscribers(worktreeId)) {
      logChatTurnProgressOutcome(target, 'no-subscribers', null);
      return;
    }

    // Detached on purpose: everything past this point is the transcript read.
    void emitChatTurnProgress(target, async () => {
      const { readClaudeTurnProgress } = await import('@/lib/hooks/sources/claude/history');
      return readClaudeTurnProgress(
        { worktreeId, cliToolId, instanceId: instanceId ?? cliToolId },
        { worktreePath },
      );
    });
  } catch (error) {
    // Issue #2248: the reader's half of the same failure — the worktree row or
    // one of the dynamic imports — on the same once-per-run gate as the push's.
    logChatTurnProgressOutcome(target, 'failed', null, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
