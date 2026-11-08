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
  | 'promote-record-only';

export type MemTransitionResult = { ok: true; next: MemState; reason?: MemCloseReason } | { ok: false };

/**
 * What a transition leads to from a state, or refused.
 *
 * - `close` of an open decision is a withdrawal; of a recorded one, refused (the screen closes it).
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
  }
}
