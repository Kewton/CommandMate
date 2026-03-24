/**
 * Timer Message Configuration Constants
 * Issue #534: Timer-based delayed message sending feature
 *
 * [DP-001] TIMER_DELAYS dynamically generated from MIN/MAX/STEP constants.
 * isValidTimerDelay() uses range check (not array.includes).
 */

// =============================================================================
// Delay Time Range Constants (5-minute increments, 5min to 8h45m)
// =============================================================================

/** Minimum delay: 5 minutes */
export const MIN_DELAY_MS = 5 * 60 * 1000; // 300000

/** Maximum delay: 8 hours 45 minutes */
export const MAX_DELAY_MS = 525 * 60 * 1000; // 31500000

/** Delay step: 5 minutes */
export const DELAY_STEP_MS = 5 * 60 * 1000; // 300000

/**
 * All valid timer delay values (dynamically generated from MIN/MAX/STEP).
 * Used by UI for dropdown options.
 * [DP-001] Eliminates hardcoded 105-element array.
 */
export const TIMER_DELAYS: number[] = Array.from(
  { length: Math.floor((MAX_DELAY_MS - MIN_DELAY_MS) / DELAY_STEP_MS) + 1 },
  (_, i) => MIN_DELAY_MS + i * DELAY_STEP_MS
);

// =============================================================================
// Limits
// =============================================================================

/** Maximum number of pending timers per worktree */
export const MAX_TIMERS_PER_WORKTREE = 5;

/** Maximum timer message length (DoS protection, same as terminal/route.ts) [CON-C-002] */
export const MAX_TIMER_MESSAGE_LENGTH = 10000;

// =============================================================================
// Timer Status
// =============================================================================

/** Timer status constants */
export const TIMER_STATUS = {
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

/** Timer status type (union of TIMER_STATUS values) */
export type TimerStatus = typeof TIMER_STATUS[keyof typeof TIMER_STATUS];

// =============================================================================
// Polling
// =============================================================================

/** Timer list polling interval: 10 seconds [CON-C-003] */
export const TIMER_LIST_POLL_INTERVAL_MS = 10000;

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate whether a value is a valid timer delay.
 * [DP-001] Uses range check (MIN <= value <= MAX, value % STEP === 0)
 * instead of array.includes() for efficiency.
 *
 * @param value - Value to validate
 * @returns true if valid timer delay
 */
export function isValidTimerDelay(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    value >= MIN_DELAY_MS &&
    value <= MAX_DELAY_MS &&
    value % DELAY_STEP_MS === 0
  );
}
