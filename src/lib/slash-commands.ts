/**
 * Slash Commands Loader
 *
 * Loads and parses slash commands from:
 * - .claude/commands/*.md (Claude commands)
 * - .claude/skills/{name}/SKILL.md (Claude skills, Issue #343)
 * - .agents/skills/{name}/SKILL.md (Codex skills, current CLI standard, Issue #1165)
 * - .codex/skills/{name}/SKILL.md (Codex skills, legacy, Issue #166)
 *
 * `.agents/skills` is where the current Codex CLI reads skills
 * ($REPO_ROOT/.agents/skills and $HOME/.agents/skills); `.codex/skills` is kept
 * for backward compatibility. `.codex/prompts` is intentionally not scanned
 * (Codex CLI never reads it, Issue #790).
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
import { groupByCategory, keyOf } from '@/lib/command-merger';
import { isCliToolType, type CLIToolType } from '@/lib/cli-tools/types';
import { truncateString } from '@/lib/utils';
import { clearCatalogCache } from '@/lib/slash-command-catalog';
import { STANDARD_COMMANDS } from '@/lib/standard-commands';
import type { OpencodeLiveCommand } from '@/lib/slash-command-reconcile/providers/opencode';
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

/** Codex skills subdirectory path, legacy location (Issue #166) */
const CODEX_SKILLS_SUBDIR = path.join('.codex', 'skills');

/** Codex skills subdirectory path, current CLI standard location (Issue #1165) */
const AGENTS_SKILLS_SUBDIR = path.join('.agents', 'skills');

/** opencode's own project/global skills subdirectory (Issue #2037) */
const OPENCODE_SKILLS_SUBDIR = path.join('.opencode', 'skills');

/**
 * Skill roots opencode 1.18.22 was **measured** to scan, in the order they are
 * folded together here (Issue #2037).
 *
 * Not taken from the docs. Six probe Skills were planted, one per candidate
 * root, and `GET /skill` answered with the absolute `SKILL.md` path of every
 * one — which is what makes this a measurement rather than a reading. Two of the
 * three project roots are exactly `SKILL_INSTALL_ROOT_PREFIXES`, so a Skill
 * CommandMate installs is discovered by opencode with no extra placement.
 *
 * `.agents/skills` is listed last on purpose: it is CommandMate's primary
 * install root, and the fold below lets the last occurrence of a name win, so a
 * package installed by CommandMate beats a same-named copy left in another root.
 */
const OPENCODE_SKILL_SUBDIRS = [
  OPENCODE_SKILLS_SUBDIR,
  path.join('.claude', 'skills'),
  AGENTS_SKILLS_SUBDIR,
] as const;

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
 * Parse cliTools frontmatter into validated CLI tool IDs.
 */
