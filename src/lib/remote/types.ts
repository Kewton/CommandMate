/**
 * Provider abstraction for `commandmate remote` (Issue #1937, R1).
 *
 * The shapes here are §6.1 of `docs/design/remote-qr-pairing-1937.md` verbatim.
 * Two of them carry a structural guarantee rather than a convention, and both
 * exist because a Provider can destroy configuration the user created and that
 * CommandMate has no way to restore (§6.3):
 *
 * 1. `RemoteProvider` has no `reset()` / `cleanupAll()`. `stop()` takes a
 *    `RemoteHandle` and nothing else, so "read the Provider's whole config and
 *    tear it down" is not expressible in this type. A pinning test asserts the
 *    member list stays exactly `id` / `detect` / `start` / `stop`.
 * 2. `start()` must return `preexisting`. `stop()` reverts only what is in
 *    `owned` and NOT in `preexisting`; anything in both is skipped and reported
 *    in `StopOutcome.skipped` so a human can see what was left alone.
 *
 * Choosing between Providers is deliberately NOT here. "Tailscale first, and do
 * not silently fall back to a public tunnel" is a rule about selection, not a
 * property of either Provider, so it lives in the orchestrator that will own
 * `src/cli/commands/remote.ts` (R9). See `provider-registry.ts`.
 */

/** Every Provider CommandMate knows how to drive. */
export type RemoteProviderId = 'tailscale-serve' | 'cloudflare-quick';

/**
 * Result of a side-effect-free probe.
 *
 * `available` and `ready` are separate on purpose: Tailscale can be installed
 * and still be unable to serve because the machine is not logged in. Keeping
 * the two apart is what lets the orchestrator write the selection rule
 * (Tailscale -> cloudflared -> explain) as a plain `ready` check.
 */
export interface ProviderDetection {
  /** The executable exists and could be run. */
  available: boolean;
  /** Version string as reported by the executable, when it could be read. */
  version?: string;
  /** The Provider is in a state where `start()` could succeed right now. */
  ready: boolean;
  /** Why `available` or `ready` is false. Shown to the user; never a secret. */
  reason?: string;
}

/**
 * A snapshot of the Provider's own configuration taken immediately before
 * `start()` ran.
 *
 * `RemoteHandle.preexisting` is typed `unknown` because the raw shape differs
 * per Provider (§6.2: "how to take the snapshot is Provider-specific"). This
 * interface is the one part the shared skip rule needs to read, so a Provider
 * that has revertible state MUST snapshot into this shape. A Provider with no
 * persistent state (Cloudflare Quick Tunnel) leaves `preexisting` as `null`.
 */
export interface PreexistingSnapshot {
  /**
   * Keys, in the same keyspace as `RemoteHandle.owned.revert`, that already
   * existed before `start()`. `stop()` must not touch these.
   */
  keys: readonly string[];
  /** The verbatim Provider-specific snapshot, kept for diagnostics. */
  raw: unknown;
}

/** What CommandMate made the Provider create during one remote session. */
export interface RemoteHandle {
  provider: RemoteProviderId;
  /** The public https:// URL the Provider is now serving. */
  url: string;
  /** Identifies only what CommandMate created. `stop()` touches nothing else. */
  owned: {
    /** Child process CommandMate spawned, or null when the Provider is a daemon. */
    pid: number | null;
    /** Provider-specific "how to undo this", keyed like `PreexistingSnapshot.keys`. */
    revert: Record<string, string> | null;
  };
  /**
   * Provider state as it was just before `start()`. Anything in here is
   * off-limits to `stop()`. Use `PreexistingSnapshot` when there is state to
   * protect; `null` when the Provider persists nothing.
   */
  preexisting: unknown;
}

/** What `stop()` actually did, including what it deliberately did not do. */
export interface StopOutcome {
  /** True only if every owned entry that needed reverting was reverted. */
  reverted: boolean;
  /**
   * Owned keys left alone because they were also in `preexisting`. Surfacing
   * them is the point: a silent skip is indistinguishable from a silent delete.
   */
  skipped: string[];
  /** Non-fatal problems worth showing the user. */
  warnings: string[];
}

/**
 * One way of exposing `http://127.0.0.1:<port>` to a phone.
 *
 * Deliberately absent: any method that operates on "the Provider's current
 * configuration" instead of on a handle. See the file header.
 */
export interface RemoteProvider {
  readonly id: RemoteProviderId;
  /** Probe availability and readiness. Must have no side effects. */
  detect(): Promise<ProviderDetection>;
  /** Expose 127.0.0.1:port. Must fill in `preexisting` before returning. */
  start(opts: { port: number; signal: AbortSignal }): Promise<RemoteHandle>;
  /** Undo only `handle.owned`. Never touches anything in `handle.preexisting`. */
  stop(handle: RemoteHandle): Promise<StopOutcome>;
}

/** Narrows `RemoteHandle.preexisting` to the shape the shared skip rule reads. */
export function isPreexistingSnapshot(value: unknown): value is PreexistingSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const keys = (value as { keys?: unknown }).keys;
  return Array.isArray(keys) && keys.every((key) => typeof key === 'string');
}

/** The revert entries `stop()` may act on, and the ones it must leave alone. */
export interface StopPlan {
  /** Owned and not preexisting: safe to undo. */
  revert: Record<string, string>;
  /** Owned and also preexisting: must be left in place, and reported. */
  skipped: string[];
}

/**
 * Splits a handle's owned revert entries into "safe to undo" and "leave alone".
 *
 * This is the single implementation of §6.3-2. Every Provider's `stop()` routes
 * through it so the rule cannot drift between Providers, and so the rule can be
 * tested once instead of once per Provider.
 */
export function planStop(handle: RemoteHandle): StopPlan {
  const owned = handle.owned.revert ?? {};
  const protectedKeys = new Set(
    isPreexistingSnapshot(handle.preexisting) ? handle.preexisting.keys : [],
  );

  const revert: Record<string, string> = {};
  const skipped: string[] = [];
  for (const key of Object.keys(owned)) {
    if (protectedKeys.has(key)) {
      skipped.push(key);
      continue;
    }
    revert[key] = owned[key];
  }
  return { revert, skipped: skipped.sort() };
}
