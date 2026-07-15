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

/** Notification kinds that a subscription can independently opt into. */
export type PushNotificationKind = 'prompt' | 'completion';

/** A stored Web Push subscription (one device). */
export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  deviceLabel: string | null;
  enabledPrompt: boolean;
  enabledCompletion: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Input for creating/updating a subscription. */
export interface UpsertPushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabel?: string | null;
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_label: string | null;
  enabled_prompt: number;
  enabled_completion: number;
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
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

const SELECT_COLUMNS = `
  id, endpoint, p256dh, auth, device_label,
  enabled_prompt, enabled_completion, created_at, updated_at
`;

/**
 * Create or update a subscription keyed by endpoint. On conflict the encryption
 * keys and device label are refreshed but the per-type preferences are preserved
 * (a browser re-subscribe must not silently reset the user's toggles).
 */
export function upsertPushSubscription(
  db: Database.Database,
  input: UpsertPushSubscriptionInput
): PushSubscriptionRecord {
  const now = Date.now();
  const deviceLabel = input.deviceLabel ?? null;

  db.prepare(`
    INSERT INTO push_subscriptions (
      id, endpoint, p256dh, auth, device_label,
      enabled_prompt, enabled_completion, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      device_label = excluded.device_label,
      updated_at = excluded.updated_at
  `).run(randomUUID(), input.endpoint, input.p256dh, input.auth, deviceLabel, now, now);

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
  const column = kind === 'prompt' ? 'enabled_prompt' : 'enabled_completion';
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM push_subscriptions WHERE ${column} = 1 ORDER BY created_at ASC`
    )
    .all() as PushSubscriptionRow[];
  return rows.map(mapRow);
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
