/**
 * What a roster row says about its relays (Issue #2377).
 *
 * Three surfaces draw this — the PC roster pane, the phone's roster sheet and
 * the chat strip — and the rule is not "print the count": a row can be BOTH
 * ends of two different relays at once (this session owes B an answer and is
 * itself waiting on C), and one of the two is more urgent to show than the
 * other. Deciding that once, here, is what keeps the three surfaces from each
 * inventing a slightly different precedence.
 *
 * Pure and translation-free: the caller passes the alias resolver and does the
 * `t()`. The badge carries a message KEY and its parameters instead, so the
 * wording lives in `locales/` where a label belongs.
 *
 * @module lib/relay/relay-badges
 */

import type { SessionRelay } from '@/lib/relay/types';

/**
 * Which of the things a row can be saying. Issue #4082: `held` — a payload
 * going to this row (the requester) whose delivery is not known. Issue #4105:
 * `blocked` — the last delivery attempt to this row (the requester) stopped
 * because THIS row's pane showed a confirmation; not to be confused with
 * `prompt`, which is the OTHER end (the worker) stopping on one.
 */
export type RelayBadgeTone = 'held' | 'blocked' | 'owed' | 'awaiting' | 'prompt';

/** Tones where somebody has to act (Issues #4082, #4105): `prompt`, `held`, `blocked`. */
export function relayToneNeedsAttention(tone: RelayBadgeTone): boolean {
  return tone === 'prompt' || tone === 'held' || tone === 'blocked';
}

/** One badge, ready for `t(key, params)`. */
export interface RelayBadge {
  tone: RelayBadgeTone;
  /** Key inside the `worktree.relay` namespace. */
  key: string;
  params: Record<string, string | number>;
  /** Key of the `title` attribute, same namespace. */
  titleKey: string;
  /** How many relays this badge stands for. */
  count: number;
}

/** How the caller names the OTHER end of a relay. */
export type RelayAliasResolver = (
  endpoint: { worktreeId: string; instanceId: string }
) => string;

/** What {@link resolveRelayBadges} is given about one roster row. */
export interface RelayBadgeInput {
  /** Open relays this row must answer (it is the `to` end). */
  owed: SessionRelay[];
  /** Open relays this row is waiting on (it is the `from` end). */
  awaiting: SessionRelay[];
  /**
   * Issue #4082: relays (open or closed) whose payload to this row is held as
   * `uncertain`. Absent = none. The caller keeps them out of `owed` / `awaiting`.
   */
  held?: SessionRelay[];
  /**
   * Issue #4193: CLOSED relays whose payload to this row (the requester) — the
   * expiry notice, in practice — is still undelivered and whose last attempt
   * stopped. Absent = none. Only feeds `blocked`; never `awaiting`.
   */
  closedBlocked?: SessionRelay[];
  /** Names the other end; defaults to the instance id. */
  aliasOf: RelayAliasResolver;
}

/**
 * The badges one roster row should show, most urgent first.
 *
 * Precedence, and the reason for it:
 *
 *  0. **`held`** (Issue #4082) — a payload to this row whose delivery is not
 *     known. Nothing will happen to it until somebody looks at this pane and
 *     settles it (`commandmate relays resolve`), so it outranks the rest.
 *  0b. **`blocked`** (Issue #4105) — the last attempt to deliver to this row
 *     stopped on this row's own confirmation dialog. Somebody at THIS pane has
 *     to answer it, and left alone the payload is replaced by the expiry
 *     notice. Below `held` because a held payload needs a decision before
 *     anything else, and the strip shows only the first badge. Counted in
 *     relays (the row is one session); the relays stay counted in
 *     `prompt` / `awaiting` too — this badge is added, never subtracted.
 *  1. **`prompt`** — a relay whose worker stopped on a confirmation. It is the
 *     only one of the three that means somebody has to DO something, and it is
 *     drawn as a warning for that reason.
 *  2. **`awaiting`** — this row asked and has not been answered. Second because
 *     it is the state an operator scanning the roster is looking for.
 *  3. **`owed`** — this row was asked. Last because it needs no action: the
 *     delivery is automatic when the turn ends.
 *
 * A row with nothing open gets an empty array, and the callers' `{badges.map}`
 * renders nothing — the same rule the model line and the source line follow, so
 * a roster of ordinary sessions is unchanged pixel for pixel.
 */
