/**
 * useWorktreesCache - Shared worktree list cache hook.
 *
 * Issue #600: UX refresh - single source of truth for worktree list [DR3-004]
 * Issue #608: Add adaptive polling for real-time sidebar status sync
 */

'use client';

import { useState, useEffect, useCallback, useRef, startTransition } from 'react';
import type { Worktree } from '@/types/models';
import type { RepositorySummary } from '@/lib/api-client';
import { useRealtime } from '@/hooks/useRealtimeConnection';
import type { RealtimeEvent } from '@/lib/realtime/types';

/** Polling interval when at least one session is running (5s) */
export const POLLING_INTERVAL_ACTIVE = 5000;

/** Polling interval when no sessions are active (30s) */
export const POLLING_INTERVAL_IDLE = 30000;

/**
 * Issue #1120: while a live WebSocket push connection is established the poll is
 * only a fallback safety net, so it is throttled well below the polling-only
 * cadence. Session-status transitions and new messages arrive via push.
 */
export const POLLING_INTERVAL_ACTIVE_WS = 20000;
export const POLLING_INTERVAL_IDLE_WS = 60000;

/**
 * Return value of useWorktreesCache hook.
 */
export interface UseWorktreesCacheReturn {
  /** List of worktrees */
  worktrees: Worktree[];
  /**
   * List of repositories returned by the same /api/worktrees response
   * (Issue #690). Used by the Sidebar to filter out hidden repositories.
   */
  repositories: RepositorySummary[];
  /** Whether the initial load is in progress */
  isLoading: boolean;
  /** Last error, if any */
  error: Error | null;
  /** Manually trigger a refresh */
  refresh: () => Promise<void>;
}

/**
 * Hook that provides cached access to the worktree list.
 *
 * Includes adaptive polling: 5s when any session is running, 30s when idle.
 * Pauses polling when the tab is hidden and resumes on visibility change.
 *
 * @returns Worktree list, loading state, error state, and refresh function
 */
