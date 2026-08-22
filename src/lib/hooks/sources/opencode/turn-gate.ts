/**
 * Deciding which frames are a turn's real boundaries (Issue #1763).
 *
 * opencode repeats both of the frames CommandMate reads as one-off facts, and
 * in both cases the repeat is byte-identical to the original. A source that
 * mapped frames one-to-one would therefore report the same event several times,
 * and the status layer — which reads only the *newest* event — would turn that
 * into a wrong verdict. This module tells the first from the rest.
 *
 * ## `session.idle` — the end of a turn
 *
 * It is opencode's `Stop`: #1758 §5.3.1 held a session on an approval dialog
 * for 10 minutes 19 seconds and not one `session.idle` arrived for it, so the
 * event really does mean "the turn finished" rather than "the agent is not
 * busy". `commandmate wait` may key off it. What it may not do is count them:
 *
 *  - **Abnormal endings fire twice.** An abort emitted `session.idle` at
 *    08:15:00.416 and again at 08:15:00.435 — 19 ms apart, same session, same
 *    turn (§5.3.2). Provider errors do the same. Normal endings fire once.
 *  - **The payload has no turn identifier.** It is `{ "sessionID": "ses_…" }`
 *    and nothing else, so two idles cannot be told apart by looking at them
 *    (§5.3.3). Claude's `Stop` carried `prompt_id`; this does not.
 *  - **An idle can arrive for a turn this connection never watched start** — a
 *    stream opened mid-session, a resubscribe after a restart — and treating
 *    that as a completion resolves a `wait` for work that is not over.
 *
 * So: **arm on `session.status(busy)`, complete on the first `session.idle`
 * after arming, drop the rest.** `session.status(idle)` is deliberately inert —
 * it is emitted in the same millisecond as `session.idle` and is the same
 * signal, so honouring both would double every turn (§5.3.2 rule 4).
 *
 * ## `message.updated` — the start of a turn
 *
 * `user_prompt_submit` has no event of its own; it is `message.updated` with
 * `info.role === "user"`. That frame is **re-emitted for the same message
 * several times per turn, including after `session.idle`** — measured live on
 * 1.18.3 while implementing this Issue:
 *
 * ```
 * 13:53:14.251  session.idle
 * 13:53:14.297  message.updated  role=user  id=msg_ffb668eec001WToZ7VW0lQgmoa
 * ```
 *
 * Both copies carry `time: { created: … }` and nothing else, so nothing in the
 * payload distinguishes them. Mapped one-to-one, the newest event after a
 * finished turn is `user_prompt_submit`, which `status-mapping` reads as
 * **`running`** — so `commandmate wait` would hang on every completed opencode
 * turn until the 30-minute staleness bound expired. The fix has the same shape:
 * **announce the first `message.updated` for a message id, suppress the
 * repeats.**
 *
 * Unlike the arming state, announced ids **survive a reconnect**. A genuinely
 * new prompt always carries a new id, so keeping them costs nothing and closes
 * the window where a reconnect lands between a turn's end and its trailing
 * repeat.
 *
 * ## Which session's turn is the *instance's* turn (Issue #1900)
 *
 * One opencode server can carry several sessions at once (#1758 §5.6.1
 * measured two busy simultaneously), and a sub-agent runs in a session of its
 * own. Every frame is tagged with its `sessionID`, but CommandMate's unit of
 * state is the **instance** — `(worktree, tool, instance)` — so an idle that
 * belongs to a sub-agent used to be published as the instance's `stop` while
 * the session the human is waiting on was still working. Downstream that is not
 * a cosmetic error: `mergeStructuredStatus` lets a structured `ready` overwrite
 * a scraper `running`, so `commandmate wait` returned 0 mid-turn.
 *
 * So the gate also decides *whose* completion counts:
 *
 *  - A session first seen busy while **nothing else is busy** becomes the
 *    **primary** session — the one whose turn is the instance's turn. A session
 *    that goes busy *during* another session's turn cannot take the title,
 *    which is exactly the shape a sub-agent has.
 *  - A session ever seen with a non-empty `info.parentID` is a **child** and can
 *    never be primary. `parentID` is in the server's own `Session` schema
 *    (verified against `GET /doc` on 1.18.21) and is the only positive statement
 *    opencode makes about the relationship.
 *  - An idle from any other session is dropped as `foreign-session` **while the
 *    primary is still busy**. Once the primary's own turn has closed the rule
 *    lifts: at that point the instance is not working, so letting a stray idle
 *    through cannot cut a live turn short — which bounds the cost of inferring
 *    the primary wrongly to "one turn is closed late by the scraper".
 *
 * The gate is a pure state machine over frame types so it can be driven from
 * fixtures. The subscription owns one per connection.
 *
 * @module lib/hooks/sources/opencode/turn-gate
 */

