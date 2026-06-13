/**
 * useMobileSelectedInstances Hook (Issue #874)
 *
 * 折衷案 (compromise) ownership split:
 *   - The agent instance ROSTER (id / cliTool / alias / order) lives in the DB
 *     (`agentInstances`, PATCH /api/worktrees/[id]) and is SHARED with PC. Adding,
 *     renaming, deleting and reordering instances on mobile updates the DB so the
 *     roster stays consistent across devices.
 *   - WHICH instances are shown as tabs on THIS device is a per-device view
 *     preference, kept in localStorage and NEVER written to the DB. This preserves
 *     the #837/#851 intent: a mobile user narrowing their tabs must not shrink the
 *     PC view (which reads the DB `selectedAgents`).
 *
 * Resolution runs against the DB roster (`AgentInstance[]`) — the per-instance
 * successor to the pre-#874 per-CLI-tool mobile selection:
 *   - no stored preference  -> show ALL roster instances (roster order)
 *   - stored subset         -> roster-ordered filter to the stored ids
 *   - stale ids (removed from the roster) are dropped
 *   - duplicates are removed
 *   - at least one instance is always visible (MIN_VISIBLE_INSTANCES = 1); a
 *     preference that filters to empty falls back to the full roster.
 *
 * @module hooks/useMobileSelectedInstances
 */

'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import type { AgentInstance } from '@/lib/cli-tools/types';

/** At least one instance (tab) must always be visible on a device. */
export const MIN_VISIBLE_INSTANCES = 1;

/** localStorage key prefix for the per-worktree mobile visible-instance preference. */
export const MOBILE_SELECTED_INSTANCES_KEY_PREFIX = 'commandmate:worktree:mobileInstances:';

/** Build the localStorage key for a worktree's mobile visible-instance preference. */
export function mobileSelectedInstancesKey(worktreeId: string): string {
  return `${MOBILE_SELECTED_INSTANCES_KEY_PREFIX}${worktreeId}`;
}

export interface UseMobileSelectedInstancesOptions {
  /** Worktree ID (scopes the localStorage key). */
  worktreeId: string;
  /** DB-shared roster of agent instances (resolution target). */
  roster: AgentInstance[];
}

export interface UseMobileSelectedInstancesReturn {
  /** Resolved instances to display as tabs on this device (roster order). */
  visibleInstances: AgentInstance[];
  /** Resolved visible instance ids (roster order). */
  visibleInstanceIds: string[];
  /** Whether an explicit per-device preference is stored (false = show-all default). */
  hasStoredPreference: boolean;
  /** Toggle one instance's visibility on this device (enforces MIN_VISIBLE_INSTANCES). */
  toggleInstanceVisible: (instanceId: string) => void;
  /** Replace the explicit visible set (roster-ordered, MIN enforced). */
  setVisibleInstanceIds: (instanceIds: string[]) => void;
  /** Ensure the given instances are visible (used when a new instance is added). */
  showInstances: (instanceIds: string[]) => void;
}

/**
 * Resolve a raw stored preference against the DB roster.
 *
 * Returns a roster-ordered, deduped subset of `roster`. When `raw` is null, or
 * filters to empty, ALL roster instances are returned (so at least one tab is
 * always shown — MIN_VISIBLE_INSTANCES). Stale ids absent from the roster are
 * dropped. An empty roster always resolves to an empty list.
 */
export function resolveVisibleInstances(
  raw: string[] | null,
  roster: AgentInstance[]
): AgentInstance[] {
  if (roster.length === 0) return [];

  if (raw !== null) {
    const wanted = new Set(raw);
    const filtered = roster.filter((instance) => wanted.has(instance.id));
    if (filtered.length > 0) return filtered;
  }

  // Default / fallback: show the whole roster (roster order).
  return [...roster];
}

/** Read and validate the raw stored preference (null when missing/invalid/empty). */
function readStoredPreference(worktreeId: string): string[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(mobileSelectedInstancesKey(worktreeId));
    if (stored === null) return null;
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter((v): v is string => typeof v === 'string');
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

/** Write the raw preference to localStorage (best-effort). */
function writeStoredPreference(worktreeId: string, instanceIds: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      mobileSelectedInstancesKey(worktreeId),
      JSON.stringify(instanceIds)
    );
  } catch {
    // localStorage unavailable / quota exceeded - silently ignore
  }
}

/**
 * Hook for the mobile-only "which instances to show" preference.
 *
 * localStorage backed; never touches the DB roster. The roster itself (entity +
 * alias) is managed via AgentInstancesPane → PATCH /api/worktrees/[id].
 */
export function useMobileSelectedInstances({
  worktreeId,
  roster,
}: UseMobileSelectedInstancesOptions): UseMobileSelectedInstancesReturn {
  // Raw stored preference (null until read from localStorage on mount).
  const [raw, setRaw] = useState<string[] | null>(null);

  // (Re)read from localStorage on mount and when the worktree changes.
  useEffect(() => {
    setRaw(readStoredPreference(worktreeId));
  }, [worktreeId]);

  const visibleInstances = useMemo(
    () => resolveVisibleInstances(raw, roster),
    [raw, roster]
  );

  const visibleInstanceIds = useMemo(
    () => visibleInstances.map((instance) => instance.id),
    [visibleInstances]
  );

  // True only when a non-empty preference that resolves against the roster is
  // stored — i.e. the device has explicitly narrowed its tabs.
  const hasStoredPreference = useMemo(() => {
    if (raw === null) return false;
    return roster.some((instance) => raw.includes(instance.id));
  }, [raw, roster]);

  // Persist an explicit, roster-ordered set. An empty target is ignored so we
  // never store a preference that would hide every tab (MIN_VISIBLE_INSTANCES).
  const commit = useCallback(
    (targetIds: string[]) => {
      const wanted = new Set(targetIds);
      const ordered = roster
        .filter((instance) => wanted.has(instance.id))
        .map((instance) => instance.id);
      if (ordered.length < MIN_VISIBLE_INSTANCES) return;
      setRaw(ordered);
      writeStoredPreference(worktreeId, ordered);
    },
    [roster, worktreeId]
  );

  const setVisibleInstanceIds = useCallback(
    (instanceIds: string[]) => commit(instanceIds),
    [commit]
  );

  const toggleInstanceVisible = useCallback(
    (instanceId: string) => {
      const current = resolveVisibleInstances(raw, roster).map((i) => i.id);
      if (current.includes(instanceId)) {
        // Hiding — refuse to drop below the minimum.
        if (current.length <= MIN_VISIBLE_INSTANCES) return;
        commit(current.filter((id) => id !== instanceId));
      } else {
        commit([...current, instanceId]);
      }
    },
    [raw, roster, commit]
  );

  const showInstances = useCallback(
    (instanceIds: string[]) => {
      // In show-all (default) mode every instance is already visible; only an
      // explicit preference needs the new ids merged in.
      if (raw === null) return;
      const current = resolveVisibleInstances(raw, roster).map((i) => i.id);
      commit([...current, ...instanceIds]);
    },
    [raw, roster, commit]
  );

  return {
    visibleInstances,
    visibleInstanceIds,
    hasStoredPreference,
    toggleInstanceVisible,
    setVisibleInstanceIds,
    showInstances,
  };
}

export default useMobileSelectedInstances;
