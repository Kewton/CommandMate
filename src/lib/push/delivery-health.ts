/**
 * Per-device Web Push delivery health (Issues #2124 / #2123, extensible for #2126).
 *
 * ## Why this exists
 *
 * `push-sender` has always answered a failed send in the log and nowhere else:
 *
 *   404 / 410  -> the row is deleted (the endpoint is gone at the push service)
 *   anything    -> `logger.warn('push-send-failed')`, and the subscription stays
 *
 * Both are the right handling. Neither is observable by the person holding the
 * phone. Measured by the orchestrator during the Epic #2002 device UAT
 * (2026-08-27, develop e8d09989): an APNs 403 caused by the old default
 * `CM_VAPID_SUBJECT` (#2124) silenced an iPad for an entire session while
 * Android kept receiving, and a 410 removed the Android subscription without a
 * single line reaching the UI — the reader's whole experience was "notifications
 * stopped at some point". This module is the state that lets the More screen say
 * "this device is not receiving" instead.
 *
 * ## What it records, and what it deliberately does not
 *
 * One row per endpoint that is CURRENTLY unhealthy. A successful send deletes the
 * row, so the store holds failures only and a device that recovers leaves nothing
 * behind. It is not a history and not a metric: the UI question is "is this phone
 * getting notifications right now, and if not, what did the push service say".
 *
 * `state` separates the two outcomes the sender already distinguishes:
 *
 *   'removed' — 404/410; the subscription row is gone and the device must
 *               re-subscribe. The health row OUTLIVES the subscription on
 *               purpose: it is the only remaining evidence of why the device
 *               went quiet, and `GET /api/push/subscriptions` reads it for an
 *               endpoint that no longer has a subscription.
 *   'failing' — everything else (403 from APNs over a bad `sub`, and the 4xx
 *               #2126 is about). The subscription is untouched — a configuration
 *               mistake must never delete a reader's subscription — so the row
 *               is purely advisory.
 *
 * ## Why `app_settings`, and why the SQL is here
 *
 * The same trade `escalation-settings` and `prompt-card-state` made in this
 * directory: `app_settings` (migration v27) is the generic key-value table, so
 * this needs **no migration**, and the accessor lives beside its only two
 * consumers. One row per unhealthy endpoint rather than one JSON map, so record
 * and clear are single statements with no read-modify-write between processes
 * sharing the database file.
 *
 * ## Why the key is a hash
 *
 * A push endpoint is a bearer capability — anyone holding it can send to that
 * device — which is why this repository never logs one. An `app_settings` key is
 * plainly readable by anything that opens the database, and `commandmate` shows
 * that database to the user, so the key is `sha256(endpoint)` and the endpoint
 * itself is never stored. Lookup still works because every reader (the sender,
 * and the API route serving a client that knows its own endpoint) has the
 * endpoint in hand and can hash it.
 *
 * Every database call here is total: an unopenable database, a missing table or
 * a malformed value all resolve to "healthy" rather than throwing. The callers
 * are a push fan-out and a settings route; neither may be disturbed by storage.
 *
 * @module lib/push/delivery-health
 */

import { createHash } from 'crypto';
import { getDbInstance } from '@/lib/db/db-instance';
import { createLogger } from '@/lib/logger';

const logger = createLogger('push/delivery-health');

/** `app_settings` key prefix for a delivery-health row. */
export const PUSH_DELIVERY_HEALTH_KEY_PREFIX = 'push_delivery_health:';

/**
 * How long an unhealthy record is kept.
 *
 * 30 days: long enough that a phone left in a drawer still gets an explanation
 * when it is picked up, short enough that a device the reader has abandoned does
 * not keep a row forever. Pruned lazily on read and on write, so no sweeper task
 * has to exist.
 */
export const PUSH_DELIVERY_HEALTH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Which of the sender's two failure handlings produced this record. */
export type PushDeliveryState =
  /** 404/410 — the subscription was deleted; the device must subscribe again. */
  | 'removed'
  /** Any other failure — the subscription is intact but nothing is arriving. */
  | 'failing';

/** What the UI is told about one endpoint. */
export interface PushDeliveryHealth {
  state: PushDeliveryState;
  /** HTTP status the push service returned, or null when the error carried none. */
  statusCode: number | null;
  /** Consecutive failures since the last success. */
  failureCount: number;
  /** Epoch ms of the first failure in this streak. */
  firstFailureAt: number;
  /** Epoch ms of the most recent failure. */
  lastFailureAt: number;
}

function keyFor(endpoint: string): string {
  return `${PUSH_DELIVERY_HEALTH_KEY_PREFIX}${createHash('sha256').update(endpoint).digest('hex')}`;
}

