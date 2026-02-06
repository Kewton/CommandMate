/**
 * useSlashCommands Hook
 *
 * Provides slash commands data with loading state and filtering
 *
 * Issue #4: Added cliToolId parameter to filter commands by CLI tool
 */

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { handleApiError } from '@/lib/api-client';
import { filterCommandGroups } from '@/lib/command-merger';
import type { SlashCommand, SlashCommandGroup } from '@/types/slash-commands';
import type { CLIToolType } from '@/lib/cli-tools/types';

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
  /** Currently loaded CLI tool */
  cliTool: CLIToolType;
}

/**
 * Hook for loading and filtering slash commands
 *
 * @param worktreeId - Optional worktree ID for loading worktree-specific commands (Issue #56)
 * @param cliToolId - Optional CLI tool ID to filter commands (Issue #4)
 * @returns UseSlashCommandsResult with commands data and controls
 *
 * @example
 * ```tsx
 * function CommandSelector() {
 *   const { filteredGroups, loading, filter, setFilter } = useSlashCommands(worktreeId, 'codex');
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
export function useSlashCommands(
  worktreeId?: string,
  cliToolId?: CLIToolType
): UseSlashCommandsResult {
  const [groups, setGroups] = useState<SlashCommandGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [currentCliTool, setCurrentCliTool] = useState<CLIToolType>(cliToolId || 'claude');

  /**
   * Fetch commands from API
   * If worktreeId is provided, fetches worktree-specific commands (Issue #56)
   * If cliToolId is provided, filters by CLI tool (Issue #4)
   */
  const fetchCommands = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Build endpoint URL with optional cliTool query param
      let endpoint = worktreeId
        ? `/api/worktrees/${worktreeId}/slash-commands`
        : '/api/slash-commands';

      // Issue #4: Add cliTool query parameter if provided
      if (cliToolId) {
        endpoint += `?cliTool=${cliToolId}`;
      }

      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      const data = await response.json();
      setGroups(data.groups);
      setCurrentCliTool(data.cliTool || cliToolId || 'claude');
    } catch (err) {
      setError(handleApiError(err));
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [worktreeId, cliToolId]);

  /**
   * Load commands on mount or when cliToolId changes
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
    cliTool: currentCliTool,
  };
}
