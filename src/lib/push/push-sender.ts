/**
 * Web Push fan-out (Issue #1125).
 *
 * Thin layer over detection: given an agent event (prompt-waiting / completion /
 * failure, Issue #2000), fan out a minimal notification to every opted-in
 * subscription. Expired
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
import type { WaitingKind } from '@/lib/session/waiting-kind';
import { getVapidConfig } from './vapid';
import { shouldSendNotification, shouldSendWaitingPush } from './notification-dedup';

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

/**
 * Which failure signal raised a `kind: 'failure'` notification (Issue #2000).
 *
 * Declared here, next to the wording it selects, rather than in
 * `failure-push-notifier`: that module imports this one, and a type living the
 * other way round would be a cycle for no gain. Each value maps to exactly one
 * pair of dictionary keys, so a new signal cannot be added without deciding
 * what the phone should say about it.
 */
export type FailurePushReason =
  /** A verification run closed `failed` / `error` (`lib/verification/gate-runner`). */
  | 'verification-failed'
  /** An upstream (model API) fault signature appeared on the pane (#1839). */
  | 'upstream-fault'
  /** `SessionStartFailedError` — the CLI printed a terminal error while starting. */
  | 'session-start-failed';

/** What a failure notification is about (Issue #2000). */
export interface FailureContext {
  reason: FailurePushReason;
  /**
   * Identity of this failure episode. Never rendered — it replaces the excerpt
   * as the dedup content, so the guard keys off *which incident* this is rather
   * than off wording that changes between retries (a 529 banner carries an
   * attempt counter). Producers build it; see `failure-push-notifier`.
   */
  signature: string;
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
  /**
   * What the agent is waiting for (Issue #1790). Only meaningful for
   * `kind: 'prompt'`, and it changes the body rather than the kind: the reader
   * needs to know whether the notification can be answered from the app
   * (`'prompt'`) or only at the terminal (`'menu'` / `'unclassified'`).
   */
  waitingKind?: WaitingKind | null;
  /**
   * The waiting episode this notification belongs to (#1786's `since`).
   *
   * Present, it makes the notification episode-scoped: dedup keys off it rather
   * than off the content hash, so one wait produces one notification no matter
   * which path reported it. Absent, the legacy 30 s content dedup applies.
   */
  waitingSince?: number | null;
  /** Instance id for the episode key; falls back to {@link agentName}. */
  instanceId?: string;
  /** True for the "still waiting" re-notification (Issue #1790). */
  escalated?: boolean;
  /**
   * Required for `kind: 'failure'` (Issue #2000), meaningless otherwise. It
   * chooses the body and supplies the dedup key — see {@link FailureContext}.
   */
  failure?: FailureContext;
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
  /**
   * Present only on waiting notifications (Issue #1790). Omitted — not null —
   * elsewhere, so a completion payload keeps the exact shape #1125 shipped.
   */
  waitingKind?: WaitingKind;
}

/** Collapse whitespace and truncate to a single short line. Never the full terminal. */
export function buildExcerpt(text: string | undefined, maxLength = MAX_EXCERPT_LENGTH): string {
  if (!text) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return collapsed.slice(0, maxLength - 1).trimEnd() + '…';
}

/**
 * Whether this wait can only be dealt with at the terminal (Issue #1790).
 *
 * A `menu` (selection list / pager) and an `unclassified` wait share the one
 * fact the reader acts on: tapping the notification will not present anything
 * to answer. `prompt` — and an absent kind, which is every pre-#1790 caller —
 * keeps the original "waiting for your reply" wording.
 */
function needsTerminal(waitingKind: WaitingKind | null | undefined): boolean {
  return waitingKind === 'menu' || waitingKind === 'unclassified';
}

/** The body for a waiting notification, in the reader's language. */
function buildWaitingBody(
  event: NotificationEvent,
  messages: typeof enNotifications.push,
  excerpt: string,
  now: number
): string {
  const terminal = needsTerminal(event.waitingKind);

  if (event.escalated) {
    // The excerpt is dropped on purpose: after ten minutes the question is no
    // longer news, the elapsed time is.
    const elapsedMs = now - (event.waitingSince ?? now);
    const minutes = String(Math.max(1, Math.floor(elapsedMs / 60_000)));
    return (terminal ? messages.stillWaitingTerminal : messages.stillWaitingPrompt).replace(
      '{minutes}',
      minutes
    );
  }

  if (terminal) {
    return excerpt
      ? messages.terminalAttentionWithExcerpt.replace('{excerpt}', excerpt)
      : messages.terminalAttention;
  }

  return excerpt
    ? messages.promptWaitingWithExcerpt.replace('{excerpt}', excerpt)
    : messages.promptWaiting;
}