import { isPlainObject, readNestedString } from '../event-mapper';

/** What one frame did to the gate. */
export type TurnObservation =
  /** Not a frame the gate cares about. */
  | { kind: 'ignored' }
  /** The session started working; the next idle is a real completion. */
  | { kind: 'armed'; sessionId: string }
  /** A turn ended. This — and only this — may be reported as `stop`. */
  | { kind: 'completed'; sessionId: string }
  /**
   * A user message seen for the first time. This — and only this — may be
   * reported as `user_prompt_submit`.
   */
  | { kind: 'announced'; sessionId: string; messageId: string }
  /** A repeat that must not be reported. See {@link SuppressionReason}. */
  | { kind: 'suppressed'; sessionId: string; reason: SuppressionReason }
  /** The turn is ending badly. Recorded beside the completion, never instead. */
  | { kind: 'failed'; sessionId: string; errorName: string | null };

/**
 * Why a frame was dropped.
 *
 * - `never-armed` — no `session.status(busy)` has been seen for this session on
 *   this connection, so whatever this idle is reporting the end of, CommandMate
 *   did not watch the start of.
 * - `already-completed` — the second (and later) idle of an abnormal ending.
 * - `already-announced` — a `message.updated` for a user message that has
 *   already been reported. The one that arrives *after* `session.idle` is the
 *   dangerous member: unsuppressed it would leave a finished turn reading
 *   `running`.
 * - `foreign-session` — an idle for a session that is not this instance's turn
 *   while that turn is still open (Issue #1900). See the module comment.
 */
export type SuppressionReason =
  | 'never-armed'
  | 'already-completed'
  | 'already-announced'
  | 'foreign-session';

/** Per-session phase. Absent from the map means "never seen busy". */
type TurnPhase = 'busy' | 'idle';

/**
 * Cap on remembered sessions.
 *
 * One opencode server can host several sessions (#1758 §5.6.1) and a long-lived
 * TUI accumulates them, so the map is bounded. The oldest is dropped, which at
 * worst re-arms an ancient session — the failure mode of forgetting is a
 * suppressed idle, never a spurious completion.
 */
export const MAX_TRACKED_TURN_SESSIONS = 64;

/**
 * Cap on remembered user-message ids.
 *
 * Larger than the session cap because it counts prompts rather than sessions,
 * and because these survive reconnects. Forgetting the oldest costs one
 * re-announced `user_prompt_submit` for a prompt from thousands of turns ago.
 */
export const MAX_TRACKED_USER_MESSAGES = 512;

/**
 * Cap on remembered child sessions.
 *
 * Same order as the session cap and for the same reason. Forgetting the oldest
 * costs the `parentID` half of the primary rule for an ancient sub-agent; the
 * "cannot take the title mid-turn" half is unaffected.
 */
export const MAX_TRACKED_CHILD_SESSIONS = 64;

