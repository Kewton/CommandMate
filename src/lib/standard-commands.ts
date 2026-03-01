/**
 * Standard CLI Tool Commands (Issue #56, Issue #4)
 *
 * Static definitions for built-in slash commands of supported CLI tools.
 * - Claude Code commands (existing, no cliTools field for backward compatibility)
 * - Codex CLI commands (new, with cliTools: ['codex'])
 *
 * References:
 * - Claude Code: https://www.gradually.ai/en/claude-code-commands/
 * - Codex CLI: https://developers.openai.com/codex/cli/slash-commands
 */

import type { SlashCommand, SlashCommandGroup } from '@/types/slash-commands';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { groupByCategory } from '@/lib/command-merger';

/**
 * Standard CLI tool commands
 *
 * Issue #4: Codex-specific commands use `cliTools: ['codex']`.
 * Existing Claude commands have no cliTools field (backward compatible, Claude-only).
 */
export const STANDARD_COMMANDS: SlashCommand[] = [
  // ============================================================================
  // CLAUDE CODE COMMANDS (existing, no cliTools for backward compatibility)
  // ============================================================================

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
    cliTools: ['claude', 'opencode'],
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
    cliTools: ['claude', 'opencode'],
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

  // ============================================================================
  // CODEX CLI ONLY COMMANDS (Issue #4)
  // ============================================================================

  // Session Management - Codex only
  {
    name: 'new',
    description: 'Start a new conversation',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex', 'opencode'],
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

  // ============================================================================
  // OPENCODE TUI ONLY COMMANDS (Issue #379)
  // ============================================================================

  // Session Management - OpenCode only
  {
    name: 'sessions',
    description: 'Browse conversation history',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['opencode'],
  },
  {
    name: 'connect',
    description: 'Connect to language server',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['opencode'],
  },
  {
    name: 'exit',
    description: 'Exit OpenCode TUI',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['opencode'],
  },

  // Configuration - OpenCode only
  {
    name: 'models',
    description: 'Switch AI model',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['opencode'],
  },
  {
    name: 'agents',
    description: 'Switch agent',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['opencode'],
  },
  {
    name: 'themes',
    description: 'Change TUI theme',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['opencode'],
  },

  // Utility - OpenCode only
  {
    name: 'editor',
    description: 'Open editor for long messages',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['opencode'],
  },
];

/**
 * Frequently used standard commands per CLI tool
 */
export const FREQUENTLY_USED: Record<string, string[]> = {
  claude: ['clear', 'compact', 'status', 'help', 'review'],
  codex: ['new', 'undo', 'diff', 'approvals', 'mcp'],
  opencode: ['models', 'new', 'compact', 'help', 'exit'],
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
      // For Claude: include commands without cliTools or with 'claude' in cliTools
      // For Codex: include only commands with 'codex' in cliTools
      (toolId === 'claude'
        ? !cmd.cliTools || cmd.cliTools.includes('claude')
        : cmd.cliTools?.includes(toolId as CLIToolType))
  );
}