export function useWorktreesCache(): UseWorktreesCacheReturn {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  // Issue #690: Cache repositories alongside worktrees so the Sidebar
  // can filter out hidden repositories (visible=false) without an extra
  // round-trip.
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const worktreesRef = useRef<Worktree[]>([]);
  /**
   * Issue #710: Tracks the currently-active polling interval (ms) so that
   * the worktrees-change effect can decide whether the existing setInterval
   * needs to be re-created. `null` means polling is currently stopped
   * (e.g. before initial start or while the tab is hidden).
   */
  const currentIntervalRef = useRef<number | null>(null);

  // Issue #1120: realtime push integration. When connected, session-status and
  // new-message events arrive via WebSocket and the poll is throttled to a
  // fallback cadence. On disconnect the normal cadence is restored automatically.
  const { connected, subscribe, unsubscribe, addListener } = useRealtime();
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch('/api/worktrees');
      if (!response.ok) {
        throw new Error(`Failed to fetch worktrees: ${response.status}`);
      }
      const data = await response.json();
      const wts = data.worktrees ?? [];
      const repos = data.repositories ?? [];
      // Mark polling state updates as low-priority transitions so urgent
      // user interactions (clicks, keypresses) are never blocked by a
      // poll-induced list reorder landing mid-click.
      startTransition(() => {
        setWorktrees(wts);
        setRepositories(repos);
      });
      worktreesRef.current = wts;
    } catch (err) {
      const fetchError = err instanceof Error ? err : new Error(String(err));
      setError(fetchError);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Returns true if any cached worktree is currently running a session.
   * Reads from `worktreesRef` so it always sees the latest list regardless
   * of closure capture.
   */
  const hasActiveSession = useCallback(
    () => worktreesRef.current.some((wt) => wt.isSessionRunning === true),
    [],
  );

  /**
   * Desired poll interval given the current active/idle state and whether a live
   * push connection is up. Issue #1120: connected → throttled fallback cadence.
   */
  const getDesiredInterval = useCallback(() => {
    const active = hasActiveSession();
    if (connectedRef.current) {
      return active ? POLLING_INTERVAL_ACTIVE_WS : POLLING_INTERVAL_IDLE_WS;
    }
    return active ? POLLING_INTERVAL_ACTIVE : POLLING_INTERVAL_IDLE;
  }, [hasActiveSession]);

  /**
   * Stops the currently-active polling interval (if any) and clears the
   * `currentIntervalRef` so future starts can re-evaluate the desired
   * interval.
   */
  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    currentIntervalRef.current = null;
  }, []);

  /**
   * (Re)starts polling. Computes the desired interval based on the latest
   * `hasActiveSession()` reading, stores it in `currentIntervalRef`, and
   * schedules a new setInterval. Any previously-active interval is
   * cleared first via `stopPolling()`.
   */
  const startPolling = useCallback(() => {
    stopPolling();
    const interval = getDesiredInterval();
    currentIntervalRef.current = interval;
    intervalRef.current = setInterval(() => {
      refresh();
    }, interval);
  }, [getDesiredInterval, refresh, stopPolling]);

  // Adaptive polling: initial start + visibility change handling
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        refresh();
        startPolling();
      }
    };

    // Start polling after initial load settles (next tick)
    const timeoutId = setTimeout(() => {
      startPolling();
    }, 0);

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearTimeout(timeoutId);
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refresh, startPolling, stopPolling]);

  // Sync worktreesRef and re-evaluate the polling interval when worktrees
  // change. Issue #710: if the active/idle state changed, restart polling
  // with the new desired interval; otherwise this is a no-op.
  useEffect(() => {
    worktreesRef.current = worktrees;

    // Skip while the tab is hidden (visibilitychange handles re-start).
    if (typeof document !== 'undefined' && document.hidden) {
      return;
    }
    // Skip when polling is not yet running. The adaptive-polling useEffect
    // owns the initial start (and visibilitychange handles restoration).
    if (currentIntervalRef.current === null) {
      return;
    }
    // Issue #1120: `connected` is included in the deps so a WS connect/disconnect
    // transition also re-evaluates and restarts polling at the new cadence.
    const desired = getDesiredInterval();
    if (currentIntervalRef.current !== desired) {
      startPolling();
    }
  }, [worktrees, connected, getDesiredInterval, startPolling]);

  // Issue #1120: subscribe to every cached worktree room so session-status and
  // new-message pushes arrive for any branch shown in the sidebar. Worktree ids
  // are space-free slugs, so a sorted, space-joined key is a stable set key.
  const worktreeIdsKey = worktrees.map((wt) => wt.id).sort().join(' ');
  useEffect(() => {
    const ids = worktreeIdsKey.length > 0 ? worktreeIdsKey.split(' ') : [];
    ids.forEach((id) => subscribe(id));
    return () => {
      ids.forEach((id) => unsubscribe(id));
    };
  }, [worktreeIdsKey, subscribe, unsubscribe]);

  // Issue #1120: apply push events to the cached list immediately.
  useEffect(() => {
    return addListener((event: RealtimeEvent) => {
      if (event.type === 'session_status_changed' && typeof event.worktreeId === 'string') {
        const targetId = event.worktreeId;
        const isRunning = (event as { isRunning?: boolean }).isRunning;
        if (typeof isRunning !== 'boolean') return;
        // Issue #1171: a SCOPED stop (a single agent instance / CLI ended, so the
        // event carries a `cliTool` or `instance`) does NOT imply the whole
        // worktree stopped — another instance may still be running. Forcing the
        // aggregate `isSessionRunning` to false here would flip the sidebar/header
        // to idle while a sibling session runs. Re-fetch the server-computed
        // aggregate instead. Unscoped stops (kill-all) and any running transition
        // keep the direct set below (unchanged behavior).
        const scoped =
          (event as { cliTool?: string | null }).cliTool != null ||
          (event as { instance?: string | null }).instance != null;
        if (scoped && isRunning === false) {
          void refresh();
          return;
        }
        startTransition(() => {
          setWorktrees((prev) => {
            let changed = false;
            const next = prev.map((wt) => {
              if (wt.id === targetId && wt.isSessionRunning !== isRunning) {
                changed = true;
                return { ...wt, isSessionRunning: isRunning };
              }
              return wt;
            });
            return changed ? next : prev;
          });
        });
      } else if (event.type === 'message' || event.type === 'message_updated') {
        // New / updated message → pull fresh sidebar metadata (unread, last message).
        void refresh();
      }
    });
  }, [addListener, refresh]);

  return { worktrees, repositories, isLoading, error, refresh };
}
