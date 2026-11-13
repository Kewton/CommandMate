/**
 * The pane an answer was decided for, carried as a value from the frame it was
 * decided on to everything the answer does afterwards (Issue #4304 F1-a, the
 * contract after §6-6: "BoundFrame から作る名目的な回答コンテキストを、送信の
 * 成功・失敗・記録・再開まで必須で運ぶ").
 *
 * Two halves:
 *
 * - {@link PaneAnswerContext}: made only from a {@link BoundFrame} (the frame
 *   `captureBoundFrame` confirmed), so it names the generation G the answer's
 *   screen was read from, the session it was read for, and that frame. It is
 *   never re-pointed at a later pane H: nothing here takes a generation.
 * - {@link applyWhilePaneIsCurrent}: the one entry through which an answer acts
 *   on the instance's CURRENT state (a dedup key, a task event, a waiting
 *   episode, a response-poll restart, a partial-answer hold). It reads the
 *   session's pane AFTER every await the caller made, compares it with the
 *   context's G, asks the caller's own ownership conditions again, and only then
 *   runs the effect — synchronously, so no await can come between that look and
 *   the write. A look taken earlier (a bool, an epoch) is not accepted: the
 *   entry takes the context, not a verdict.
 *
 * What an answer did to its own pane in the past — an audit row, a ledger line,
 * a stored strict operation, a stored row it answered — is history and is
 * written whether or not the session still shows G. It never resolves H's state.
 *
 * @module lib/session/pane-answer-context
 */

import { checkPaneGeneration, type BoundFrame, type PaneGeneration } from '@/lib/session/cli-session';

/** Type-only brand: a context is made by {@link paneAnswerContextOf} and nowhere else. */
declare const paneAnswerContextBrand: unique symbol;

/**
 * The pane an answer was decided for (Issue #4304 F1-a): the generation G, the
 * session it was read for, and the bound frame the answer was decided on.
 */
export interface PaneAnswerContext {
  readonly [paneAnswerContextBrand]: true;
  readonly sessionName: string;
  readonly generation: PaneGeneration;
  /** The frame the answer was decided on, bound to {@link generation}. */
  readonly frame: BoundFrame;
}

/**
 * The context of an answer decided on `frame`: its generation, the frame
 * itself, and the session the answer is addressed to — the session `frame`
 * was read for (`captureBoundFrame` resolves the same name the answer's keys
 * go to; given apart only because a worktree target names it indirectly).
 */
export function paneAnswerContextOf(frame: BoundFrame, sessionName: string = frame.sessionName): PaneAnswerContext {
  return Object.freeze({
    sessionName,
    generation: frame.generation,
    frame,
  }) as unknown as PaneAnswerContext;
}

/**
 * An effect on the current state, run synchronously inside
 * {@link applyWhilePaneIsCurrent}. Its return type is `undefined`, not `void`:
 * an `async` function (whose `Promise` would let an await slip in after the
 * look) does not type-check as one.
 */
export type CurrentPaneEffect = () => undefined;

/** What {@link applyWhilePaneIsCurrent} saw when it looked. */
export type CurrentPaneVerdict =
  /** The session shows G (alive, or — when allowed — dead) and the caller still owns it: the effect ran. */
  | 'applied'
  /** The session shows another pane, none, or one that could not be read: nothing ran. */
  | 'pane-moved'
  /** G is still there but the caller's own conditions (tick, grant, epoch, …) no longer hold: nothing ran. */
  | 'not-owned';

export interface CurrentPaneOptions {
  /**
   * Whether G, dead, still counts as the answered pane: an answer that ended
   * the agent leaves its own pane dead (agy's `No, exit`, a `y` that ends a
   * session). Never another pane.
   */
  allowDead: boolean;
  /**
   * The caller's ownership conditions, asked after the pane look (the last
   * await) and before the effect: the poller tick, the grant, the session
   * epoch, … — kept, never replaced by the pane look.
   */
  owned: () => boolean;
}

/**
 * Run `effect` on the current state only when the session still shows the
 * pane `context` names and the caller still owns it, looked at now — after
 * every await the caller made before calling this (Issue #4304 F1-a, §3.3-3).
 * Never throws for the look itself: a pane that cannot be read is
 * `pane-moved`.
 */
export async function applyWhilePaneIsCurrent(
  context: PaneAnswerContext,
  options: CurrentPaneOptions,
  effect: CurrentPaneEffect,
): Promise<CurrentPaneVerdict> {
  let check;
  try {
    check = await checkPaneGeneration(context.sessionName, context.generation);
  } catch {
    check = 'generation-unreadable' as const;
  }
  if (!(check === 'same' || (options.allowDead && check === 'pane-dead'))) return 'pane-moved';
  if (!options.owned()) return 'not-owned';
  effect();
  return 'applied';
}

// ===========================================================================
// What a send did (§3.3-1): one boundary for every way it ends
// ===========================================================================

/**
 * Where a keystroke answer's pane comes from.
 *
 * - `pane`: the caller decided the answer on a bound frame — every production
 *   answer path (`/prompt-response`, `/respond`, the Auto-Yes tick, the canary).
 * - `sender-bound`: a direct caller of the Auto-Yes step with no frame of its
 *   own (unit tests of `detectAndRespondToPrompt`; the poller's tick always
 *   hands its bound frame over). The sender binds the answer to the pane it
 *   confirms itself, and keys go only there, but the caller holds no G: what it
 *   does to the current state is not looked at again, as before #4304. A
 *   guard holds the tick to `pane`.
 */
