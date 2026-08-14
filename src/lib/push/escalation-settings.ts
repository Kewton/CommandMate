/**
 * The "still waiting" reminder setting (Issue #1790).
 *
 * A wait that nobody answers is the case push notifications exist for, and one
 * notification is easy to miss — so after a threshold the server sends exactly
 * one more. How long to wait, and whether to do it at all, is a user decision,
 * and it is a *server-side* one: the check runs in the background with no
 * request and no browser attached, so it cannot read a device's localStorage the
 * way #1788's in-app toggle does. It is therefore stored once for the install
 * and applies to every subscribed device.
 *
 * ## Why the SQL lives here
 *
 * `app_settings` (migration v27) is the generic key-value store this rides on,
 * so no migration is added. Its typed helpers live in `db/app-settings-db`, but
 * both existing ones are `string[]`-shaped and this value is an object with two
 * fields of different types; a third helper there would be a fourth reader of
 * the same table with no shared logic to gain. Keeping the accessor beside its
 * only consumer also keeps the defaults — which the escalation tick applies on
 * every failure path — in one file.
 *
 * Every read is total: a missing row, malformed JSON, an out-of-range threshold
 * or an unopenable database all resolve to {@link DEFAULT_ESCALATION_SETTINGS}
 * rather than throwing. The caller is a background timer whose failure mode
 * must be "no reminder", never "the server logs an exception every minute".
 *
 * @module lib/push/escalation-settings
 */

import { getDbInstance } from '@/lib/db/db-instance';
import { createLogger } from '@/lib/logger';

const logger = createLogger('push/escalation-settings');

/** `app_settings.key` this setting is stored under. */
export const ESCALATION_SETTINGS_KEY = 'push_escalation';

/** How long a wait may last before the one reminder is sent. */
export interface PushEscalationSettings {
  enabled: boolean;
  thresholdMinutes: number;
}

/**
 * On by default at ten minutes, per the Issue.
 *
 * Defaulting to *on* is the same call #1788 made for the in-app toast: a user
 * who never opened the settings screen is the one most likely to walk away from
 * a waiting agent, and the cost of being wrong is one extra notification per
 * unanswered wait — bounded, because there is only ever one.
 */
export const DEFAULT_ESCALATION_SETTINGS: PushEscalationSettings = {
  enabled: true,
  thresholdMinutes: 10,
};

/** The thresholds the settings UI offers, in minutes. */
export const ESCALATION_THRESHOLD_CHOICES = [5, 10, 30, 60] as const;

/** Guard rails for a hand-written value: at least a minute, at most a day. */
export const MIN_ESCALATION_THRESHOLD_MINUTES = 1;
export const MAX_ESCALATION_THRESHOLD_MINUTES = 1440;

/**
 * Narrow arbitrary input to a usable setting, filling each field independently.
 *
 * Field-by-field rather than all-or-nothing so that a bad threshold does not
 * silently switch the reminder back on (or off): the half the user did set is
 * the half that is honoured.
 */
export function normalizeEscalationSettings(value: unknown): PushEscalationSettings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_ESCALATION_SETTINGS };

  const record = value as { enabled?: unknown; thresholdMinutes?: unknown };
  const enabled =
    typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_ESCALATION_SETTINGS.enabled;

  const raw = record.thresholdMinutes;
  const thresholdMinutes =
    typeof raw === 'number' &&
    Number.isFinite(raw) &&
    raw >= MIN_ESCALATION_THRESHOLD_MINUTES &&
    raw <= MAX_ESCALATION_THRESHOLD_MINUTES
      ? Math.round(raw)
      : DEFAULT_ESCALATION_SETTINGS.thresholdMinutes;

  return { enabled, thresholdMinutes };
}

/** Read the setting. Never throws — see the module docblock. */
export function getPushEscalationSettings(): PushEscalationSettings {
  try {
    const row = getDbInstance()
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(ESCALATION_SETTINGS_KEY) as { value: string } | undefined;

    if (!row) return { ...DEFAULT_ESCALATION_SETTINGS };
    return normalizeEscalationSettings(JSON.parse(row.value));
  } catch (error) {
    logger.warn('escalation-settings-read-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...DEFAULT_ESCALATION_SETTINGS };
  }
}

/**
 * Persist the setting, normalizing first so a malformed request cannot store a
 * value later reads would have to reject anyway.
 *
 * @returns What was actually written.
 */
export function setPushEscalationSettings(value: unknown): PushEscalationSettings {
  const settings = normalizeEscalationSettings(value);
  const now = Date.now();

  getDbInstance()
    .prepare(`
      INSERT INTO app_settings (key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `)
    .run(ESCALATION_SETTINGS_KEY, JSON.stringify(settings), now, now);

  return settings;
}
