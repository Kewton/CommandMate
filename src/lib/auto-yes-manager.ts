/**
 * Auto Yes Manager - Server-side in-memory state management
 *
 * Manages auto-yes mode per worktree using an in-memory Map.
 * State is automatically cleared on server restart.
 *
 * Issue #138: Added server-side polling functionality to handle
 * auto-yes responses when browser tabs are in background.
 */

import type { CLIToolType } from './cli-tools/types';
import { captureSessionOutput } from './cli-session';
import { detectPrompt } from './prompt-detector';
import { resolveAutoAnswer } from './auto-yes-resolver';
import { sendKeys } from './tmux';
import { CLIToolManager } from './cli-tools/manager';
import { stripAnsi, detectThinking, buildDetectPromptOptions } from './cli-patterns';

/** Auto yes state for a worktree */
export interface AutoYesState {
  /** Whether auto-yes is enabled */
  enabled: boolean;
  /** Timestamp when auto-yes was enabled (Date.now()) */
  enabledAt: number;
  /** Timestamp when auto-yes expires (enabledAt + 3600000ms = 1 hour) */
  expiresAt: number;
}

/** Poller state for a worktree (Issue #138) */
export interface AutoYesPollerState {
  /** setTimeout ID */
  timerId: ReturnType<typeof setTimeout> | null;
  /** CLI tool ID being polled */
  cliToolId: CLIToolType;
  /** Consecutive error count */
  consecutiveErrors: number;
  /** Current polling interval (with backoff applied) */
  currentInterval: number;
  /** Last server-side response timestamp */
  lastServerResponseTimestamp: number | null;
}

/** Result of starting a poller */
export interface StartPollingResult {
  /** Whether the poller was started */
  started: boolean;
  /** Reason if not started */
  reason?: string;
}

// =============================================================================
// Constants (Issue #138)
// =============================================================================

/** Polling interval in milliseconds */
export const POLLING_INTERVAL_MS = 2000;

/** Maximum backoff interval in milliseconds (60 seconds) */
export const MAX_BACKOFF_MS = 60000;

/** Number of consecutive errors before applying backoff */
export const MAX_CONSECUTIVE_ERRORS = 5;

/** Maximum concurrent pollers (DoS protection) */
export const MAX_CONCURRENT_POLLERS = 50;

/** Timeout duration: 1 hour in milliseconds */
const AUTO_YES_TIMEOUT_MS = 3600000;

/** Worktree ID validation pattern (security: prevent command injection) */
const WORKTREE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// =============================================================================
// In-memory State (globalThis for hot reload persistence - Issue #153)
// =============================================================================

/**
 * globalThis pattern for hot reload persistence (Issue #153)
 *
 * Problem: Next.js hot reload or worker restart resets module-scoped variables,
 * causing UI and background state inconsistency.
 *
 * Solution: Use globalThis to persist state. globalThis is unique per process
 * and persists even when modules are reloaded.
 *
 * Limitation: In multi-process environments (cluster mode, etc.), each process
 * has its own state. CommandMate is designed for single-process operation,
 * so this limitation is acceptable.
 */
declare global {
  // eslint-disable-next-line no-var
  var __autoYesStates: Map<string, AutoYesState> | undefined;
  // eslint-disable-next-line no-var
  var __autoYesPollerStates: Map<string, AutoYesPollerState> | undefined;
}

/** In-memory storage for auto-yes states (globalThis for hot reload persistence) */
const autoYesStates = globalThis.__autoYesStates ??
  (globalThis.__autoYesStates = new Map<string, AutoYesState>());

/** In-memory storage for poller states (globalThis for hot reload persistence) */
const autoYesPollerStates = globalThis.__autoYesPollerStates ??
  (globalThis.__autoYesPollerStates = new Map<string, AutoYesPollerState>());

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Validate worktree ID format (security measure)
 * Only allows alphanumeric characters, hyphens, and underscores.
 */
export function isValidWorktreeId(worktreeId: string): boolean {
  if (!worktreeId || worktreeId.length === 0) return false;
  return WORKTREE_ID_PATTERN.test(worktreeId);
}

/**
 * Calculate backoff interval based on consecutive errors
 */
export function calculateBackoffInterval(consecutiveErrors: number): number {
  if (consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
    return POLLING_INTERVAL_MS;
  }

  // Exponential backoff: 2^(errors - 4) * 2000
  // 5 errors: 2^1 * 2000 = 4000
  // 6 errors: 2^2 * 2000 = 8000
  // etc.
  const backoffMultiplier = Math.pow(2, consecutiveErrors - MAX_CONSECUTIVE_ERRORS + 1);
  const backoffMs = POLLING_INTERVAL_MS * backoffMultiplier;
  return Math.min(backoffMs, MAX_BACKOFF_MS);
}

