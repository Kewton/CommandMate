/**
 * Command Merger Module (Issue #56, Issue #4)
 *
 * Merges standard commands with worktree-specific commands.
 * Implements SF-1: Worktree commands take priority over standard commands.
 *
 * Issue #4: Added CLI tool filtering to show only relevant commands for each tool.
 *
 * This module provides shared utilities for grouping and filtering commands,
 * following DRY principle by centralizing category ordering and grouping logic.
 */

import type { SlashCommand, SlashCommandGroup, SlashCommandCategory } from '@/types/slash-commands';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { CATEGORY_LABELS } from '@/types/slash-commands';

/**
 * Category order for merged command groups
 * Custom worktree commands appear first, then standard commands
 *
 * @remarks
 * This is the single source of truth for category ordering.
 * All grouping functions should use this order.
 */
export const CATEGORY_ORDER: SlashCommandCategory[] = [
  // Custom categories first
  'planning',
  'development',
  'review',
  'documentation',
  'workflow',
  'skill',              // Issue #343: Skills between workflow and standard categories
  // Standard categories
  'standard-session',
  'standard-config',
  'standard-monitor',
  'standard-git',
  'standard-util',
];

/**
 * Group commands by category
 *
 * @param commands - Array of SlashCommand objects
 * @returns Array of SlashCommandGroup objects
 */
export function groupByCategory(commands: SlashCommand[]): SlashCommandGroup[] {
  if (commands.length === 0) {
    return [];
  }

  // Group commands by category
  const groupMap = new Map<SlashCommandCategory, SlashCommand[]>();

  for (const command of commands) {
    const existing = groupMap.get(command.category) || [];
    existing.push(command);
    groupMap.set(command.category, existing);
  }

  // Convert to array with labels in specified order
  const groups: SlashCommandGroup[] = [];

  for (const category of CATEGORY_ORDER) {
    const categoryCommands = groupMap.get(category);
    if (categoryCommands && categoryCommands.length > 0) {
      groups.push({
        category,
        label: CATEGORY_LABELS[category],
        commands: categoryCommands,
      });
    }
  }

  // Add any remaining categories not in the order list
  for (const [category, categoryCommands] of groupMap) {
    if (!CATEGORY_ORDER.includes(category) && categoryCommands.length > 0) {
      groups.push({
        category,
        label: CATEGORY_LABELS[category] || category,
        commands: categoryCommands,
      });
    }
  }

  return groups;
}

/**
 * Build a deduplication key from a command's name + normalized CLI tool scope.
 *
 * Issue #800, #1380: The key is `name + cliTools` (not name alone). Undefined or
 * empty cliTools (= Claude-only, backward compatible) collapse to the `claude`
 * sentinel so they stay distinct from CLI-specific entries that share the same
 * name. cliTools order is normalized (sorted) so `['codex','gemini']` and
 * `['gemini','codex']` produce the same key.
 *
 * Shared by deduplicateByName() (slash-commands.ts) and mergeCommandGroups()
 * below so both dedup layers use the same key granularity (DRY). Without this,
 * mergeCommandGroups() keyed on name alone would collapse a Claude entry
 * (cliTools undefined) and a Codex entry (cliTools ['codex']) that share a name
 * into one, silently dropping the Claude side (Issue #1380).
 *
 * @param c - Command to derive a key for
 * @returns Deduplication key in the form `name::toolsKey`
 */
export function keyOf(c: SlashCommand): string {
  const toolsKey =
    c.cliTools && c.cliTools.length > 0 ? [...c.cliTools].sort().join(',') : 'claude';
  return `${c.name}::${toolsKey}`;
}

/**
 * Merge standard and worktree command groups
 *
 * SF-1: Worktree commands take priority over standard commands within the same
 * CLI tool scope. When a command name AND CLI tool scope exist in both, the
 * worktree version is used. Entries that share a name but target disjoint CLI
 * tools (e.g. a Claude command with cliTools undefined and a Codex skill with
 * cliTools ['codex']) coexist instead of one overriding the other (Issue #1380).
 *
 * @param standardGroups - Standard command groups
 * @param worktreeGroups - Worktree-specific command groups
 * @returns Merged command groups
 */