export type AnswerOrigin =
  | { readonly kind: 'pane'; readonly context: PaneAnswerContext }
  | { readonly kind: 'sender-bound'; readonly sessionName: string };

/** Type-only brand: a delivery is made by {@link deliverAnswer} and nowhere else. */
declare const answerDeliveryBrand: unique symbol;

/**
 * What a keystroke answer did to its pane (§3.3-1), carried with its
 * {@link AnswerOrigin} to everything after it:
 *
 * - `not-sent`: known to have typed nothing (every refusal before the first
 *   key — the pane, the foreground, the input ticket, the contract, the
 *   dialog's own rules — and a transport refusal before it started).
 * - `sent`: every key went out.
 * - `partial`: some keys are on the pane and the rest were not sent.
 * - `indeterminate`: a tmux call ended without an exit status (its key may be
 *   there: `transport: 'indeterminate'`), or the failure said nothing of what
 *   it did (`transport: 'unreported'`, a non-Error throw among them).
 *
 * Only an `AnswerOrigin` reaches `sent` / `partial` / `indeterminate`: there is
 * no "unconfirmed" origin, so a pane that was never confirmed cannot produce
 * one. The refusal of an answer that never got a context (its capture could
 * not be bound) is answered before any delivery and is not one.
 */
export type AnswerDelivery = { readonly [answerDeliveryBrand]: true; readonly origin: AnswerOrigin } & (
  | { readonly kind: 'not-sent'; readonly error: unknown }
  | { readonly kind: 'sent' }
  | { readonly kind: 'partial'; readonly error: unknown }
  | {
      readonly kind: 'indeterminate';
      readonly transport: 'indeterminate' | 'unreported';
      /** A key is known to be on the pane before the failure whose outcome is not known. */
      readonly keysOnPane: boolean;
      readonly error: unknown;
    }
);

/** The answer refusals that are known to have typed nothing, whatever they carry. */
const REFUSED_BEFORE_ANY_KEY = new Set([
  'PromptAnswerRejectedError',
  'FreeTextAnswerRejectedError',
  'FreeTextAtChoiceOnlyPromptError',
]);

function classify(origin: AnswerOrigin, error: unknown): AnswerDelivery {
  const make = (fields: object): AnswerDelivery => Object.freeze({ origin, ...fields }) as AnswerDelivery;
  if (!(error instanceof Error)) {
    return make({ kind: 'indeterminate', transport: 'unreported', keysOnPane: false, error });
  }
  const keysSent = 'keysSent' in error ? (error as { keysSent?: unknown }).keysSent : undefined;
  const transport = 'answerDelivery' in error ? (error as { answerDelivery?: unknown }).answerDelivery : undefined;
  if (transport === 'indeterminate') {
    return make({ kind: 'indeterminate', transport: 'indeterminate', keysOnPane: keysSent === true, error });
  }
  if (keysSent === true) return make({ kind: 'partial', error });
  if (keysSent === false || REFUSED_BEFORE_ANY_KEY.has(error.name)) return make({ kind: 'not-sent', error });
  return make({ kind: 'indeterminate', transport: 'unreported', keysOnPane: false, error });
}

/**
 * Send an answer and say what it did — the one place a send's `void` or its
 * throw is read (§3.3-1: "全 throw を一つの内部境界で正規化"). Never throws.
 * The sender's `keysSent` / `answerDelivery` are read here and nowhere after:
 * every later step reads the delivery.
 */
export async function deliverAnswer(origin: AnswerOrigin, send: () => Promise<void>): Promise<AnswerDelivery> {
  try {
    await send();
  } catch (error: unknown) {
    return classify(origin, error);
  }
  return Object.freeze({ origin, kind: 'sent' as const }) as AnswerDelivery;
}

/** Whether a delivery may have left keys on the pane: a hold must be kept. */
export function deliveryMayBeOnPane(delivery: AnswerDelivery): boolean {
  return delivery.kind === 'partial' || (delivery.kind === 'indeterminate' && delivery.transport === 'indeterminate');
}

/** The generation a delivery's keys went to; null for `sender-bound` (the caller holds none). */
export function deliveryGeneration(delivery: AnswerDelivery): PaneGeneration | null {
  return delivery.origin.kind === 'pane' ? delivery.origin.context.generation : null;
}

/**
 * {@link applyWhilePaneIsCurrent} for an answer's origin. `sender-bound` (a
 * direct caller with no frame, never the tick) is not looked at again, as
 * before #4304: only the caller's own conditions are asked.
 */
export async function applyWhileAnswerPaneIsCurrent(
  origin: AnswerOrigin,
  options: CurrentPaneOptions,
  effect: CurrentPaneEffect,
): Promise<CurrentPaneVerdict> {
  if (origin.kind === 'pane') return applyWhilePaneIsCurrent(origin.context, options, effect);
  if (!options.owned()) return 'not-owned';
  effect();
  return 'applied';
}
