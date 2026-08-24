/**
 * Push subscription management (Issue #1125).
 *
 *   GET    /api/push/subscriptions?endpoint=... — current per-type prefs for a device
 *   POST   /api/push/subscriptions               — register/refresh a subscription
 *   PATCH  /api/push/subscriptions               — update per-type prefs, and/or
 *                                                  acknowledge the defaults notice (#2056)
 *   DELETE /api/push/subscriptions               — unsubscribe this device
 *
 * Auth is enforced globally by middleware. Endpoints/keys are secrets and are
 * never logged (the module logger auto-masks, but we also avoid passing them).
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  upsertPushSubscription,
  getPushSubscriptionByEndpoint,
  updatePushSubscriptionPreferences,
  deletePushSubscriptionByEndpoint,
  pushSubscriptionNeedsDefaultsNotice,
  type PushSubscriptionRecord,
  type PushSubscriptionPreferenceUpdate,
} from '@/lib/db';
import { createLogger } from '@/lib/logger';
import { LOCALE_COOKIE_NAME, resolveLocale } from '@/config/i18n-config';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/push-subscriptions');

/**
 * The locale to notify this device in (Issue #1308).
 *
 * Registration is the last point where a request context exists — the poller
 * that later sends the push has none — so the reader's language is resolved here
 * and stored on the row. Uses the same resolver as `src/i18n.ts` so the push
 * body always matches the language the UI is rendered in.
 */
function localeFromRequest(request: Request): string {
  const cookieHeader = request.headers.get('cookie') ?? '';
  const cookieLocale = cookieHeader
    .split(';')
    .map((part) => part.trim().split('='))
    .find(([name]) => name === LOCALE_COOKIE_NAME)?.[1];

  return resolveLocale(
    cookieLocale && decodeURIComponent(cookieLocale),
    request.headers.get('accept-language')
  );
}

/**
 * Public view of a subscription — excludes the encryption keys.
 *
 * `defaultsNoticePending` (Issue #2056) is a sibling of `preferences`, not a
 * member of it: it is not something the reader sets, and the client compares
 * `preferences` against its own state. The raw `defaults_version` stays on the
 * server — the client has no use for the number, only for the verdict.
 */
function serialize(record: PushSubscriptionRecord) {
  return {
    endpoint: record.endpoint,
    deviceLabel: record.deviceLabel,
    preferences: {
      prompt: record.enabledPrompt,
      completion: record.enabledCompletion,
    },
    defaultsNoticePending: pushSubscriptionNeedsDefaultsNotice(record),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function GET(request: Request) {
  try {
    const endpoint = new URL(request.url).searchParams.get('endpoint');
    if (!isNonEmptyString(endpoint)) {
      return NextResponse.json({ error: 'endpoint is required' }, { status: 400 });
    }
    const record = getPushSubscriptionByEndpoint(getDbInstance(), endpoint);
    if (!record) {
      return NextResponse.json({ subscribed: false });
    }
    return NextResponse.json({ subscribed: true, subscription: serialize(record) });
  } catch (error) {
    logger.error('push-subscription-get-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
      deviceLabel?: unknown;
    };

    const subscription = body.subscription;
    const endpoint = subscription?.endpoint;
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;

    if (!isNonEmptyString(endpoint) || !isNonEmptyString(p256dh) || !isNonEmptyString(auth)) {
      return NextResponse.json(
        { error: 'A valid subscription with endpoint and keys is required' },
        { status: 400 }
      );
    }

    const deviceLabel = isNonEmptyString(body.deviceLabel) ? body.deviceLabel : null;

    const record = upsertPushSubscription(getDbInstance(), {
      endpoint,
      p256dh,
      auth,
      deviceLabel,
      locale: localeFromRequest(request),
    });
    logger.info('push-subscription-registered');
    return NextResponse.json({ success: true, subscription: serialize(record) }, { status: 201 });
  } catch (error) {
    logger.error('push-subscription-post-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as {
      endpoint?: unknown;
      preferences?: { prompt?: unknown; completion?: unknown };
      acknowledgeDefaultsNotice?: unknown;
    };

    if (!isNonEmptyString(body.endpoint)) {
      return NextResponse.json({ error: 'endpoint is required' }, { status: 400 });
    }

    const prefs: PushSubscriptionPreferenceUpdate = {};
    if (typeof body.preferences?.prompt === 'boolean') prefs.enabledPrompt = body.preferences.prompt;
    if (typeof body.preferences?.completion === 'boolean') {
      prefs.enabledCompletion = body.preferences.completion;
    }
    // Issue #2056: "keep this device as it is" sends the acknowledgement and
    // nothing else, so an ack alone is a valid PATCH. Without this the only way
    // to dismiss the notice would be to change a preference — i.e. the reader
    // could not decline the new default.
    if (body.acknowledgeDefaultsNotice === true) prefs.acknowledgeDefaultsNotice = true;

    if (
      prefs.enabledPrompt === undefined &&
      prefs.enabledCompletion === undefined &&
      prefs.acknowledgeDefaultsNotice === undefined
    ) {
      return NextResponse.json({ error: 'No valid preferences provided' }, { status: 400 });
    }

    const record = updatePushSubscriptionPreferences(getDbInstance(), body.endpoint, prefs);
    if (!record) {
      return NextResponse.json({ error: 'Subscription not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, subscription: serialize(record) });
  } catch (error) {
    logger.error('push-subscription-patch-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { endpoint?: unknown };
    if (!isNonEmptyString(body.endpoint)) {
      return NextResponse.json({ error: 'endpoint is required' }, { status: 400 });
    }
    const removed = deletePushSubscriptionByEndpoint(getDbInstance(), body.endpoint);
    logger.info('push-subscription-deleted', { removed });
    return NextResponse.json({ success: true, removed });
  } catch (error) {
    logger.error('push-subscription-delete-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
