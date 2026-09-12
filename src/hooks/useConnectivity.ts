/**
 * useConnectivity — one connection verdict, from three independent signals.
 * Issue #2501.
 *
 * Before this hook the only thing the UI knew about connectivity was the shared
 * WebSocket's `status`, and the only place it was rendered was the desktop
 * header — so a phone that had lost its network said nothing at all. The three
 * signals folded together here are:
 *
 *   1. `navigator.onLine` — whether the device believes it is on a network.
 *   2. The shared WebSocket status (`useRealtime`) — whether live push is up.
 *   3. Server reachability — whether an actual HTTP request reaches the server.
 *
 * The asymmetry in (1) is the important part and is deliberate:
 * **`navigator.onLine === false` is trusted, `=== true` is not.** A captive
 * portal, a hotel Wi-Fi splash page or a phone holding an association with an
 * access point that routes nowhere all report `true`, so the flag can confirm
 * "offline" but can never on its own confirm "online". Positive evidence has to
 * come from (2) or (3) — something the server actually answered.
 *
 * Signal (3) has two sources. This hook runs its own lightweight probe while
 * the verdict is degraded, and `reportServerReachability()` lets any call site
 * feed the outcome of a real API request in without going through the hook —
 * that is the seam for instrumenting the app's fetches later.
 *
 * The status is exported as a pure function (`resolveConnectivityStatus`) so
 * the decision itself can be tested, and reused, without a React tree.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRealtime } from '@/hooks/useRealtimeConnection';
import type { RealtimeStatus } from '@/lib/realtime/types';

// ============================================================================
// Types
// ============================================================================

/**
 * The single verdict the UI renders from.
 *
 * - `online`       — the server answered; nothing is shown.
 * - `reconnecting` — the server is reachable but live push is down (polling is
 *                    carrying the app), or we are still establishing it.
 * - `offline`      — the device is off the network, or the server cannot be
 *                    reached at all.
 */
export type ConnectivityStatus = 'online' | 'reconnecting' | 'offline';

/** The raw inputs behind a {@link ConnectivityStatus}. */
export interface ConnectivitySignals {
  /**
   * `navigator.onLine`. `false` is treated as proof of being offline; `true` is
   * treated as no evidence at all (see the module note).
   */
  browserOnline: boolean;
  /** Status of the shared WebSocket (`useRealtime`). */
  realtimeStatus: RealtimeStatus;
  /**
   * Whether the last HTTP exchange with the server completed.
   * `null` means "not measured yet" and must not be read as either answer.
   */
  serverReachable: boolean | null;
}

/** What {@link useConnectivity} hands back. */
export interface ConnectivityState {
  /** The resolved verdict. */
  status: ConnectivityStatus;
  /** `status === 'online'`. */
  isOnline: boolean;
  /** `status === 'reconnecting'`. */
  isReconnecting: boolean;
  /** `status === 'offline'`. */
  isOffline: boolean;
  /**
   * Whether the UI should actually show something. Degraded *and* degraded for
   * longer than the settle window — see `surfaceDelayMs`. Every connectivity
   * surface should gate on this rather than on `status` directly.
   */
  shouldSurface: boolean;
  /** The inputs the verdict was computed from. */
  signals: ConnectivitySignals;
  /** `Date.now()` of the last confirmed reachability; `null` if never. */
  lastReachableAt: number | null;
  /** Run a reachability probe now (e.g. from a "retry" affordance). */
  recheck: () => void;
}

/** Options for {@link useConnectivity}. All have defaults. */
export interface UseConnectivityOptions {
  /** Endpoint the reachability probe requests. */
  probeUrl?: string;
  /** How long the verdict must stay degraded before the first probe (ms). */
  probeDelayMs?: number;
  /** Gap between probes while the verdict stays degraded (ms). */
  probeIntervalMs?: number;
  /** Per-probe request timeout (ms). */
  probeTimeoutMs?: number;
  /** How long a degraded verdict must hold before `shouldSurface` flips (ms). */
  surfaceDelayMs?: number;
  /** Set `false` to take the passive signals only and never issue a probe. */
  probe?: boolean;
}

// ============================================================================
// Defaults
// ============================================================================

/**
 * Probe target. `/api/capabilities` reads no database, spawns no process and
 * has no rate limiter, and the Service Worker never caches `/api/*` — so the
 * answer always comes from the server rather than from a cache.
 */
export const DEFAULT_PROBE_URL = '/api/capabilities';

