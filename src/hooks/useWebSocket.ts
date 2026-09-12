/**
 * useWebSocket — low-level single WebSocket connection manager (Issue #1120).
 *
 * Owns exactly one same-origin WebSocket. Responsibilities:
 *  - connect / reconnect with jittered exponential backoff (base 1s .. max 30s)
 *  - pause reconnection while the tab is hidden; reconnect immediately on visible
 *  - detect a half-open path from inbound silence and fall back to `disconnected`
 *  - subscription management (re-sends the subscribed room set on every (re)connect)
 *  - parse the room broadcast envelope and dispatch inner events to `onEvent`
 *
 * Authentication is Cookie-based (Issue #331): the browser attaches
 * `cm_auth_token` to the upgrade handshake automatically, and the server rejects
 * unauthenticated upgrades with 401 (verified server-side).
 *
 * This hook is transport-only. Listener fan-out and subscription ref-counting
 * live in `useRealtimeConnection` (the provider that owns the single instance).
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CLIENT_VERSION_MESSAGE_TYPE,
  parseRealtimeEvent,
  type RealtimeEvent,
  type RealtimeStatus,
} from '@/lib/realtime/types';
import {
  WS_CLIENT_LIVENESS_CHECK_INTERVAL_MS,
  WS_CLIENT_LIVENESS_TIMEOUT_MS,
  WS_HALF_OPEN_CLOSE_CODE,
  WS_HEARTBEAT_MESSAGE_TYPE,
  WS_RECONNECT_BASE_DELAY_MS,
  WS_RECONNECT_JITTER_RATIO,
  WS_RECONNECT_MAX_DELAY_MS,
} from '@/config/websocket-config';

export type WebSocketStatus = RealtimeStatus;

/**
 * Version of the client bundle this tab was built from (#1338/#1356).
 *
 * Mirrors `version-checker.getClientVersion()` but reads the baked env directly:
 * version-checker.ts imports `fs`/`path` at module scope (it resolves the server's
 * runtime package.json), so importing it here would drag Node built-ins into the
 * client bundle. `NEXT_PUBLIC_APP_VERSION` is inlined at build time, so this is
 * exactly the bundle's own version.
 */
function getClientBundleVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';
}

export const DEFAULT_RECONNECT_BASE_DELAY_MS = WS_RECONNECT_BASE_DELAY_MS;
export const DEFAULT_RECONNECT_MAX_DELAY_MS = WS_RECONNECT_MAX_DELAY_MS;

export interface UseWebSocketOptions {
  /** Called for every parsed inbound realtime event. */
  onEvent?: (event: RealtimeEvent) => void;
  /** Called whenever the connection status changes. */
  onStatusChange?: (status: WebSocketStatus) => void;
  /** Auto-reconnect on unexpected disconnect (default true). */
  autoReconnect?: boolean;
  /** Base reconnect delay in ms (default 1000). */
  reconnectBaseDelay?: number;
  /** Max reconnect delay in ms (default 30000). */
  reconnectMaxDelay?: number;
  /** Inbound silence (ms) after which the socket is declared half-open (#2502). */
  livenessTimeout?: number;
  /** How often that silence is measured, in ms (#2502). */
  livenessCheckInterval?: number;
  /** Disable the hook entirely (e.g. SSR / tests without a WS impl). */
  enabled?: boolean;
}

export interface UseWebSocketReturn {
  status: WebSocketStatus;
  /** Subscribe to a worktree room. Idempotent; re-sent on reconnect. */
  subscribe: (worktreeId: string) => void;
  /** Unsubscribe from a worktree room. */
  unsubscribe: (worktreeId: string) => void;
  /** Send a raw control message (e.g. subscribe/unsubscribe/terminal_input). */
  send: (message: Record<string, unknown>) => void;
}

/** Resolve the WebSocket constructor, allowing tests to stub globalThis.WebSocket. */
function getWebSocketCtor(): typeof WebSocket | null {
  if (typeof globalThis !== 'undefined' && typeof globalThis.WebSocket === 'function') {
    return globalThis.WebSocket as typeof WebSocket;
  }
  return null;
}