export function mergeCommandGroups(
  standardGroups: SlashCommandGroup[],
  worktreeGroups: SlashCommandGroup[]
): SlashCommandGroup[] {
  // Use a Map to deduplicate by command name + CLI tool scope (Issue #1380)
  const commandMap = new Map<string, SlashCommand>();

  // 1. Register standard commands first
  for (const group of standardGroups) {
    for (const cmd of group.commands) {
      commandMap.set(keyOf(cmd), {
        ...cmd,
        source: cmd.source || 'standard',
      });
    }
  }

  // 2. Worktree commands override standard commands with the same name AND same
  //    CLI tool scope (SF-1); disjoint scopes coexist (Issue #1380)
  for (const group of worktreeGroups) {
    for (const cmd of group.commands) {
      commandMap.set(keyOf(cmd), {
        ...cmd,
        source: cmd.source || 'worktree',
      });
    }
  }

  // 3. Group the merged commands by category
  const allCommands = Array.from(commandMap.values());
  return groupByCategory(allCommands);
}

/**
 * Count commands in groups
 *
 * @param groups - Array of SlashCommandGroup objects
 * @returns Total number of commands
 */
export function countCommands(groups: SlashCommandGroup[]): number {
  return groups.reduce((total, group) => total + group.commands.length, 0);
}

/**
 * Filter command groups by search query
 *
 * DRY: Shared filtering logic used by both useSlashCommands hook
 * and SlashCommandSelector component.
 *
 * @param groups - Array of SlashCommandGroup objects
 * @param query - Search query string
 * @param resolveDescription - Maps a command to the description text the user
 *   actually sees. Callers rendering translated descriptions (Issue #1306) must
 *   pass a resolver, otherwise built-in commands carrying a `descriptionKey`
 *   match against nothing and become unsearchable by description.
 * @returns Filtered groups containing only matching commands
 */
export function filterCommandGroups(
  groups: SlashCommandGroup[],
  query: string,
  resolveDescription: (cmd: SlashCommand) => string = (cmd) => cmd.description ?? ''
): SlashCommandGroup[] {
  if (!query.trim()) {
    return groups;
  }

  const lowerQuery = query.toLowerCase();

  return groups
    .map((group) => ({
      ...group,
      commands: group.commands.filter((cmd) => {
        const nameMatch = cmd.name.toLowerCase().includes(lowerQuery);
        const descMatch = resolveDescription(cmd).toLowerCase().includes(lowerQuery);
        return nameMatch || descMatch;
      }),
    }))
    .filter((group) => group.commands.length > 0);
}

/**
 * Filter command groups by CLI tool (Issue #4)
 *
 * Filters commands to only show those available for the specified CLI tool.
 * - Commands with undefined cliTools: Claude only (backward compatible with existing commands)
 * - Commands with cliTools array: shown only for specified tools
 *
 * @param groups - Array of SlashCommandGroup objects
 * @param cliToolId - CLI tool ID to filter by ('claude', 'codex', 'gemini')
 * @returns Filtered groups containing only commands available for the specified tool
 */
export function filterCommandsByCliTool(
  groups: SlashCommandGroup[],
  cliToolId: CLIToolType
): SlashCommandGroup[] {
  return groups
    .map((group) => ({
      ...group,
      commands: group.commands.filter((cmd) => {
        // If cliTools is undefined, command is Claude-only (backward compatible)
        if (!cmd.cliTools) {
          return cliToolId === 'claude';
        }
        // Otherwise, check if the tool is in the allowed list
        return cmd.cliTools.includes(cliToolId);
      }),
    }))
    .filter((group) => group.commands.length > 0);
}