/** A degraded verdict must hold this long before the first probe fires. */
export const DEFAULT_PROBE_DELAY_MS = 1000;

/** Gap between probes while the verdict stays degraded. */
export const DEFAULT_PROBE_INTERVAL_MS = 15000;

/** A probe that has not answered within this is treated as unreachable. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * Settle window before anything is shown. A page load spends its first moments
 * with the WebSocket still opening, and a banner that blinks on every
 * navigation is worse than no banner at all.
 */
export const DEFAULT_SURFACE_DELAY_MS = 1500;

// ============================================================================
// Decision
// ============================================================================

/**
 * Fold the three signals into one verdict. Pure — no React, no I/O.
 *
 * Order matters, and each step is a piece of evidence rather than a preference:
 *
 *   1. The device says it is off the network → believe it. Nothing else can be
 *      true underneath that.
 *   2. Live push is up → the server answered a moment ago, by definition. This
 *      outranks a stale `serverReachable: false` left over from before.
 *   3. A completed exchange said the server is unreachable → offline, *even
 *      though* `navigator.onLine` is true. This is the captive-portal case, and
 *      the reason this function never reads `browserOnline === true` as proof.
 *   4. The server answered but push is down → reconnecting; polling carries on.
 *   5. Nothing measured yet: `connecting` is a reconnect in progress, anything
 *      else is treated as offline until some evidence arrives.
 */
export function resolveConnectivityStatus(signals: ConnectivitySignals): ConnectivityStatus {
  if (!signals.browserOnline) return 'offline';
  if (signals.realtimeStatus === 'connected') return 'online';
  if (signals.serverReachable === false) return 'offline';
  if (signals.serverReachable === true) return 'reconnecting';
  return signals.realtimeStatus === 'connecting' ? 'reconnecting' : 'offline';
}

// ============================================================================
// Reachability probe
// ============================================================================

/**
 * Probes already in flight, keyed by URL, so concurrent callers share one
 * request. Issues #2499 / #2500 / #2503 mount this hook alongside #2501's two
 * surfaces, and N mounted consumers asking the same question at the same moment
 * should cost one request, not N.
 */
const inFlightProbes = new Map<string, Promise<boolean>>();

