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
