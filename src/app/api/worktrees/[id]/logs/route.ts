/**
 * API Route: GET /api/worktrees/:id/logs
 * Returns list of log files for a specific worktree
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { listLogs } from '@/lib/log-manager';
import fs from 'fs/promises';
import path from 'path';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const db = getDbInstance();

    // Check if worktree exists
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${params.id}' not found` },
        { status: 404 }
      );
    }

    // Get log files using log-manager
    const logPaths = await listLogs(params.id);

    // Extract filenames from full paths and get file info
    const logFiles = await Promise.all(
      logPaths.map(async (logPath) => {
        const filename = path.basename(logPath);
        const stat = await fs.stat(logPath);
        return {
          filename,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
    );

    // Return just the filenames array (to match the expected API response)
    const filenames = logFiles.map(f => f.filename);

    return NextResponse.json(filenames, { status: 200 });
  } catch (error) {
    console.error('Error fetching log files:', error);
    return NextResponse.json(
      { error: 'Failed to fetch log files' },
      { status: 500 }
    );
  }
}