async function runProbe(url: string, timeoutMs: number): Promise<boolean> {
  const controller =
    typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;
  try {
    await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller?.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Ask the server whether it is there.
 *
 * "Reachable" means *the server produced an HTTP response*, whatever the code:
 * a 401 from the auth middleware and a 500 from a broken route both prove the
 * request crossed the network and came back. Only a transport failure or the
 * timeout counts as unreachable, which is exactly the distinction the verdict
 * needs.
 *
 * Calls that overlap on the same URL share a single request; the entry is
 * dropped the moment it settles, so a later call always probes afresh rather
 * than reading a cached answer.
 */
export function probeServerReachable(
  url: string = DEFAULT_PROBE_URL,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS
): Promise<boolean> {
  if (typeof fetch !== 'function') return Promise.resolve(false);
  const existing = inFlightProbes.get(url);
  if (existing) return existing;

  const pending = runProbe(url, timeoutMs).finally(() => {
    inFlightProbes.delete(url);
  });
  inFlightProbes.set(url, pending);
  return pending;
}

// ============================================================================
// External reachability reports
// ============================================================================

type ReachabilityListener = (reachable: boolean) => void;

const reachabilityListeners = new Set<ReachabilityListener>();

/**
 * Feed the outcome of a real API call into every mounted `useConnectivity`.
 *
 * The probe above is a fallback for when nothing else is talking to the server;
 * a request the app was making anyway is better evidence and costs nothing.
 * Call this with `true` when a fetch resolved (any status) and `false` when it
 * rejected at the transport layer — never `false` for a 4xx/5xx, which proves
 * the opposite.
 */
export function reportServerReachability(reachable: boolean): void {
  reachabilityListeners.forEach((listener) => {
    try {
      listener(reachable);
    } catch {
      // Isolate one subscriber's failure from the others.
    }
  });
}

/** Subscribe to {@link reportServerReachability}. Returns an unsubscribe fn. */
export function subscribeServerReachability(listener: ReachabilityListener): () => void {
  reachabilityListeners.add(listener);
  return () => {
    reachabilityListeners.delete(listener);
  };
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Track the app's connection to the server.
 *
 * Renders nothing and shows nothing while connected: `shouldSurface` is the
 * flag to gate a banner or pill on, and it only becomes true once a degraded
 * verdict has held for the settle window.
 *
 * @example
 * ```tsx
 * const { shouldSurface, isReconnecting } = useConnectivity();
 * if (!shouldSurface) return null;
 * return <Banner tone={isReconnecting ? 'warning' : 'danger'} />;
 * ```
 */
export function useConnectivity(options: UseConnectivityOptions = {}): ConnectivityState {
  const {
    probeUrl = DEFAULT_PROBE_URL,
    probeDelayMs = DEFAULT_PROBE_DELAY_MS,
    probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    surfaceDelayMs = DEFAULT_SURFACE_DELAY_MS,
    probe = true,
  } = options;

  const { status: realtimeStatus } = useRealtime();

  // Starts optimistic so the server render and the first client render agree;
  // the mount effect below immediately replaces it with the real value.
  const [browserOnline, setBrowserOnline] = useState(true);
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);
  const [lastReachableAt, setLastReachableAt] = useState<number | null>(null);

  const markReachable = useCallback((reachable: boolean) => {
    setServerReachable(reachable);
    if (reachable) setLastReachableAt(Date.now());
  }, []);

  // navigator.onLine + its events.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
    setBrowserOnline(navigator.onLine !== false);

    const handleOnline = () => {
      // "Back online" from the browser is a hint, not proof — drop reachability
      // back to unmeasured so a stale verdict cannot survive the transition,
      // and let the probe or the WebSocket supply the evidence.
      setServerReachable(null);
      setBrowserOnline(true);
    };
    const handleOffline = () => setBrowserOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // An established WebSocket is first-hand proof the server answered.
  useEffect(() => {
    if (realtimeStatus === 'connected') markReachable(true);
  }, [realtimeStatus, markReachable]);

  // Outcomes reported by ordinary API calls.
  useEffect(() => subscribeServerReachability(markReachable), [markReachable]);

  const signals = useMemo<ConnectivitySignals>(
    () => ({ browserOnline, realtimeStatus, serverReachable }),
    [browserOnline, realtimeStatus, serverReachable]
  );
  const status = resolveConnectivityStatus(signals);
  const degraded = status !== 'online';

  // Read through a ref so changing the URL/timeout does not restart the loop.
  const probeConfigRef = useRef({ url: probeUrl, timeoutMs: probeTimeoutMs });
  probeConfigRef.current = { url: probeUrl, timeoutMs: probeTimeoutMs };

  // Probe only while the verdict is degraded and the device claims a network:
  // a healthy WebSocket already answers the question, and a device that knows
  // it is offline has nothing to probe with.
  const shouldProbe = probe && degraded && browserOnline;

  useEffect(() => {
    if (!shouldProbe || typeof fetch !== 'function') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      const { url, timeoutMs } = probeConfigRef.current;
      const reachable = await probeServerReachable(url, timeoutMs);
      if (cancelled) return;
      markReachable(reachable);
      // Self-rescheduling rather than setInterval, so a slow probe cannot
      // stack up behind itself.
      timer = setTimeout(run, probeIntervalMs);
    };

    timer = setTimeout(run, probeDelayMs);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [shouldProbe, probeDelayMs, probeIntervalMs, markReachable]);

  // Settle window: a degraded verdict has to hold before anything is shown.
  // Keyed on `degraded` rather than `status` so flapping between offline and
  // reconnecting does not keep restarting the timer. Recovery is immediate.
  const [surfaced, setSurfaced] = useState(false);
  useEffect(() => {
    if (!degraded) {
      setSurfaced(false);
      return;
    }
    if (surfaceDelayMs <= 0) {
      setSurfaced(true);
      return;
    }
    const timer = setTimeout(() => setSurfaced(true), surfaceDelayMs);
    return () => clearTimeout(timer);
  }, [degraded, surfaceDelayMs]);

  const recheck = useCallback(() => {
    if (typeof fetch !== 'function') return;
    const { url, timeoutMs } = probeConfigRef.current;
    void probeServerReachable(url, timeoutMs).then(markReachable);
  }, [markReachable]);

  return useMemo<ConnectivityState>(
    () => ({
      status,
      isOnline: status === 'online',
      isReconnecting: status === 'reconnecting',
      isOffline: status === 'offline',
      shouldSurface: degraded && surfaced,
      signals,
      lastReachableAt,
      recheck,
    }),
    [status, degraded, surfaced, signals, lastReachableAt, recheck]
  );
}

export default useConnectivity;
