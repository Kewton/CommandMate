/** Polling lifecycle management: start, stop, schedule, and state tracking for response polling. */

import { AsyncLocalStorage } from 'async_hooks';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import {
  initTuiAccumulator,
  clearTuiAccumulator,
} from '../tui-accumulator';
import { clearPromptHashCache, renamePromptHashCacheKey } from './prompt-dedup';
import { clearResponseHashCache, renameResponseHashCacheKey } from './response-dedup';
import { renamePromptDedupSkips } from './prompt-dedup-state';
import { checkForResponse } from './response-checker';
import { broadcastTerminalSnapshot } from '@/lib/realtime/terminal-broadcast';

const logger = createLogger('response-poller');

// ============================================================================
// Constants
// ============================================================================

/**
 * Polling interval in milliseconds (default: 2 seconds)
 */
export const POLLING_INTERVAL = 2000;

/**
 * Maximum polling duration in milliseconds (default: 30 minutes)
 * Previously 5 minutes, which caused silent polling stops for long-running tasks.
 */
export const MAX_POLLING_DURATION = 30 * 60 * 1000;

/**
 * How long a tick may sit inside `checkForResponse()` before a restart stops
 * waiting for it (Issue #2223).
 *
 * Restarts are normally handed to the in-flight tick so the old and new chains
 * never run at once. That queue is only safe while the tick is guaranteed to
 * settle: a `checkForResponse()` that never resolves would otherwise park every
 * later `startPolling()` for that session *forever*, which is a worse failure
 * than the overlap the queue avoids. One tmux capture plus the save path is
 * seconds at the outside, so a minute means the tick is lost, and the restart
 * goes ahead without it.
 */
export const STALLED_TICK_TIMEOUT = 60 * 1000;

/**
 * Gemini auth/loading state indicators that should not be treated as complete responses.
 * Braille spinner characters are shared with CLAUDE_SPINNER_CHARS in cli-patterns.ts.
 * Extracted to module level for clarity and to avoid re-creation on each call.
 */
export const GEMINI_LOADING_INDICATORS: readonly string[] = [
  'Waiting for auth',
  '\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f',
];

// ============================================================================
// Poller State Management
// ============================================================================

/** The session one poller chain polls. */
interface PollTarget {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
}

/**
 * Ownership token for one poller chain — one "generation" of a poller key.
 *
 * The chain's `setTimeout` callback holds this object directly, so it can ask
 * *"am I still the poller for this key?"* rather than *"is there a poller for
 * this key?"* — the question the pre-#2223 `activePollers.has(pollerKey)` guard
 * asked, and the reason a superseded tick could re-register itself over the
 * poller that replaced it.
 *
 * The two flags are deliberately distinct:
 *
 * - `superseded` — a newer chain took the key (restart or worktree-ID
 *   migration). The old tick must neither reschedule **nor** broadcast: its
 *   snapshot is of the turn that just ended and would arrive after the new
 *   chain's frames.
 * - `stopped` — this chain itself ended (`stopPolling`, max duration, session
 *   gone). The tick must not reschedule, but its final snapshot is still the
 *   most recent screen and is still pushed, exactly as before #2223.
 */
interface PollerOwner {
  readonly pollerKey: string;
  readonly generation: number;
  superseded: boolean;
  stopped: boolean;
}

/**
 * Process-wide poller coordinator (Issue #2223).
 *
 * Reached through `globalThis` for the reason `__terminalSnapshotVersions`
 * (#2220), `__chatTurnProgressState` (#2199) and `__promptDedupSkips` (#1736)
 * are: under `next start` this module is evaluated **twice** — once in the
 * custom server's graph (`server.ts` → `timer-manager` → `sendUserMessage`,
 * and the Auto-Yes poller) and once per Next route bundle (`/send`,
 * `/respond`, `/prompt-response`). Module scope made "the map of active
 * pollers" one map *per graph*, so a poller started by a restored timer and a
 * poller started by the next `/send` were invisible to each other: both ran,
 * both captured the same pane, and both saved the same reply.
 *
 * `activePollers` / `pollingStartTimes` stay plain Maps under the same names
 * because `migrateResponsePollerWorktreeIds` and its tests write into them
 * directly. `owners` / `running` / `pendingRestart` are the part that makes the
 * singleton actually hold, and are internal.
 */
