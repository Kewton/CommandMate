/**
 * What one key of a strict answer did (Issue #4304 F1-a, §3.3-1): the one
 * place every way `StrictRespondDeps.sendKey` can end is turned into a
 * delivery, so `strict-respond` counts only keys that may have reached tmux.
 *
 * Before this, only the pane-generation refusal said "not sent"; the input
 * ticket's refusals before the key (#3952) were plain `Error`s and counted as a
 * key that may have gone — code 41, a `prompt_answered_human` row and the
 * launch's trust debt dropped for an answer with nothing on the pane.
 *
 * @module lib/prompt-observation/strict-key-delivery
 */

/** Why a strict key was refused before tmux was asked to type it. */
export type StrictKeyRefusal =
  /** The session no longer shows the pane the answer's reads were of. */
  | 'generation-mismatch'
  /** Which pane the session shows could not be read. */
  | 'generation-unreadable'
  /** The pane the reads were of is dead. */
  | 'pane-dead'
  /** The session's input ticket the answer held is no longer current (a relaunch took it, #3952). */
  | 'input-ticket-lost'
  /** No read fixed the answer's pane before this key: there is no pane to send it to. */
  | 'no-read'
  /** The tmux transport refused before it started (`TmuxSendError`, `not-started`). */
  | 'transport-not-started';

/**
 * A strict key refused before it was sent: nothing of THIS key reached tmux.
 * Thrown by the session I/O's `sendKey` for every refusal it makes before the
 * key (`StrictKeyRefusal`).
 */
export class StrictKeyNotSentError extends Error {
  readonly keysSent = false as const;

  constructor(
    sessionName: string,
    readonly refusal: StrictKeyRefusal,
  ) {
    super(
      refusal === 'input-ticket-lost'
        ? `Session ${sessionName} was replaced while the strict answer held its input; the key was not sent (Issue #3952, #4304)`
        : `The strict answer's key to ${sessionName} was not sent (${refusal}, Issue #4304)`,
    );
    this.name = 'StrictKeyNotSentError';
  }
}

/** What one key did. */
export type StrictKeyDelivery =
  | { readonly kind: 'sent' }
  /** Known not to have reached tmux. */
  | { readonly kind: 'not-sent'; readonly refusal: StrictKeyRefusal }
  /** Failed in a way that may have left the key on the pane (a transport failure, a non-Error throw, …). */
  | { readonly kind: 'indeterminate'; readonly cause: unknown };

/** The transport's own "nothing was started" (by name: test doubles of tmux need not export the class). */
function isTransportNotStarted(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'TmuxSendError' &&
    (error as { delivery?: unknown }).delivery === 'not-started' &&
    !((error as { keysDelivered?: unknown }).keysDelivered as number > 0)
  );
}

/** Send one key and say what it did. Never throws. */
export async function deliverStrictKey(send: () => Promise<void>): Promise<StrictKeyDelivery> {
  try {
    await send();
    return { kind: 'sent' };
  } catch (error: unknown) {
    if (error instanceof StrictKeyNotSentError) return { kind: 'not-sent', refusal: error.refusal };
    if (isTransportNotStarted(error)) return { kind: 'not-sent', refusal: 'transport-not-started' };
    return { kind: 'indeterminate', cause: error };
  }
}