/**
 * Compute exponential backoff delay for a given attempt (0-based), clamped to
 * max, then randomised by +/-{@link WS_RECONNECT_JITTER_RATIO}.
 *
 * Issue #2502: the jitter is the point. Every tab that was talking to a
 * restarting server loses its socket in the same second and, on a pure
 * exponential curve, retries on the identical 1s/2s/4s grid — so the whole herd
 * lands together on the first socket the new process manages to open, and the
 * ones it drops line up again for the next slot. Smearing each delay across a
 * +/-20% window breaks the lockstep without changing the curve's shape.
 *
 * `random` is injectable so tests can pin the delay; 0.5 yields no jitter at all,
 * which is the value to pass when asserting the exponential progression itself.
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  random: () => number = Math.random,
): number {
  const exp = baseDelay * 2 ** Math.max(0, attempt);
  const clamped = Math.min(exp, maxDelay);
  // Applied after the clamp, so the ceiling stays the ceiling in expectation.
  // Floored at 0 because a negative timeout would fire on the next tick.
  const spread = (random() * 2 - 1) * WS_RECONNECT_JITTER_RATIO;
  return Math.max(0, Math.round(clamped * (1 + spread)));
}

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const {
    onEvent,
    onStatusChange,
    autoReconnect = true,
    reconnectBaseDelay = DEFAULT_RECONNECT_BASE_DELAY_MS,
    reconnectMaxDelay = DEFAULT_RECONNECT_MAX_DELAY_MS,
    livenessTimeout = WS_CLIENT_LIVENESS_TIMEOUT_MS,
    livenessCheckInterval = WS_CLIENT_LIVENESS_CHECK_INTERVAL_MS,
    enabled = true,
  } = options;

  const [status, setStatus] = useState<WebSocketStatus>('disconnected');

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const subscribedRef = useRef<Set<string>>(new Set());
  const intentionalCloseRef = useRef(false);
  /**
   * When anything last arrived on the current socket (Issue #2502).
   *
   * The only evidence a browser has about the path. `readyState` answers OPEN
   * for a half-open socket indefinitely, and the WebSocket API hides the
   * protocol-level pong the browser sends on its own, so "how long has it been
   * quiet" is the whole liveness signal — hence the server's application-level
   * heartbeat, which guarantees this clock moves on an idle-but-live socket.
   */
  const lastInboundAtRef = useRef(0);
  /**
   * Latest `connect`, so `scheduleReconnect` can call it without the two
   * `useCallback`s having to reference each other.
   */
  const connectRef = useRef<() => void>(() => {});

  // Keep the latest callbacks in refs so connect() identity stays stable.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const updateStatus = useCallback((next: WebSocketStatus) => {
    setStatus(next);
    onStatusChangeRef.current?.(next);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  /**
   * Arm the backoff timer for the next connect attempt.
   *
   * Issue #2502: lifted out of `ws.onclose`, which used to be the only way into
   * the reconnect path — and is exactly the event a half-open socket never
   * fires. The liveness check needs the same path.
   */
  const scheduleReconnect = useCallback(() => {
    if (intentionalCloseRef.current || !autoReconnect) return;
    // Do not schedule reconnection while the tab is hidden — the
    // visibilitychange handler reconnects on becoming visible again.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    clearReconnectTimer();
    const delay = computeBackoffDelay(attemptRef.current, reconnectBaseDelay, reconnectMaxDelay);
    attemptRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectRef.current();
    }, delay);
  }, [autoReconnect, reconnectBaseDelay, reconnectMaxDelay, clearReconnectTimer]);

  const connect = useCallback(() => {
    if (!enabled) return;
    if (typeof window === 'undefined') return;
    const Ctor = getWebSocketCtor();
    if (!Ctor) return;
    if (
      wsRef.current &&
      (wsRef.current.readyState === Ctor.OPEN || wsRef.current.readyState === Ctor.CONNECTING)
    ) {
      return;
    }

    clearReconnectTimer();
    intentionalCloseRef.current = false;
    // Start the silence clock now rather than on open: a socket that never
    // finishes connecting is just as quiet as one that went half-open.
    lastInboundAtRef.current = Date.now();
    updateStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new Ctor(`${protocol}//${window.location.host}`);
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      lastInboundAtRef.current = Date.now();
      updateStatus('connected');
      // Announce this tab's bundle version so the server can flag a version
      // drift after a server upgrade (#1338/#1356). Sent on every (re)connect —
      // a reconnect right after a server swap is exactly when detection matters.
      try {
        ws.send(
          JSON.stringify({ type: CLIENT_VERSION_MESSAGE_TYPE, version: getClientBundleVersion() }),
        );
      } catch {
        // best-effort; a failing send means the socket is already closing.
      }
      // Re-send the full subscription set on every (re)connect.
      subscribedRef.current.forEach((id) => {
        try {
          ws.send(JSON.stringify({ type: 'subscribe', worktreeId: id }));
        } catch {
          // best-effort; a failing send means the socket is already closing.
        }
      });
    };

    ws.onmessage = (event: MessageEvent) => {
      // Issue #2502: recorded before parsing, and for every frame. A frame this
      // build cannot parse is still proof the path carries bytes, which is the
      // only question the liveness check asks.
      lastInboundAtRef.current = Date.now();
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      const parsed = parseRealtimeEvent(raw);
      if (!parsed) return;
      // The heartbeat exists only to move the clock above. It is not part of
      // `RealtimeEvent` (hence the cast) and no listener has a case for it, so
      // it stops here instead of touring the whole fan-out.
      if ((parsed as { type: string }).type === WS_HEARTBEAT_MESSAGE_TYPE) return;
      onEventRef.current?.(parsed);
    };

    ws.onerror = () => {
      updateStatus('error');
    };

    ws.onclose = () => {
      wsRef.current = null;
      updateStatus('disconnected');
      scheduleReconnect();
    };
  }, [enabled, updateStatus, clearReconnectTimer, scheduleReconnect]);

  connectRef.current = connect;

  /**
   * Give up on a socket that has gone quiet and re-enter the reconnect path
   * (Issue #2502).
   *
   * Dropping `status` to `disconnected` is half the fix on its own: the
   * terminal pane had its own push-staleness rescue
   * (`useTerminalPanePolling`'s `pushHealthy`), but every other surface —
   * sidebar, history, the version-mismatch banner — keys its polling interval
   * off this status and stayed on the slow path while `connected` was a lie.
   */
  const handleHalfOpen = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    // Detach before closing. On a genuinely dead path `close()` cannot complete
    // its handshake, so the socket sits in CLOSING until the OS TCP timeout and
    // fires `onclose` minutes later — after this tab has long since built a
    // replacement. That late event would schedule a second reconnect for a
    // connection nobody is waiting on.
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    wsRef.current = null;
    try {
      ws.close(WS_HALF_OPEN_CLOSE_CODE, 'half-open');
    } catch {
      // ignore; the socket is being abandoned either way.
    }
    updateStatus('disconnected');
    scheduleReconnect();
  }, [updateStatus, scheduleReconnect]);

  const disconnect = useCallback(() => {
    clearReconnectTimer();
    intentionalCloseRef.current = true;
    if (wsRef.current) {
      try {
        wsRef.current.close(1000, 'Client disconnect');
      } catch {
        // ignore
      }
      wsRef.current = null;
    }
  }, [clearReconnectTimer]);

  const send = useCallback((message: Record<string, unknown>) => {
    const ws = wsRef.current;
    const Ctor = getWebSocketCtor();
    if (ws && Ctor && ws.readyState === Ctor.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // ignore transient send failures; reconnect resends subscriptions.
      }
    }
  }, []);

  const subscribe = useCallback(
    (worktreeId: string) => {
      if (subscribedRef.current.has(worktreeId)) return;
      subscribedRef.current.add(worktreeId);
      send({ type: 'subscribe', worktreeId });
    },
    [send],
  );

  const unsubscribe = useCallback(
    (worktreeId: string) => {
      if (!subscribedRef.current.has(worktreeId)) return;
      subscribedRef.current.delete(worktreeId);
      send({ type: 'unsubscribe', worktreeId });
    },
    [send],
  );

  // Mount: connect. Unmount: disconnect.
  useEffect(() => {
    if (!enabled) return;
    connect();
    return () => {
      disconnect();
    };
  }, [enabled, connect, disconnect]);

  // Issue #2502: the half-open detector. Polls the silence clock rather than
  // arming a timeout per frame — one interval per tab, and no work on the hot
  // path of a busy terminal stream.
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined') return;
    const timer = setInterval(() => {
      const ws = wsRef.current;
      const Ctor = getWebSocketCtor();
      if (!ws || !Ctor || ws.readyState !== Ctor.OPEN) return;
      if (Date.now() - lastInboundAtRef.current < livenessTimeout) return;
      handleHalfOpen();
    }, livenessCheckInterval);
    return () => clearInterval(timer);
  }, [enabled, livenessTimeout, livenessCheckInterval, handleHalfOpen]);

  // visibilitychange: reconnect immediately when the tab becomes visible if the
  // connection dropped while hidden.
  useEffect(() => {
    if (!enabled) return;
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (wsRef.current) return;
      attemptRef.current = 0;
      connect();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [enabled, connect]);

  // Issue #2502: `online` gets the same treatment as `visibilitychange`. The
  // browser knows the radio came back well before the backoff timer is due, and
  // on a late attempt that timer can be 30s away — a phone that walks back into
  // Wi-Fi should not stare at a stale screen for half a minute.
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined') return;
    const onOnline = () => {
      if (wsRef.current) return;
      attemptRef.current = 0;
      connect();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [enabled, connect]);

  return { status, subscribe, unsubscribe, send };
}
