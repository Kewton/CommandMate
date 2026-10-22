/**
 * Auto-Yes poller state store and tick generation (Issue #3783: split out of
 * `auto-yes-poller.ts`, which re-exports the public names).
 *
 * Does not statically import `auto-yes-poller.ts` (no cycle outside the
 * baseline in `import-cycles-baseline-3482`, which does not count dynamic
 * `import()`).
 *
 * @module lib/polling/auto-yes-poller-generation
 */

import type { CLIToolType } from '../cli-tools/types';
import { getEnterFallbackSessionEpoch } from './auto-yes-enter-fallback';
import {
  getAutoYesState,
  POLLING_INTERVAL_MS,
  DUPLICATE_RETRY_EXPIRY_MS,
  type AutoYesState,
} from '../auto-yes-state';
import { getOrInitGlobal } from '../global-state';
import type { AutoYesPollerState } from './auto-yes-poller-state';

// =============================================================================
// In-memory State (globalThis for hot reload persistence - Issue #153)
// Issue #525: Map key changed from worktreeId to compositeKey
// =============================================================================

declare global {
  // eslint-disable-next-line no-var
  var __autoYesPollerStates: Map<string, AutoYesPollerState> | undefined;
}

/** In-memory storage for poller states (globalThis for hot reload persistence) */
export const autoYesPollerStates = getOrInitGlobal('__autoYesPollerStates', () => new Map<string, AutoYesPollerState>());

// =============================================================================
// Poller State Accessors (compositeKey-based)
// =============================================================================

/**
 * Get poller state by composite key.
 *
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @returns Poller state or undefined
 */
export function getPollerState(compositeKey: string): AutoYesPollerState | undefined {
  return autoYesPollerStates.get(compositeKey);
}

/**
 * Get the number of active pollers.
 */
export function getActivePollerCount(): number {
  return autoYesPollerStates.size;
}

/**
 * Get the last server response timestamp for a composite key.
 *
 * Issue #525: Changed from (worktreeId) to (compositeKey).
 *
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @returns Timestamp (Date.now()) of the last server response, or null if none
 */
export function getLastServerResponseTimestamp(compositeKey: string): number | null {
  const pollerState = getPollerState(compositeKey);
  return pollerState?.lastServerResponseTimestamp ?? null;
}

/**
 * Check if a server-side auto-yes poller is active for a composite key.
 *
 * Issue #525: Changed from (worktreeId) to (compositeKey).
 *
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @returns true if a poller is actively running
 */
export function isPollerActive(compositeKey: string): boolean {
  return autoYesPollerStates.has(compositeKey);
}

/**
 * Update the last server response timestamp.
 *
 * @param compositeKey - Composite key
 * @param timestamp - Timestamp value (Date.now())
 */
export function updateLastServerResponseTimestamp(
  compositeKey: string,
  timestamp: number,
  owner?: AutoYesPollerState,
): void {
  const pollerState = ownedPollerState(compositeKey, owner);
  if (pollerState) {
    pollerState.lastServerResponseTimestamp = timestamp;
  }
}

/**
 * Reset error count for a poller and restore the default polling interval.
 * Called after every poll that ran to the end without an error (Issue #3329)
 * and after an answer is sent.
 *
 * @param compositeKey - Composite key
 * @param owner - The tick's own poller state (Issue #3706); see {@link ownedPollerState}
 */
export function resetErrorCount(compositeKey: string, owner?: AutoYesPollerState): void {
  const pollerState = ownedPollerState(compositeKey, owner);
  if (pollerState) {
    pollerState.consecutiveErrors = 0;
    pollerState.currentInterval = POLLING_INTERVAL_MS;
  }
}

// =============================================================================
// Tick generation (Issue #3706)
// =============================================================================

/**
 * What one tick acts for — its "generation" — taken at the top of the tick and
 * compared, never re-read by key, after every wait (Issue #3706).
 *
 * The response poller's `PollerOwner` (`polling/poller-owner.ts`) idea, held by the Auto-Yes state itself: the poller state object
 * `startAutoYesPolling` creates is the poller's token (a restart or a
 * disable → enable makes a new one, a stop deletes it), and the
 * {@link AutoYesState} object in `auto-yes-state` is the grant's (an enable
 * and a disable each store a new one). Re-reading by KEY cannot tell the old
 * generation from a new one that took the key over, which is how a tick in
 * flight across a disable → enable used to answer, and to re-arm a second timer
 * over the new poller's.
 */
export interface AutoYesTickGeneration {
  readonly compositeKey: string;
  readonly worktreeId: string;
  readonly cliToolId: CLIToolType;
  readonly instanceId: string | undefined;
  /** The poller state the tick started under. */
  readonly pollerState: AutoYesPollerState;
  /** The grant the tick started under. */
  readonly grant: AutoYesState;
  /** `getEnterFallbackSessionEpoch` at the start: a relaunch the poller outlived moves it. */
  readonly sessionEpoch: number;
  /**
   * Epoch ms the tick started. A pending prompt row saved after it cannot be the
   * one this tick read off the screen (Issue #3706, see `finishAnsweredPrompt`).
   */
  readonly startedAt: number;
}

/**
 * The poller state under `compositeKey`, but only when it is `owner` — the
 * tick's own (Issue #3706). Without `owner` (callers outside a tick, and tests
 * driving `detectAndRespondToPrompt` with a hand-built state) it is the plain
 * by-key read this always was.
 */
export function ownedPollerState(compositeKey: string, owner?: AutoYesPollerState): AutoYesPollerState | undefined {
  const pollerState = getPollerState(compositeKey);
  if (owner !== undefined && pollerState !== owner) return undefined;
  return pollerState;
}

/** Is the tick's poller still the one under its key (not stopped, not replaced)? */
export function isPollerCurrent(generation: AutoYesTickGeneration): boolean {
  return getPollerState(generation.compositeKey) === generation.pollerState;
}

/**
 * May the tick still act: its poller, its grant (the same enable, not expired)
 * and its session (no relaunch since) are all still the ones it started under.
 * Checked after capture, after each wait before a key, and inside the send.
 */
export function isTickCurrent(generation: AutoYesTickGeneration): boolean {
  if (!isPollerCurrent(generation)) return false;
  // `getAutoYesState` returns the stored object until it expires, when it
  // stores (and returns) a disabled one — so an expiry fails identity too.
  const grant = getAutoYesState(generation.worktreeId, generation.cliToolId, generation.instanceId);
  if (grant !== generation.grant || !grant.enabled) return false;
  return isSameSession(generation);
}

/**
 * Is the session the tick answered still the one it started on (Issue #3706)?
 * What the follow-ups of an answer already sent — the response poller restart,
 * the terminal push — are judged by: a disable after the keys landed does not
 * un-send them, a relaunch does make them about another process.
 */
export function isSameSession(generation: AutoYesTickGeneration): boolean {
  return getEnterFallbackSessionEpoch(generation.compositeKey) === generation.sessionEpoch;
}

/**
 * Check if the given prompt has already been answered recently.
 *
 * @param pollerState - Current poller state
 * @param promptKey - Composite key of the current prompt
 * @returns true if the prompt key matches and is within the retry expiry window
 */
export function isDuplicatePrompt(
  pollerState: AutoYesPollerState,
  promptKey: string
): boolean {
  if (pollerState.lastAnsweredPromptKey !== promptKey) return false;
  if (pollerState.lastAnsweredAt === null) return false;
  return (Date.now() - pollerState.lastAnsweredAt) < DUPLICATE_RETRY_EXPIRY_MS;
}