function parseCliTools(value: unknown): CLIToolType[] | undefined {
  if (typeof value === 'string') {
    return isCliToolType(value) ? [value] : undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const cliTools = value.filter(
    (entry): entry is CLIToolType => typeof entry === 'string' && isCliToolType(entry)
  );

  if (cliTools.length === 0) {
    return undefined;
  }

  return Array.from(new Set(cliTools));
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
      cliTools: parseCliTools(frontmatter.cliTools),
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
 * [D009] Note on cliTools: .claude/skills/ skills default to undefined unless frontmatter
 * sets cliTools explicitly. Undefined means Claude-only in filterCommandsByCliTool().
 * Codex skills (.codex/skills/) still set cliTools: ['codex'] explicitly in loadCodexSkills().
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
    let cliTools: CLIToolType[] | undefined;
    try {
      const { data: frontmatter } = safeParseFrontmatter(content);
      name = frontmatter.name || skillName;
      description = frontmatter.description || '';
      cliTools = parseCliTools(frontmatter.cliTools);
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
      cliTools,
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
 * Load Codex skills from .agents/skills/{name}/SKILL.md (Issue #1165)
 *
 * `.agents/skills` is the directory both the current Codex CLI and the
 * Antigravity CLI (agy) scan for skills ($REPO_ROOT/.agents/skills and
 * $HOME/.agents/skills). agy exposes each skill as a `/<name>` slash command,
 * so these entries are surfaced to both codex and antigravity sessions
 * (cliTools ['codex', 'antigravity'], Issue #1504). The legacy .codex/skills
 * scan (loadCodexSkills) stays codex-only because agy does not read it.
 *
 * Reuses the codex-skill source; the insert trigger is disambiguated per
 * session by getSlashCommandTrigger() ($NAME for codex, /NAME for antigravity).
 * Also scans .system/ for built-in Codex skills. Same-named entries across
 * .codex/skills and .agents/skills are collapsed by mergeCodexFamilySkills().
 *
 * @param basePath - Optional base path. If not provided, uses os.homedir()
 * @returns Promise resolving to array of SlashCommand objects
 */
export async function loadAgentsSkills(basePath?: string): Promise<SlashCommand[]> {
  const root = basePath ?? os.homedir();
  const skillsDir = path.join(root, AGENTS_SKILLS_SUBDIR);
  return scanSkillDirs(
    skillsDir,
    { source: 'codex-skill', cliTools: ['codex', 'antigravity'] },
    'agents-skills-count-limit',
    true,
  );
}

/**
 * Load the Skills an opencode session can actually invoke (Issue #2037).
 *
 * ## What was measured, on opencode 1.18.22, 2026-08-25
 *
 * Isolated `HOME` per `docs/design/opencode-server-live-verification.md` §4, one
 * probe Skill planted per candidate root, each instructed to answer a unique
 * token:
 *
 *  - **discovery** — `GET /skill` returned all six probes with their absolute
 *    `SKILL.md` paths, `.agents/skills` and `.claude/skills` (project *and*
 *    `$HOME`) among them. The `/skills` picker in the TUI listed the same six.
 *  - **invocation** — submitting `/probe-agents-root` loaded that Skill's
 *    instructions and the agent answered `PROBE_OK_probe-agents-root`. Repeated
 *    for `.claude/skills` and `.opencode/skills`; all three answered their own
 *    token. So a `/`-prefixed name is a working invocation route.
 *  - **the gap this function fills** — typing `/probe-agents-root` into the
 *    opencode composer shows **"No matching items"**. opencode's own slash
 *    palette lists `source: "command"` rows only, so the invocation route above
 *    exists and is *undiscoverable* from the palette. Positive control: `/status`
 *    matched its own row; negative control: `/zzzznotacommand` matched nothing.
 *
 * That is why these are surfaced with `cliTools: ['opencode']` and
 * `source: 'skill'` rather than folded into the `codex-skill` entries
 * `loadAgentsSkills` already produces: `getSlashCommandTrigger` spells a
 * `codex-skill` as `$name` for everything except antigravity, and `$name` is not
 * the route measured to work here. A separate entry also keeps `keyOf`
 * (`name::opencode`) distinct from `name::antigravity,codex`, so codex and
 * antigravity palettes are byte-identical to before.
 *
 * ## The trailing space is load-bearing
 *
 * Also measured: `POST /tui/append-prompt` with a bare `/name` opens the
 * completion dropdown, and while it is open `POST /tui/submit-prompt` answers
 * `true` and submits nothing. Appending one space closes it and the Skill runs.
 * `MessageInput` already inserts `` `${trigger} ` ``, so the palette path is
 * safe; a caller that builds the trigger by hand must keep that space.
 *
 * @param basePath - Repository root to scan, or os.homedir() for the global roots
 * @returns Skills scoped to opencode, later roots winning a name collision
 */
export async function loadOpencodeSkills(basePath?: string): Promise<SlashCommand[]> {
  const root = basePath ?? os.homedir();
  const byName = new Map<string, SlashCommand>();

  for (const subdir of OPENCODE_SKILL_SUBDIRS) {
    const skills = scanSkillDirs(
      path.join(root, subdir),
      { source: 'skill', cliTools: ['opencode'] },
      'opencode-skills-count-limit',
    );
    for (const skill of skills) byName.set(skill.name, skill);
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Turn one `GET /command` document into palette entries (Issue #2036).
 *
 * The live registry is the only place a project's own `.opencode/commands/*.md`
 * exists — the bundled catalog cannot know about it — so this is what puts a
 * `/test` row in the palette with the description its frontmatter declares.
 *
 * `hints` (`['$ARGUMENTS']`) are appended to the description rather than carried
 * in a field of their own: `SlashCommand` has no argument-hint slot, and adding
 * one would be a change to `src/types` that every consumer would have to learn.
 * The suffix is what the operator needs to know anyway — that the command takes
 * arguments — and it survives the description search in `filterCommandGroups`.
 *
 * Entries carry a literal `description`, never a `descriptionKey`: this text is
 * authored by the operator (or by opencode upstream) and there is nothing to
 * translate it to. That is also why the caller must not let one of these
 * override a catalog entry — see `foldInMissingCommands` in command-merger.ts.
 *
 * @param live - Rows parsed from `GET /command`
 * @returns Palette entries scoped to opencode
 */
export function opencodeLiveCommandsToSlashCommands(
  live: readonly OpencodeLiveCommand[]
): SlashCommand[] {
  return live.map((command) => {
    const hint = command.hints.length > 0 ? command.hints.join(' ') : '';
    const description = [command.description, hint].filter((part) => part.length > 0).join(' · ');
    const isSkill = command.source === 'skill';

    return {
      name: truncateString(command.name, MAX_SKILL_NAME_LENGTH),
      description: truncateString(description, MAX_SKILL_DESCRIPTION_LENGTH),
      category: isSkill ? 'skill' : 'workflow',
      source: isSkill ? 'skill' : 'worktree',
      cliTools: ['opencode'],
      filePath: '',
    } satisfies SlashCommand;
  });
}

/**
 * Collapse skills that exist in both .codex/skills and .agents/skills (Issue #1504).
 *
 * The two locations feed the same codex-skill palette, but .agents/skills entries
 * carry cliTools ['codex', 'antigravity'] while legacy .codex/skills entries stay
 * ['codex']. The downstream dedup key (keyOf) is name + cliTools scope, so a
 * same-named skill in both dirs no longer collapses on its own and would appear
 * twice in codex sessions. Drop the .codex/skills entry when a matching name
 * exists in .agents/skills; the .agents/skills entry wins because it is also
 * visible to antigravity. Callers pass the results into deduplicateByName /
 * mergeCommandGroups exactly as before.
 *
 * @param codexSkills - Skills loaded from .codex/skills (loadCodexSkills)
 * @param agentsSkills - Skills loaded from .agents/skills (loadAgentsSkills)
 * @returns Combined list with name collisions resolved in favor of .agents/skills
 */
export function mergeCodexFamilySkills(
  codexSkills: SlashCommand[],
  agentsSkills: SlashCommand[],
): SlashCommand[] {
  const agentsNames = new Set(agentsSkills.map((s) => s.name));
  const codexOnly = codexSkills.filter((s) => !agentsNames.has(s.name));
  return [...codexOnly, ...agentsSkills];
}

/**
 * Get Copilot CLI builtin commands (Issue #547, reconciled in Issue #1913).
 *
 * The list is no longer hardcoded here. Issue #1913 moved it into the bundled
 * catalog (src/config/slash-commands-catalog.json) so Copilot entries carry a
 * `descriptionKey` like every other tool instead of literal English text — the
 * palette used to show English descriptions to ja users for Copilot alone.
 *
 * This function stays because the slash-commands route injects the Copilot
 * built-ins as their own group; the entries it returns are now the same objects
 * the standard layer already contains, so the injection dedups against itself
 * (keyOf = name + cliTools) instead of overriding the catalog with a second
 * definition. Their `source` is therefore `'standard'`, not `'builtin'`.
 *
 * @returns Array of SlashCommand objects for Copilot builtins
 */
export function getCopilotBuiltinCommands(): SlashCommand[] {
  return STANDARD_COMMANDS.filter((cmd) => cmd.cliTools?.includes('copilot'));
}

/**
 * Get Gemini CLI builtin commands.
 *
 * Returns curated interactive commands confirmed from Gemini CLI source/docs.
 * These are injected only when cliTool is 'gemini' so they can safely override
 * shared standard command names like clear/model/help for Gemini sessions.
 */
export function getGeminiBuiltinCommands(): SlashCommand[] {
  return [
    { name: 'clear', description: 'Clear the screen and conversation history', category: 'standard-session', cliTools: ['gemini'], filePath: '', source: 'builtin' },
    { name: 'compact', description: 'Compress the context by replacing it with a summary', category: 'standard-session', cliTools: ['gemini'], filePath: '', source: 'builtin' },
    { name: 'rewind', description: 'Rewind to a previous conversation state', category: 'standard-session', cliTools: ['gemini'], filePath: '', source: 'builtin' },
    { name: 'quit', description: 'Exit the CLI', category: 'standard-session', cliTools: ['gemini'], filePath: '', source: 'builtin' },
    { name: 'model', description: 'Manage model configuration', category: 'standard-config', cliTools: ['gemini'], filePath: '', source: 'builtin' },
    { name: 'theme', description: 'Change the theme', category: 'standard-config', cliTools: ['gemini'], filePath: '', source: 'builtin' },
    { name: 'agents reload', description: 'Reload the agent registry', category: 'standard-config', cliTools: ['gemini'], filePath: '', source: 'builtin' },
    { name: 'commands reload', description: 'Reload custom slash commands', category: 'standard-config', cliTools: ['gemini'], filePath: '', source: 'builtin' },
    { name: 'memory reload', description: 'Reload context files (e.g. GEMINI.md)', category: 'standard-config', cliTools: ['gemini'], filePath: '', source: 'builtin' },
    { name: 'mcp reload', description: 'Restart and reload MCP servers', category: 'standard-config', cliTools: ['gemini'], filePath: '', source: 'builtin' },
    { name: 'skills reload', description: 'Reload discovered agent skills from disk', category: 'standard-config', cliTools: ['gemini'], filePath: '', source: 'builtin' },
    { name: 'extensions reload', description: 'Reload all active extensions', category: 'standard-config', cliTools: ['gemini'], filePath: '', source: 'builtin' },
    { name: 'help', description: 'Show help for interactive commands', category: 'standard-util', cliTools: ['gemini'], filePath: '', source: 'builtin' },
  ];
}

/**
 * Deduplicate commands and skills by name + CLI tool (Issue #343, #800)
 *
 * Skills are registered first, then commands override any skills with the
 * same name AND the same CLI tool scope. This ensures commands take priority
 * over skills while keeping CLI-specific entries from masking each other.
 *
 * Issue #800: The dedup key is `name + cliTools` (not name alone). Entries
 * that share a name but target disjoint CLI tools (e.g. a Codex skill with
 * `cliTools: ['codex']` and a Claude command with `cliTools: undefined`) now
 * coexist instead of one silently overriding the other. Only entries with an
 * identical name and identical CLI tool scope are deduplicated (later wins).
 *
 * @param skills - Array of skill SlashCommand objects
 * @param commands - Array of command SlashCommand objects (take priority)
 * @returns Deduplicated array of SlashCommand objects
 */
export function deduplicateByName(skills: SlashCommand[], commands: SlashCommand[]): SlashCommand[] {
  const map = new Map<string, SlashCommand>();

  // Key = name + normalized CLI tool scope (see keyOf in command-merger.ts).
  // Shared with mergeCommandGroups() so both dedup layers agree on granularity
  // (Issue #800, #1380).

  // Register skills first
  for (const skill of skills) {
    map.set(keyOf(skill), skill);
  }

  // Commands override skills with the same name AND same CLI tool scope
  for (const cmd of commands) {
    map.set(keyOf(cmd), cmd);
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
    // Local Codex-family skills: current .agents/skills (Issue #1165, codex+antigravity)
    // + legacy .codex/skills (Issue #166, codex-only). Collapse same-named entries so a
    // skill present in both dirs is shown once, even though their cliTools scopes differ
    // after Issue #1504 (mergeCodexFamilySkills, .agents/skills wins).
    const codexLocalSkills = await loadCodexSkills(basePath);
    const agentsLocalSkills = await loadAgentsSkills(basePath);
    const codexFamilySkills = mergeCodexFamilySkills(codexLocalSkills, agentsLocalSkills);
    // opencode's own rows are deliberately NOT loaded here (Issue #2037). This
    // function is the tool-agnostic worktree layer, and an opencode-scoped copy
    // of every Skill would ride along into every caller — including the ones
    // that count entries by name across all tools. The route loads them beside
    // the global Skill scans, under `cliTool === 'opencode'`, which is also the
    // only session that can see them (see loadOpencodeSkills).
    const deduplicated = deduplicateByName(
      [...skills, ...codexFamilySkills],
      commands,
    );
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
  const deduplicated = deduplicateByName([...skillsCache], commandsCache);
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
  // Issue #1476: keep the user-catalog / staleness caches in lockstep.
  clearCatalogCache();
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
    const descMatch = (cmd.description ?? '').toLowerCase().includes(lowerQuery);
    return nameMatch || descMatch;
  });
}
