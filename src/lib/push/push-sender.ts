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
 * `engines: ">=22.0.0"` still admits. The bodies only ever substitute a handful
 * of named placeholders — `{excerpt}`, `{minutes}` (#1790), `{agent}` /
 * `{version}` (#2045) — so a dependency-free replace covers them.
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
import { clearPushDeliveryHealth, recordPushDeliveryFailure } from './delivery-health';
import { shouldSendNotification, shouldSendWaitingPush } from './notification-dedup';
import { markPromptCardShown } from './prompt-card-state';

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
  /** `SessionStartFailedError`, or any other failed launch — the session never came up. */
  | 'session-start-failed'
  /**
   * `SessionStartUnavailableError` — the CLI is not installed, so no session
   * could even be attempted (Issue #2009). Separate from the line above because
   * the remedy is different and the body has to say so: "install it", not "read
   * the pane".
   */
  | 'session-start-unavailable'
  /**
   * The agent's own server reported that a turn ended in an error
   * (Issue #2045). Today only opencode publishes such a frame — `session.error`,
   * raised from `sources/opencode/push`.
   *
   * Deliberately **not** folded into `upstream-fault`. That wording asserts an
   * upstream cause, and this signal does not establish one: opencode 1.18.22's
   * `session.error` carries any of eight error names (measured from its own
   * `GET /doc`, `docs/design/opencode-server-live-verification.md` §17), and
   * only `APIError` / `ProviderAuthError` are upstream. `UnknownError`,
   * `MessageOutputLengthError`, `StructuredOutputError`, `ContextOverflowError`
   * and `ContentFilterError` are local to the run, so the copy names the fact
   * the frame does establish — the agent stopped — and lets the excerpt (the
   * agent's own `error.data.message`) say which.
   */
  | 'agent-session-error';

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
  /**
   * This event *ends* a wait rather than opening one (Issue #2001).
   *
   * It rides on `kind: 'prompt'` deliberately, so it reaches exactly the
   * devices that were told about the wait and carries exactly the `tag` their
   * stale card has. Only `resolution-push-notifier` sets it; see that module
   * and `docs/design/cross-device-notification-dismissal.md` for why the
   * resolution is a *displayed* notification and not a silent close.
   */
  resolved?: boolean;
  /**
   * A newer build of the agent CLI exists (Issue #2045).
   *
   * Rides on `kind: 'completion'` and is meaningless on the other two, which is
   * the honest bucket for it: nothing is blocked and nobody has to act, so it
   * belongs to the same opt-in toggle (`enabled_completion`) an ordinary
   * completion does rather than to the "you need to act" one. Set, it replaces
   * the completion body — "Done: …" would be a lie about a notice that reports
   * no work at all.
   *
   * It shares the completion `tag`, so an update notice and a completion card
   * replace each other on the device. Deliberate: both are informational, the
   * notice is raised at most once per subscription, and giving it a tag of its
   * own would let a stale "1.19.0 is available" outlive the update itself.
   *
   * Producers: `sources/opencode/push`, from `installation.update-available`.
   */
  updateAvailable?: {
    /** The instance the notice is about — `opencode`, `opencode-2`, …. */
    agent: string;
    /** The version opencode says is available (`properties.version`). */
    version: string;
  };
  /**
   * Where tapping this notification goes (Issue #2022).
   *
   * Omitted — which is every caller that shipped before #2022 — the target is
   * `/worktrees/<worktreeId>`, unchanged. It is set only by a producer whose
   * subject is not a worktree row: Assistant Chat is scoped to a repository and
   * lives at `/chat`, so the derived URL would point at a worktree page that
   * does not exist.
   *
   * The `tag` is deliberately NOT derived from it. A tag groups the cards a
   * Service Worker may replace, and that grouping is per subject
   * (`worktreeId:kind`), not per destination.
   */
  url?: string;
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
  /**
   * Present only on a resolution push (Issue #2001), and omitted rather than
   * `false` elsewhere so every payload that shipped before keeps its exact
   * shape. It is the Service Worker's whole instruction: close the stale cards
   * carrying {@link PushPayload.tag}, then show this one silently in their
   * place.
   */
  resolved?: true;
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
  'session-start-unavailable': {
    withExcerpt: 'failureSessionUnavailableWithExcerpt',
    plain: 'failureSessionUnavailable',
  },
  'agent-session-error': {
    withExcerpt: 'failureAgentSessionWithExcerpt',
    plain: 'failureAgentSession',
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
      ? // Issue #2001: the resolution's body replaces the stale card's, so it
        // has to answer the question that card asked. It quotes no excerpt —
        // the prompt is over, and repeating it would read as a new one.
        event.resolved === true
        ? messages.promptResolved
        : buildWaitingBody(event, messages, excerpt, now)
      : event.kind === 'failure'
        ? buildFailureBody(event, messages, excerpt)
        : // Issue #2045: an update notice is a completion by *bucket*, not by
          // content, so it is the one completion whose body is not "Done".
          event.updateAvailable
          ? messages.updateAvailable
              .replace('{agent}', event.updateAvailable.agent)
              .replace('{version}', event.updateAvailable.version)
          : excerpt
            ? messages.completionWithExcerpt.replace('{excerpt}', excerpt)
            : messages.completion;

  return {
    kind: event.kind,
    title,
    body,
    worktreeId: event.worktreeId,
    // Issue #2022: the worktree page is the default, not the only answer.
    url: event.url ?? `/worktrees/${event.worktreeId}`,
    // Unchanged by #1790, and deliberately: the escalation carries the same tag
    // as the notification it follows up, so the Service Worker replaces the
    // stale one instead of stacking a second card for the same wait.
    tag: `${event.worktreeId}:${event.kind}`,
    timestamp: now,
    ...(event.waitingKind ? { waitingKind: event.waitingKind } : {}),
    ...(event.resolved === true ? { resolved: true as const } : {}),
  };
}

/**
 * Send to one device, and record what happened where the reader can see it.
 *
 * The two failure handlings are UNCHANGED (Issue #2124 verifies that explicitly):
 * 404/410 removes the subscription because the push service says the endpoint is
 * gone, and every other status — 403 from APNs over a bad `sub`, the 4xx #2126 is
 * about — leaves the subscription alone, because a configuration mistake must
 * never delete a reader's subscription.
 *
 * What is new is that both outcomes now also land in `delivery-health`, keyed by
 * a hash of the endpoint, so `GET /api/push/subscriptions` can tell the device
 * "you are not receiving" instead of the failure ending in a server log the
 * phone's owner never reads.
 *
 * @returns True when the payload was accepted by the push service.
 */
async function sendToOne(
  sub: PushSubscriptionRecord,
  payload: string,
  now: number = Date.now()
): Promise<boolean> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload
    );
    // Only the recovery edge is logged: a device that was failing and is now
    // receiving again is the one success worth a line. Logging every success
    // would put one line per device per notification into the log.
    if (clearPushDeliveryHealth(sub.endpoint)) {
      logger.info('push-delivery-recovered');
    }
    return true;
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      // Subscription expired / unsubscribed at the push service — auto-remove.
      deletePushSubscriptionByEndpoint(getDbInstance(), sub.endpoint);
      recordPushDeliveryFailure(sub.endpoint, { statusCode, removed: true }, now);
      logger.info('push-subscription-removed', { statusCode });
      return false;
    }
    const health = recordPushDeliveryFailure(sub.endpoint, { statusCode: statusCode ?? null }, now);
    logger.warn('push-send-failed', {
      statusCode: statusCode ?? 'unknown',
      // Issue #2124: one 403 is a blip, a streak of them is a misconfigured
      // `CM_VAPID_SUBJECT`. The count is what tells the two apart in a log.
      consecutiveFailures: health.failureCount,
    });
    return false;
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
  // Issue #2001: a resolution is guarded by the card state instead, which is
  // exact — `resolution-push-notifier` clears the mark as it sends, so a second
  // resolution for the same card decides `no-card` and never reaches here.
  // Running the content hash for it would be worse than redundant: its key is
  // `${worktreeId}:prompt`, the same slot a legacy (pre-#1790) prompt event
  // uses, so the two would suppress each other on a 30 s window neither wants.
  if (event.resolved === true) return true;

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

    // Issue #2001: this is the only line in the process that knows a prompt card
    // is really going to reach a device — past the VAPID check, past the dedup,
    // past an empty subscription table. Recording it anywhere earlier would tell
    // `resolution-push-notifier` to clear cards that were never shown, which is
    // exactly the extra push Epic #2002 is trying not to spend. The resolution
    // itself does not mark; it clears, and it does so in its own module so each
    // direction has one writer.
    if (event.kind === 'prompt' && event.resolved !== true) {
      markPromptCardShown(event.worktreeId, now);
    }

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

    const outcomes = (
      await Promise.all(
        Array.from(byLocale, ([locale, subs]) => {
          const payload = JSON.stringify(buildPushPayload(event, locale, now));
          return Promise.all(subs.map((sub) => sendToOne(sub, payload, now)));
        })
      )
    ).flat();

    // Issue #2124: a fan-out that reached nobody used to be indistinguishable
    // from one that was never attempted — `push-send-failed` is per device and
    // sits below the default log level's attention, and success said nothing at
    // all. One line per fan-out names both halves, and no endpoint.
    //
    // Issue #2133: it also names *whose* fan-out it was. Without the subject,
    // two worktrees notifying in the same second print two identical lines, so
    // the UAT steps that pass by counting zero notifications
    // (`docs/qa/2001-cross-device-dismissal-uat.md` T-4 / T-6 / T-7) read a
    // neighbour's push as their own — which is what the Epic #2002 run hit on
    // 2026-08-29, and only the co-timed `resolution-push-sent` (which does carry
    // `worktreeId`) rescued the reading. A waiting push has no such partner.
    //
    // The key names match `resolution-push-notifier`'s context on purpose, so
    // both halves of one episode grep together. `instanceId` resolves exactly as
    // the episode dedup key above does, and is left absent — `JSON.stringify`
    // drops `undefined` — rather than logged as an empty string when no producer
    // named an instance.
    const delivered = outcomes.filter(Boolean).length;
    const failed = outcomes.length - delivered;
    logger.info('push-fanout-complete', {
      kind: event.kind,
      worktreeId: event.worktreeId,
      instanceId: event.instanceId ?? event.agentName,
      delivered,
      failed,
    });
  } catch (err) {
    logger.warn('push-fanout-error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