interface PollerCoordinator {
  /** Poller key -> the timer for its next tick (a fired timer while one runs). */
  activePollers: Map<string, NodeJS.Timeout>;
  /** Poller key -> when the current turn's polling began. */
  pollingStartTimes: Map<string, number>;
  /** Poller key -> the chain that currently owns it. */
  owners: Map<string, PollerOwner>;
  /** Poller key -> the tick executing right now, and when it started. */
  running: Map<string, { owner: PollerOwner; since: number }>;
  /** Poller key -> a restart handed to the in-flight tick's epilogue. */
  pendingRestart: Map<string, PollTarget>;
  /**
   * Carries the running tick's ownership token through `checkForResponse()`,
   * so a `stopPolling()` raised *inside* a superseded tick can be told apart
   * from one raised by a route, `session-cleanup` or `kill-session`. Without
   * it the old tick's "the turn is over" verdict would stop the chain that
   * replaced it — the reverse of the re-registration race, and just as fatal.
   */
  ownerStorage: AsyncLocalStorage<PollerOwner>;
  /** Monotonic across every key, so a generation is never reused. */
  generationCounter: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __responsePollerCoordinator: PollerCoordinator | undefined;
}

const coordinator: PollerCoordinator =
  globalThis.__responsePollerCoordinator ??
  (globalThis.__responsePollerCoordinator = {
    activePollers: new Map<string, NodeJS.Timeout>(),
    pollingStartTimes: new Map<string, number>(),
    owners: new Map<string, PollerOwner>(),
    running: new Map<string, { owner: PollerOwner; since: number }>(),
    pendingRestart: new Map<string, PollTarget>(),
    ownerStorage: new AsyncLocalStorage<PollerOwner>(),
    generationCounter: 0,
  });

/**
 * Active pollers map: "worktreeId:instanceId" -> NodeJS.Timeout
 *
 * Shared through `globalThis` (see {@link PollerCoordinator}): the Node module
 * cache does **not** give this singleton behaviour, because the module is
 * evaluated once per bundle and `next start` builds more than one bundle that
 * reaches it (Issue #2223).
 *
 * Issue #868: The key is scoped by instanceId so multiple instances of the
 * same CLI tool on one worktree get independent pollers. For the primary
 * instance (instanceId omitted or equal to cliToolId), the key is identical
 * to the legacy "worktreeId:cliToolId" form for backward compatibility.
 *
 * Membership alone does **not** say who owns the chain — a tick that has
 * already fired leaves its timer here while it runs. Code deciding whether to
 * keep polling must compare ownership tokens, not call `.has()`.
 */
export const activePollers = coordinator.activePollers;

/**
 * Polling start times map: "worktreeId:instanceId" -> timestamp
 */
export const pollingStartTimes = coordinator.pollingStartTimes;

/**
 * Generate poller key from worktree ID and agent instance.
 *
 * Issue #868: When instanceId is omitted it defaults to cliToolId (the primary
 * instance), preserving the legacy "worktreeId:cliToolId" key.
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini, ...)
 * @param instanceId - Optional agent instance ID (defaults to cliToolId)
 */
export function getPollerKey(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): string {
  return `${worktreeId}:${instanceId ?? cliToolId}`;
}

/** Hand `pollerKey` to a brand-new chain, retiring whichever chain held it. */
function takeOwnership(pollerKey: string): PollerOwner {
  const previous = coordinator.owners.get(pollerKey);
  if (previous) previous.superseded = true;

  const owner: PollerOwner = {
    pollerKey,
    generation: ++coordinator.generationCounter,
    superseded: false,
    stopped: false,
  };
  coordinator.owners.set(pollerKey, owner);
  return owner;
}