/** The state machine one subscription drives. */
export interface TurnGate {
  /**
   * Feed one raw frame.
   *
   * @param type - The frame's `type`, or null when it carried none
   * @param payload - The whole frame, `{ id, type, properties }`
   */
  observe(type: string | null, payload: Record<string, unknown>): TurnObservation;
  /** Whether this session is mid-turn. Test seam and diagnostics. */
  isArmed(sessionId: string): boolean;
  /**
   * Arm a session from something other than a frame (Issue #1900).
   *
   * The reconnect's `GET /session/status` is a statement of the same fact
   * `session.status(busy)` carries — "this session is working" — arriving over
   * the one channel that survives a dropped stream. Feeding it here is what
   * lets an idle that lands after the reconnect still resolve a `wait`, instead
   * of being dropped as `never-armed` for the next thirty minutes.
   */
  arm(sessionId: string): void;
  /** The sessions currently mid-turn, oldest first. */
  armedSessions(): string[];
  /** The session whose turn is the instance's turn, or null. Diagnostics. */
  primarySession(): string | null;
  /**
   * Forget the arming state — a reconnect starts a new arming window.
   *
   * Announced message ids are **kept**: see the module comment. Clearing them
   * would let a trailing `message.updated` that arrives just after a reconnect
   * mark a finished turn as running. Known **child** sessions are kept too:
   * parentage is a permanent property of a session id, and re-learning it needs
   * a frame that may never come again on the new connection.
   */
  reset(): void;
}

/** `properties.sessionID`, or null. */
function sessionIdOf(payload: Record<string, unknown>): string | null {
  const properties = isPlainObject(payload.properties) ? payload.properties : {};
  return readNestedString(properties, ['sessionID']);
}

/** `properties.status.type` for `session.status`. */
function statusType(payload: Record<string, unknown>): string | null {
  const properties = isPlainObject(payload.properties) ? payload.properties : {};
  return readNestedString(properties, ['status', 'type']);
}

/** `properties.error.name` for `session.error` — `MessageAbortedError`, `APIError`, … */
function errorName(payload: Record<string, unknown>): string | null {
  const properties = isPlainObject(payload.properties) ? payload.properties : {};
  return readNestedString(properties, ['error', 'name']);
}

/**
 * The session this frame declares a parent for, or null (Issue #1900).
 *
 * `Session.parentID` is optional in opencode's own schema and present only on a
 * sub-agent's session, so a non-empty value is a positive identification. Read
 * off `info.id` rather than `properties.sessionID` because those differ on
 * `message.updated`, whose `info` is a *message* and carries no `parentID` at
 * all — which is what keeps this generic read from mislabelling one.
 */
function childSessionOf(payload: Record<string, unknown>): string | null {
  const properties = isPlainObject(payload.properties) ? payload.properties : {};
  const info = isPlainObject(properties.info) ? properties.info : null;
  if (info === null) return null;
  if (!readNestedString(info, ['parentID'])) return null;
  return readNestedString(info, ['id']) ?? readNestedString(properties, ['sessionID']);
}

/** `properties.info.role` / `properties.info.id` for `message.updated`. */
function messageInfo(payload: Record<string, unknown>): { role: string | null; id: string | null } {
  const properties = isPlainObject(payload.properties) ? payload.properties : {};
  return {
    role: readNestedString(properties, ['info', 'role']),
    id: readNestedString(properties, ['info', 'id']),
  };
}

/** Drop the oldest entries until the collection fits. */
function trim(keys: { size: number; keys(): IterableIterator<string>; delete(key: string): boolean }, max: number): void {
  // Both Map and Set iterate in insertion order, so the head is the oldest.
  while (keys.size > max) {
    const oldest = keys.keys().next();
    if (oldest.done) break;
    keys.delete(oldest.value);
  }
}

/**
 * Build a gate.
 *
 * @param maxSessions - Cap on remembered sessions; defaults to
 *   {@link MAX_TRACKED_TURN_SESSIONS}
 * @param maxUserMessages - Cap on remembered user-message ids; defaults to
 *   {@link MAX_TRACKED_USER_MESSAGES}
 */