// =============================================================================
// Auto-Yes State Management (Existing)
// =============================================================================

/**
 * Check if an auto-yes state has expired
 */
export function isAutoYesExpired(state: AutoYesState): boolean {
  return Date.now() > state.expiresAt;
}

/**
 * Get the auto-yes state for a worktree
 * Returns null if no state exists or if expired (auto-disables on expiry)
 */
export function getAutoYesState(worktreeId: string): AutoYesState | null {
  const state = autoYesStates.get(worktreeId);
  if (!state) return null;

  // Auto-disable if expired
  if (isAutoYesExpired(state)) {
    const disabledState: AutoYesState = {
      ...state,
      enabled: false,
    };
    autoYesStates.set(worktreeId, disabledState);
    return disabledState;
  }

  return state;
}

/**
 * Set the auto-yes enabled state for a worktree
 */
export function setAutoYesEnabled(worktreeId: string, enabled: boolean): AutoYesState {
  if (enabled) {
    const now = Date.now();
    const state: AutoYesState = {
      enabled: true,
      enabledAt: now,
      expiresAt: now + AUTO_YES_TIMEOUT_MS,
    };
    autoYesStates.set(worktreeId, state);
    return state;
  } else {
    const existing = autoYesStates.get(worktreeId);
    const state: AutoYesState = {
      enabled: false,
      enabledAt: existing?.enabledAt ?? 0,
      expiresAt: existing?.expiresAt ?? 0,
    };
    autoYesStates.set(worktreeId, state);
    return state;
  }
}

/**
 * Clear all auto-yes states (for testing)
 */
export function clearAllAutoYesStates(): void {
  autoYesStates.clear();
}

// =============================================================================
// Server-side Polling (Issue #138)
// =============================================================================

/**
 * Get the number of active pollers
 */
export function getActivePollerCount(): number {
  return autoYesPollerStates.size;
}

/**
 * Clear all poller states (for testing)
 */
export function clearAllPollerStates(): void {
  stopAllAutoYesPolling();
  autoYesPollerStates.clear();
}

/**
 * Get the last server response timestamp for a worktree
 * Used by clients to prevent duplicate responses
 */
export function getLastServerResponseTimestamp(worktreeId: string): number | null {
  const pollerState = autoYesPollerStates.get(worktreeId);
  return pollerState?.lastServerResponseTimestamp ?? null;
}

/**
 * Update the last server response timestamp
 */
function updateLastServerResponseTimestamp(worktreeId: string, timestamp: number): void {
  const pollerState = autoYesPollerStates.get(worktreeId);
  if (pollerState) {
    pollerState.lastServerResponseTimestamp = timestamp;
  }
}

/**
 * Reset error count for a poller
 */
function resetErrorCount(worktreeId: string): void {
  const pollerState = autoYesPollerStates.get(worktreeId);
  if (pollerState) {
    pollerState.consecutiveErrors = 0;
    pollerState.currentInterval = POLLING_INTERVAL_MS;
  }
}

/**
 * Increment error count and apply backoff if needed
 */
function incrementErrorCount(worktreeId: string): void {
  const pollerState = autoYesPollerStates.get(worktreeId);
  if (pollerState) {
    pollerState.consecutiveErrors++;
    pollerState.currentInterval = calculateBackoffInterval(pollerState.consecutiveErrors);
  }
}

/**
 * Internal polling function (setTimeout recursive)
 */
