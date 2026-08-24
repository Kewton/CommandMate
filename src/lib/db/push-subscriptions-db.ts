/**
 * Push subscription database operations (Issue #1125).
 *
 * CRUD for the `push_subscriptions` table. One row per browser push endpoint.
 * `endpoint` is the natural upsert key; per-type toggles gate which notification
 * kinds a device receives. Sensitive fields (endpoint, p256dh, auth) must never
 * be logged — callers pass these straight through without logging.
 */

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

/**
 * Notification kinds a subscription can be fanned out for.
 *
 * Issue #2000 split the axis from "what happened" to "do you have to act".
 * `prompt` and `failure` are both the acting half, so they share one stored
 * toggle — see {@link KIND_COLUMN}. The kind still travels separately because
 * the body wording and the Service Worker `tag` differ: a failure must not
 * replace the card for a prompt that is still waiting.
 */
export type PushNotificationKind = 'prompt' | 'completion' | 'failure';

/**
 * Which stored toggle governs each kind (Issue #2000).
 *
 * The table keeps two columns on purpose. The Issue's own proposal is two
 * buckets — "you need to act" and "for information" — and a prompt waiting, a
 * failed verification, an upstream fault and a session that could not start are
 * all the first one. A third column would have to be migrated, surfaced in the
 * UI and explained, to split a bucket nobody has asked to split. Written as an
 * exhaustive Record so a new kind fails the type check here rather than
 * silently landing in the completion bucket.
 */
const KIND_COLUMN: Record<PushNotificationKind, 'enabled_prompt' | 'enabled_completion'> = {
  prompt: 'enabled_prompt',
  failure: 'enabled_prompt',
  completion: 'enabled_completion',
};

/**
 * Per-kind state a **newly created** subscription starts in (Issue #2000).
 *
 * `enabledCompletion: false` is the whole of the Issue's default change. It is
 * applied here, in the INSERT, and NOT as a schema DEFAULT or a migration:
 *
 *  - the INSERT below has always bound these two columns explicitly, so the
 *    `DEFAULT 1` v41 declares is dead code on this path (measured: it is the
 *    only INSERT into this table in `src/`);
 *  - existing rows must not move. Turning a live subscriber's completions off
 *    behind their back reads as "notifications broke", which is indistinguishable
 *    from a genuine fault. The adjudication on Issue #2000 is explicit: new
 *    subscriptions only, existing rows untouched.
 *
 * The `ON CONFLICT` clause below preserves per-type preferences, so a device
 * that re-subscribes with the same endpoint keeps whatever it had — the new
 * default reaches an existing reader only when their endpoint changes (another
 * browser, another device, or a full unsubscribe/re-register).
 */
export const NEW_SUBSCRIPTION_DEFAULTS = {
  enabledPrompt: true,
  enabledCompletion: false,
} as const;

/** A stored Web Push subscription (one device). */
export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  deviceLabel: string | null;
  enabledPrompt: boolean;
  enabledCompletion: boolean;
  /** Locale captured at registration. NULL for subscriptions predating v42. */
  locale: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Input for creating/updating a subscription. */
export interface UpsertPushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabel?: string | null;
  locale?: string | null;
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_label: string | null;
  enabled_prompt: number;
  enabled_completion: number;
  locale: string | null;
  created_at: number;
  updated_at: number;
}

