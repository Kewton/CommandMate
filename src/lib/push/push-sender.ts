/**
 * Web Push fan-out (Issue #1125).
 *
 * Thin layer over detection: given an agent event (prompt-waiting / completion),
 * fan out a minimal notification to every opted-in subscription. Expired
 * endpoints (404/410 Gone) are auto-removed. This module NEVER logs endpoints or
 * VAPID secrets.
 *
 * Server-only: imports web-push (Node) and the DB. Do not import from client code.
 */

import webpush from 'web-push';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  getPushSubscriptionsForKind,
  deletePushSubscriptionByEndpoint,
  type PushSubscriptionRecord,
  type PushNotificationKind,
} from '@/lib/db/push-subscriptions-db';
import { createLogger } from '@/lib/logger';
import { getVapidConfig } from './vapid';
import { shouldSendNotification } from './notification-dedup';

const logger = createLogger('push/sender');

const MAX_EXCERPT_LENGTH = 120;

/** The agent event that triggers a notification. */
export interface NotificationEvent {
  worktreeId: string;
  worktreeName: string;
  kind: PushNotificationKind;
  /** CLI tool / agent identifier (e.g. "claude", "codex"). */
  agentName?: string;
  /** Short human-readable excerpt (prompt question or response tail). */
  excerpt?: string;
}

/** The JSON payload delivered to the Service Worker. Minimal by design. */
export interface PushPayload {
  kind: PushNotificationKind;
  title: string;
  body: string;
  worktreeId: string;
  url: string;
  tag: string;
  timestamp: number;
}

/** Collapse whitespace and truncate to a single short line. Never the full terminal. */
export function buildExcerpt(text: string | undefined, maxLength = MAX_EXCERPT_LENGTH): string {
  if (!text) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return collapsed.slice(0, maxLength - 1).trimEnd() + '…';
}

/** Build the minimal notification payload for an event. */
export function buildPushPayload(event: NotificationEvent, now: number = Date.now()): PushPayload {
  const excerpt = buildExcerpt(event.excerpt);
  const agentSuffix = event.agentName ? ` (${event.agentName})` : '';
  const title = `${event.worktreeName}${agentSuffix}`;
  const body =
    event.kind === 'prompt'
      ? excerpt
        ? `応答待ち: ${excerpt}`
        : '応答待ちです'
      : excerpt
        ? `完了: ${excerpt}`
        : 'セッションが完了しました';

  return {
    kind: event.kind,
    title,
    body,
    worktreeId: event.worktreeId,
    url: `/worktrees/${event.worktreeId}`,
    tag: `${event.worktreeId}:${event.kind}`,
    timestamp: now,
  };
}

async function sendToOne(
  sub: PushSubscriptionRecord,
  payload: string
): Promise<void> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload
    );
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      // Subscription expired / unsubscribed at the push service — auto-remove.
      deletePushSubscriptionByEndpoint(getDbInstance(), sub.endpoint);
      logger.info('push-subscription-removed', { statusCode });
      return;
    }
    logger.warn('push-send-failed', { statusCode: statusCode ?? 'unknown' });
  }
}

/**
 * Fan out a notification to all subscriptions opted into this event's kind.
 * Never throws — push is advisory and must not disrupt the poller. No-op when
 * push is unconfigured, deduped, or there are no matching subscriptions.
 */
export async function notifyPushSubscribers(event: NotificationEvent): Promise<void> {
  try {
    const config = getVapidConfig();
    if (!config) return;

    if (!shouldSendNotification({ worktreeId: event.worktreeId, kind: event.kind, content: event.excerpt })) {
      return;
    }

    const db = getDbInstance();
    const subscriptions = getPushSubscriptionsForKind(db, event.kind);
    if (subscriptions.length === 0) return;

    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    const payload = JSON.stringify(buildPushPayload(event));

    await Promise.all(subscriptions.map((sub) => sendToOne(sub, payload)));
  } catch (err) {
    logger.warn('push-fanout-error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