// ============================================================================
// Polling lifecycle (public API)
// ============================================================================

/**
 * Start polling for CLI tool response
 *
 * Issue #2223: at most one chain per poller key exists in the whole process,
 * and starting one while a tick of the previous chain is still inside
 * `checkForResponse()` does **not** run the two side by side — the restart is
 * handed to that tick's epilogue and applied when it settles.
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @param instanceId - Optional agent instance ID (defaults to primary)
 *
 * @example
 * ```typescript
 * startPolling('feature-foo', 'claude');
 * ```
 */
export function startPolling(worktreeId: string, cliToolId: CLIToolType, instanceId?: string): void {
  const pollerKey = getPollerKey(worktreeId, cliToolId, instanceId);
  const target: PollTarget = { worktreeId, cliToolId, instanceId };

  const inFlight = coordinator.running.get(pollerKey);
  if (inFlight) {
    // Whatever happens next, the tick that is mid-flight has lost the key: it
    // must not reschedule itself over the new chain, and its snapshot is of the
    // previous turn.
    inFlight.owner.superseded = true;

    if (Date.now() - inFlight.since < STALLED_TICK_TIMEOUT) {
      coordinator.pendingRestart.set(pollerKey, target);
      return;
    }

    logger.warn('poller:restart-past-stalled-tick', {
      pollerKey,
      generation: inFlight.owner.generation,
      runningForMs: Date.now() - inFlight.since,
    });
    coordinator.running.delete(pollerKey);
  }

  // Stop existing poller if any
  stopPolling(worktreeId, cliToolId, instanceId);

  beginPolling(target);
}

/** Seed a fresh polling cycle (start time, TUI accumulator) and schedule its first tick. */
function beginPolling(target: PollTarget): void {
  const pollerKey = getPollerKey(target.worktreeId, target.cliToolId, target.instanceId);

  // Record start time
  coordinator.pollingStartTimes.set(pollerKey, Date.now());

  // Initialize TUI accumulator for full-screen TUI tools (Layer 2 safety net)
  if (target.cliToolId === 'opencode' || target.cliToolId === 'copilot') {
    initTuiAccumulator(pollerKey);
  }

  // Start polling with setTimeout chain to prevent race conditions
  scheduleNextResponsePoll(target.worktreeId, target.cliToolId, target.instanceId);
}

/**
 * Take over `pollerKey` with a new chain and schedule its first tick.
 *
 * Public because {@link migrateResponsePollerWorktreeIds} restarts a poller
 * under a new worktree ID with it. The chain's own continuation does *not* go
 * through here: it keeps its ownership token, so its generation survives the
 * whole cycle.
 */
export function scheduleNextResponsePoll(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): void {
  const pollerKey = getPollerKey(worktreeId, cliToolId, instanceId);
  scheduleTick({ worktreeId, cliToolId, instanceId }, takeOwnership(pollerKey));
}

/** Arm the next tick of an existing chain, keeping its ownership token. */
function scheduleTick(target: PollTarget, owner: PollerOwner): void {
  const timerId = setTimeout(() => {
    void runPollTick(target, owner);
  }, POLLING_INTERVAL);

  coordinator.activePollers.set(owner.pollerKey, timerId);
}

/**
 * One poll: check for a response, push a snapshot, and arm the next tick.
 *
 * Every decision after the `await` is made against `owner`, never against the
 * presence of a key in {@link activePollers}. `clearTimeout()` cannot cancel a
 * timer that has already fired, so a tick of a chain that was stopped or
 * superseded while it was awaiting `checkForResponse()` still gets here — and
 * before #2223 it read `activePollers.has()` as "I am still the poller",
 * re-registering its own timer over the live one and leaving that poller's
 * timer running but untracked (Issue #2223).
 */
