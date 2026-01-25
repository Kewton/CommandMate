/**
 * useSlashCommands Hook
 *
 * Provides slash commands data with loading state and filtering
 */

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { handleApiError } from '@/lib/api-client';
import { filterCommandGroups } from '@/lib/command-merger';
import type { SlashCommand, SlashCommandGroup } from '@/types/slash-commands';

/**
 * Return type for useSlashCommands hook
 */
export interface UseSlashCommandsResult {
  /** All command groups */
  groups: SlashCommandGroup[];
  /** Filtered groups based on current filter */
  filteredGroups: SlashCommandGroup[];
  /** Flat list of all commands */
  allCommands: SlashCommand[];
  /** Loading state */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Current filter value */
  filter: string;
  /** Set filter value */
  setFilter: (filter: string) => void;
  /** Refresh commands from API */
  refresh: () => void;
}

/**
 * Hook for loading and filtering slash commands
 *
 * @param worktreeId - Optional worktree ID for loading worktree-specific commands (Issue #56)
 * @returns UseSlashCommandsResult with commands data and controls
 *
 * @example
 * ```tsx
 * function CommandSelector() {
 *   const { filteredGroups, loading, filter, setFilter } = useSlashCommands();
 *
 *   if (loading) return <Spinner />;
 *
 *   return (
 *     <div>
 *       <input
 *         value={filter}
 *         onChange={(e) => setFilter(e.target.value)}
 *         placeholder="Search commands..."
 *       />
 *       {filteredGroups.map(group => (
 *         <CommandGroup key={group.category} group={group} />
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useSlashCommands(worktreeId?: string): UseSlashCommandsResult {
  const [groups, setGroups] = useState<SlashCommandGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  /**
   * Fetch commands from API
   * If worktreeId is provided, fetches worktree-specific commands (Issue #56)
   */
  const fetchCommands = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Use worktree-specific API if worktreeId is provided
      const endpoint = worktreeId
        ? `/api/worktrees/${worktreeId}/slash-commands`
        : '/api/slash-commands';

      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      const data = await response.json();
      setGroups(data.groups);
    } catch (err) {
      setError(handleApiError(err));
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [worktreeId]);

  /**
   * Load commands on mount
   */
  useEffect(() => {
    void fetchCommands();
  }, [fetchCommands]);

  /**
   * Flat list of all commands
   */
  const allCommands = useMemo(() => {
    return groups.flatMap((group) => group.commands);
  }, [groups]);

  /**
   * Filtered groups based on current filter
   * Uses shared filterCommandGroups utility (DRY principle)
   */
  const filteredGroups = useMemo(() => {
    return filterCommandGroups(groups, filter);
  }, [groups, filter]);

  /**
   * Refresh commands
   */
  const refresh = useCallback(() => {
    void fetchCommands();
  }, [fetchCommands]);

  return {
    groups,
    filteredGroups,
    allCommands,
    loading,
    error,
    filter,
    setFilter,
    refresh,
  };
}
