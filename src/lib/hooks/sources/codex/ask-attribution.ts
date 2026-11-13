/**
 * codex's adapter for ask attribution (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §3・§3.6・§6 PR2).
 *
 * The chain, on codex's own records: the envelope on a `UserMessage` item →
 * that item's id and **its own record's** `thread_id` (I6) → the `turn_id` the
 * item carries → the `task_complete` of that `turn_id` → the turn's assistant
 * row (`codex-turn:<turn_id>`). The ledger and its state table are the shared
 * ones in `@/lib/ask/ask-correlation`, the same as claude's.
 *
 * ## What counts as the turn's close (Q1, the human decision of 2026-11-14)
 *
 * codex writes `task_complete` with a `turn_id` and no session (measured on the
 * Q3 record, 0.167.2, and on the 0.151.0 fixtures). It is taken as the close
 * only inside a window whose every session-bearing record names the session the
 * instance follows — the rollout of that session, the input checked against it
 * — and never from a window that names another session.
 *
 * ## What the turn's input set is (Q2)
 *
 * Every `UserMessage` of the turn, after the session check, one per native
 * identity (session + item id): two or more → `ambiguous/shared_turn` for every
 * ask among them. That an input folded into a running turn always shows up as a
 * `UserMessage` is not shown on a real record, so nothing is inferred beyond
 * them — no claude-style absorption (`markAskAbsorbed`) is called. An aborted
 * turn (`turn_aborted`) is not a close: the ask stays pending.
 *
 * ## Complete, not only closed (F4)
 *
 * `closed` says the turn ended, not that this read saw all of it. A turn is
 * complete for an ask only when the read also holds its `task_started`, no
 * unparseable line inside its span, and no item that named no session. An
 * overflowed turn (items dropped) is `body_truncated`, never a reply.
 *
 * Turns with no envelope cost nothing here: no database read, no write.
 *
 * Never throws: History is the reader's job, and the ledger never stops it.
 */

import type { AgentInstanceRef } from '../types';
import { createLogger } from '@/lib/logger';
import { codexTurnRequestId } from '@/types/agent-transcript';
import type { AskTurnState } from '@/lib/ask/ask-correlation';
import {
  CODEX_TURN_TRUNCATION_MARKER,
  type CodexAskInput,
  type CodexTurnAccumulator,
} from './transcript';

const logger = createLogger('lib/hooks/sources/codex/ask-attribution');

/** What one read saw besides its turns (`parseCodexRollout` / `buildCodexTurns`). */
export interface CodexAskWindow {
  /** Every turn of the window, oldest first. */
  readonly turns: readonly CodexTurnAccumulator[];
  /** Sessions named by the window's records (`CodexTurnBuild.windowSessionIds`). */
  readonly windowSessionIds: readonly string[];
  /** `CodexRolloutParse.malformedAfter`. */
  readonly malformedAfter: readonly number[];
}

/** One native input: the identity (session + item id) and where it was seen. */
interface CodexInputIdentity {
  readonly key: string;
  readonly input: CodexAskInput;
}

const NUL = '\u0000';

/** The identity of an input with an id; null for one with none (each such input is its own). */
function identityKey(input: CodexAskInput): string | null {
  return input.itemId ? `${input.sessionId ?? ''}${NUL}${input.itemId}` : null;
}

/**
 * The distinct inputs of a turn, in order (F2): repeats of one identity with
 * the same text are one; an input with no id is one of its own. `conflict` is
 * set when one identity comes back with another text, or after another input
 * came in between — its id alone then does not say which records answer it.
 */
function distinctInputs(turn: CodexTurnAccumulator): { inputs: CodexInputIdentity[]; conflict: boolean } {
  const inputs: CodexInputIdentity[] = [];
  const seen = new Map<string, CodexAskInput>();
  let conflict = false;
  let lastKey: string | null = null;
  let anonymous = 0;
  for (const input of turn.askInputs ?? []) {
    const key = identityKey(input);
    if (key === null) {
      anonymous += 1;
      inputs.push({ key: `${NUL}anonymous${NUL}${anonymous}`, input });
      lastKey = null;
      continue;
    }
    const earlier = seen.get(key);
    if (earlier) {
      if (earlier.text !== input.text || lastKey !== key) conflict = true;
      lastKey = key;
      continue;
    }
    seen.set(key, input);
    inputs.push({ key, input });
    lastKey = key;
  }
  return { inputs, conflict };
}

/** Whether an unparseable line sits inside the turn's span of records. */
function hasMalformedInside(turn: CodexTurnAccumulator, malformedAfter: readonly number[]): boolean {
  const first = turn.firstRecordIndex;
  const last = turn.lastRecordIndex;
  if (first === undefined || last === undefined) return malformedAfter.length > 0;
  return malformedAfter.some((at) => at > first && at <= last);
}

/**
 * Where a codex turn stands for an ask (§3.6 I5, Q1, Q2, F4). `closed` only for
 * a turn whose `task_complete` is in a window of the followed session alone,
 * read whole; everything else is `open` (pending). Never `interrupted`: an
 * aborted turn is not shown to settle (Q2).
 */
export function codexAskTurnState(
  turn: CodexTurnAccumulator,
  window: Pick<CodexAskWindow, 'windowSessionIds' | 'malformedAfter'>,
  currentSessionId: string | null,
  identityConflict = false,
): AskTurnState {
  if (identityConflict) return 'open';
  if (!turn.closed) return 'open';
  // F4: the opening mark is what says the window holds every input of the turn.
  if (!turn.started) return 'open';
  if ((turn.sessionlessItems ?? 0) > 0) return 'open';
  if (hasMalformedInside(turn, window.malformedAfter)) return 'open';
  // Q1: a sessionless close counts only in a window of the followed session alone.
  if (!currentSessionId) return 'open';
  if (window.windowSessionIds.length === 0) return 'open';
  if (window.windowSessionIds.some((id) => id !== currentSessionId)) return 'open';
  return 'closed';
}

