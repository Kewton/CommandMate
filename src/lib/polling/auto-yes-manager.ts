/**
 * Auto Yes Manager - Barrel file for auto-yes state and polling modules.
 *
 * Issue #479: Split into auto-yes-state.ts (state management) and
 * auto-yes-poller.ts (polling logic) for SRP compliance.
 *
 * Issue #525: Added composite key helpers and byWorktree helpers.
 *
 * This barrel file re-exports all public APIs to maintain backward compatibility.
 * No `export *` - all exports are explicitly named (Issue #479 constraint).
 */

// =============================================================================
// Re-exports from auto-yes-state.ts (State Management)
// =============================================================================

export type { AutoYesStopReason } from '../auto-yes-state';
export type { AutoYesState } from '../auto-yes-state';

export {
  // Composite key helpers (Issue #525)
  COMPOSITE_KEY_SEPARATOR,
  buildCompositeKey,
  extractWorktreeId,
  extractCliToolId,

  // State management
  isAutoYesExpired,
  getAutoYesState,
  setAutoYesEnabled,
  disableAutoYes,
  clearAllAutoYesStates,
  executeRegexWithTimeout,
  checkStopCondition,
  deleteAutoYesState,
  getAutoYesStateCompositeKeys,
  getAutoYesStateWorktreeIds,

  // byWorktree helpers (Issue #525)
  filterCompositeKeysByWorktree,
  getCompositeKeysByWorktree,
  deleteAutoYesStateByWorktree,

  // Constants
  calculateBackoffInterval,
  POLLING_INTERVAL_MS,
  COOLDOWN_INTERVAL_MS,
  DUPLICATE_RETRY_EXPIRY_MS,
  MAX_BACKOFF_MS,
  MAX_CONSECUTIVE_ERRORS,
  MAX_CONCURRENT_POLLERS,
  THINKING_CHECK_LINE_COUNT,
} from '../auto-yes-state';

// =============================================================================
// Re-exports from auto-yes-poller.ts (Polling Logic)
// =============================================================================

export type { AutoYesPollerState, StartPollingResult } from '../auto-yes-poller';

export {
  getActivePollerCount,
  clearAllPollerStates,
  getLastServerResponseTimestamp,
  isPollerActive,
  validatePollingContext,
  captureAndCleanOutput,
  processStopConditionDelta,
  detectAndRespondToPrompt,
  startAutoYesPolling,
  stopAutoYesPolling,
  stopAllAutoYesPolling,
  getAutoYesPollerCompositeKeys,
  getAutoYesPollerWorktreeIds,
  // byWorktree helpers (Issue #525)
  stopAutoYesPollingByWorktree,
  isAnyPollerActiveForWorktree,
} from '../auto-yes-poller';
