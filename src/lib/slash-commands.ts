/**
 * Slash Commands Loader
 *
 * Loads and parses slash commands from:
 * - .claude/commands/*.md (Claude commands)
 * - .claude/skills/{name}/SKILL.md (Claude skills, Issue #343)
 * - .codex/skills/{name}/SKILL.md (Codex skills, Issue #166)
 * - .codex/prompts/*.md (Codex custom prompts, Issue #166)
 *
 * Uses gray-matter for frontmatter parsing
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import matter from 'gray-matter';
import type {
  SlashCommand,
  SlashCommandCategory,
  SlashCommandGroup,
} from '@/types/slash-commands';
import { COMMAND_CATEGORIES } from '@/types/slash-commands';
import { groupByCategory } from '@/lib/command-merger';
import { truncateString } from '@/lib/utils';
import { createLogger } from '@/lib/logger';

const logger = createLogger('slash-commands');

/**
 * Cache for loaded commands
 */
let commandsCache: SlashCommand[] | null = null;

/**
 * Cache for loaded skills (Issue #343)
 * Managed independently from commandsCache
 */
let skillsCache: SlashCommand[] | null = null;

/** Codex skills subdirectory path (Issue #166) */
const CODEX_SKILLS_SUBDIR = path.join('.codex', 'skills');

/** Codex prompts subdirectory path (Issue #166) */
const CODEX_PROMPTS_SUBDIR = path.join('.codex', 'prompts');

/** Skills subdirectory scan limit (Issue #343) */
const MAX_SKILLS_COUNT = 100;
/** SKILL.md maximum file size in bytes (64KB) (Issue #343) */
const MAX_SKILL_FILE_SIZE_BYTES = 65536;
/** Skill name maximum length (Issue #343) */
const MAX_SKILL_NAME_LENGTH = 100;
/** Skill description maximum length (Issue #343) */
const MAX_SKILL_DESCRIPTION_LENGTH = 500;

/**
 * Safe wrapper around gray-matter to prevent arbitrary code execution.
 *
 * [S001] gray-matter enables JavaScript engines by default, allowing
 * eval() via ---js or ---javascript frontmatter delimiters. This is a
 * CRITICAL vulnerability. This wrapper explicitly disables JS engines
 * and only allows YAML frontmatter parsing.
 *
 * @param content - Raw file content to parse
 * @returns Parsed gray-matter result
 */
