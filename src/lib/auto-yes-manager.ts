/**
 * Auto Yes Manager - Server-side in-memory state management
 *
 * Manages auto-yes mode per worktree using an in-memory Map.
 * State is automatically cleared on server restart.
 */

/** Auto yes state for a worktree */
export interface AutoYesState {
  /** Whether auto-yes is enabled */
  enabled: boolean;
  /** Timestamp when auto-yes was enabled (Date.now()) */
  enabledAt: number;
  /** Timestamp when auto-yes expires (enabledAt + 3600000ms = 1 hour) */
  expiresAt: number;
}

/** Timeout duration: 1 hour in milliseconds */
const AUTO_YES_TIMEOUT_MS = 3600000;

/** In-memory storage for auto-yes states */
const autoYesStates = new Map<string, AutoYesState>();

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
