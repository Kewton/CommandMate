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
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { getSlashCommandGroups, loadCodexSkills, loadCodexPrompts } from '@/lib/slash-commands';
import { getStandardCommandGroups } from '@/lib/standard-commands';
import { mergeCommandGroups, filterCommandsByCliTool } from '@/lib/command-merger';
import { isValidWorktreePath } from '@/lib/security/worktree-path-validator';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import type { SlashCommandGroup } from '@/types/slash-commands';
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
  };
  cliTool: CLIToolType;
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

    // Get standard command groups
    const standardGroups = getStandardCommandGroups();

    // Get worktree-specific command groups (includes local Codex skills via getSlashCommandGroups)
    let worktreeGroups: SlashCommandGroup[] = [];
    try {
      worktreeGroups = await getSlashCommandGroups(worktree.path);
    } catch {
      logger.warn('commands:load-failed');
      worktreeGroups = [];
    }

    // Load global Codex skills and prompts from ~/.codex/ (Issue #166)
    const globalCodexSkills = await loadCodexSkills().catch(() => []);
    const globalCodexPrompts = await loadCodexPrompts().catch(() => []);
    const allGlobalCodex = [...globalCodexSkills, ...globalCodexPrompts];

    // SF-1: Merge with worktree commands taking priority
    // Include global Codex skills/prompts in worktree groups (local ones already included via getSlashCommandGroups)
    const globalCodexGroups: SlashCommandGroup[] = allGlobalCodex.length > 0
      ? [{ category: 'skill' as const, label: 'Skills', commands: allGlobalCodex }]
      : [];
    const mergedGroups = mergeCommandGroups(standardGroups, [...worktreeGroups, ...globalCodexGroups]);

    // Issue #4: Filter by CLI tool
    const filteredGroups = filterCommandsByCliTool(mergedGroups, cliTool);

    // Calculate source counts in a single pass
    const sourceCounts = { standard: 0, worktree: 0, skill: 0, codexSkill: 0 };
    for (const group of filteredGroups) {
      for (const cmd of group.commands) {
        if (cmd.source === 'standard') sourceCounts.standard++;
        else if (cmd.source === 'worktree') sourceCounts.worktree++;
        else if (cmd.source === 'skill') sourceCounts.skill++;
        else if (cmd.source === 'codex-skill') sourceCounts.codexSkill++;
      }
    }

    return NextResponse.json({
      groups: filteredGroups,
      sources: {
        ...sourceCounts,
        mcbd: 0, // MCBD commands are loaded separately via /api/slash-commands
      },
      cliTool,
    });
  } catch (error) {
    logger.error('error:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to load slash commands' },
      { status: 500 }
    );
  }
}
