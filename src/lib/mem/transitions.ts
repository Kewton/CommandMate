/**
 * The state tables of §3 as functions (Issue #4221). A writes `open` and `closed`
 * only; `recorded` / `promoted` belong to the screen path of #4225, and the checks
 * for them are here so that path has one place to ask.
 *
 * @module lib/mem/transitions
 */

import type { MemCloseReason, MemKind, MemState } from '@/types/mem';

export type MemTransition =
  | 'update'
  | 'close'
  | 'condition'
  | 'record'
  | 'promote'
  | 'promote-record-only'
  /**
   * Issue #4227 (S-D): a person closes a recorded decision without reflecting it
   * (`recorded → closed`, `withdrawn`). Only the screen's close with the person's
   * explicit confirmation asks for it (`memWriteFromScreen`); `close` still refuses.
   */
  | 'withdraw-recorded';

export type MemTransitionResult = { ok: true; next: MemState; reason?: MemCloseReason } | { ok: false };

/**
 * What a transition leads to from a state, or refused.
 *
 * - `close` of an open decision is a withdrawal; of a recorded one, refused (the screen closes it
 *   with `withdraw-recorded`, Issue #4227).
 * - `condition` never closes a decision before it is promoted (it stays as not yet reflected).
 */
export function memTransition(kind: MemKind, state: MemState, transition: MemTransition): MemTransitionResult {
  if (state === 'closed') return { ok: false };
  if (kind !== 'decision') {
    if (state !== 'open') return { ok: false };
    switch (transition) {
      case 'update':
        return { ok: true, next: 'open' };
      case 'close':
        return { ok: true, next: 'closed', reason: 'manual' };
      case 'condition':
        return { ok: true, next: 'closed', reason: 'condition' };
      default:
        return { ok: false };
    }
  }
  switch (transition) {
    case 'update':
      return state === 'open' ? { ok: true, next: 'open' } : { ok: false };
    case 'close':
      if (state === 'open') return { ok: true, next: 'closed', reason: 'withdrawn' };
      if (state === 'promoted') return { ok: true, next: 'closed', reason: 'manual' };
      return { ok: false };
    case 'condition':
      return state === 'promoted' ? { ok: true, next: 'closed', reason: 'condition' } : { ok: false };
    case 'record':
      return state === 'open' ? { ok: true, next: 'recorded' } : { ok: false };
    case 'promote':
      return state === 'recorded' ? { ok: true, next: 'promoted' } : { ok: false };
    case 'promote-record-only':
      return state === 'open' ? { ok: true, next: 'promoted' } : { ok: false };
    case 'withdraw-recorded':
      return state === 'recorded' ? { ok: true, next: 'closed', reason: 'withdrawn' } : { ok: false };
  }
}

/** What the screen offers on a row (Issue #4227, the screen's rule (5)): read off {@link memTransition}. */
export interface MemScreenActions {
  /** `update` leads somewhere from this state. */
  edit: boolean;
  /**
   * The close the row offers, or null. `withdraw-recorded` is a recorded decision's
   * (the two-step confirmation); `withdraw` names a close that leaves as `withdrawn`.
   */
  close: { transition: 'close' | 'withdraw-recorded'; withdraw: boolean } | null;
}

/**
 * The buttons of a row, derived from the transition table so the screen never offers
 * what the store refuses (a recorded decision is not edited; a promoted one closes as
 * `manual`, not as a withdrawal). `now` is the #2427 note's path: nothing here.
 * Pure (types only), so the client imports it.
 */
export function memScreenActions(kind: MemKind, state: MemState): MemScreenActions {
  if (kind === 'now') return { edit: false, close: null };
  const edit = memTransition(kind, state, 'update').ok;
  const close = memTransition(kind, state, 'close');
  if (close.ok) return { edit, close: { transition: 'close', withdraw: close.reason === 'withdrawn' } };
  if (kind === 'decision') {
    const recorded = memTransition(kind, state, 'withdraw-recorded');
    if (recorded.ok) return { edit, close: { transition: 'withdraw-recorded', withdraw: recorded.reason === 'withdrawn' } };
  }
  return { edit, close: null };
}
