/**
 * Ownership and readiness under the instance input lock (Issue #4056: split out
 * of `submit-verified-sender.ts`): {@link assertInputOwner} before every key,
 * and the tool's readiness asked again of the frames read under the lock.
 *
 * Sends no key. Imports nothing from `submit-verified-sender.ts`.
 */

import type { CLIToolType } from './types';
import { recheckComposerBeforeInput } from '@/lib/session/composer-clear';
import type { InstanceInputTicket } from '@/lib/session/instance-input-lock';
import {
  INPUT_READINESS_UNDER_LOCK_POLL_MS,
  INPUT_READINESS_UNDER_LOCK_WAIT_MS,
  logger,
  type InputReadiness,
} from './submit-verified-sender-shared';

/** What {@link beforeDeadline} answers when the deadline came first. */
export const DEADLINE_PASSED = Symbol('deadline-passed');

/**
 * `read`'s value, or {@link DEADLINE_PASSED} when `deadline` (epoch ms) comes
 * first. A rejection that arrives in time is thrown; one that arrives later is
 * dropped with the read (Issue #4040).
 */
export async function beforeDeadline<T>(read: Promise<T>, deadline: number): Promise<T | typeof DEADLINE_PASSED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof DEADLINE_PASSED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_PASSED), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([read, expired]);
  } finally {
    clearTimeout(timer);
    read.catch(() => undefined);
  }
}

export function isReadyFrame(readiness: InputReadiness, frame: string): boolean {
  try {
    return readiness.isReady(frame);
  } catch {
    return false;
  }
}

/**
 * The newest frame under the lock that passes the tool's readiness test
 * (Issue #4040), or a refusal before any key.
 *
 * The refusal does not quote the frame: `classifySendFailure` reads this
 * wording, and a screen saying `submit could not be confirmed` would turn it
 * into `indeterminate`.
 *
 * @throws Error `<label> prompt not ready …` (`not-sent` / `prompt-not-ready`);
 *   the re-check's own refusals (dialog, unreadable pane); a lost lock
 */
export async function awaitReadyUnderLock(
  readiness: InputReadiness | undefined,
  frame: string,
  params: { sessionName: string; cliToolId: CLIToolType; ticket: InstanceInputTicket }
): Promise<string> {
  if (readiness === undefined || isReadyFrame(readiness, frame)) return frame;
  const { sessionName, cliToolId, ticket } = params;
  const deadline = Date.now() + INPUT_READINESS_UNDER_LOCK_WAIT_MS;
  for (;;) {
    const beforeSleep = deadline - Date.now();
    if (beforeSleep <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(INPUT_READINESS_UNDER_LOCK_POLL_MS, beforeSleep)));
    if (Date.now() >= deadline) break;
    assertInputOwner(ticket, cliToolId, 'the readiness re-read', false);
    const current = await beforeDeadline(recheckComposerBeforeInput(sessionName, cliToolId), deadline);
    // A frame read after the deadline is not taken: the wait is over.
    if (current === DEADLINE_PASSED || Date.now() > deadline) break;
    if (isReadyFrame(readiness, current)) return current;
  }
  logger.warn('input-readiness-not-ready-under-lock', { sessionName, cliToolId });
  throw new Error(
    `${readiness.label} prompt not ready under the input lock: ` +
      `no input prompt within ${INPUT_READINESS_UNDER_LOCK_WAIT_MS}ms, so nothing was typed (Issue #4040)`
  );
}

/**
 * Throw unless `ticket` still owns the composer (Issue #3945 stage 3). Called
 * right before every key a send sends — body, paste, each Enter — so work still
 * in flight after its ownership ended cannot reach the next owner's composer.
 *
 * @param typed - Whether any of the body may already be in the composer, which
 *   decides how the failure classifies (`not-sent` before the body only).
 */
export function assertInputOwner(ticket: InstanceInputTicket, cliToolId: CLIToolType, step: string, typed: boolean): void {
  if (ticket.isCurrent()) return;
  logger.error('input-lock-lost', { sessionName: ticket.sessionName, cliToolId, step, generation: ticket.generation });
  if (!typed) {
    throw new Error(
      `Session ${ticket.sessionName} was handed to another writer before ${step}; input lock lost, nothing was typed (Issue #3945).`
    );
  }
  throw new Error(
    `Session ${ticket.sessionName} was handed to another writer before ${step}; part of the message may be in its composer (Issue #3945).`
  );
}
