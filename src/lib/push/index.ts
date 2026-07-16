/** Web Push module barrel (Issue #1125). */

export { getVapidConfig, isPushConfigured, getVapidPublicKey } from './vapid';
export type { VapidConfig } from './vapid';
export {
  notifyPushSubscribers,
  buildPushPayload,
  buildExcerpt,
  resolvePushLocale,
} from './push-sender';
export type { NotificationEvent, PushPayload } from './push-sender';
export {
  shouldSendNotification,
  resetNotificationDedup,
  DEFAULT_DEDUP_WINDOW_MS,
} from './notification-dedup';
export type { DedupEvent } from './notification-dedup';