async function runPollTick(target: PollTarget, owner: PollerOwner): Promise<void> {
  const pollerKey = owner.pollerKey;

  // The timer fired for a chain that has since lost the key. Nothing to do:
  // whoever retired it also armed (or deliberately did not arm) the successor.
  if (owner.superseded || owner.stopped) return;

  coordinator.running.set(pollerKey, { owner, since: Date.now() });

  try {
    // Check if max duration exceeded
    const startTime = coordinator.pollingStartTimes.get(pollerKey);
    if (startTime && Date.now() - startTime > MAX_POLLING_DURATION) {
      stopPollingByKey(pollerKey);
      return;
    }

    // Check for response
    try {
      await coordinator.ownerStorage.run(owner, () =>
        checkForResponse(target.worktreeId, target.cliToolId, target.instanceId)
      );
    } catch (error: unknown) {
      logger.error('error:', { error: error instanceof Error ? error.message : String(error) });
    }

    // Issue #1120: push the current terminal snapshot to WS subscribers so the
    // output streams during generation. No-op (and no tmux capture) when nobody
    // is subscribed to the worktree room. Best-effort; polling is the fallback.
    //
    // Issue #2223: skipped once another chain owns the key — a superseded tick
    // would push the previous turn's screen on top of the live one, and its
    // `version` counter would make the client drop the real frame that follows.
    if (!owner.superseded) {
      void broadcastTerminalSnapshot(target.worktreeId, target.cliToolId, target.instanceId);
    }

    // Schedule next poll ONLY after current one completes
    // Guard: only if THIS chain is still the poller for the key (Issue #2223)
    if (!owner.superseded && !owner.stopped) {
      scheduleTick(target, owner);
    }
  } finally {
    if (coordinator.running.get(pollerKey)?.owner === owner) {
      coordinator.running.delete(pollerKey);
    }

    // Apply a restart that arrived while this tick was in flight. Doing it here
    // rather than in startPolling() is what keeps the old and new chains from
    // polling the same pane at the same time.
    const pending = coordinator.pendingRestart.get(pollerKey);
    if (pending) {
      coordinator.pendingRestart.delete(pollerKey);
      stopPollingByKey(pollerKey);
      beginPolling(pending);
    }
  }
}

/**
 * Stop the poller identified by an already-computed poller key.
 * Shared by stopPolling() and stopAllPolling() so cleanup logic stays in one place.
 */
function stopPollingByKey(pollerKey: string): void {
  // Issue #2223: a tick that has been superseded still runs to completion, and
  // `checkForResponse()` ends the turn with `stopPolling()` on four paths
  // (worktree gone, session not running, prompt detected, TUI reply saved).
  // Honouring that verdict would kill the chain that replaced it — the old
  // tick is describing a turn that is already over.
  const caller = coordinator.ownerStorage.getStore();
  if (caller && caller.pollerKey === pollerKey && (caller.superseded || caller.stopped)) {
    logger.info('poller:stale-stop-ignored', {
      pollerKey,
      generation: caller.generation,
    });
    return;
  }

  const owner = coordinator.owners.get(pollerKey);
  if (owner) {
    owner.stopped = true;
    coordinator.owners.delete(pollerKey);
  }
  // A restart queued behind an in-flight tick is cancelled by an explicit stop:
  // "start then stop" must leave the session stopped.
  coordinator.pendingRestart.delete(pollerKey);

  const timerId = coordinator.activePollers.get(pollerKey);

  if (timerId) {
    clearTimeout(timerId);
    coordinator.activePollers.delete(pollerKey);
    coordinator.pollingStartTimes.delete(pollerKey);
  }

  // Clean up TUI accumulator if present
  clearTuiAccumulator(pollerKey);

  // Issue #565: Clear prompt hash cache to prevent stale dedup state
  clearPromptHashCache(pollerKey);

  // Issue #1268: Clear response hash cache too, so the next turn can save a
  // response even when its content is identical to the previous turn's.
  clearResponseHashCache(pollerKey);
}

