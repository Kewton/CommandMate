import { useCallback, useEffect, useState } from 'react';
import { useRealtimeListener } from '@/hooks/useRealtimeConnection';
import { useOptionalWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { MODEL_CHANGED_EVENT_TYPE, type ModelChangedEvent, type RealtimeEvent } from '@/lib/realtime/types';

/**
 * How long the session row stays amber after a model change (Issue #2357).
 *
 * Five minutes, measured from the change's own timestamp rather than from
 * when the frame arrived, so a phone that reconnects late shows the notice
 * for the remainder of the same window rather than for a fresh one.
 */
export const MODEL_CHANGE_HIGHLIGHT_MS = 5 * 60_000;

/** A model change this tab has heard about and not yet dismissed. */
export interface RecentModelChange {
  from: string;
  to: string;
  at: number;
}

/**
 * Whether a `model_changed` frame is about THIS tab's instance.
 *
 * `instance` is always resolved on the wire (`instanceId ?? cliToolId`), so
 * the comparison is against this tab's resolved id and nothing else.
 */
function isModelChangeForInstance(
  event: RealtimeEvent,
  worktreeId: string,
  instanceId: string
): event is ModelChangedEvent {
  if (event.type !== MODEL_CHANGED_EVENT_TYPE) return false;
  const evt = event as Partial<ModelChangedEvent>;
  return evt.worktreeId === worktreeId && evt.instance === instanceId;
}

/** The most recent model change for this instance, and how to dismiss it. */
export function useRecentModelChange(
  worktreeId: string,
  resolvedInstanceId: string
): { recentModelChange: RecentModelChange | null; dismissModelChange: () => void } {
  const worktreesCache = useOptionalWorktreesCacheContext();
  // The most recent `model_changed` frame for THIS instance, held until it is
  // dismissed or `MODEL_CHANGE_HIGHLIGHT_MS` has passed since the change. The
  // frame comes from the server's edge (`agent-event-state`), which already
  // applied every suppression rule; this tab compares nothing itself.
  const [recentModelChange, setRecentModelChange] = useState<RecentModelChange | null>(null);
  useRealtimeListener((event) => {
    if (!isModelChangeForInstance(event, worktreeId, resolvedInstanceId)) return;
    setRecentModelChange({ from: event.from, to: event.to, at: event.at });
    // The label reads the list cache, which polls slowly while a socket is
    // up; the frame IS the news that it is stale, so the list is re-read now
    // rather than the row saying "changed to B" beside a label still reading A.
    void worktreesCache?.refresh();
  });
  // Expire the highlight relative to the change's own timestamp. Keyed on `at`
  // so a second change restarts the window, and cleared on unmount so a timer
  // cannot fire into a torn-down tree.
  useEffect(() => {
    if (recentModelChange === null) return;
    const remaining = recentModelChange.at + MODEL_CHANGE_HIGHLIGHT_MS - Date.now();
    if (remaining <= 0) {
      setRecentModelChange(null);
      return;
    }
    const timer = setTimeout(() => setRecentModelChange(null), remaining);
    return () => clearTimeout(timer);
  }, [recentModelChange]);
  const dismissModelChange = useCallback(() => setRecentModelChange(null), []);
  // A different instance is a different session row: drop the notice with it.
  useEffect(() => {
    setRecentModelChange(null);
  }, [worktreeId, resolvedInstanceId]);
  return { recentModelChange, dismissModelChange };
}