export function resolveRelayBadges(input: RelayBadgeInput): RelayBadge[] {
  const badges: RelayBadge[] = [];

  const held = input.held ?? [];
  if (held.length === 1) {
    badges.push({
      tone: 'held',
      key: 'badgeHeld',
      params: { alias: input.aliasOf(held[0].to) },
      titleKey: 'heldTitle',
      count: 1,
    });
  } else if (held.length > 1) {
    badges.push({
      tone: 'held',
      key: 'badgeHeldMany',
      params: { count: held.length },
      titleKey: 'heldTitle',
      count: held.length,
    });
  }

  // Issue #4105: only the requester's own dialog. `generating` and
  // `session_stopped` are readable in `relays`, but need nobody to act here.
  // Issue #4193: a closed relay's expiry notice stopped the same way counts
  // too — the relay is no longer open, but the dialog still holds the notice.
  const blocked = [...input.awaiting, ...(input.closedBlocked ?? [])].filter(
    (relay) => relay.lastDeliveryBlock?.reason === 'prompt_waiting'
  );
  if (blocked.length === 1) {
    badges.push({
      tone: 'blocked',
      key: 'badgeBlockedByPrompt',
      params: { alias: input.aliasOf(blocked[0].to) },
      titleKey: 'blockedByPromptTitle',
      count: 1,
    });
  } else if (blocked.length > 1) {
    badges.push({
      tone: 'blocked',
      key: 'badgeBlockedByPromptMany',
      params: { count: blocked.length },
      titleKey: 'blockedByPromptTitle',
      count: blocked.length,
    });
  }

  const promptWaits = input.awaiting.filter((relay) => relay.state === 'prompt');
  if (promptWaits.length > 0) {
    badges.push({
      tone: 'prompt',
      key: 'badgePrompt',
      params: { count: promptWaits.length, alias: input.aliasOf(promptWaits[0].to) },
      titleKey: 'promptTitle',
      count: promptWaits.length,
    });
  }

  const pendingWaits = input.awaiting.filter((relay) => relay.state !== 'prompt');
  if (pendingWaits.length === 1) {
    badges.push({
      tone: 'awaiting',
      key: 'badgeAwaiting',
      params: { alias: input.aliasOf(pendingWaits[0].to) },
      titleKey: 'awaitingTitle',
      count: 1,
    });
  } else if (pendingWaits.length > 1) {
    badges.push({
      tone: 'awaiting',
      key: 'badgeAwaitingMany',
      params: { count: pendingWaits.length },
      titleKey: 'awaitingTitle',
      count: pendingWaits.length,
    });
  }

  if (input.owed.length === 1) {
    badges.push({
      tone: 'owed',
      key: 'badgeOwed',
      params: { alias: input.aliasOf(input.owed[0].from) },
      titleKey: 'owedTitle',
      count: 1,
    });
  } else if (input.owed.length > 1) {
    badges.push({
      tone: 'owed',
      key: 'badgeOwedMany',
      params: { count: input.owed.length },
      titleKey: 'owedTitle',
      count: input.owed.length,
    });
  }

  return badges;
}

/**
 * The one line the chat surface shows above the transcript, or null.
 *
 * The strip has room for a sentence, not a row of chips, so it takes the first
 * badge {@link resolveRelayBadges} produced and renders its `strip*` wording.
 * Same precedence, so the strip and the roster never disagree about which relay
 * matters most.
 */
export function resolveRelayStrip(badges: RelayBadge[]): RelayBadge | null {
  if (badges.length === 0) return null;
  const [first] = badges;
  const stripKey =
    first.tone === 'held'
      ? first.count > 1
        ? 'stripHeldMany'
        : 'stripHeld'
      : first.tone === 'blocked'
      ? first.count > 1
        ? 'stripBlockedByPromptMany'
        : 'stripBlockedByPrompt'
      : first.tone === 'prompt'
      ? 'stripPrompt'
      : first.tone === 'owed'
        ? 'stripOwed'
        : first.count > 1
          ? 'stripAwaitingMany'
          : 'stripAwaiting';
  return { ...first, key: stripKey };
}
