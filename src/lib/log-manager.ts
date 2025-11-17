/**
 * Log file management for Claude output
 * Generates and manages Markdown log files from Claude's responses
 */

import fs from 'fs/promises';
import path from 'path';
import { format } from 'date-fns';

/**
 * Log directory configuration
 */
const LOG_DIR = process.env.MCBD_LOG_DIR || path.join(process.cwd(), 'data', 'logs');

/**
 * Ensure log directory exists
 */
async function ensureLogDirectory(): Promise<void> {
  try {
    await fs.access(LOG_DIR);
  } catch {
    await fs.mkdir(LOG_DIR, { recursive: true });
  }
}

/**
 * Get log file path for a worktree
 *
 * @param worktreeId - Worktree ID
 * @returns Log file path
 *
 * @example
 * ```typescript
 * getLogFilePath('feature-foo')
 * // => '/path/to/data/logs/feature-foo-2025-01-20.md'
 * ```
 */
export function getLogFilePath(worktreeId: string): string {
  const date = format(new Date(), 'yyyy-MM-dd');
  const filename = `${worktreeId}-${date}.md`;
  return path.join(LOG_DIR, filename);
}

/**
 * Create a Markdown log file for a conversation
 *
 * @param worktreeId - Worktree ID
 * @param userMessage - User's message
 * @param claudeResponse - Claude's response
 * @returns Path to the created log file
 *
 * @example
 * ```typescript
 * const logPath = await createLog(
 *   'feature-foo',
 *   'Explain this code',
 *   'This code implements...'
 * );
 * ```
 */
export async function createLog(
  worktreeId: string,
  userMessage: string,
  claudeResponse: string
): Promise<string> {
  await ensureLogDirectory();

  const logPath = getLogFilePath(worktreeId);
  const timestamp = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

  // Check if log file already exists
  let logContent = '';
  try {
    logContent = await fs.readFile(logPath, 'utf-8');
  } catch {
    // File doesn't exist, create header
    logContent = `# Claude Conversation Log: ${worktreeId}\n\n`;
    logContent += `Created: ${timestamp}\n\n`;
    logContent += `---\n\n`;
  }

  // Append new conversation
  logContent += `## Conversation at ${timestamp}\n\n`;
  logContent += `### User\n\n`;
  logContent += `${userMessage}\n\n`;
  logContent += `### Claude\n\n`;
  logContent += `${claudeResponse}\n\n`;
  logContent += `---\n\n`;

  await fs.writeFile(logPath, logContent, 'utf-8');

  return logPath;
}

/**
 * Append to existing log file
 *
 * @param worktreeId - Worktree ID
 * @param content - Content to append
 *
 * @example
 * ```typescript
 * await appendToLog('feature-foo', 'Additional notes...');
 * ```
 */
export async function appendToLog(
  worktreeId: string,
  content: string
): Promise<void> {
  await ensureLogDirectory();

  const logPath = getLogFilePath(worktreeId);
  const timestamp = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

  let logContent = '';
  try {
    logContent = await fs.readFile(logPath, 'utf-8');
  } catch {
    // File doesn't exist, create header
    logContent = `# Claude Conversation Log: ${worktreeId}\n\n`;
    logContent += `Created: ${timestamp}\n\n`;
    logContent += `---\n\n`;
  }

  logContent += `${content}\n\n`;

  await fs.writeFile(logPath, logContent, 'utf-8');
}

/**
 * Read log file content
 *
 * @param worktreeId - Worktree ID
 * @returns Log file content, or null if file doesn't exist
 *
 * @example
 * ```typescript
 * const log = await readLog('feature-foo');
 * if (log) {
 *   console.log(log);
 * }
 * ```
 */
export async function readLog(worktreeId: string): Promise<string | null> {
  const logPath = getLogFilePath(worktreeId);

  try {
    return await fs.readFile(logPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * List all log files for a worktree
 *
 * @param worktreeId - Worktree ID
 * @returns Array of log file paths
 *
 * @example
 * ```typescript
 * const logs = await listLogs('feature-foo');
 * // => ['/path/to/feature-foo-2025-01-20.md', '/path/to/feature-foo-2025-01-19.md']
 * ```
 */
export async function listLogs(worktreeId: string): Promise<string[]> {
  await ensureLogDirectory();

  try {
    const files = await fs.readdir(LOG_DIR);
    const logFiles = files
      .filter((file) => file.startsWith(`${worktreeId}-`) && file.endsWith('.md'))
      .map((file) => path.join(LOG_DIR, file))
      .sort()
      .reverse(); // Most recent first

    return logFiles;
  } catch {
    return [];
  }
}

/**
 * Delete old log files (older than specified days)
 *
 * @param days - Number of days to keep
 *
 * @example
 * ```typescript
 * // Delete logs older than 30 days
 * await cleanupOldLogs(30);
 * ```
 */
export async function cleanupOldLogs(days: number = 30): Promise<number> {
  await ensureLogDirectory();

  const now = new Date();
  const cutoffDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  try {
    const files = await fs.readdir(LOG_DIR);
    let deletedCount = 0;

    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const filePath = path.join(LOG_DIR, file);
      const stats = await fs.stat(filePath);

      if (stats.mtime < cutoffDate) {
        await fs.unlink(filePath);
        deletedCount++;
      }
    }

    return deletedCount;
  } catch (error) {
    console.error('Error cleaning up old logs:', error);
    return 0;
  }
}
