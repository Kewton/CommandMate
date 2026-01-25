/**
 * Standard Claude Code Commands (Issue #56)
 *
 * Static definitions for Claude Code's built-in slash commands.
 * These commands are available in all Claude Code sessions without any setup.
 *
 * Reference: https://www.gradually.ai/en/claude-code-commands/
 */

import type { SlashCommand, SlashCommandGroup } from '@/types/slash-commands';
import { groupByCategory } from '@/lib/command-merger';

/**
 * Standard Claude Code commands
 * These are built into Claude Code CLI and require no additional configuration.
 */
export const STANDARD_COMMANDS: SlashCommand[] = [
  // Session Management
  {
    name: 'clear',
    description: 'Clear conversation history',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'compact',
    description: 'Compact context to reduce token usage',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'resume',
    description: 'Resume previous conversation',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'rewind',
    description: 'Rewind to previous conversation state',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },

  // Configuration
  {
    name: 'config',
    description: 'Open configuration settings',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'model',
    description: 'Switch AI model',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'permissions',
    description: 'View or update tool permissions',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },

  // Monitoring
  {
    name: 'status',
    description: 'Check session status',
    category: 'standard-monitor',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'context',
    description: 'Show context window usage',
    category: 'standard-monitor',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'cost',
    description: 'Display token and cost usage',
    category: 'standard-monitor',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },

  // Git/Review
  {
    name: 'review',
    description: 'Review code changes',
    category: 'standard-git',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'pr-comments',
    description: 'Show PR comments',
    category: 'standard-git',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },

  // Utility
  {
    name: 'help',
    description: 'Show all available commands',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'doctor',
    description: 'Check installation health',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'export',
    description: 'Export conversation history',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'todos',
    description: 'Show TODO list',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
];

/**
 * Frequently used standard commands
 * These are displayed at the top of the command list for easy access.
 */
export const FREQUENTLY_USED: string[] = [
  'clear',
  'compact',
  'status',
  'help',
  'review',
];

/**
 * Get standard commands grouped by category
 *
 * Uses shared groupByCategory utility from command-merger module (DRY principle).
 * The CATEGORY_ORDER in command-merger.ts ensures proper ordering.
 *
 * @returns Array of SlashCommandGroup objects for standard commands
 */
export function getStandardCommandGroups(): SlashCommandGroup[] {
  return groupByCategory(STANDARD_COMMANDS);
}

/**
 * Get frequently used commands
 *
 * @returns Array of frequently used SlashCommand objects
 */
export function getFrequentlyUsedCommands(): SlashCommand[] {
  return STANDARD_COMMANDS.filter((cmd) => FREQUENTLY_USED.includes(cmd.name));
}
