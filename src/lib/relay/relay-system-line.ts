/**
 * The one-line system rows a relay leaves in the requester's transcript (#2377).
 *
 * Exactly the mechanism Issue #2357 built for "the model changed": a row in
 * `chat_messages`, written in the readers' language, followed by the same
 * `message` frame `sendUserMessage` publishes. One write therefore reaches the
 * chat surface, the History tab and any transcript that happens to be open,
 * without a fourth history surface being invented for four sentences.
 *
 * Idempotent: the request id is `relay-sys:<relayId>:<kind>` and each row is
 * probed for before it is written, so a delivery that is retried — which the
 * pump does by design — does not stack four "waiting for the reply" lines.
 *
 * Never throws. A transcript line is the least important of a relay's three
 * effects, and it must not cost the delivery.
 *
 * @module lib/relay/relay-system-line
 */

import type Database from 'better-sqlite3';
import {
  createRelaySystemMessage,
  findMessageByRequestId,
  RELAY_SYSTEM_REQUEST_ID_PREFIX,
} from '@/lib/db/chat-db';
import { resolveReadersLocale } from '@/lib/push/model-change-push-notifier';
import { broadcastMessage } from '@/lib/ws-server';
import { buildRelaySystemLine, type RelaySystemLineKind } from '@/lib/relay/relay-messages';
import type { ResolvedRelaySession } from '@/lib/relay/relay-session-ref';
import { createLogger } from '@/lib/logger';

const logger = createLogger('relay-system-line');

/**
 * Write one system line into `target`'s transcript, once.
 *
 * @param db - Database
 * @param relayId - The ledger row the line is about
 * @param kind - Which of the four sentences
 * @param target - Whose transcript the line goes in (always the requester, A)
 * @param subject - Whose name the sentence carries (always the worker, B)
 * @param at - Epoch ms
 * @returns Whether a row was written by this call
 */
export function writeRelaySystemLine(
  db: Database.Database,
  relayId: string,
  kind: RelaySystemLineKind,
  target: ResolvedRelaySession,
  subject: ResolvedRelaySession,
  at: number = Date.now()
): boolean {
  const requestId = `${RELAY_SYSTEM_REQUEST_ID_PREFIX}${relayId}:${kind}`;
  try {
    if (findMessageByRequestId(db, target.worktreeId, requestId)) return false;

    const locale = resolveReadersLocale(db);
    const message = createRelaySystemMessage(db, {
      worktreeId: target.worktreeId,
      cliToolId: target.cliToolId,
      instanceId: target.instanceId,
      content: buildRelaySystemLine(locale, kind, subject.alias),
      relayId,
      kind,
      at,
    });

    try {
      broadcastMessage('message', {
        worktreeId: target.worktreeId,
        message: { ...message, cliToolId: target.cliToolId, instanceId: target.instanceId },
      });
    } catch (error) {
      // The row is already durable; a socket with no owner must not turn a
      // written line into a failure the caller reports.
      logger.warn('relay-system-line-broadcast-failed', {
        relayId,
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  } catch (error) {
    logger.warn('relay-system-line-failed', {
      relayId,
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