async function pollAutoYes(worktreeId: string, cliToolId: CLIToolType): Promise<void> {
  // Check if poller was stopped
  const pollerState = autoYesPollerStates.get(worktreeId);
  if (!pollerState) return;

  // Check if auto-yes is still enabled
  const autoYesState = getAutoYesState(worktreeId);
  if (!autoYesState?.enabled || isAutoYesExpired(autoYesState)) {
    stopAutoYesPolling(worktreeId);
    return;
  }

  try {
    // 1. Capture tmux output
    const output = await captureSessionOutput(worktreeId, cliToolId, 5000);

    // 2. Strip ANSI codes
    const cleanOutput = stripAnsi(output);

    // 2.5. Skip prompt detection during thinking state (Issue #161, Layer 1)
    // This prevents false positive detection of numbered lists in CLI output
    // while Claude is actively processing (thinking/planning).
    if (detectThinking(cliToolId, cleanOutput)) {
      scheduleNextPoll(worktreeId, cliToolId);
      return;
    }

    // 3. Detect prompt
    const promptOptions = buildDetectPromptOptions(cliToolId);
    const promptDetection = detectPrompt(cleanOutput, promptOptions);

    if (!promptDetection.isPrompt || !promptDetection.promptData) {
      // No prompt detected, schedule next poll
      scheduleNextPoll(worktreeId, cliToolId);
      return;
    }

    // 4. Resolve auto answer
    const answer = resolveAutoAnswer(promptDetection.promptData);
    if (answer === null) {
      // Cannot auto-answer this prompt
      scheduleNextPoll(worktreeId, cliToolId);
      return;
    }

    // 5. Send answer to tmux
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);
    const sessionName = cliTool.getSessionName(worktreeId);

    // Send answer followed by Enter
    await sendKeys(sessionName, answer, false);
    await new Promise(resolve => setTimeout(resolve, 100));
    await sendKeys(sessionName, '', true);

    // 6. Update timestamp
    updateLastServerResponseTimestamp(worktreeId, Date.now());

    // 7. Reset error count on success
    resetErrorCount(worktreeId);

    // Log success (without sensitive content)
    console.info(`[Auto-Yes Poller] Sent response for worktree: ${worktreeId}`);
  } catch (error) {
    // Increment error count on failure
    incrementErrorCount(worktreeId);

    // Log error (without sensitive details)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`[Auto-Yes Poller] Error for worktree ${worktreeId}: ${errorMessage}`);
  }

  // Schedule next poll
  scheduleNextPoll(worktreeId, cliToolId);
}

/**
 * Schedule the next polling iteration
 */
function scheduleNextPoll(worktreeId: string, cliToolId: CLIToolType): void {
  const pollerState = autoYesPollerStates.get(worktreeId);
  if (!pollerState) return;

  pollerState.timerId = setTimeout(() => {
    pollAutoYes(worktreeId, cliToolId);
  }, pollerState.currentInterval);
}

/**
 * Start server-side auto-yes polling for a worktree
 */
export function startAutoYesPolling(
  worktreeId: string,
  cliToolId: CLIToolType
): StartPollingResult {
  // Validate worktree ID (security)
  if (!isValidWorktreeId(worktreeId)) {
    return { started: false, reason: 'invalid worktree ID' };
  }

  // Check if auto-yes is enabled
  const autoYesState = getAutoYesState(worktreeId);
  if (!autoYesState?.enabled) {
    return { started: false, reason: 'auto-yes not enabled' };
  }

  // Check concurrent poller limit (DoS protection)
  // If this worktree already has a poller, don't count it toward the limit
  const existingPoller = autoYesPollerStates.has(worktreeId);
  if (!existingPoller && autoYesPollerStates.size >= MAX_CONCURRENT_POLLERS) {
    return { started: false, reason: 'max concurrent pollers reached' };
  }

  // Stop existing poller if any
  if (existingPoller) {
    stopAutoYesPolling(worktreeId);
  }

  // Create new poller state
  const pollerState: AutoYesPollerState = {
    timerId: null,
    cliToolId,
    consecutiveErrors: 0,
    currentInterval: POLLING_INTERVAL_MS,
    lastServerResponseTimestamp: null,
  };
  autoYesPollerStates.set(worktreeId, pollerState);

  // Start polling immediately
  pollerState.timerId = setTimeout(() => {
    pollAutoYes(worktreeId, cliToolId);
  }, POLLING_INTERVAL_MS);

  console.info(`[Auto-Yes Poller] Started for worktree: ${worktreeId}, cliTool: ${cliToolId}`);
  return { started: true };
}

/**
 * Stop server-side auto-yes polling for a worktree
 */
export function stopAutoYesPolling(worktreeId: string): void {
  const pollerState = autoYesPollerStates.get(worktreeId);
  if (!pollerState) return;

  // Clear timer
  if (pollerState.timerId) {
    clearTimeout(pollerState.timerId);
  }

  // Remove state
  autoYesPollerStates.delete(worktreeId);
  console.info(`[Auto-Yes Poller] Stopped for worktree: ${worktreeId}`);
}

/**
 * Stop all server-side auto-yes polling (graceful shutdown)
 */
export function stopAllAutoYesPolling(): void {
  for (const [worktreeId, pollerState] of autoYesPollerStates.entries()) {
    if (pollerState.timerId) {
      clearTimeout(pollerState.timerId);
    }
    console.info(`[Auto-Yes Poller] Stopped for worktree: ${worktreeId} (shutdown)`);
  }
  autoYesPollerStates.clear();
}
