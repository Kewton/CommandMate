/**
 * useMobileSelectedAgents Hook (Issue #837)
 *
 * Decouples the *mobile* agent selection from the PC selection.
 *
 * Problem: the mobile Agent tab (AgentSettingsPane) used to PATCH the worktree's
 * `selectedAgents` DB column, which PC reads as the source of truth for its
 * DesktopHeader indicators. A mobile user picking 2 agents therefore shrank the
 * PC view to 2.
 *
 * Solution (Option A): mobile keeps its 2-agent preference in localStorage only
 * and NEVER writes the DB. PC remains the source of truth (DB `selectedAgents`).
 * The mobile preference is resolved *against* the DB selection so it always
 * references agents the PC has actually activated:
 *   - initial value (no stored preference): the first MOBILE_MAX_AGENTS of the
 *     DB `selectedAgents`
 *   - stored items no longer present in the DB selection are dropped, and the
 *     result is topped up from the DB selection (DB order) so up to
 *     MOBILE_MAX_AGENTS valid agents are always shown.
 *
 * @module hooks/useMobileSelectedAgents
 */

'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { isCliToolType, type CLIToolType } from '@/lib/cli-tools/types';

/** Maximum number of agents shown on mobile (screen-space constraint). */
export const MOBILE_MAX_AGENTS = 2;

/** localStorage key prefix for the per-worktree mobile agent preference. */
export const MOBILE_SELECTED_AGENTS_KEY_PREFIX = 'commandmate:worktree:mobileAgents:';

/** Build the localStorage key for a worktree's mobile agent preference. */
export function mobileSelectedAgentsKey(worktreeId: string): string {
  return `${MOBILE_SELECTED_AGENTS_KEY_PREFIX}${worktreeId}`;
}

export interface UseMobileSelectedAgentsOptions {
  /** Worktree ID (scopes the localStorage key). */
  worktreeId: string;
  /** DB `selectedAgents` (the PC source of truth). */
  dbSelectedAgents: CLIToolType[];
}

export interface UseMobileSelectedAgentsReturn {
  /** Resolved mobile selection: a subset of dbSelectedAgents, up to MOBILE_MAX_AGENTS. */
  mobileSelectedAgents: CLIToolType[];
  /** Persist a new mobile selection to localStorage (capped at MOBILE_MAX_AGENTS). */
  setMobileSelectedAgents: (agents: CLIToolType[]) => void;
}

/**
 * Resolve a raw stored preference against the current DB selection.
 *
 * Guarantees the result is a subset of `db` containing up to MOBILE_MAX_AGENTS
 * entries, preferring the stored order and topping up from the DB order.
 */
export function resolveMobileAgents(
  raw: CLIToolType[] | null,
  db: CLIToolType[]
): CLIToolType[] {
  const target = Math.min(MOBILE_MAX_AGENTS, db.length);
  const result: CLIToolType[] = [];

  if (raw) {
    for (const agent of raw) {
      if (
        db.includes(agent) &&
        !result.includes(agent) &&
        result.length < MOBILE_MAX_AGENTS
      ) {
        result.push(agent);
      }
    }
  }

  // Top up from the DB selection (DB order) to reach the target count.
  for (const agent of db) {
    if (result.length >= target) break;
    if (!result.includes(agent)) {
      result.push(agent);
    }
  }

  return result;
}

/** Read and validate the raw stored preference (null when missing/invalid). */
function readStoredPreference(worktreeId: string): CLIToolType[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(mobileSelectedAgentsKey(worktreeId));
    if (stored === null) return null;
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter(
      (v): v is CLIToolType => typeof v === 'string' && isCliToolType(v)
    );
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

/** Write the raw preference to localStorage (best-effort). */
function writeStoredPreference(worktreeId: string, agents: CLIToolType[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      mobileSelectedAgentsKey(worktreeId),
      JSON.stringify(agents)
    );
  } catch {
    // localStorage unavailable / quota exceeded - silently ignore
  }
}

/**
 * Hook for the mobile-only agent preference (localStorage backed, never DB).
 */
export function useMobileSelectedAgents({
  worktreeId,
  dbSelectedAgents,
}: UseMobileSelectedAgentsOptions): UseMobileSelectedAgentsReturn {
  // Raw stored preference (null until read from localStorage on mount).
  const [raw, setRaw] = useState<CLIToolType[] | null>(null);

  // (Re)read from localStorage on mount and when the worktree changes.
  useEffect(() => {
    setRaw(readStoredPreference(worktreeId));
  }, [worktreeId]);

  const mobileSelectedAgents = useMemo(
    () => resolveMobileAgents(raw, dbSelectedAgents),
    [raw, dbSelectedAgents]
  );

  const setMobileSelectedAgents = useCallback(
    (agents: CLIToolType[]) => {
      const capped = agents.slice(0, MOBILE_MAX_AGENTS);
      setRaw(capped);
      writeStoredPreference(worktreeId, capped);
    },
    [worktreeId]
  );

  return { mobileSelectedAgents, setMobileSelectedAgents };
}

export default useMobileSelectedAgents;