/**
 * Stop polling for a worktree and CLI tool / instance combination
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @param instanceId - Optional agent instance ID (defaults to primary)
 *
 * @example
 * ```typescript
 * stopPolling('feature-foo', 'claude');
 * ```
 */
export function stopPolling(worktreeId: string, cliToolId: CLIToolType, instanceId?: string): void {
  stopPollingByKey(getPollerKey(worktreeId, cliToolId, instanceId));
}

/**
 * Stop all active pollers
 * Used for cleanup on server shutdown
 */
export function stopAllPolling(): void {
  const keys = new Set([
    ...Array.from(coordinator.activePollers.keys()),
    ...Array.from(coordinator.owners.keys()),
  ]);
  for (const pollerKey of keys) {
    stopPollingByKey(pollerKey);
  }
  coordinator.pendingRestart.clear();
}

/**
 * Get list of active pollers
 *
 * @returns Array of worktree IDs currently being polled
 */
export function getActivePollers(): string[] {
  return Array.from(coordinator.activePollers.keys());
}

// ============================================================================
// Worktree ID migration (Issue #1621 Phase 3)
// ============================================================================

/** One response poller that moved from one worktree ID to another. */
export interface MigratedPollerKey {
  /** Poller key the poller used to run under */
  oldKey: string;
  /** Poller key it runs under now */
  newKey: string;
  /** Worktree ID after the move */
  newWorktreeId: string;
  /** CLI tool being polled */
  cliToolId: CLIToolType;
  /** Agent instance being polled (equals cliToolId for the primary) */
  instanceId: string;
}

/** Split a poller key into its worktree and instance halves. */
function splitPollerKey(pollerKey: string): { worktreeId: string; instanceId: string } | null {
  const separatorIndex = pollerKey.indexOf(':');
  // A worktree ID never contains ':' (isValidWorktreeId), so the first one is
  // always the boundary.
  if (separatorIndex <= 0 || separatorIndex === pollerKey.length - 1) return null;
  return {
    worktreeId: pollerKey.slice(0, separatorIndex),
    instanceId: pollerKey.slice(separatorIndex + 1),
  };
}

/**
 * Move every running response poller from a renamed worktree ID to the new one
 * (Issue #1621 Phase 3).
 *
 * Re-keying the maps alone is **not** enough, and this is the subtle part: the
 * `setTimeout` chain in {@link scheduleNextResponsePoll} closes over
 * `worktreeId` and recomputes its key on every tick. A poller left running
 * would go on capturing `mcbd-<cli>-<OLD id>` (a session that no longer exists
 * after the rename), writing its messages against an ID no row carries, and
 * re-registering the old key the moment it fired. So each poller is torn down
 * and restarted under the new ID — ownership token included (Issue #2223), so a
 * tick already inside `checkForResponse()` cannot come back and act on the old
 * ID — with everything that represents *progress* carried across:
 *
 * - `pollingStartTimes`, so MAX_POLLING_DURATION still measures from when the
 *   turn actually began rather than restarting the 30-minute budget;
 * - the prompt and response dedup hashes, so the screen currently on display is
 *   not saved a second time as a new message, together with the prompt-skip
 *   tally that explains those suppressions to `capture --json` (Issue #1695).
 *
 * The TUI accumulator (opencode / copilot only) is re-initialised empty at the
 * new key instead of carried over: `tui-accumulator.ts` exposes no way to write
 * a buffer back, and it is outside this Issue's allowed scope. The cost is that
 * one in-flight TUI response may be truncated at the rename boundary; the next
 * turn accumulates normally.
 *
 * Takes the whole batch because IDs can swap (A→B, B→A): every source key is
 * removed before any destination key is written.
 *
 * @param renames - Worktree ID pairs being applied
 * @param resolveCliToolId - Maps a poller's (worktree, instance) back to its CLI
 *   tool, which the poller key does not encode for alias instances. Callers pass
 *   a roster-backed lookup; returning null skips that poller (it is stopped
 *   rather than left pointing at a dead ID).
 * @returns One entry per poller that was moved
 */