export function safeParseFrontmatter(content: string): matter.GrayMatterFile<string> {
  return matter(content, {
    engines: {
      js: {
        parse: (): never => {
          throw new Error('JavaScript engine is disabled for security');
        },
        stringify: (): never => {
          throw new Error('JavaScript engine is disabled for security');
        },
      },
      javascript: {
        parse: (): never => {
          throw new Error('JavaScript engine is disabled for security');
        },
        stringify: (): never => {
          throw new Error('JavaScript engine is disabled for security');
        },
      },
    },
  });
}

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
 * Get the skills directory path (Issue #343)
 *
 * @param basePath - Optional base path. If not provided, uses process.cwd()
 */
function getSkillsDir(basePath?: string): string {
  const root = basePath || process.cwd();
  return path.join(root, '.claude', 'skills');
}

/**
 * Parse a command file and extract metadata
 */
function parseCommandFile(filePath: string): SlashCommand | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { data: frontmatter } = safeParseFrontmatter(content);

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
    logger.error('error-parsing-command-file-filepath:', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Parse a skill file (SKILL.md) and extract metadata (Issue #343)
 *
 * [D009] Note on cliTools: .claude/skills/ skills do not set cliTools (left as undefined),
 * which means filterCommandsByCliTool() treats them as claude-only (cliToolId === 'claude').
 * Codex skills (.codex/skills/) set cliTools: ['codex'] explicitly in loadCodexSkills().
 * See filterCommandsByCliTool() in command-merger.ts for the authoritative behavior.
 *
 * @param skillDirPath - Absolute path to the skill subdirectory
 * @param skillName - Directory name used as fallback for skill name
 * @returns Parsed SlashCommand or null if parsing fails
 */
function parseSkillFile(skillDirPath: string, skillName: string): SlashCommand | null {
  const skillPath = path.join(skillDirPath, 'SKILL.md');
  try {
    const stat = fs.statSync(skillPath);
    if (stat.size > MAX_SKILL_FILE_SIZE_BYTES) {
      logger.warn('skipping-oversized-skill-file-statsize-b');
      return null;
    }
    const content = fs.readFileSync(skillPath, 'utf-8');
    let name: string = skillName;
    let description: string = '';
    try {
      const { data: frontmatter } = safeParseFrontmatter(content);
      name = frontmatter.name || skillName;
      description = frontmatter.description || '';
    } catch {
      // Fallback: SKILL.md may contain YAML-unfriendly characters (e.g., unquoted
      // colons or brackets in argument-hint). Extract only name/description via regex.
      const fmResult = extractFrontmatterFields(content);
      name = fmResult.name || skillName;
      description = fmResult.description || '';
    }
    return {
      name: truncateString(name, MAX_SKILL_NAME_LENGTH),
      description: truncateString(description, MAX_SKILL_DESCRIPTION_LENGTH),
      category: 'skill',
      source: 'skill',
      filePath: path.relative(process.cwd(), skillPath),
    };
  } catch (error) {
    logger.error('error-parsing-skill-file-skillpath:', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Regex-based fallback to extract name and description from frontmatter.
 *
 * Used when safeParseFrontmatter() fails due to YAML parse errors (e.g., unquoted
 * colons in argument-hint fields). Only extracts the two fields needed for the UI.
 *
 * @param content - Raw SKILL.md file content
 * @returns Object with name and description (empty string if not found)
 */
export function extractFrontmatterFields(content: string): { name: string; description: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    return { name: '', description: '' };
  }
  const fmBlock = fmMatch[1];
  const nameMatch = fmBlock.match(/^name:\s*(.+)$/m);
  const descMatch = fmBlock.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : '',
    description: descMatch ? descMatch[1].trim() : '',
  };
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
    logger.warn('commands-directory-not-found:commandsdir');
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
  // Note: commandsCache is also assigned in getSlashCommandGroups() when basePath is not
  // provided (via `commandsCache = await loadSlashCommands()`). This dual assignment is
  // intentional: loadSlashCommands() always updates the cache for getCachedCommands() callers,
  // while getSlashCommandGroups() uses the cache to avoid redundant loads.
  commandsCache = commands;

  return commands;
}

/**
 * Scan a directory for skill subdirectories, applying security guards.
 *
 * Shared by loadSkills() and loadCodexSkills() to avoid duplicating
 * the traversal-prevention / resolved-path / count-limit logic.
 *
 * @param skillsDir - Root skills directory to scan
 * @param overrides - Fields to spread onto each parsed skill (source, cliTools, etc.)
 * @param warnTag - Logger tag for the count-limit warning
 * @param expandSystem - If true, also scan .system/ subdirectory (Codex built-in skills)
 * @returns Array of SlashCommand objects
 */
function scanSkillDirs(
  skillsDir: string,
  overrides: Partial<SlashCommand>,
  warnTag: string,
  expandSystem = false,
): SlashCommand[] {
  if (!fs.existsSync(skillsDir)) return [];

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

  // Collect directories to scan
  const dirsToScan: { dir: string; name: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.includes('..')) continue;

    if (expandSystem && entry.name === '.system') {
      try {
        const systemDir = path.join(skillsDir, '.system');
        const systemEntries = fs.readdirSync(systemDir, { withFileTypes: true });
        for (const sysEntry of systemEntries) {
          if (!sysEntry.isDirectory()) continue;
          if (sysEntry.name.includes('..')) continue;
          dirsToScan.push({ dir: systemDir, name: sysEntry.name });
        }
      } catch {
        // .system directory unreadable, skip silently
      }
    } else {
      dirsToScan.push({ dir: skillsDir, name: entry.name });
    }
  }

  const resolvedRoot = path.resolve(skillsDir) + path.sep;
  const skills: SlashCommand[] = [];

  for (const { dir, name } of dirsToScan) {
    if (skills.length >= MAX_SKILLS_COUNT) {
      logger.warn(warnTag);
      break;
    }
    const resolvedPath = path.resolve(dir, name);
    if (!resolvedPath.startsWith(resolvedRoot)) continue;

    const skill = parseSkillFile(resolvedPath, name);
    if (skill) {
      skills.push({ ...skill, ...overrides });
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Load all skills from .claude/skills/{name}/SKILL.md (Issue #343)
 *
 * @param basePath - Optional base path. If not provided, uses process.cwd()
 * @returns Promise resolving to array of SlashCommand objects
 */
export async function loadSkills(basePath?: string): Promise<SlashCommand[]> {
  return scanSkillDirs(getSkillsDir(basePath), {}, 'skills-count-limit');
}

/**
 * Load Codex skills from .codex/skills/{name}/SKILL.md (Issue #166)
 *
 * Also scans .system/ subdirectory for built-in Codex skills.
 *
 * @param basePath - Optional base path. If not provided, uses os.homedir()
 * @returns Promise resolving to array of SlashCommand objects
 */
export async function loadCodexSkills(basePath?: string): Promise<SlashCommand[]> {
  const root = basePath ?? os.homedir();
  const skillsDir = path.join(root, CODEX_SKILLS_SUBDIR);
  return scanSkillDirs(
    skillsDir,
    { source: 'codex-skill', cliTools: ['codex'] },
    'codex-skills-count-limit',
    true,
  );
}

/**
 * Parse a flat .md file as a Codex prompt command (Issue #166)
 *
 * Reuses the shared frontmatter parsing logic (safeParseFrontmatter /
 * extractFrontmatterFields fallback) from parseSkillFile, but differs
 * in that the file name (not a frontmatter `name` field) is the command name,
 * and invocation is set to 'codex-prompt'.
 */
function parseCodexPromptFile(filePath: string): SlashCommand | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SKILL_FILE_SIZE_BYTES) {
      logger.warn('skipping-oversized-codex-prompt-file');
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileName = path.basename(filePath, '.md');
    let description = '';
    try {
      const { data: frontmatter } = safeParseFrontmatter(content);
      description = frontmatter.description || '';
    } catch {
      description = extractFrontmatterFields(content).description || '';
    }
    return {
      name: truncateString(fileName, MAX_SKILL_NAME_LENGTH),
      invocation: 'codex-prompt',
      description: truncateString(description, MAX_SKILL_DESCRIPTION_LENGTH),
      category: 'skill',
      source: 'codex-skill',
      cliTools: ['codex'],
      filePath: path.relative(process.cwd(), filePath),
    };
  } catch (error) {
    logger.error('error-parsing-codex-prompt-file:', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Load Codex custom prompts from .codex/prompts/*.md (Issue #166)
 *
 * @param basePath - Optional base path. If not provided, uses os.homedir()
 * @returns Promise resolving to array of SlashCommand objects
 */
export async function loadCodexPrompts(basePath?: string): Promise<SlashCommand[]> {
  const root = basePath ?? os.homedir();
  const promptsDir = path.join(root, CODEX_PROMPTS_SUBDIR);

  if (!fs.existsSync(promptsDir)) {
    return [];
  }

  const resolvedRoot = path.resolve(promptsDir) + path.sep;
  const files = fs.readdirSync(promptsDir).filter(f => f.endsWith('.md'));
  const prompts: SlashCommand[] = [];

  for (const file of files) {
    if (prompts.length >= MAX_SKILLS_COUNT) {
      logger.warn('codex-prompts-count-limit');
      break;
    }
    if (file.includes('..')) continue;
    if (!path.resolve(promptsDir, file).startsWith(resolvedRoot)) continue;

    const prompt = parseCodexPromptFile(path.join(promptsDir, file));
    if (prompt) {
      prompts.push(prompt);
    }
  }

  prompts.sort((a, b) => a.name.localeCompare(b.name));
  return prompts;
}

/**
 * Deduplicate commands and skills by name (Issue #343)
 *
 * Skills are registered first, then commands override any skills with
 * the same name. This ensures commands always take priority over skills.
 *
 * @param skills - Array of skill SlashCommand objects
 * @param commands - Array of command SlashCommand objects (take priority)
 * @returns Deduplicated array of SlashCommand objects
 */
export function deduplicateByName(skills: SlashCommand[], commands: SlashCommand[]): SlashCommand[] {
  const map = new Map<string, SlashCommand>();

  // Register skills first
  for (const skill of skills) {
    map.set(skill.name, skill);
  }

  // Commands override skills with same name
  for (const cmd of commands) {
    map.set(cmd.name, cmd);
  }

  return Array.from(map.values());
}

/**
 * Get commands grouped by category
 *
 * Uses shared groupByCategory utility from command-merger module (DRY principle).
 * The CATEGORY_ORDER in command-merger.ts ensures proper ordering.
 *
 * Issue #343: Now also loads skills and merges them with commands.
 * Skills are deduplicated against commands (commands take priority).
 *
 * @param basePath - Optional base path for loading worktree-specific commands
 * @returns Promise resolving to array of SlashCommandGroup objects
 */
export async function getSlashCommandGroups(basePath?: string): Promise<SlashCommandGroup[]> {
  // If basePath is provided, always load fresh (for worktree-specific commands)
  if (basePath) {
    const commands = await loadSlashCommands(basePath);
    const skills = await loadSkills(basePath);
    const codexLocalSkills = await loadCodexSkills(basePath);
    const codexLocalPrompts = await loadCodexPrompts(basePath);
    const deduplicated = deduplicateByName([...skills, ...codexLocalSkills, ...codexLocalPrompts], commands);
    return groupByCategory(deduplicated);
  }

  // Use cache for MCBD commands
  if (commandsCache === null) {
    commandsCache = await loadSlashCommands();
  }
  if (skillsCache === null) {
    // Intentional: skillsCache is populated here; loadSkills does not manage its own cache
    skillsCache = await loadSkills().catch(() => []);
  }
  const deduplicated = deduplicateByName(skillsCache, commandsCache);
  return groupByCategory(deduplicated);
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
 * Clear the commands and skills cache (Issue #343: clears both caches)
 */
export function clearCache(): void {
  commandsCache = null;
  skillsCache = null;
}

/**
 * Filter commands by search query
 *
 * NOTE: This function only searches commandsCache and does NOT include skills.
 * For UI filtering that includes both commands and skills, use
 * `filterCommandGroups()` from command-merger.ts instead.
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
