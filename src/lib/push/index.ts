/** Web Push module barrel (Issue #1125). */

export { getVapidConfig, isPushConfigured, getVapidPublicKey } from './vapid';
export type { VapidConfig } from './vapid';
export {
  notifyPushSubscribers,
  buildPushPayload,
  buildExcerpt,
  resolvePushLocale,
} from './push-sender';
export type {
  NotificationEvent,
  PushPayload,
  FailureContext,
  FailurePushReason,
} from './push-sender';
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

// Failure notifications (Issue #2000).
// NOTE: the producers import these from './failure-push-notifier' directly, for
// the reason the prompt gate above gives — a suite that stubs the whole
// '@/lib/push' barrel would otherwise leave the notifier undefined on the very
// path it guards.
export {
  notifyVerificationFailurePush,
  notifyUpstreamFaultPush,
  notifySessionStartFailurePush,
} from './failure-push-notifier';
export type {
  VerificationFailurePushInput,
  UpstreamFaultPushInput,
  SessionStartFailurePushInput,
  FailurePushSuppressionReason,
} from './failure-push-notifier';
export {
  observeUpstreamFaultEdge,
  clearUpstreamFaultEpisodes,
  UPSTREAM_FAULT_COOLDOWN_MS,
} from './failure-episode-state';
export type { UpstreamFaultEdge, UpstreamFaultEdgeReason } from './failure-episode-state';

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

// Cross-device dismissal of a resolved wait (Issue #2001).
// NOTE: `waiting-push-notifier` reaches the notifier through its own module
// path, for the reason the two blocks above give — a suite that stubs the whole
// '@/lib/push' barrel would otherwise leave the closing edge inert.
export {
  decidePromptResolution,
  notifyPromptResolved,
  MIN_DEVICES_FOR_CROSS_DEVICE_CLEAR,
} from './resolution-push-notifier';
export type {
  ResolutionPushDecision,
  ResolutionPushReason,
  PromptResolvedInput,
} from './resolution-push-notifier';
// The card mark itself, durable across a restart since Issue #2057.
export {
  markPromptCardShown,
  hasPromptCard,
  clearPromptCard,
  clearAllPromptCards,
  forgetPromptCardMemory,
  promptCardCount,
  PROMPT_CARD_KEY_PREFIX,
  PROMPT_CARD_MAX_AGE_MS,
} from './prompt-card-state';
