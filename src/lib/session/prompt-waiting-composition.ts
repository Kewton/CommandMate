/**
 * The single answer to "is a prompt waiting on this session?" (Issue #1737).
 *
 * Two layers can see a dialog: the screen scraper (`detectSessionStatus`) and
 * the agent's own structured events (`agent-event-state`). Issue #1725 composed
 * them with OR inside `buildCurrentOutput` — and the `send` guard added by
 * #1708 asked the scraper directly, so the same question had two answers and
 * the guard let a structured-only dialog through. This module holds the
 * composition once; `current-output-builder` and `prompt-waiting-guard` both
 * read it and neither reimplements it.
 *
 * ## Two verdicts, deliberately, from one resolution
 *
 * `waiting` is what the payload publishes. `blocksSend` is what refuses a send.
 * They are not the same question because they do not cost the same thing when
 * they are wrong:
 *
 *  - a wrong `waiting` costs a user a prompt panel they can dismiss, and costs
 *    `wait --on-prompt agent` an early exit 10 — bounded, visible, recoverable;
 *  - a wrong `blocksSend` costs the session its writability. Nobody can talk to
 *    the agent, including the operator trying to unstick it. That is the
 *    failure #1725's author declined to risk ("a provisional record making a
 *    session unwritable is a worse failure than the one it would prevent"), and
 *    it is the reason this module exists rather than a one-line OR in the guard.
 *
 * So the structured layer's veto over sends — and only that veto — is bounded
 * three ways: {@link STRUCTURED_SEND_BLOCK_MAX_AGE_MS}, a server-wide env
 * switch, and a per-send opt-out. The scraper's half is bounded by nothing,
 * because it re-reads the live frame every time and releases itself.
 *
 * @module lib/session/prompt-waiting-composition
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type { SessionStatus } from '@/lib/detection/status-detector';
import {
  clearStructuredPromptWaiting,
  corroborateStructuredPromptWaiting,
  getStructuredPromptWaiting,
  type StructuredPromptWaitingState,
} from '@/lib/session/agent-event-state';
import { HOOK_STATUS_REASON } from '@/lib/session/status-mapping';

/**
 * How long a structured-only dialog may keep refusing sends (Issue #1737).
 *
 * The structured record is released by `Stop`, `user_prompt_submit`,
 * `post_tool_use`, `Notification(idle_prompt)`, a generation change, and by the
 * scraper watching the frame it corroborated clear. Every one of those is an
 * event that may simply never arrive: hooks are fail-open by design, a `Stop`
 * can be lost to a timeout, and the case this whole feature exists for is the
 * scraper being blind to the dialog and therefore unable to report it gone. Put
 * those together and a record can outlive its dialog with nothing left to
 * release it — until {@link
 * agent-event-state!STRUCTURED_STATE_MAX_AGE_MS} at 30 minutes, which is far too
 * long to leave a session unwritable.
 *
 * Five minutes is chosen against what it costs in each direction. Losing the
 * veto early costs the pre-#1737 behaviour for a dialog *the scraper cannot
 * see* — a narrow slice of the #1708 hazard, since a dialog the scraper CAN see
 * still blocks with no time bound at all. Holding it too long costs an operator
 * every route to their own agent. The first is a missed guard; the second is an
 * outage.
 *
 * Measured from the record's `at` — when the human was first reported blocked —
 * for the same reason the other bounds are: that is the instant the fact was
 * created, and refreshing it on corroboration would let a scraper that keeps
 * misreading a frame extend the veto indefinitely.
 */
export const STRUCTURED_SEND_BLOCK_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Server-wide off switch for the structured half of the send guard.
 *
 * Set to `off` (or `0` / `false`) to make `send` consult only the scraper, i.e.
 * exactly the #1708 guard. The escape hatch of last resort: it needs a server
 * restart, which by itself already clears the in-memory record, so the per-send
 * opt-out is the one an operator reaches for first. This exists for the fleet
 * that decides it does not want the structured veto at all.
 */
export const STRUCTURED_SEND_GUARD_ENV = 'CM_STRUCTURED_SEND_GUARD';

/** Which layer is refusing the send. */
export type PromptWaitingLayer = 'scraper' | 'structured';

/** Why the structured layer was not allowed to refuse a send. */
export type StructuredSendBlockSuppression =
  /** Older than {@link STRUCTURED_SEND_BLOCK_MAX_AGE_MS}. */
  | 'expired'
  /** {@link STRUCTURED_SEND_GUARD_ENV} turns it off for this server. */
  | 'disabled'
  /** This one send asked to bypass it. */
  | 'caller_opt_out';

