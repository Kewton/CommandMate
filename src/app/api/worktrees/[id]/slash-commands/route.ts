/**
 * Worktree-Specific Slash Commands API (Issue #56)
 *
 * GET /api/worktrees/[id]/slash-commands
 *
 * Returns merged slash commands for a specific worktree:
 * - Standard Claude Code commands
 * - Worktree-specific commands from .claude/commands/
 *
 * MF-1: Implements path validation to prevent traversal attacks
 * SF-1: Worktree commands take priority over standard commands
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { getSlashCommandGroups } from '@/lib/slash-commands';
import { getStandardCommandGroups, STANDARD_COMMANDS } from '@/lib/standard-commands';
import { mergeCommandGroups, countCommands } from '@/lib/command-merger';
import { isValidWorktreePath } from '@/lib/worktree-path-validator';
import type { SlashCommandGroup } from '@/types/slash-commands';

/**
 * Slash commands API response
 */
interface SlashCommandsResponse {
  groups: ReturnType<typeof getStandardCommandGroups>;
  sources: {
    standard: number;
    worktree: number;
    mcbd: number;
  };
}

/**
 * GET /api/worktrees/[id]/slash-commands
 *
 * Returns merged slash commands for the specified worktree.
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

    // Calculate source counts
    const standardCount = STANDARD_COMMANDS.length;
    const worktreeCount = countCommands(worktreeGroups);

    return NextResponse.json({
      groups: mergedGroups,
      sources: {
        standard: standardCount,
        worktree: worktreeCount,
        mcbd: 0, // MCBD commands are loaded separately via /api/slash-commands
      },
    });
  } catch (error) {
    console.error('[slash-commands API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to load slash commands' },
      { status: 500 }
    );
  }
}
