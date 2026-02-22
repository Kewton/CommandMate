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
import { getSlashCommandGroups } from '@/lib/slash-commands';
import { getStandardCommandGroups } from '@/lib/standard-commands';
import { mergeCommandGroups, filterCommandsByCliTool } from '@/lib/command-merger';
import { isValidWorktreePath } from '@/lib/worktree-path-validator';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import type { SlashCommandGroup } from '@/types/slash-commands';

/**
 * Slash commands API response
 *
 * NOTE: This interface is local to the worktree-specific API route.
 * A separate SlashCommandsResponse exists in api-client.ts for /api/slash-commands (MCBD).
 * The two types share the same name but have different structures (this one includes sources).
 */
// TODO: api-client.ts の SlashCommandsResponse との型統合を検討する（sources フィールドの共有）
interface SlashCommandsResponse {
  groups: ReturnType<typeof getStandardCommandGroups>;
  sources: {
    standard: number;
    worktree: number;
    mcbd: number;
    skill: number;  // Issue #343: Skills source count
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
      console.error(`[slash-commands API] Invalid worktree path detected: ${id}`);
      return NextResponse.json(
        { error: 'Invalid worktree configuration' },
        { status: 400 }
      );
    }

    // Issue #4: Get CLI tool from query parameter
    const cliTool = validateCliTool(request.nextUrl.searchParams.get('cliTool'));

    // Get standard command groups
    const standardGroups = getStandardCommandGroups();

    // Get worktree-specific command groups
    let worktreeGroups: SlashCommandGroup[] = [];
    try {
      worktreeGroups = await getSlashCommandGroups(worktree.path);
    } catch (error) {
      console.warn(`[slash-commands API] Could not load worktree commands: ${error}`);
      worktreeGroups = [];
    }

    // SF-1: Merge with worktree commands taking priority
    const mergedGroups = mergeCommandGroups(standardGroups, worktreeGroups);

    // Issue #4: Filter by CLI tool
    const filteredGroups = filterCommandsByCliTool(mergedGroups, cliTool);

    // Calculate source counts (after filtering) - DRY: flatMap once
    const allFilteredCommands = filteredGroups.flatMap(g => g.commands);
    const filteredStandardCount = allFilteredCommands.filter(cmd => cmd.source === 'standard').length;
    const filteredWorktreeCount = allFilteredCommands.filter(cmd => cmd.source === 'worktree').length;
    const filteredSkillCount = allFilteredCommands.filter(cmd => cmd.source === 'skill').length;

    return NextResponse.json({
      groups: filteredGroups,
      sources: {
        standard: filteredStandardCount,
        worktree: filteredWorktreeCount,
        mcbd: 0, // MCBD commands are loaded separately via /api/slash-commands
        skill: filteredSkillCount, // Issue #343: Skills source count
      },
      cliTool,
    });
  } catch (error) {
    console.error('[slash-commands API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to load slash commands' },
      { status: 500 }
    );
  }
}