/** What `detectSessionStatus()` said about the frame being composed. */
export interface ScraperPromptVerdict {
  status: SessionStatus;
  reason: string;
  /** `StatusDetectionResult.hasActivePrompt` — the published prompt signal. */
  hasActivePrompt: boolean;
}

export interface PromptWaitingResolution {
  /**
   * The OR rule, stated once: either layer seeing a prompt is a prompt. Neither
   * false may cancel the other's true — the structured layer is blind to the
   * AskUserQuestion screens (#1721 §5.6) and the scraper is blind to whatever
   * the next Claude release renders differently, and the whole point of running
   * two layers is that a gap in one is covered by the other.
   */
  waiting: boolean;
  /** The scraper's own half, for callers that must not confuse the two. */
  scraperWaiting: boolean;
  /**
   * The structured record after the release rule has been applied, or null.
   * The live object, not a copy — callers mark corroboration and history writes
   * on it.
   */
  structured: StructuredPromptWaitingState | null;
  /** Whether a `send` must be refused. See the module docblock. */
  blocksSend: boolean;
  /** Which layer refused, or null when nothing did. */
  blockedBy: PromptWaitingLayer | null;
  /** The refusing layer's reason string, or null. */
  blockReason: string | null;
  /**
   * Set when a structured record existed and was not allowed to refuse. Null
   * when there was none, or when it did refuse.
   */
  structuredSendBlockSuppressed: StructuredSendBlockSuppression | null;
}

export interface ResolvePromptWaitingParams {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
  /** The scraper's verdict for the frame just captured. */
  scraper: ScraperPromptVerdict;
  /**
   * Bypass the structured layer's veto for this call (Issue #1737).
   *
   * Affects `blocksSend` only. `waiting` still reports what the layers see: an
   * opt-out is permission to type into the session anyway, not a claim that no
   * dialog is open.
   */
  ignoreStructured?: boolean;
  /** Epoch ms; defaults to now. */
  now?: number;
}

/**
 * The status reason a structured-only dialog publishes.
 *
 * Shared so `sessionStatusReason` in the payload and the reason logged by the
 * send refusal cannot drift apart — an operator reading `hook_permission_prompt`
 * in one surface should find the same word in the other.
 */
export function structuredWaitingReason(state: StructuredPromptWaitingState): string {
  return state.source === 'notification'
    ? HOOK_STATUS_REASON.PERMISSION_PROMPT
    : HOOK_STATUS_REASON.PERMISSION_REQUEST;
}

/** Whether {@link STRUCTURED_SEND_GUARD_ENV} turns the structured veto off. */
function isStructuredSendGuardDisabled(): boolean {
  const raw = process.env[STRUCTURED_SEND_GUARD_ENV]?.trim().toLowerCase();
  return raw === 'off' || raw === '0' || raw === 'false';
}

/**
 * Resolve both layers into one verdict, applying the release rule on the way.
 *
 * Has side effects on the structured record, by design: this is the only place
 * the scraper's observations reach it, so every caller that captured a frame
 * must feed it here or the release rule simply stops running for that path.
 *
 * The release rule is asymmetric on purpose (Issue #1725). The scraper is
 * allowed to say "that prompt is gone" only about a prompt it once saw, because
 * the case this exists for is the scraper being BLIND to the dialog: if "the
 * scraper reports no prompt" released the state on its own, the structured
 * layer would be silenced in exactly the situation it was added for. So a frame
 * the scraper reads as `waiting` arms the release (and confirms a provisional
 * record), and only after that does a non-waiting frame clear it.
 *
 * This is also what the push/pull timing demands. The structured fact arrives
 * over HTTP the moment the agent posts it, while the scraper reads a pane
 * through a 5 s capture cache (`CACHE_TTL_MS`), so "the event is here and the
 * scraper has not seen the dialog yet" is a state that always exists — and
 * under a rule that let the scraper's silence win, that state would be a lost
 * detection every single time.
 */