function mapRow(row: PushSubscriptionRow): PushSubscriptionRecord {
  return {
    id: row.id,
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
    deviceLabel: row.device_label,
    enabledPrompt: row.enabled_prompt === 1,
    enabledCompletion: row.enabled_completion === 1,
    locale: row.locale,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

const SELECT_COLUMNS = `
  id, endpoint, p256dh, auth, device_label,
  enabled_prompt, enabled_completion, locale, created_at, updated_at
`;

/**
 * Create or update a subscription keyed by endpoint. On conflict the encryption
 * keys and device label are refreshed but the per-type preferences are preserved
 * (a browser re-subscribe must not silently reset the user's toggles).
 *
 * Locale follows the keys, not the preferences: a re-registration carries the
 * reader's current language, so a resolved locale overwrites the stored one.
 * An *unresolved* locale must not clobber a good stored value, hence COALESCE.
 */
export function upsertPushSubscription(
  db: Database.Database,
  input: UpsertPushSubscriptionInput
): PushSubscriptionRecord {
  const now = Date.now();
  const deviceLabel = input.deviceLabel ?? null;
  const locale = input.locale ?? null;

  db.prepare(`
    INSERT INTO push_subscriptions (
      id, endpoint, p256dh, auth, device_label,
      enabled_prompt, enabled_completion, locale, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      device_label = excluded.device_label,
      locale = COALESCE(excluded.locale, push_subscriptions.locale),
      updated_at = excluded.updated_at
  `).run(
    randomUUID(),
    input.endpoint,
    input.p256dh,
    input.auth,
    deviceLabel,
    NEW_SUBSCRIPTION_DEFAULTS.enabledPrompt ? 1 : 0,
    NEW_SUBSCRIPTION_DEFAULTS.enabledCompletion ? 1 : 0,
    locale,
    now,
    now
  );

  const record = getPushSubscriptionByEndpoint(db, input.endpoint);
  if (!record) {
    throw new Error('Failed to persist push subscription');
  }
  return record;
}

/** Fetch a single subscription by its endpoint, or null. */
export function getPushSubscriptionByEndpoint(
  db: Database.Database,
  endpoint: string
): PushSubscriptionRecord | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM push_subscriptions WHERE endpoint = ?`)
    .get(endpoint) as PushSubscriptionRow | undefined;
  return row ? mapRow(row) : null;
}

/** All subscriptions (used for notification fan-out). */
export function getAllPushSubscriptions(db: Database.Database): PushSubscriptionRecord[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM push_subscriptions ORDER BY created_at ASC`)
    .all() as PushSubscriptionRow[];
  return rows.map(mapRow);
}

/** Subscriptions that have opted into a given notification kind. */
export function getPushSubscriptionsForKind(
  db: Database.Database,
  kind: PushNotificationKind
): PushSubscriptionRecord[] {
  const column = KIND_COLUMN[kind];
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM push_subscriptions WHERE ${column} = 1 ORDER BY created_at ASC`
    )
    .all() as PushSubscriptionRow[];
  return rows.map(mapRow);
}

/**
 * How many subscriptions have opted into a given kind (Issue #2001).
 *
 * Separate from {@link getPushSubscriptionsForKind} because the cross-device
 * dismissal asks a question about the *fleet*, not about the rows: "is there a
 * second device that could still be holding a stale card?". Counting in SQL
 * keeps that decision from materialising — and from logging the shape of — a
 * table of endpoints and encryption keys it has no use for.
 */
export function countPushSubscriptionsForKind(
  db: Database.Database,
  kind: PushNotificationKind
): number {
  const column = KIND_COLUMN[kind];
  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM push_subscriptions WHERE ${column} = 1`)
    .get() as { total: number };
  return row.total;
}

/** Update per-type preferences for a subscription. Returns the updated record or null. */
export function updatePushSubscriptionPreferences(
  db: Database.Database,
  endpoint: string,
  prefs: { enabledPrompt?: boolean; enabledCompletion?: boolean }
): PushSubscriptionRecord | null {
  const assignments: string[] = ['updated_at = ?'];
  const params: (string | number)[] = [Date.now()];

  if (prefs.enabledPrompt !== undefined) {
    assignments.push('enabled_prompt = ?');
    params.push(prefs.enabledPrompt ? 1 : 0);
  }
  if (prefs.enabledCompletion !== undefined) {
    assignments.push('enabled_completion = ?');
    params.push(prefs.enabledCompletion ? 1 : 0);
  }

  params.push(endpoint);
  db.prepare(
    `UPDATE push_subscriptions SET ${assignments.join(', ')} WHERE endpoint = ?`
  ).run(...params);

  return getPushSubscriptionByEndpoint(db, endpoint);
}

/** Delete a subscription by endpoint. Returns true if a row was removed. */
export function deletePushSubscriptionByEndpoint(
  db: Database.Database,
  endpoint: string
): boolean {
  const info = db
    .prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
    .run(endpoint);
  return info.changes > 0;
}
