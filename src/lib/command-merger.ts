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
 * Merge standard and worktree command groups
 *
 * SF-1: Worktree commands take priority over standard commands.
 * When a command name exists in both, the worktree version is used.
 *
 * @param standardGroups - Standard command groups
 * @param worktreeGroups - Worktree-specific command groups
 * @returns Merged command groups
 */
export function mergeCommandGroups(
  standardGroups: SlashCommandGroup[],
  worktreeGroups: SlashCommandGroup[]
): SlashCommandGroup[] {
  // Use a Map to deduplicate by command name
  const commandMap = new Map<string, SlashCommand>();

  // 1. Register standard commands first
  for (const group of standardGroups) {
    for (const cmd of group.commands) {
      commandMap.set(cmd.name, {
        ...cmd,
        source: cmd.source || 'standard',
      });
    }
  }

  // 2. Worktree commands override standard commands (SF-1)
  for (const group of worktreeGroups) {
    for (const cmd of group.commands) {
      commandMap.set(cmd.name, {
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
 * @returns Filtered groups containing only matching commands
 */
export function filterCommandGroups(
  groups: SlashCommandGroup[],
  query: string
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
        const descMatch = cmd.description.toLowerCase().includes(lowerQuery);
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