export function resolvePromptWaiting({
  worktreeId,
  cliToolId,
  instanceId,
  scraper,
  ignoreStructured = false,
  now = Date.now(),
}: ResolvePromptWaitingParams): PromptWaitingResolution {
  let structured = getStructuredPromptWaiting(worktreeId, cliToolId, instanceId, now);
  if (structured !== null) {
    if (scraper.status === 'waiting') {
      corroborateStructuredPromptWaiting(worktreeId, cliToolId, instanceId, now);
    } else if (structured.scraperCorroborated) {
      clearStructuredPromptWaiting(worktreeId, cliToolId, instanceId);
      structured = null;
    }
  }

  const waiting = scraper.hasActivePrompt || structured !== null;

  // The scraper is reading the frame in front of it right now, so its verdict
  // needs no bound: the next capture releases it.
  if (scraper.hasActivePrompt) {
    return {
      waiting,
      scraperWaiting: true,
      structured,
      blocksSend: true,
      blockedBy: 'scraper',
      blockReason: scraper.reason,
      structuredSendBlockSuppressed: null,
    };
  }

  if (structured === null) {
    return {
      waiting,
      scraperWaiting: false,
      structured: null,
      blocksSend: false,
      blockedBy: null,
      blockReason: null,
      structuredSendBlockSuppressed: null,
    };
  }

  const suppressed = structuredSendBlockSuppression(structured, ignoreStructured, now);
  return {
    waiting,
    scraperWaiting: false,
    structured,
    blocksSend: suppressed === null,
    blockedBy: suppressed === null ? 'structured' : null,
    blockReason: suppressed === null ? structuredWaitingReason(structured) : null,
    structuredSendBlockSuppressed: suppressed,
  };
}

/** What a read-only caller is allowed to know. See {@link peekPromptWaiting}. */
export interface PromptWaitingPeek {
  /** The same OR rule {@link PromptWaitingResolution.waiting} publishes. */
  waiting: boolean;
  /** The scraper's own half. */
  scraperWaiting: boolean;
  /**
   * The structured record as it stands, or null — the live object, but a peek
   * caller must not write to it.
   */
  structured: StructuredPromptWaitingState | null;
}

export interface PeekPromptWaitingParams {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
  scraper: ScraperPromptVerdict;
  /** Epoch ms; defaults to now. */
  now?: number;
}

/**
 * The OR rule without the release rule: read both layers, change neither
 * (Issue #1786).
 *
 * Added for the list API (`/api/worktrees`), which had been publishing the
 * scraper's verdict alone and therefore showed no dot at all for a dialog only
 * the agent's events could see. It needs the composed answer; what it must not
 * have is {@link resolvePromptWaiting}'s side effects, for three reasons:
 *
 *  - **it is not the same evidence.** The list path detects on
 *    `STATUS_DETECTION_CAPTURE_LINES`, a deliberately smaller window than the
 *    detail path's, so its "no prompt here" is a weaker statement than the one
 *    the release rule was written for. Letting it clear a corroborated episode
 *    would retire a record on evidence #1725 never intended.
 *  - **`blocksSend` reads the same record.** A list poll that wrongly cleared it
 *    would silently disarm the `send` guard — the #1708 hazard, restored by a
 *    read endpoint. The Issue's own instruction is that `blocksSend` must not
 *    change, and the cheapest way to guarantee that is to write nothing.
 *  - **it is polled by every open tab, for every worktree.** A state machine
 *    whose outcome depends on how many browsers are watching is not one anybody
 *    can reason about later.
 *
 * What the list path gives up is arming corroboration. It costs nothing that was
 * ever there: the arming callers (`current-output-builder`, the `send` guard)
 * are unchanged, and the structured record's own releases — `Stop`,
 * `user_prompt_submit`, `post_tool_use`, `Notification(idle_prompt)`, a
 * generation change — are what retire it in the ordinary case, with
 * {@link agent-event-state!STRUCTURED_STATE_MAX_AGE_MS} as the backstop.
 */
export function peekPromptWaiting({
  worktreeId,
  cliToolId,
  instanceId,
  scraper,
  now = Date.now(),
}: PeekPromptWaitingParams): PromptWaitingPeek {
  const structured = getStructuredPromptWaiting(worktreeId, cliToolId, instanceId, now);
  return {
    waiting: scraper.hasActivePrompt || structured !== null,
    scraperWaiting: scraper.hasActivePrompt,
    structured,
  };
}

/**
 * Why this structured record may not refuse a send, or null when it may.
 *
 * Ordered so the answer names the operator's own action first: someone who
 * passed the opt-out should be told that is what happened, not that the record
 * had also aged out.
 */
function structuredSendBlockSuppression(
  state: StructuredPromptWaitingState,
  ignoreStructured: boolean,
  now: number,
): StructuredSendBlockSuppression | null {
  if (ignoreStructured) return 'caller_opt_out';
  if (isStructuredSendGuardDisabled()) return 'disabled';
  if (now - state.at >= STRUCTURED_SEND_BLOCK_MAX_AGE_MS) return 'expired';
  return null;
}
