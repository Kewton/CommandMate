/**
 * API Route: GET /api/worktrees/:id/logs
 * Returns list of log files for a specific worktree
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { listLogs } from '@/lib/log-manager';
import { withLogging } from '@/lib/api-logger';
import fs from 'fs/promises';
import path from 'path';

export const GET = withLogging<{ id: string }>(async (
  request: NextRequest,
  { params }: { params: { id: string } | Promise<{ id: string }> }
) => {
  try {
    const resolvedParams = await Promise.resolve(params);
    const db = getDbInstance();

    // Check if worktree exists
    const worktree = getWorktreeById(db, resolvedParams.id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${resolvedParams.id}' not found` },
        { status: 404 }
      );
    }

    // Get query parameter for CLI tool filter
    const searchParams = request.nextUrl?.searchParams;
    const cliToolFilter = searchParams?.get('cliTool') || 'all';

    // Get log files using log-manager
    const logPaths = await listLogs(resolvedParams.id, cliToolFilter);

    // Extract filenames from full paths and get file info
    const logFiles = await Promise.all(
      logPaths.map(async (logPath) => {
        const filename = path.basename(logPath);
        const stat = await fs.stat(logPath);

        // Extract CLI tool from path (e.g., /data/logs/claude/file.md -> claude)
        const pathParts = logPath.split(path.sep);
        const cliToolId = pathParts[pathParts.length - 2]; // Directory name before filename

        return {
          filename,
          cliToolId,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
    );

    // Return just the filenames array (to match the expected API response)
    // But include CLI tool info for frontend to display
    const filenames = logFiles.map(f => f.filename);

    return NextResponse.json(filenames, { status: 200 });
  } catch (error) {
    console.error('Error fetching log files:', error);
    return NextResponse.json(
      { error: 'Failed to fetch log files' },
      { status: 500 }
    );
  }
});