function isExpired(record: PushDeliveryHealth, now: number): boolean {
  return now - record.lastFailureAt >= PUSH_DELIVERY_HEALTH_MAX_AGE_MS;
}

/** Structural check for a record read back out of `app_settings`. */
function parseRecord(value: string): PushDeliveryHealth | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const r = parsed as Partial<PushDeliveryHealth>;
    if (r.state !== 'removed' && r.state !== 'failing') return null;
    if (typeof r.failureCount !== 'number' || !Number.isFinite(r.failureCount)) return null;
    if (typeof r.firstFailureAt !== 'number' || !Number.isFinite(r.firstFailureAt)) return null;
    if (typeof r.lastFailureAt !== 'number' || !Number.isFinite(r.lastFailureAt)) return null;
    const statusCode =
      typeof r.statusCode === 'number' && Number.isFinite(r.statusCode) ? r.statusCode : null;
    return {
      state: r.state,
      statusCode,
      failureCount: r.failureCount,
      firstFailureAt: r.firstFailureAt,
      lastFailureAt: r.lastFailureAt,
    };
  } catch {
    return null;
  }
}

function writeRow(endpoint: string, record: PushDeliveryHealth): void {
  try {
    getDbInstance()
      .prepare(`
        INSERT INTO app_settings (key, value, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(keyFor(endpoint), JSON.stringify(record), record.firstFailureAt, record.lastFailureAt);
  } catch (error) {
    logger.debug('delivery-health-write-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function deleteRow(endpoint: string): boolean {
  try {
    return (
      getDbInstance().prepare('DELETE FROM app_settings WHERE key = ?').run(keyFor(endpoint))
        .changes > 0
    );
  } catch (error) {
    logger.debug('delivery-health-delete-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Whether this endpoint is currently failing, and how.
 *
 * @returns The record, or `null` when the device is healthy (or the store cannot
 *   answer — "healthy" is the fail-open direction: a diagnostic that cannot be
 *   read must not turn into a warning banner on a working device).
 */
export function getPushDeliveryHealth(
  endpoint: string,
  now: number = Date.now()
): PushDeliveryHealth | null {
  try {
    const row = getDbInstance()
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(keyFor(endpoint)) as { value: string } | undefined;
    if (!row) return null;

    const record = parseRecord(row.value);
    if (record === null) return null;
    if (isExpired(record, now)) {
      deleteRow(endpoint);
      return null;
    }
    return record;
  } catch (error) {
    logger.debug('delivery-health-read-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Record that a send to this endpoint failed.
 *
 * Called from the ONE place that observes the failure (`push-sender.sendToOne`),
 * for both handlings — the caller says which by passing `removed`.
 *
 * The streak continues across restarts: `failureCount` is read back and
 * incremented, so "403 every time for two days" is distinguishable from "one
 * blip", which is what #2126 will need when it decides whether a device is
 * genuinely cut off.
 *
 * A `removed` record never re-opens as `failing`: once the push service has said
 * the endpoint is gone, a later failure on the same endpoint is the same fact.
 *
 * Never throws.
 */
export function recordPushDeliveryFailure(
  endpoint: string,
  options: { statusCode?: number | null; removed?: boolean } = {},
  now: number = Date.now()
): PushDeliveryHealth {
  const previous = getPushDeliveryHealth(endpoint, now);
  const state: PushDeliveryState =
    options.removed === true || previous?.state === 'removed' ? 'removed' : 'failing';

  const record: PushDeliveryHealth = {
    state,
    statusCode: options.statusCode ?? null,
    failureCount: (previous?.failureCount ?? 0) + 1,
    firstFailureAt: previous?.firstFailureAt ?? now,
    lastFailureAt: now,
  };

  writeRow(endpoint, record);
  return record;
}

/**
 * Record that a send to this endpoint succeeded, clearing any streak.
 *
 * @returns True when a record was actually cleared, i.e. when the device had been
 *   failing and has now recovered. The caller logs on that edge — it is the one
 *   push success worth a line, and the reason `push-sender` was silent about
 *   successes is that every OTHER success is unremarkable.
 */
export function clearPushDeliveryHealth(endpoint: string): boolean {
  return deleteRow(endpoint);
}

/**
 * Drop every delivery-health row. Test-only helper; the production paths clear
 * one endpoint at a time.
 */
export function clearAllPushDeliveryHealth(): void {
  try {
    // GLOB rather than LIKE: the prefix contains `_`, which LIKE treats as a
    // single-character wildcard and would match neighbouring keys with.
    getDbInstance()
      .prepare('DELETE FROM app_settings WHERE key GLOB ?')
      .run(`${PUSH_DELIVERY_HEALTH_KEY_PREFIX}*`);
  } catch (error) {
    logger.debug('delivery-health-clear-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