export function createTurnGate(
  maxSessions: number = MAX_TRACKED_TURN_SESSIONS,
  maxUserMessages: number = MAX_TRACKED_USER_MESSAGES,
  maxChildSessions: number = MAX_TRACKED_CHILD_SESSIONS
): TurnGate {
  const phases = new Map<string, TurnPhase>();
  const announced = new Set<string>();
  const children = new Set<string>();
  let primary: string | null = null;

  const remember = (sessionId: string, phase: TurnPhase): void => {
    phases.delete(sessionId);
    phases.set(sessionId, phase);
    trim(phases, maxSessions);
  };

  /** Whether the instance's own turn is open. */
  const primaryIsBusy = (): boolean => primary !== null && phases.get(primary) === 'busy';

  /**
   * Take the title, if this session is allowed to and nobody holds it.
   *
   * Called after the session has been recorded busy, so `primaryIsBusy()` here
   * asks about a *different* session — the one whose turn this new arrival is
   * running inside.
   */
  const adoptPrimary = (sessionId: string): void => {
    if (children.has(sessionId)) return;
    if (primary === sessionId) return;
    if (primaryIsBusy()) return;
    primary = sessionId;
  };

  /** Whether this idle belongs to somebody else's turn. */
  const isForeign = (sessionId: string): boolean => {
    if (children.has(sessionId)) return true;
    return primary !== null && sessionId !== primary && primaryIsBusy();
  };

  const armSession = (sessionId: string): void => {
    remember(sessionId, 'busy');
    adoptPrimary(sessionId);
  };

  return {
    observe(type, payload) {
      // Before the dispatch and for every frame: parentage arrives on
      // `session.created` / `session.updated`, which are not the frames the
      // turn rules below look at.
      const child = childSessionOf(payload);
      if (child !== null) {
        children.add(child);
        trim(children, maxChildSessions);
        if (primary === child) primary = null;
      }

      if (type === 'message.updated') {
        const { role, id } = messageInfo(payload);
        // Only the user's own message is `user_prompt_submit`; the assistant's
        // updates carry the reply and map to nothing.
        if (role !== 'user' || id === null) return { kind: 'ignored' };
        const sessionId = sessionIdOf(payload) ?? '';
        if (announced.has(id)) {
          return { kind: 'suppressed', sessionId, reason: 'already-announced' };
        }
        announced.add(id);
        trim(announced, maxUserMessages);
        return { kind: 'announced', sessionId, messageId: id };
      }

      if (type === 'session.status') {
        // Only `busy` arms. `idle` here is the same signal as `session.idle`,
        // emitted in the same millisecond, and honouring both would count every
        // turn twice (#1758 §5.3.2 rule 4).
        if (statusType(payload) !== 'busy') return { kind: 'ignored' };
        const sessionId = sessionIdOf(payload);
        if (sessionId === null) return { kind: 'ignored' };
        armSession(sessionId);
        return { kind: 'armed', sessionId };
      }

      if (type === 'session.error') {
        const sessionId = sessionIdOf(payload);
        if (sessionId === null) return { kind: 'ignored' };
        // Not a completion: the idle that follows is. Reported so the caller can
        // tell "finished" from "gave up" — `session.idle` alone cannot (§5.3.3
        // requirement 3).
        return { kind: 'failed', sessionId, errorName: errorName(payload) };
      }

      if (type !== 'session.idle') return { kind: 'ignored' };

      const sessionId = sessionIdOf(payload);
      if (sessionId === null) return { kind: 'ignored' };

      // Issue #1900. Checked before the phase rules so the reason names the
      // real cause: a sub-agent's idle is not "a turn we did not watch start",
      // it is a turn that is not this instance's. Recorded as idle on the way
      // out so the session does not sit armed forever and reappear as a
      // synthesised completion after the next reconnect.
      if (isForeign(sessionId)) {
        remember(sessionId, 'idle');
        return { kind: 'suppressed', sessionId, reason: 'foreign-session' };
      }

      const phase = phases.get(sessionId);
      if (phase === undefined) {
        return { kind: 'suppressed', sessionId, reason: 'never-armed' };
      }
      if (phase === 'idle') {
        return { kind: 'suppressed', sessionId, reason: 'already-completed' };
      }

      remember(sessionId, 'idle');
      return { kind: 'completed', sessionId };
    },

    isArmed(sessionId) {
      return phases.get(sessionId) === 'busy';
    },

    arm(sessionId) {
      armSession(sessionId);
    },

    armedSessions() {
      return [...phases.entries()]
        .filter(([, phase]) => phase === 'busy')
        .map(([sessionId]) => sessionId);
    },

    primarySession() {
      return primary;
    },

    reset() {
      phases.clear();
      primary = null;
      // `announced` and `children` are deliberately kept — see the module
      // comment and {@link TurnGate.reset}.
    },
  };
}