/**
 * The body for a failure notification, in the reader's language (Issue #2000).
 *
 * Every wording names the failure explicitly ("不合格" / "failed", "障害" /
 * "fault", "起動できません" / "could not start") so the acceptance criterion —
 * a reader tells success from failure from the body alone — holds without
 * having to open the app. A `reason` nobody added copy for would be a type
 * error at {@link FAILURE_BODY_KEYS}, not a blank notification.
 */
const FAILURE_BODY_KEYS: Record<
  FailurePushReason,
  { withExcerpt: keyof typeof enNotifications.push; plain: keyof typeof enNotifications.push }
> = {
  'verification-failed': {
    withExcerpt: 'failureVerificationWithExcerpt',
    plain: 'failureVerification',
  },
  'upstream-fault': {
    withExcerpt: 'failureUpstreamWithExcerpt',
    plain: 'failureUpstream',
  },
  'session-start-failed': {
    withExcerpt: 'failureSessionStartWithExcerpt',
    plain: 'failureSessionStart',
  },
};

function buildFailureBody(
  event: NotificationEvent,
  messages: typeof enNotifications.push,
  excerpt: string
): string {
  // An event that claims `kind: 'failure'` without saying which failure is a
  // producer bug. Falling back to the verification wording would misreport it,
  // so the generic "something failed" copy is used instead.
  const reason = event.failure?.reason;
  if (reason === undefined) {
    return excerpt ? messages.failureWithExcerpt.replace('{excerpt}', excerpt) : messages.failure;
  }

  const keys = FAILURE_BODY_KEYS[reason];
  return excerpt
    ? messages[keys.withExcerpt].replace('{excerpt}', excerpt)
    : messages[keys.plain];
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
      ? buildWaitingBody(event, messages, excerpt, now)
      : event.kind === 'failure'
        ? buildFailureBody(event, messages, excerpt)
        : excerpt
          ? messages.completionWithExcerpt.replace('{excerpt}', excerpt)
          : messages.completion;

  return {
    kind: event.kind,
    title,
    body,
    worktreeId: event.worktreeId,
    url: `/worktrees/${event.worktreeId}`,
    // Unchanged by #1790, and deliberately: the escalation carries the same tag
    // as the notification it follows up, so the Service Worker replaces the
    // stale one instead of stacking a second card for the same wait.
    tag: `${event.worktreeId}:${event.kind}`,
    timestamp: now,
    ...(event.waitingKind ? { waitingKind: event.waitingKind } : {}),
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
 * Which guard applies to this event (Issue #1790).
 *
 * An episode-scoped waiting notification is deduped by the wait it belongs to;
 * everything else — every completion, and any prompt event that predates the
 * episode store — keeps the content hash and its 30 s window. Both record as
 * they decide, so this must be called exactly once per event.
 *
 * Issue #2000: a failure hashes its {@link FailureContext.signature} instead of
 * its excerpt. The producers already collapse a failure to one notification per
 * incident (`failure-push-notifier`), so this is the second net rather than the
 * first — but the excerpt is the wrong key for it either way: a retry storm
 * prints a different attempt counter every few seconds, which would defeat a
 * content hash, while two *distinct* incidents can share a line of prose.
 */
function passesDedup(event: NotificationEvent): boolean {
  if (event.kind === 'prompt' && typeof event.waitingSince === 'number') {
    return shouldSendWaitingPush({
      worktreeId: event.worktreeId,
      instanceId: event.instanceId ?? event.agentName ?? '',
      since: event.waitingSince,
      escalated: event.escalated,
    });
  }

  return shouldSendNotification({
    worktreeId: event.worktreeId,
    kind: event.kind,
    content: event.kind === 'failure' ? event.failure?.signature : event.excerpt,
  });
}

/**
 * Fan out a notification to all subscriptions opted into this event's kind.
 * Never throws — push is advisory and must not disrupt the poller. No-op when
 * push is unconfigured, deduped, or there are no matching subscriptions.
 *
 * `now` is injectable because the escalation body quotes how long the wait has
 * lasted (Issue #1790): the reminder is raised from a periodic check that knows
 * the tick's time, and reading the clock again here would report a different
 * elapsed time from the one that decided to send.
 */
export async function notifyPushSubscribers(
  event: NotificationEvent,
  now: number = Date.now()
): Promise<void> {
  try {
    const config = getVapidConfig();
    if (!config) return;

    if (!passesDedup(event)) return;

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
        const payload = JSON.stringify(buildPushPayload(event, locale, now));
        return Promise.all(subs.map((sub) => sendToOne(sub, payload)));
      })
    );
  } catch (err) {
    logger.warn('push-fanout-error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
