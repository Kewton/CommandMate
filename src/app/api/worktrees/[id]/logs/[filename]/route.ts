/**
 * API Route: GET /api/worktrees/:id/logs/:filename
 * Returns content of a specific log file
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { getLogDir } from '@/config/log-config';
import { sanitizeForExport } from '@/lib/log-export-sanitizer';
import { withLogging } from '@/lib/api-logger';
import fs from 'fs/promises';
import path from 'path';

export const GET = withLogging<{ id: string; filename: string }>(async (
  request: NextRequest,
  { params }: { params: { id: string; filename: string } | Promise<{ id: string; filename: string }> }
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

    // Validate filename to prevent path traversal attacks
    const filename = resolvedParams.filename;

    // Only allow .md files and ensure it starts with the worktree ID
    if (!filename.endsWith('.md') || !filename.startsWith(`${resolvedParams.id}-`)) {
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

    // Try to find file in CLI tool subdirectories (claude, codex, gemini)
    const cliTools = ['claude', 'codex', 'gemini'];
    let fileFound = false;
    let fileContent = '';
    let fileStat: { size: number; mtime: Date } | null = null;
    let foundCliTool = '';

    for (const cliTool of cliTools) {
      const filePath = path.join(getLogDir(), cliTool, filename);

      try {
        const stat = await fs.stat(filePath);

        if (stat.isFile()) {
          // File found
          fileFound = true;
          foundCliTool = cliTool;
          fileStat = { size: stat.size, mtime: stat.mtime };
          fileContent = await fs.readFile(filePath, 'utf-8');
          break;
        }
      } catch (error: unknown) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== 'ENOENT') {
          throw error; // Re-throw non-ENOENT errors
        }
        // Continue to next CLI tool
      }
    }

    if (!fileFound) {
      return NextResponse.json(
        { error: `Log file '${filename}' not found in any CLI tool directory` },
        { status: 404 }
      );
    }

    // Apply sanitization if requested (Issue #11: log export feature)
    const sanitize = request.nextUrl?.searchParams?.get('sanitize') === 'true';
    if (sanitize) fileContent = sanitizeForExport(fileContent);

    return NextResponse.json(
      {
        filename,
        cliToolId: foundCliTool,
        content: fileContent,
        size: fileStat!.size,
        modifiedAt: fileStat!.mtime.toISOString(),
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    console.error('Error reading log file:', error);
    return NextResponse.json(
      { error: 'Failed to read log file' },
      { status: 500 }
    );
  }
}, { skipResponseBody: true });
