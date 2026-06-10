/**
 * useMobileSelectedAgents Hook (Issue #837, #851)
 *
 * Decouples the *mobile* agent selection from the PC selection.
 *
 * Problem: the mobile Agent tab (AgentSettingsPane) used to PATCH the worktree's
 * `selectedAgents` DB column, which PC reads as the source of truth for its
 * DesktopHeader indicators. A mobile user picking 2 agents therefore shrank the
 * PC view to 2.
 *
 * Solution (Option A): mobile keeps its agent preference in localStorage only
 * and NEVER writes the DB. PC remains the source of truth (DB `selectedAgents`).
 *
 * Issue #851: the mobile preference is now resolved against the full agent pool
 * (CLI_TOOL_IDS), NOT the DB `selectedAgents`, so mobile can freely pick any of
 * the 6 CLI tools — independent of what the PC has activated:
 *   - initial value (no stored preference): the first MOBILE_DEFAULT_AGENTS of
 *     CLI_TOOL_IDS (e.g. claude/codex).
 *   - stored items that are not valid CLI tools are dropped; duplicates are
 *     removed; the result is capped at MOBILE_MAX_AGENTS.
 *   - if nothing valid remains, it falls back to the initial default so at
 *     least one agent (a tab) is always shown.
 *
 * @module hooks/useMobileSelectedAgents
 */

'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { CLI_TOOL_IDS, isCliToolType, type CLIToolType } from '@/lib/cli-tools/types';

/**
 * Maximum number of agents selectable on mobile.
 * Issue #851: raised to the full agent count so mobile can pick every CLI tool.
 */
export const MOBILE_MAX_AGENTS = CLI_TOOL_IDS.length;

/**
 * Number of agents shown by default on mobile when no preference is stored.
 * Kept small (vs. MOBILE_MAX_AGENTS) so first-visit mobile users see a tidy set
 * of tabs rather than all agents at once (Issue #851 留意: 6 tabs is cramped).
 */
export const MOBILE_DEFAULT_AGENTS = 2;

/** localStorage key prefix for the per-worktree mobile agent preference. */
export const MOBILE_SELECTED_AGENTS_KEY_PREFIX = 'commandmate:worktree:mobileAgents:';

/** Build the localStorage key for a worktree's mobile agent preference. */
export function mobileSelectedAgentsKey(worktreeId: string): string {
  return `${MOBILE_SELECTED_AGENTS_KEY_PREFIX}${worktreeId}`;
}

export interface UseMobileSelectedAgentsOptions {
  /** Worktree ID (scopes the localStorage key). */
  worktreeId: string;
}

export interface UseMobileSelectedAgentsReturn {
  /** Resolved mobile selection: valid CLI tools, up to MOBILE_MAX_AGENTS. */
  mobileSelectedAgents: CLIToolType[];
  /** Persist a new mobile selection to localStorage (capped at MOBILE_MAX_AGENTS). */
  setMobileSelectedAgents: (agents: CLIToolType[]) => void;
}

/**
 * Resolve a raw stored preference against the full agent pool.
 *
 * Issue #851: resolution is against `pool` (all CLI tools by default), NOT the
 * PC's DB selection, so mobile may pick any agent. Guarantees the result is a
 * deduped subset of `pool` containing up to MOBILE_MAX_AGENTS entries in stored
 * order. When nothing valid remains, it falls back to the first
 * MOBILE_DEFAULT_AGENTS of `pool` so at least one tab is always shown (MIN=1).
 */
export function resolveMobileAgents(
  raw: CLIToolType[] | null,
  pool: readonly CLIToolType[] = CLI_TOOL_IDS
): CLIToolType[] {
  const result: CLIToolType[] = [];

  if (raw) {
    for (const agent of raw) {
      if (
        pool.includes(agent) &&
        !result.includes(agent) &&
        result.length < MOBILE_MAX_AGENTS
      ) {
        result.push(agent);
      }
    }
  }

  // Fall back to the initial default when no valid preference resolved
  // (first visit, or a stored preference that filtered to empty).
  if (result.length === 0) {
    const target = Math.min(MOBILE_DEFAULT_AGENTS, pool.length);
    for (const agent of pool) {
      if (result.length >= target) break;
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
}: UseMobileSelectedAgentsOptions): UseMobileSelectedAgentsReturn {
  // Raw stored preference (null until read from localStorage on mount).
  const [raw, setRaw] = useState<CLIToolType[] | null>(null);

  // (Re)read from localStorage on mount and when the worktree changes.
  useEffect(() => {
    setRaw(readStoredPreference(worktreeId));
  }, [worktreeId]);

  // Issue #851: resolved against the full agent pool (CLI_TOOL_IDS), so mobile
  // is independent of the PC's DB selection.
  const mobileSelectedAgents = useMemo(
    () => resolveMobileAgents(raw),
    [raw]
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
