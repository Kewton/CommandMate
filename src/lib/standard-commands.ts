/**
 * Standard CLI Tool Commands (Issue #56, Issue #4)
 *
 * Built-in slash command snapshot for supported CLI tools.
 *
 * Issue #1476: The snapshot lives in a package-bundled JSON catalog
 * (src/config/slash-commands-catalog.json) rather than being hardcoded here.
 * This module reads the catalog and reconstructs the SlashCommand[] the rest of
 * the app already expects, so the migration is behavior-preserving. Entry
 * content (name / descriptionKey / category / cliTools / isStandard / source) is
 * unchanged; only the storage location moved. The catalog is statically
 * imported so it resolves under Next, build:cli, and build:server alike.
 *
 * References:
 * - Claude Code: https://www.gradually.ai/en/claude-code-commands/
 * - Codex CLI: https://developers.openai.com/codex/cli/slash-commands
 */

import type { SlashCommand, SlashCommandGroup, SlashCommandCategory } from '@/types/slash-commands';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { groupByCategory } from '@/lib/command-merger';
import catalogJson from '@/config/slash-commands-catalog.json';

/** Raw catalog entry as authored in slash-commands-catalog.json. */
interface CatalogCommandEntry {
  name: string;
  descriptionKey?: string;
  category: string;
  cliTools?: string[];
  isStandard?: boolean;
  source?: string;
}

/** Shape of the bundled catalog file. */
interface SlashCommandsCatalog {
  verifiedAgainst: Record<string, string>;
  frequentlyUsed: Record<string, string[]>;
  commands: CatalogCommandEntry[];
}

const catalog = catalogJson as SlashCommandsCatalog;

/**
 * CLI versions the bundled catalog was last verified against (Issue #1476).
 * Consumed by the staleness check in slash-command-catalog.ts.
 */
export const CATALOG_VERIFIED_AGAINST: Record<string, string> = catalog.verifiedAgainst;

/**
 * Reconstruct a SlashCommand from a catalog entry.
 *
 * `filePath` is set to '' (built-ins have no backing file) to match the shape
 * callers and tests already rely on; `description` is intentionally left unset
 * so built-ins resolve via descriptionKey + the locale dictionary (Issue #1306).
 */
function toStandardCommand(entry: CatalogCommandEntry): SlashCommand {
  const command: SlashCommand = {
    name: entry.name,
    descriptionKey: entry.descriptionKey,
    category: entry.category as SlashCommandCategory,
    isStandard: entry.isStandard,
    source: entry.source as SlashCommand['source'],
    filePath: '',
  };
  if (entry.cliTools) {
    command.cliTools = entry.cliTools as CLIToolType[];
  }
  return command;
}

/**
 * Standard CLI tool commands (Issue #1476: sourced from the bundled catalog).
 *
 * Issue #4: Codex-specific commands use `cliTools: ['codex']`.
 * Issue #594: Commands shared with Codex must opt in explicitly via `cliTools`.
 * Commands without `cliTools` remain Claude-only for backward compatibility.
 */
export const STANDARD_COMMANDS: SlashCommand[] = catalog.commands.map(toStandardCommand);

/**
 * Frequently used standard commands per CLI tool
 * (Issue #1476: sourced from the bundled catalog).
 */
export const FREQUENTLY_USED: Record<string, string[]> = catalog.frequentlyUsed;

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
