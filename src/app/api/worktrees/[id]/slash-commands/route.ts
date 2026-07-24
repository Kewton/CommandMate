/**
 * Worktree-Specific Slash Commands API (Issue #56, Issue #4)
 *
 * GET /api/worktrees/[id]/slash-commands?cliTool=claude|codex|gemini
 *
 * Returns merged slash commands for a specific worktree:
 * - Standard CLI tool commands (filtered by cliTool)
 * - Worktree-specific commands from .claude/commands/
 *
 * MF-1: Implements path validation to prevent traversal attacks
 * SF-1: Worktree commands take priority over standard commands
 * Issue #4: Filters commands by CLI tool
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { getSlashCommandGroups, loadCodexSkills, loadAgentsSkills, mergeCodexFamilySkills, getCopilotBuiltinCommands, getGeminiBuiltinCommands } from '@/lib/slash-commands';
import { getStandardCommandGroups } from '@/lib/standard-commands';
import { loadUserCatalogCommands, composeStandardLayer, getCatalogStaleness } from '@/lib/slash-command-catalog';
import { mergeCommandGroups, filterCommandsByCliTool, groupByCategory } from '@/lib/command-merger';
import { isValidWorktreePath } from '@/lib/security/worktree-path-validator';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import type { SlashCommandGroup, CatalogStaleness } from '@/types/slash-commands';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/slash-commands');

/**
 * Slash commands API response
 *
 * NOTE: This interface is local to the worktree-specific API route.
 * A separate SlashCommandsResponse exists in api-client.ts for /api/slash-commands (MCBD).
 * The two types share the same name but have different structures (this one includes sources).
 */
interface SlashCommandsResponse {
  groups: ReturnType<typeof getStandardCommandGroups>;
  sources: {
    standard: number;
    worktree: number;
    mcbd: number;
    skill: number;  // Issue #343: Skills source count
    codexSkill: number;  // Issue #166: Codex skills source count
    userCatalog: number;  // Issue #1476: user extension entries
  };
  cliTool: CLIToolType;
  /**
   * Issue #1476: per-tool staleness of the built-in catalog. Additive and
   * backward compatible — a tool appears only when its CLI version could be
   * read, so an empty object means "nothing known to be stale".
   */
  catalogStaleness: CatalogStaleness;
}

/**
 * Validate CLI tool ID from query parameter
 */
function validateCliTool(cliTool: string | null): CLIToolType {
  if (cliTool && CLI_TOOL_IDS.includes(cliTool as CLIToolType)) {
    return cliTool as CLIToolType;
  }
  return 'claude'; // Default to Claude for backward compatibility
}

/**
 * GET /api/worktrees/[id]/slash-commands
 *
 * Returns merged slash commands for the specified worktree.
 * Optionally filters by CLI tool via ?cliTool=claude|codex|gemini query parameter.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<SlashCommandsResponse | { error: string }>> {
  try {
    const { id } = await params;
    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);

    if (!worktree) {
      return NextResponse.json(
        { error: 'Worktree not found' },
        { status: 404 }
      );
    }

    // MF-1: Path validation to prevent traversal attacks
    if (!isValidWorktreePath(worktree.path)) {
      logger.error('invalid-worktree-path-detected:');
      return NextResponse.json(
        { error: 'Invalid worktree configuration' },
        { status: 400 }
      );
    }

    // Issue #4: Get CLI tool from query parameter
    const cliTool = validateCliTool(request.nextUrl.searchParams.get('cliTool'));

    // Get standard command groups, then fold in user extension commands
    // (Issue #1476). User entries override bundled entries that share the same
    // name + CLI tool scope, but stay part of the standard layer so worktree
    // commands still take priority (SF-1 invariant preserved by the merge below).
    const standardGroups = composeStandardLayer(
      getStandardCommandGroups(),
      loadUserCatalogCommands()
    );

    // Get worktree-specific command groups (includes local Codex skills via getSlashCommandGroups)
    let worktreeGroups: SlashCommandGroup[] = [];
    try {
      worktreeGroups = await getSlashCommandGroups(worktree.path);
    } catch {
      logger.warn('commands:load-failed');
      worktreeGroups = [];
    }

    // Load global Codex-family skills: current ~/.agents/skills/ (Issue #1165,
    // codex+antigravity) and legacy ~/.codex/skills/ (Issue #166, #790, codex-only).
    // mergeCodexFamilySkills collapses same-named entries whose cliTools scopes now
    // differ (Issue #1504) so they are not shown twice in codex sessions.
    // .codex/prompts/ is intentionally NOT loaded: Codex CLI never reads it, so
    // surfacing those entries in the palette only misleads users.
    const globalCodexSkills = await loadCodexSkills().catch(() => []);
    const globalAgentsSkills = await loadAgentsSkills().catch(() => []);
    const globalSkills = mergeCodexFamilySkills(globalCodexSkills, globalAgentsSkills);

    // SF-1: Merge with worktree commands taking priority
    // Include global Codex skills in worktree groups (local ones already included via getSlashCommandGroups)
    const globalCodexGroups: SlashCommandGroup[] = globalSkills.length > 0
      ? [{ category: 'skill' as const, label: 'Skills', commands: globalSkills }]
      : [];

    // Builtins are injected per-cli to prevent unrelated tools from overriding
    // shared standard commands with same names (clear, model, help, etc.).
    const copilotBuiltinGroups: SlashCommandGroup[] = cliTool === 'copilot'
      ? groupByCategory(getCopilotBuiltinCommands())
      : [];
    const geminiBuiltinGroups: SlashCommandGroup[] = cliTool === 'gemini'
      ? groupByCategory(getGeminiBuiltinCommands())
      : [];

    const mergedGroups = mergeCommandGroups(
      standardGroups,
      [...worktreeGroups, ...globalCodexGroups, ...copilotBuiltinGroups, ...geminiBuiltinGroups]
    );

    // Issue #4: Filter by CLI tool
    const filteredGroups = filterCommandsByCliTool(mergedGroups, cliTool);

    // Calculate source counts in a single pass
    const sourceCounts = { standard: 0, worktree: 0, skill: 0, codexSkill: 0, userCatalog: 0 };
    for (const group of filteredGroups) {
      for (const cmd of group.commands) {
        if (cmd.source === 'standard') sourceCounts.standard++;
        else if (cmd.source === 'worktree') sourceCounts.worktree++;
        else if (cmd.source === 'skill') sourceCounts.skill++;
        else if (cmd.source === 'codex-skill') sourceCounts.codexSkill++;
        else if (cmd.source === 'user-catalog') sourceCounts.userCatalog++;
      }
    }

    // Issue #1476: lazy, process-cached staleness probe. Never fails the request.
    const catalogStaleness = await getCatalogStaleness().catch(() => ({} as CatalogStaleness));

    return NextResponse.json({
      groups: filteredGroups,
      sources: {
        ...sourceCounts,
        mcbd: 0, // MCBD commands are loaded separately via /api/slash-commands
      },
      cliTool,
      catalogStaleness,
    });
  } catch (error) {
    logger.error('error:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to load slash commands' },
      { status: 500 }
    );
  }
}
