/**
 * Standard CLI Tool Commands (Issue #56, Issue #4)
 *
 * Static definitions for built-in slash commands of supported CLI tools.
 * - Claude Code commands (legacy Claude-only commands may omit cliTools)
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
 * Issue #594: Commands shared with Codex must opt in explicitly via `cliTools`.
 * Commands without `cliTools` remain Claude-only for backward compatibility.
 */
export const STANDARD_COMMANDS: SlashCommand[] = [
  // ============================================================================
  // CLAUDE CODE COMMANDS (existing, no cliTools for backward compatibility)
  // ============================================================================

  // Session Management
  {
    name: 'clear',
    descriptionKey: 'slashCommands.descriptions.clear',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude', 'codex', 'antigravity'],
  },
  {
    name: 'compact',
    descriptionKey: 'slashCommands.descriptions.compact',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude', 'codex', 'opencode', 'antigravity'],
  },
  {
    name: 'resume',
    descriptionKey: 'slashCommands.descriptions.resume',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude', 'codex', 'antigravity'],
  },
  {
    name: 'rewind',
    descriptionKey: 'slashCommands.descriptions.rewind',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },

  // Configuration
  {
    name: 'config',
    descriptionKey: 'slashCommands.descriptions.config',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'model',
    descriptionKey: 'slashCommands.descriptions.model',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude', 'codex', 'antigravity'],
  },
  {
    name: 'permissions',
    descriptionKey: 'slashCommands.descriptions.permissions',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude', 'codex', 'antigravity'],
  },

  // Monitoring
  {
    name: 'status',
    descriptionKey: 'slashCommands.descriptions.status',
    category: 'standard-monitor',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude', 'codex', 'antigravity'],
  },
  {
    name: 'context',
    descriptionKey: 'slashCommands.descriptions.context',
    category: 'standard-monitor',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'cost',
    descriptionKey: 'slashCommands.descriptions.cost',
    category: 'standard-monitor',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },

  // Git/Review
  {
    name: 'review',
    descriptionKey: 'slashCommands.descriptions.review',
    category: 'standard-git',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude', 'codex', 'antigravity'],
  },
  {
    name: 'pr-comments',
    descriptionKey: 'slashCommands.descriptions.pr-comments',
    category: 'standard-git',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },

  // Utility
  {
    name: 'help',
    descriptionKey: 'slashCommands.descriptions.help',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude', 'opencode'],
  },
  {
    name: 'doctor',
    descriptionKey: 'slashCommands.descriptions.doctor',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'export',
    descriptionKey: 'slashCommands.descriptions.export',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },
  {
    name: 'todos',
    descriptionKey: 'slashCommands.descriptions.todos',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
  },

  // ============================================================================
  // CLAUDE CODE NEW COMMANDS (Issue #689, cliTools: ['claude'] explicit per Issue #594 opt-in)
  // ============================================================================

  // Session Management - Claude only (new)
  {
    name: 'focus',
    descriptionKey: 'slashCommands.descriptions.focus',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },

  // Configuration - Claude only (new)
  {
    name: 'effort',
    descriptionKey: 'slashCommands.descriptions.effort',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },
  {
    name: 'fast',
    descriptionKey: 'slashCommands.descriptions.fast',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },
  {
    name: 'lazy',
    descriptionKey: 'slashCommands.descriptions.lazy',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['claude'],
  },

  // ============================================================================
  // CODEX CLI ONLY COMMANDS (Issue #4)
  // ============================================================================

  // Session Management - Codex only
  {
    name: 'new',
    descriptionKey: 'slashCommands.descriptions.new',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex', 'opencode'],
  },
  {
    name: 'undo',
    descriptionKey: 'slashCommands.descriptions.undo',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'logout',
    descriptionKey: 'slashCommands.descriptions.logout',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'quit',
    descriptionKey: 'slashCommands.descriptions.quit',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },

  // Configuration - Codex only
  {
    name: 'approvals',
    descriptionKey: 'slashCommands.descriptions.approvals',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },

  // Git/Review - Codex only
  {
    name: 'diff',
    descriptionKey: 'slashCommands.descriptions.diff',
    category: 'standard-git',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },

  // Utility - Codex only
  {
    name: 'mention',
    descriptionKey: 'slashCommands.descriptions.mention',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'mcp',
    descriptionKey: 'slashCommands.descriptions.mcp',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'init',
    descriptionKey: 'slashCommands.descriptions.init',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'feedback',
    descriptionKey: 'slashCommands.descriptions.feedback',
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },

  // ============================================================================
  // CODEX CLI NEW COMMANDS (Issue #689)
  // ============================================================================

  // Session Management - Codex only (new)
  {
    name: 'plan',
    descriptionKey: 'slashCommands.descriptions.plan',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'goal',
    descriptionKey: 'slashCommands.descriptions.goal',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'agent',
    descriptionKey: 'slashCommands.descriptions.agent',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'subagents',
    descriptionKey: 'slashCommands.descriptions.subagents',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'fork',
    descriptionKey: 'slashCommands.descriptions.fork',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },

  // Configuration - Codex only (new)
  {
    name: 'memories',
    descriptionKey: 'slashCommands.descriptions.memories',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'skills',
    descriptionKey: 'slashCommands.descriptions.skills',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['codex'],
  },
  {
    name: 'hooks',
    descriptionKey: 'slashCommands.descriptions.hooks',
    category: 'standard-config',
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
    descriptionKey: 'slashCommands.descriptions.sessions',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['opencode'],
  },
  {
    name: 'connect',
    descriptionKey: 'slashCommands.descriptions.connect',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['opencode'],
  },
  {
    name: 'exit',
    descriptionKey: 'slashCommands.descriptions.exit',
    category: 'standard-session',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['opencode'],
  },

  // Configuration - OpenCode only
  {
    name: 'models',
    descriptionKey: 'slashCommands.descriptions.models',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['opencode'],
  },
  {
    name: 'agents',
    descriptionKey: 'slashCommands.descriptions.agents',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['opencode'],
  },
  {
    name: 'themes',
    descriptionKey: 'slashCommands.descriptions.themes',
    category: 'standard-config',
    isStandard: true,
    source: 'standard',
    filePath: '',
    cliTools: ['opencode'],
  },

  // Utility - OpenCode only
  {
    name: 'editor',
    descriptionKey: 'slashCommands.descriptions.editor',
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
  codex: ['new', 'undo', 'diff', 'approvals', 'plan'],
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
