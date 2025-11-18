/**
 * API Route: GET /api/worktrees/:id/logs/:filename
 * Returns content of a specific log file
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import fs from 'fs/promises';
import path from 'path';

const LOG_DIR = process.env.MCBD_LOG_DIR || path.join(process.cwd(), 'data', 'logs');

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; filename: string } }
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

    // Validate filename to prevent path traversal attacks
    const filename = params.filename;

    // Only allow .md files and ensure it starts with the worktree ID
    if (!filename.endsWith('.md') || !filename.startsWith(`${params.id}-`)) {
      return NextResponse.json(
        { error: 'Invalid filename' },
        { status: 400 }
      );
    }

    // Check for path traversal attempts
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return NextResponse.json(
        { error: 'Invalid filename: path traversal not allowed' },
        { status: 400 }
      );
    }

    // Construct file path
    const filePath = path.join(LOG_DIR, filename);

    // Verify the file exists
    try {
      const stat = await fs.stat(filePath);

      if (!stat.isFile()) {
        return NextResponse.json(
          { error: `'${filename}' is not a file` },
          { status: 400 }
        );
      }

      // Read file content
      const content = await fs.readFile(filePath, 'utf-8');

      return NextResponse.json(
        {
          filename,
          content,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        },
        { status: 200 }
      );
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return NextResponse.json(
          { error: `Log file '${filename}' not found` },
          { status: 404 }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error('Error reading log file:', error);
    return NextResponse.json(
      { error: 'Failed to read log file' },
      { status: 500 }
    );
  }
}
