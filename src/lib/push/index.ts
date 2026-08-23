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
  shouldSendWaitingPush,
  resetWaitingPushDedup,
} from './notification-dedup';
export type { DedupEvent, WaitingDedupEvent } from './notification-dedup';

// Whether a prompt wait is worth notifying about at all (Issue #1999).
// NOTE: the two producers import this from './prompt-push-gate' directly. A
// suite that stubs the whole '@/lib/push' barrel would otherwise leave the gate
// undefined on the path it guards.
export {
  decidePromptPush,
  isPromptPushSuppressed,
} from './prompt-push-gate';
export type {
  PromptPushGateInput,
  PromptPushGateDecision,
  PromptPushGateReason,
} from './prompt-push-gate';

// Waiting-edge driven notifications (Issue #1790).
export {
  startWaitingPushNotifier,
  stopWaitingPushNotifier,
  isWaitingPushNotifierActive,
  handleWaitingTransition,
  runEscalationTick,
  pendingEscalationCount,
  ESCALATION_TICK_MS,
} from './waiting-push-notifier';
export {
  getPushEscalationSettings,
  setPushEscalationSettings,
  normalizeEscalationSettings,
  DEFAULT_ESCALATION_SETTINGS,
  ESCALATION_THRESHOLD_CHOICES,
  ESCALATION_SETTINGS_KEY,
  MIN_ESCALATION_THRESHOLD_MINUTES,
  MAX_ESCALATION_THRESHOLD_MINUTES,
} from './escalation-settings';
export type { PushEscalationSettings } from './escalation-settings';