/** Whether any turn here carries an envelope; the cheap check before any import. */
export function hasCodexAskEvidence(turns: readonly CodexTurnAccumulator[]): boolean {
  return turns.some((turn) => (turn.askInputs ?? []).some((input) => input.askId !== null));
}

/**
 * The askIds in `turns` the ledger has a reservation for under this destination
 * (I3): only their prompts lose the envelope on the way to History. Any failure
 * reads as "none" — the text then stays as the agent recorded it.
 */
export async function reservedCodexAskIds(
  target: AgentInstanceRef,
  turns: readonly CodexTurnAccumulator[],
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  for (const turn of turns) {
    for (const prompt of turn.prompts) if (prompt.askId) ids.add(prompt.askId);
  }
  if (ids.size === 0) return new Set();
  try {
    const [{ getDbInstance }, { getAskCorrelation }] = await Promise.all([
      import('@/lib/db/db-instance'),
      import('@/lib/db/ask-correlation-db'),
    ]);
    const db = getDbInstance();
    const instanceId = target.instanceId ?? target.cliToolId;
    return new Set(
      [...ids].filter((id) => {
        const row = getAskCorrelation(db, id);
        return row !== null
          && row.worktreeId === target.worktreeId
          && row.cliToolId === target.cliToolId
          && row.instanceId === instanceId;
      }),
    );
  } catch (error) {
    logger.warn('codex-ask-reservation-lookup-failed', {
      worktreeId: target.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Set();
  }
}

/**
 * Bind the envelopes of every turn in the window (oldest first) to the ledger —
 * all of them, not only those History still has to write (F3), so a turn read
 * before the send's outcome was saved settles on a later read of the same file.
 *
 * @param currentSessionId - The session the instance follows now
 *   (`resolveCodexSessionId`); a record of another session is rejected (M5)
 */
export async function bindCodexAskTurns(
  target: AgentInstanceRef,
  window: CodexAskWindow,
  currentSessionId: string | null,
): Promise<void> {
  if (!hasCodexAskEvidence(window.turns)) return;
  try {
    const [{ getDbInstance }, { findMessageByRequestId }, { bindAskSighting }] = await Promise.all([
      import('@/lib/db/db-instance'),
      import('@/lib/db/chat-db'),
      import('@/lib/ask/ask-correlation'),
    ]);
    const db = getDbInstance();
    const destination = {
      worktreeId: target.worktreeId,
      cliToolId: target.cliToolId,
      instanceId: target.instanceId ?? target.cliToolId,
    };
    const inSession = (sessionId: string | null): sessionId is string =>
      Boolean(sessionId) && Boolean(currentSessionId) && sessionId === currentSessionId;

    // F2・I9: each turn's distinct inputs, and an identity seen in two turns is a
    // conflict for both (its id alone does not say which turn answers it).
    const perTurn = window.turns.map((turn) => distinctInputs(turn));
    const turnsOfKey = new Map<string, Set<number>>();
    perTurn.forEach(({ inputs }, index) => {
      for (const { key } of inputs) {
        const set = turnsOfKey.get(key) ?? new Set<number>();
        set.add(index);
        turnsOfKey.set(key, set);
      }
    });

    // I8・I9 (F3): an envelope on two distinct native inputs of this read that
    // passed the session check is judged a duplicate before either turn's
    // completion — the earlier sighting only records its input.
    const inputsOfAsk = new Map<string, string[]>();
    perTurn.forEach(({ inputs }) => {
      for (const { key, input } of inputs) {
        if (!input.askId || !input.itemId || !inSession(input.sessionId)) continue;
        const keys = inputsOfAsk.get(input.askId) ?? [];
        if (!keys.includes(key)) keys.push(key);
        inputsOfAsk.set(input.askId, keys);
      }
    });

    for (let index = 0; index < window.turns.length; index += 1) {
      const turn = window.turns[index];
      const { inputs, conflict } = perTurn[index];
      const crossTurn = inputs.some(({ key }) => (turnsOfKey.get(key)?.size ?? 0) > 1);
      const baseState = codexAskTurnState(turn, window, currentSessionId, conflict || crossTurn);
      const turnKey = codexTurnRequestId(turn.turnId);
      const otherInputs = Math.max(0, inputs.length - 1);
      for (const { key, input } of inputs) {
        if (!input.askId || !input.itemId) continue;
        const keys = inputsOfAsk.get(input.askId) ?? [];
        const firstOfSeveral = inSession(input.sessionId) && keys.length > 1 && keys[0] === key;
        const turnState = firstOfSeveral ? 'open' : baseState;
        const row = turnState === 'closed' ? findMessageByRequestId(db, target.worktreeId, turnKey) : null;
        const outcome = bindAskSighting(db, {
          askId: input.askId,
          target: destination,
          nativeInputId: input.itemId,
          // I6: the record's own session — never the turn's, the file's or the pointer.
          nativeSessionId: input.sessionId,
          currentSessionId,
          nativeTurnKey: turnKey,
          turnState,
          otherInputs,
          notices: 0,
          assistantMessage: row && row.role === 'assistant' ? { id: row.id, content: row.content } : null,
          truncated: turn.overflowed || (row ? row.content.endsWith(CODEX_TURN_TRUNCATION_MARKER) : false),
        });
        logger.debug('codex-ask-sighting', { askId: input.askId, itemId: input.itemId, turnId: turn.turnId, outcome });
      }
    }
  } catch (error) {
    logger.warn('codex-ask-bind-failed', {
      worktreeId: target.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
