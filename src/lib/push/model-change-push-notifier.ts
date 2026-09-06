/**
 * The wording of "the model changed", and the push that carries it
 * (Issue #2357).
 *
 * ## What this module owns
 *
 * Three things, and the first is the reason the other two live together:
 *
 *  1. **The sentence.** `Model changed from gpt-5.6-sol to gpt-5-mini`, in the
 *     reader's language, from `locales/<locale>/worktree.json` —
 *     `agentModel.changed`, next to the session row that shows the value on the
 *     phone. It is rendered here rather than in `push-sender` because it is also
 *     what the history row says: the model edge writes one row into
 *     `chat_messages` and sends one push, and a reader comparing the two must
 *     find the same words.
 *  2. **Which language the history row is written in.** A row is stored once,
 *     and the server has no request to read a cookie from — the edge fires from
 *     the hook route or the status poll, neither of which is the reader. The
 *     best evidence it has is the language the readers registered their push
 *     subscriptions in, so the newest subscription's locale is used, and the
 *     default locale when nobody has registered one.
 *  3. **The push itself.** One per transition, through `notifyPushSubscribers`,
 *     on the `enabled_prompt` bucket (see `NotificationEvent.modelChange` for
 *     why that bucket and why the transport kind reads `failure`).
 *
 * ## Why the dictionaries are static imports
 *
 * The same constraint `push-sender` documents: this module is reached from the
 * custom server's graph (`ws-server` → `waiting-broadcast` →
 * `model-change-broadcast` → here) and is therefore emitted into `dist/server`
 * as CommonJS, where `next-intl` (ESM-only) cannot be required. The JSON is
 * imported directly and `{from}` / `{to}` are substituted by hand.
 *
 * @module lib/push/model-change-push-notifier
 */

import type Database from 'better-sqlite3';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from '@/config/i18n-config';
import { getDbInstance } from '@/lib/db/db-instance';
import { getAllPushSubscriptions } from '@/lib/db/push-subscriptions-db';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { createLogger } from '@/lib/logger';
import type { AgentModelChange } from '@/lib/session/agent-event-state';
import enWorktree from '../../../locales/en/worktree.json';
import jaWorktree from '../../../locales/ja/worktree.json';
import { notifyPushSubscribers, resolvePushLocale } from './push-sender';
import { isPushConfigured } from './vapid';

const logger = createLogger('push/model-change-notifier');

/**
 * The one sentence, per locale. Keyed by `SupportedLocale` so adding a locale
 * without a dictionary is a type error here rather than an English push in a
 * Japanese install.
 */
const MODEL_CHANGED_TEMPLATES: Record<SupportedLocale, string> = {
  en: enWorktree.agentModel.changed,
  ja: jaWorktree.agentModel.changed,
};

/**
 * "Model changed from {from} to {to}", in one language.
 *
 * `from` / `to` are the resolved values `sessionStatusByInstance[].model`
 * publishes, verbatim — the same string the phone's session row shows, so the
 * sentence and the row cannot name the same model two ways.
 */
export function buildModelChangedSentence(
  locale: string | null | undefined,
  from: string,
  to: string
): string {
  return MODEL_CHANGED_TEMPLATES[resolvePushLocale(locale)]
    .replace('{from}', from)
    .replace('{to}', to);
}

/** The sentence in every supported language, for a per-device fan-out. */
export function buildModelChangedBodies(
  from: string,
  to: string
): Record<SupportedLocale, string> {
  const bodies = {} as Record<SupportedLocale, string>;
  for (const locale of SUPPORTED_LOCALES) {
    bodies[locale] = buildModelChangedSentence(locale, from, to);
  }
  return bodies;
}

/**
 * The language the history row should be written in (Issue #2357).
 *
 * The newest push subscription's locale, because that is the only place the
 * server has ever been told what language a reader reads in — registration
 * resolves it the way the UI does (`resolveLocale`, cookie then
 * `Accept-Language`) and stores it on the row. No subscription at all means the
 * default locale, which is what the UI shows a reader who has chosen nothing.
 *
 * Never throws: a database that cannot answer is a reason to write the row in
 * the default language, not a reason to write no row.
 */
export function resolveReadersLocale(db: Database.Database): SupportedLocale {
  try {
    const subscriptions = getAllPushSubscriptions(db);
    let newest: { updatedAt: number; locale: string | null } | null = null;
    for (const sub of subscriptions) {
      const updatedAt = sub.updatedAt.getTime();
      if (newest === null || updatedAt > newest.updatedAt) {
        newest = { updatedAt, locale: sub.locale };
      }
    }
    return resolvePushLocale(newest?.locale ?? DEFAULT_LOCALE);
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** Why a model-change push did not leave the process, when it did not. */
export type ModelChangePushSuppressionReason = 'unconfigured';

/**
 * The worktree's display name, for the notification title. Falls back to the
 * id rather than dropping the notification — the same rule
 * `waiting-push-notifier` applies.
 */
function resolveWorktreeName(worktreeId: string): string {
  try {
    return getWorktreeById(getDbInstance(), worktreeId)?.name ?? worktreeId;
  } catch {
    return worktreeId;
  }
}

/**
 * Notify every opted-in device that this instance changed model (Issue #2357).
 *
 * States the fact and nothing more — no ranking, no "downgraded", because the
 * Issue rules that out and because the server has no table that could say
 * which of two models is the lesser. Never throws; push is advisory and the
 * edge that called this has already been observed.
 *
 * @returns Null when a fan-out was attempted, otherwise why it was not.
 */
export async function notifyModelChangePush(
  change: AgentModelChange
): Promise<ModelChangePushSuppressionReason | null> {
  if (!isPushConfigured()) {
    logger.debug('model-change-push-suppressed', {
      worktreeId: change.worktreeId,
      instanceId: change.instanceId,
      reason: 'unconfigured',
    });
    return 'unconfigured';
  }
  try {
    await notifyPushSubscribers(
      {
        worktreeId: change.worktreeId,
        worktreeName: resolveWorktreeName(change.worktreeId),
        // The delivery bucket, not the meaning — see `NotificationEvent.modelChange`.
        kind: 'failure',
        agentName: change.instanceId,
        instanceId: change.instanceId,
        modelChange: {
          from: change.from,
          to: change.to,
          body: buildModelChangedBodies(change.from, change.to),
        },
      },
      change.at
    );
    logger.info('model-change-push-raised', {
      worktreeId: change.worktreeId,
      instanceId: change.instanceId,
      from: change.from,
      to: change.to,
      source: change.source,
    });
  } catch (error) {
    logger.warn('model-change-push-failed', {
      worktreeId: change.worktreeId,
      instanceId: change.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}
