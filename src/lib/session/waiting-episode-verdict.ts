/**
 * The T table (Issue #3798, design §2.4): what one turn transition's outcome
 * does to the open waiting episode. Pure — it reads the outcome, the episode's
 * binding and the current generation, and writes nothing. Applying the verdict
 * is `waiting-episode-binding`'s job (Issue #3864 split it out of there).
 *
 * Design: `docs/design/issue-3798-waiting-episode.md`.
 *
 * @module lib/session/waiting-episode-verdict
 */

import type { TurnTransitionOutcome } from '@/lib/session/agent-event-turn';
import type { EpisodeBinding, GenerationRef, WaitingCloseReason } from '@/lib/session/waiting-episode-state';

export function sameGeneration(a: GenerationRef, b: GenerationRef): boolean {
  if (a.kind === 'none' || b.kind === 'none') return a.kind === b.kind;
  return a.at === b.at;
}

/** The T table's verdict for one outcome on one open episode. */
export type Verdict =
  | { action: 'close'; reason: WaitingCloseReason }
  | { action: 'rebind'; binding: EpisodeBinding }
  | { action: 'none' }
  /** A combination the table says cannot occur (※1 / ※5). Left alone, and logged. */
  | { action: 'unmatched' };

const NONE: Verdict = { action: 'none' };
const close = (reason: WaitingCloseReason): Verdict => ({ action: 'close', reason });

/** The previous record's turn id, for the D and F columns. Null for `none`. */
function previousTurnId(previous: Extract<TurnTransitionOutcome, { previous: unknown }>['previous']): string | null {
  return previous.kind === 'none' ? null : previous.turnId;
}

/** T1–T5: a turn opened. */
function verdictForOpened(
  outcome: Extract<TurnTransitionOutcome, { kind: 'opened' }>,
  binding: EpisodeBinding
): Verdict {
  const { previous, turnId: n, event } = outcome;
  const asTurnN: EpisodeBinding = { kind: 'turn', generation: outcome.generation, turnId: n };
  if (binding.kind === 'screen') return NONE;
  if (binding.kind === 'turn' && binding.turnId === n) return { action: 'unmatched' }; // ※1

  const p = previousTurnId(previous);
  const tookOverRecord = previous.kind === 'dialog-only' || previous.kind === 'display-only';
  // D: the record this turn took over (R3-4). Only T2 / T3 / T4 have one (※5).
  const isD = binding.kind === 'dialog-only' && binding.recordTurnId === p;

  // T5 (R1-9): a turn replaced while it was open ends every wait but a screen's.
  if (previous.kind === 'open-same-session' || previous.kind === 'open-other-session') {
    return isD ? { action: 'unmatched' } : close('turn-superseded');
  }
  // T4 (R2-4): a prompt ends them too; the turn model drops every decision here.
  if (event === 'user_prompt_submit') return close('turn-superseded');

  if (binding.kind === 'turn') return close('turn-superseded');
  if (binding.kind === 'dialog-only') {
    if (!isD) return close('turn-superseded');
    return tookOverRecord ? { action: 'rebind', binding: asTurnN } : { action: 'unmatched' }; // T1: ※5
  }
  // unattributed — F: nothing opened between the wait and this turn (R2-4).
  return binding.lastClosedTurnId === p ? { action: 'rebind', binding: asTurnN } : close('turn-superseded');
}

/** T9–T11: a stop with no turn open. */
function verdictForStopWithoutTurn(
  outcome: Extract<TurnTransitionOutcome, { kind: 'stop-without-turn' }>,
  binding: EpisodeBinding
): Verdict {
  const { previous } = outcome;
  const p = previousTurnId(previous);
  switch (previous.kind) {
    case 'closed':
      // T9: B (R1-2) and F (R2-1).
      if (binding.kind === 'turn' && binding.turnId === p) return close('turn-stop');
      if (binding.kind === 'unattributed' && binding.lastClosedTurnId === p) return close('turn-stop');
      if (binding.kind === 'dialog-only' && binding.recordTurnId === p) return { action: 'unmatched' }; // ※5
      return NONE;
    case 'dialog-only':
      // T10: D, F and G.
      if (binding.kind === 'dialog-only' && binding.recordTurnId === p) return close('turn-stop');
      if (binding.kind === 'unattributed') return close('turn-stop');
      return NONE;
    case 'display-only':
    case 'none':
      // T11: D (R3-4) and F.
      if (binding.kind === 'dialog-only' && binding.recordTurnId === p) return close('turn-stop');
      if (binding.kind === 'unattributed' && binding.lastClosedTurnId === p) return close('turn-stop');
      return NONE;
    default:
      // An open turn is `stopped` / `stop-rejected`, never this outcome.
      return { action: 'unmatched' };
  }
}

