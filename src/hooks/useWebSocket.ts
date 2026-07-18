/**
 * useWebSocket — low-level single WebSocket connection manager (Issue #1120).
 *
 * Owns exactly one same-origin WebSocket. Responsibilities:
 *  - connect / reconnect with exponential backoff (base 1s .. max 30s)
 *  - pause reconnection while the tab is hidden; reconnect immediately on visible
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

export const DEFAULT_RECONNECT_BASE_DELAY_MS = 1000;
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 30000;

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
 * Compute exponential backoff delay for a given attempt (0-based), clamped to max.
 */
export function computeBackoffDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exp = baseDelay * 2 ** Math.max(0, attempt);
  return Math.min(exp, maxDelay);
}

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const {
    onEvent,
    onStatusChange,
    autoReconnect = true,
    reconnectBaseDelay = DEFAULT_RECONNECT_BASE_DELAY_MS,
    reconnectMaxDelay = DEFAULT_RECONNECT_MAX_DELAY_MS,
    enabled = true,
  } = options;

  const [status, setStatus] = useState<WebSocketStatus>('disconnected');

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const subscribedRef = useRef<Set<string>>(new Set());
  const intentionalCloseRef = useRef(false);

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
    updateStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new Ctor(`${protocol}//${window.location.host}`);
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
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
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      const parsed = parseRealtimeEvent(raw);
      if (parsed) onEventRef.current?.(parsed);
    };

    ws.onerror = () => {
      updateStatus('error');
    };

    ws.onclose = () => {
      wsRef.current = null;
      updateStatus('disconnected');
      if (intentionalCloseRef.current || !autoReconnect) return;
      // Do not schedule reconnection while the tab is hidden — the
      // visibilitychange handler reconnects on becoming visible again.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      const delay = computeBackoffDelay(attemptRef.current, reconnectBaseDelay, reconnectMaxDelay);
      attemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };
  }, [enabled, autoReconnect, reconnectBaseDelay, reconnectMaxDelay, updateStatus, clearReconnectTimer]);

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

  return { status, subscribe, unsubscribe, send };
}
