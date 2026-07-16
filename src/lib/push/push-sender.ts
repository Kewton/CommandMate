/**
 * Web Push fan-out (Issue #1125).
 *
 * Thin layer over detection: given an agent event (prompt-waiting / completion),
 * fan out a minimal notification to every opted-in subscription. Expired
 * endpoints (404/410 Gone) are auto-removed. This module NEVER logs endpoints or
 * VAPID secrets.
 *
 * Server-only: imports web-push (Node) and the DB. Do not import from client code.
 *
 * Localization (Issue #1308): bodies are built here, in the background poller,
 * which has no request scope — so next-intl's request APIs are unavailable
 * (`getTranslations` outside the react-server condition is a stub that throws).
 * The locale therefore rides on the subscription row, captured at registration.
 *
 * The dictionaries are imported statically and interpolated by hand rather than
 * via next-intl's `createTranslator`: this module is compiled to CommonJS for
 * `dist/server` (what `npm start` runs) and next-intl is ESM-only, so importing
 * it here would `require()` an ES module — fatal below Node 22.12, which our
 * `engines: ">=22.0.0"` still admits. These four strings only ever substitute
 * `{excerpt}`, so a dependency-free replace covers them.
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
import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from '@/config/i18n-config';
import enNotifications from '../../../locales/en/notifications.json';
import jaNotifications from '../../../locales/ja/notifications.json';
import { getVapidConfig } from './vapid';
import { shouldSendNotification } from './notification-dedup';

const logger = createLogger('push/sender');

const MAX_EXCERPT_LENGTH = 120;

/** The notification bodies, per locale. Keyed by SupportedLocale so a new locale
 *  fails the type check (and the dictionary guard test) instead of silently
 *  falling back to English. */
const PUSH_MESSAGES: Record<SupportedLocale, typeof enNotifications.push> = {
  en: enNotifications.push,
  ja: jaNotifications.push,
};

/**
 * Narrow a stored subscription locale to one we can actually render.
 * Subscriptions registered before v42 have `locale = NULL` and land on
 * DEFAULT_LOCALE; they self-heal when the browser next re-registers.
 */
export function resolvePushLocale(locale: string | null | undefined): SupportedLocale {
  return isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
}

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

/** Build the minimal notification payload for an event, in the reader's language. */
export function buildPushPayload(
  event: NotificationEvent,
  locale: string | null | undefined = DEFAULT_LOCALE,
  now: number = Date.now()
): PushPayload {
  const excerpt = buildExcerpt(event.excerpt);
  const agentSuffix = event.agentName ? ` (${event.agentName})` : '';
  const title = `${event.worktreeName}${agentSuffix}`;
  const messages = PUSH_MESSAGES[resolvePushLocale(locale)];
  const body =
    event.kind === 'prompt'
      ? excerpt
        ? messages.promptWaitingWithExcerpt.replace('{excerpt}', excerpt)
        : messages.promptWaiting
      : excerpt
        ? messages.completionWithExcerpt.replace('{excerpt}', excerpt)
        : messages.completion;

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

    // Devices can be registered in different languages, so the body is built per
    // distinct locale rather than once for the whole fan-out.
    const byLocale = new Map<SupportedLocale, PushSubscriptionRecord[]>();
    for (const sub of subscriptions) {
      const locale = resolvePushLocale(sub.locale);
      const group = byLocale.get(locale);
      if (group) group.push(sub);
      else byLocale.set(locale, [sub]);
    }

    await Promise.all(
      Array.from(byLocale, ([locale, subs]) => {
        const payload = JSON.stringify(buildPushPayload(event, locale));
        return Promise.all(subs.map((sub) => sendToOne(sub, payload)));
      })
    );
  } catch (err) {
    logger.warn('push-fanout-error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