export function migrateResponsePollerWorktreeIds(
  renames: ReadonlyArray<{ oldId: string; newId: string }>,
  resolveCliToolId: (worktreeId: string, instanceId: string) => CLIToolType | null
): MigratedPollerKey[] {
  const targets = new Map<string, string>();
  for (const { oldId, newId } of renames) {
    if (!oldId || !newId || oldId === newId) continue;
    targets.set(oldId, newId);
  }
  if (targets.size === 0) return [];

  const moves: MigratedPollerKey[] = [];
  const abandoned: string[] = [];

  for (const pollerKey of Array.from(activePollers.keys())) {
    const parts = splitPollerKey(pollerKey);
    if (!parts) continue;
    const newWorktreeId = targets.get(parts.worktreeId);
    if (!newWorktreeId) continue;

    const cliToolId = resolveCliToolId(parts.worktreeId, parts.instanceId);
    if (!cliToolId) {
      abandoned.push(pollerKey);
      continue;
    }

    moves.push({
      oldKey: pollerKey,
      newKey: getPollerKey(newWorktreeId, cliToolId, parts.instanceId),
      newWorktreeId,
      cliToolId,
      instanceId: parts.instanceId,
    });
  }

  // Phase 1: stop every affected timer and lift the state off the old keys.
  // Done for the whole batch before any write so a swap cannot self-collide.
  const carried = new Map<string, { startedAt: number | undefined }>();
  for (const move of moves) {
    const timerId = activePollers.get(move.oldKey);
    if (timerId) clearTimeout(timerId);
    activePollers.delete(move.oldKey);

    // Issue #2223: retire the ownership token as well. A tick that is inside
    // `checkForResponse()` right now cannot be cancelled by `clearTimeout`, and
    // without this it would resume, find its key gone and — before #2223 —
    // still be able to act on the old worktree ID. Marked superseded rather
    // than merely stopped: Phase 2 below arms a replacement chain, so the old
    // tick's snapshot would land on top of the new one's.
    const retired = coordinator.owners.get(move.oldKey);
    if (retired) {
      retired.superseded = true;
      retired.stopped = true;
      coordinator.owners.delete(move.oldKey);
    }
    coordinator.pendingRestart.delete(move.oldKey);

    carried.set(move.newKey, { startedAt: pollingStartTimes.get(move.oldKey) });
    pollingStartTimes.delete(move.oldKey);

    renamePromptHashCacheKey(move.oldKey, move.newKey);
    renameResponseHashCacheKey(move.oldKey, move.newKey);
    // Issue #1695: the prompt hash moved on the line above, so the guard keeps
    // suppressing the prompt on screen under the new ID. Its tally has to move
    // with it, or `capture --json` reports zero skips for a session that is
    // still skipping. Old worktree ID comes back out of the key we just left.
    const movedFrom = splitPollerKey(move.oldKey);
    if (movedFrom) {
      renamePromptDedupSkips(movedFrom.worktreeId, move.newWorktreeId, move.cliToolId, move.instanceId);
    }
    clearTuiAccumulator(move.oldKey);
  }
  for (const pollerKey of abandoned) {
    stopPollingByKey(pollerKey);
    logger.warn('poller:migrate-abandoned', { pollerKey });
  }

  // Phase 2: restart each poller under its new identity.
  for (const move of moves) {
    const startedAt = carried.get(move.newKey)?.startedAt;
    pollingStartTimes.set(move.newKey, startedAt ?? Date.now());
    if (move.cliToolId === 'opencode' || move.cliToolId === 'copilot') {
      initTuiAccumulator(move.newKey);
    }
    scheduleNextResponsePoll(move.newWorktreeId, move.cliToolId, move.instanceId);
  }

  return moves;
}