/** T19 / T20 and the rest of the generation fence. */
function verdictForGenerationFenced(
  outcome: Extract<TurnTransitionOutcome, { kind: 'generation-fenced' }>,
  binding: EpisodeBinding
): Verdict {
  // T19 / T20 (R2-8): a session start in the same process keeps a screen.
  if (outcome.source === 'session-start' && binding.kind === 'screen') {
    return sameGeneration(binding.generation, outcome.generation)
      ? NONE
      : { action: 'rebind', binding: { ...binding, generation: outcome.generation } };
  }
  return sameGeneration(binding.generation, outcome.generation) ? NONE : close('generation');
}

/** T7. */
function verdictForRestored(
  outcome: Extract<TurnTransitionOutcome, { kind: 'restored' }>,
  binding: EpisodeBinding
): Verdict {
  // T7: a wait opened under the discarded turn belongs to the one put back.
  return binding.kind === 'turn' && binding.turnId === outcome.discardedTurnId
    ? { action: 'rebind', binding: { ...binding, turnId: outcome.restoredTurnId } }
    : NONE;
}

/** T8. */
function verdictForStopped(
  outcome: Extract<TurnTransitionOutcome, { kind: 'stopped' }>,
  binding: EpisodeBinding
): Verdict {
  // T8.
  return binding.kind === 'turn' && binding.turnId === outcome.turnId ? close('turn-stop') : NONE;
}

/** T13. */
function verdictForSessionEnded(
  outcome: Extract<TurnTransitionOutcome, { kind: 'session-ended' }>,
  binding: EpisodeBinding
): Verdict {
  // T13.
  return binding.kind === 'turn' && binding.turnId === outcome.turnId ? close('turn-session-end') : NONE;
}

/** T15 / T16. */
function verdictForDecisionOpened(
  outcome: Extract<TurnTransitionOutcome, { kind: 'decision-opened' }>,
  binding: EpisodeBinding,
  current: GenerationRef
): Verdict {
  // T15 / T16 (R3-6): a dialog the hook reported for a wait the screen showed first.
  return outcome.recordKind === 'dialog-only' && binding.kind === 'unattributed'
    ? {
        action: 'rebind',
        binding: { kind: 'dialog-only', generation: current, recordTurnId: outcome.recordTurnId, sessionId: null },
      }
    : NONE;
}

/** T17 / T18. */
function verdictForDecisionAnswered(
  outcome: Extract<TurnTransitionOutcome, { kind: 'decision-answered' }>,
  binding: EpisodeBinding
): Verdict {
  // T17 / T18 (R3-3): an explicit answer that left nothing pending.
  if (outcome.before === 0 || outcome.remaining > 0) return NONE;
  const bound =
    (binding.kind === 'turn' && binding.turnId === outcome.recordTurnId) ||
    (binding.kind === 'dialog-only' && binding.recordTurnId === outcome.recordTurnId);
  return bound ? close('decision-settled') : NONE;
}

/** Rows that close a binding of another generation (the I column). */
const CLOSES_OTHER_GENERATION: ReadonlySet<TurnTransitionOutcome['kind']> = new Set([
  'opened',
  'stopped',
  'stop-without-turn',
  'session-ended',
]);

/** The T table (design §2.4): one outcome on the open episode. */
export function verdictForOutcome(
  outcome: TurnTransitionOutcome,
  binding: EpisodeBinding,
  current: GenerationRef
): Verdict {
  if (outcome.kind === 'generation-fenced') return verdictForGenerationFenced(outcome, binding);

  if (!sameGeneration(binding.generation, current)) {
    return CLOSES_OTHER_GENERATION.has(outcome.kind) ? close('generation') : NONE;
  }

  switch (outcome.kind) {
    case 'opened':
      return verdictForOpened(outcome, binding);
    case 'restored':
      return verdictForRestored(outcome, binding);
    case 'stopped':
      return verdictForStopped(outcome, binding);
    case 'stop-without-turn':
      return verdictForStopWithoutTurn(outcome, binding);
    case 'session-ended':
      return verdictForSessionEnded(outcome, binding);
    case 'decision-opened':
      return verdictForDecisionOpened(outcome, binding, current);
    case 'decision-answered':
      return verdictForDecisionAnswered(outcome, binding);
    case 'continued':
    case 'stop-rejected':
    case 'session-end-rejected':
    case 'none':
      // T6, T12, T14, T21.
      return NONE;
    default:
      outcome satisfies never;
      return NONE;
  }
}
