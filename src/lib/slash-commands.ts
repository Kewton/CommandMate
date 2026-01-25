/**
 * Slash Commands Loader
 *
 * Loads and parses slash commands from .claude/commands/*.md files
 * Uses gray-matter for frontmatter parsing
 */

import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import type {
  SlashCommand,
  SlashCommandCategory,
  SlashCommandGroup,
} from '@/types/slash-commands';
import { COMMAND_CATEGORIES } from '@/types/slash-commands';
import { groupByCategory } from '@/lib/command-merger';

/**
 * Cache for loaded commands
 */
let commandsCache: SlashCommand[] | null = null;

/**
 * Get the commands directory path
 *
 * @param basePath - Optional base path. If not provided, uses process.cwd()
 */
function getCommandsDir(basePath?: string): string {
  // Use provided basePath or default to process.cwd()
  const root = basePath || process.cwd();
  return path.join(root, '.claude', 'commands');
}

/**
 * Parse a command file and extract metadata
 */
function parseCommandFile(filePath: string): SlashCommand | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { data: frontmatter } = matter(content);

    const fileName = path.basename(filePath, '.md');
    const category = COMMAND_CATEGORIES[fileName] || 'workflow';

    return {
      name: fileName,
      description: frontmatter.description || '',
      category: category as SlashCommandCategory,
      model: frontmatter.model,
      filePath: path.relative(process.cwd(), filePath),
    };
  } catch (error) {
    console.error(`Error parsing command file ${filePath}:`, error);
    return null;
  }
}

/**
 * Load all slash commands from .claude/commands/*.md
 *
 * @param basePath - Optional base path. If not provided, uses process.cwd()
 * @returns Promise resolving to array of SlashCommand objects
 */
export async function loadSlashCommands(basePath?: string): Promise<SlashCommand[]> {
  const commandsDir = getCommandsDir(basePath);

  // Check if directory exists
  if (!fs.existsSync(commandsDir)) {
    console.warn(`Commands directory not found: ${commandsDir}`);
    return [];
  }

  // Read all .md files
  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md'));

  const commands: SlashCommand[] = [];

  for (const file of files) {
    const filePath = path.join(commandsDir, file);
    const command = parseCommandFile(filePath);
    if (command) {
      commands.push(command);
    }
  }

  // Sort by name
  commands.sort((a, b) => a.name.localeCompare(b.name));

  // Update cache
  commandsCache = commands;

  return commands;
}

/**
 * Get commands grouped by category
 *
 * Uses shared groupByCategory utility from command-merger module (DRY principle).
 * The CATEGORY_ORDER in command-merger.ts ensures proper ordering.
 *
 * @param basePath - Optional base path for loading worktree-specific commands
 * @returns Promise resolving to array of SlashCommandGroup objects
 */
export async function getSlashCommandGroups(basePath?: string): Promise<SlashCommandGroup[]> {
  // If basePath is provided, always load fresh (for worktree-specific commands)
  // Otherwise, use cache for MCBD commands
  const commands = basePath
    ? await loadSlashCommands(basePath)
    : commandsCache || (await loadSlashCommands());

  // Use shared groupByCategory utility (DRY principle)
  return groupByCategory(commands);
}

/**
 * Get cached commands without reloading
 *
 * @returns Cached commands or null if not loaded
 */
export function getCachedCommands(): SlashCommand[] | null {
  return commandsCache;
}

/**
 * Clear the commands cache
 */
export function clearCache(): void {
  commandsCache = null;
}

/**
 * Filter commands by search query
 *
 * @param query - Search query string
 * @returns Filtered commands matching the query
 */
export function filterCommands(query: string): SlashCommand[] {
  const commands = commandsCache || [];

  if (!query.trim()) {
    return commands;
  }

  const lowerQuery = query.toLowerCase();

  return commands.filter((cmd) => {
    const nameMatch = cmd.name.toLowerCase().includes(lowerQuery);
    const descMatch = cmd.description.toLowerCase().includes(lowerQuery);
    return nameMatch || descMatch;
  });
}
