/**
 * Standard CLI Tool Commands (Issue #56, Issue #4)
 *
 * Static definitions for built-in slash commands of supported CLI tools.
 * - Claude Code commands
 * - Codex CLI commands
 * - Shared commands (available in both)
 *
 * References:
 * - Claude Code: https://www.gradually.ai/en/claude-code-commands/
 * - Codex CLI: https://developers.openai.com/codex/cli/slash-commands
 */

import type { SlashCommand, SlashCommandGroup } from '@/types/slash-commands';
import { groupByCategory } from '@/lib/command-merger';

/**
 * Standard CLI tool commands
 *
 * Issue #4: Each command specifies which CLI tools it's available for via `cliTools` field.
 * - undefined or omitted: available for ALL tools (backward compatible)
 * - ['claude']: Claude Code only
 * - ['codex']: Codex CLI only
 * - ['claude', 'codex']: available for both tools
 */
export const STANDARD_COMMANDS: SlashCommand[] = [
  // ============================================================================
  // SHARED COMMANDS (Claude Code + Codex CLI)
  // ============================================================================

  // Session Management - Shared
  {
    name: 'compact',
    description: 'Compact context to reduce token usage',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude', 'codex'],
  },

  // Configuration - Shared
  {
    name: 'model',
    description: 'Switch AI model',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude', 'codex'],
  },

  // Monitoring - Shared
  {
    name: 'status',
    description: 'Check session status',
    category: 'standard-monitor',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude', 'codex'],
  },

  // Git/Review - Shared
  {
    name: 'review',
    description: 'Review code changes',
    category: 'standard-git',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude', 'codex'],
  },

  // ============================================================================
  // CLAUDE CODE ONLY COMMANDS
  // ============================================================================

  // Session Management - Claude only
  {
    name: 'clear',
    description: 'Clear conversation history',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },
  {
    name: 'resume',
    description: 'Resume previous conversation',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },
  {
    name: 'rewind',
    description: 'Rewind to previous conversation state',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },

  // Configuration - Claude only
  {
    name: 'config',
    description: 'Open configuration settings',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },
  {
    name: 'permissions',
    description: 'View or update tool permissions',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },

  // Monitoring - Claude only
  {
    name: 'context',
    description: 'Show context window usage',
    category: 'standard-monitor',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },
  {
    name: 'cost',
    description: 'Display token and cost usage',
    category: 'standard-monitor',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },

  // Git/Review - Claude only
  {
    name: 'pr-comments',
    description: 'Show PR comments',
    category: 'standard-git',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },

  // Utility - Claude only
  {
    name: 'help',
    description: 'Show all available commands',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },
  {
    name: 'doctor',
    description: 'Check installation health',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },
  {
    name: 'export',
    description: 'Export conversation history',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },
  {
    name: 'todos',
    description: 'Show TODO list',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },

  // ============================================================================
  // CODEX CLI ONLY COMMANDS
  // ============================================================================

  // Configuration - Codex only
  {
    name: 'approvals',
    description: 'Change auto-execution approval level',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },

  // Git/Review - Codex only
  {
    name: 'diff',
    description: 'Show Git diff (including untracked files)',
    category: 'standard-git',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },

  // Utility - Codex only
  {
    name: 'mention',
    description: 'Attach file/folder for next interaction',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'mcp',
    description: 'List available MCP tools',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'init',
    description: 'Generate AGENTS.md template in current directory',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'feedback',
    description: 'Send feedback to Codex team',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },

  // Session Management - Codex only
  {
    name: 'new',
    description: 'Start a new conversation in same session',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'undo',
    description: 'Undo the last Codex action',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'logout',
    description: 'Sign out from Codex',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'quit',
    description: 'Exit Codex CLI',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
];

/**
 * Frequently used standard commands per CLI tool
 */
export const FREQUENTLY_USED: Record<string, string[]> = {
  claude: ['clear', 'compact', 'status', 'help', 'review'],
  codex: ['compact', 'status', 'review', 'diff', 'undo'],
};

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
 * Get frequently used commands for a specific CLI tool
 *
 * @param cliToolId - CLI tool ID ('claude', 'codex', etc.)
 * @returns Array of frequently used SlashCommand objects
 */
export function getFrequentlyUsedCommands(cliToolId?: string): SlashCommand[] {
  const toolId = cliToolId || 'claude';
  const frequentNames = FREQUENTLY_USED[toolId] || FREQUENTLY_USED.claude;
  return STANDARD_COMMANDS.filter(
    (cmd) =>
      frequentNames.includes(cmd.name) &&
      (!cmd.cliTools || cmd.cliTools.includes(toolId as 'claude' | 'codex' | 'gemini'))
  );
}
