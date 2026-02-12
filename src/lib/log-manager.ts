/**
 * Log file management for Claude output
 * Generates and manages Markdown log files from Claude's responses
 */

import fs from 'fs/promises';
import path from 'path';
import { format } from 'date-fns';
import { getLogDir } from '@/config/log-config';

/**
 * Get log directory for a CLI tool
 *
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @returns Log directory path
 */
function getCliToolLogDir(cliToolId: string = 'claude'): string {
  return path.join(getLogDir(), cliToolId);
}

/**
 * Ensure log directory exists
 *
 * @param cliToolId - CLI tool ID (optional, defaults to 'claude')
 */
async function ensureLogDirectory(cliToolId: string = 'claude'): Promise<void> {
  const logDir = getCliToolLogDir(cliToolId);
  try {
    await fs.access(logDir);
  } catch {
    await fs.mkdir(logDir, { recursive: true });
  }
}

/**
 * Get log file path for a worktree
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @returns Log file path
 *
 * @example
 * ```typescript
 * getLogFilePath('feature-foo', 'claude')
 * // => '/path/to/data/logs/claude/feature-foo-2025-01-20.md'
 * ```
 */
export function getLogFilePath(worktreeId: string, cliToolId: string = 'claude'): string {
  const date = format(new Date(), 'yyyy-MM-dd');
  const filename = `${worktreeId}-${date}.md`;
  const logDir = getCliToolLogDir(cliToolId);
  return path.join(logDir, filename);
}

/**
 * Create a Markdown log file for a conversation
 *
 * @param worktreeId - Worktree ID
 * @param userMessage - User's message
 * @param claudeResponse - Claude's response
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @returns Path to the created log file
 *
 * @example
 * ```typescript
 * const logPath = await createLog(
 *   'feature-foo',
 *   'Explain this code',
 *   'This code implements...',
 *   'claude'
 * );
 * ```
 */
export async function createLog(
  worktreeId: string,
  userMessage: string,
  claudeResponse: string,
  cliToolId: string = 'claude'
): Promise<string> {
  await ensureLogDirectory(cliToolId);

  const logPath = getLogFilePath(worktreeId, cliToolId);
  const timestamp = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

  // Check if log file already exists
  let logContent = '';
  try {
    logContent = await fs.readFile(logPath, 'utf-8');
  } catch {
    // File doesn't exist, create header
    const toolName = cliToolId === 'claude' ? 'Claude Code' : cliToolId === 'codex' ? 'Codex CLI' : 'Gemini CLI';
    logContent = `# ${toolName} Conversation Log: ${worktreeId}\n\n`;
    logContent += `Created: ${timestamp}\n\n`;
    logContent += `---\n\n`;
  }

  // Append new conversation
  logContent += `## Conversation at ${timestamp}\n\n`;
  logContent += `### User\n\n`;
  logContent += `${userMessage}\n\n`;
  logContent += `### ${cliToolId === 'claude' ? 'Claude' : cliToolId === 'codex' ? 'Codex' : 'Gemini'}\n\n`;
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
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 *
 * @example
 * ```typescript
 * await appendToLog('feature-foo', 'Additional notes...', 'claude');
 * ```
 */
export async function appendToLog(
  worktreeId: string,
  content: string,
  cliToolId: string = 'claude'
): Promise<void> {
  await ensureLogDirectory(cliToolId);

  const logPath = getLogFilePath(worktreeId, cliToolId);
  const timestamp = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

  let logContent = '';
  try {
    logContent = await fs.readFile(logPath, 'utf-8');
  } catch {
    // File doesn't exist, create header
    const toolName = cliToolId === 'claude' ? 'Claude Code' : cliToolId === 'codex' ? 'Codex CLI' : 'Gemini CLI';
    logContent = `# ${toolName} Conversation Log: ${worktreeId}\n\n`;
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
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @returns Log file content, or null if file doesn't exist
 *
 * @example
 * ```typescript
 * const log = await readLog('feature-foo', 'claude');
 * if (log) {
 *   console.log(log);
 * }
 * ```
 */
export async function readLog(worktreeId: string, cliToolId: string = 'claude'): Promise<string | null> {
  const logPath = getLogFilePath(worktreeId, cliToolId);

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
 * @param cliToolId - CLI tool ID (claude, codex, gemini), or 'all' for all tools
 * @returns Array of log file paths
 *
 * @example
 * ```typescript
 * const logs = await listLogs('feature-foo', 'claude');
 * // => ['/path/to/logs/claude/feature-foo-2025-01-20.md', '/path/to/logs/claude/feature-foo-2025-01-19.md']
 * ```
 */
export async function listLogs(worktreeId: string, cliToolId: string = 'all'): Promise<string[]> {
  const toolIds = cliToolId === 'all' ? ['claude', 'codex', 'gemini'] : [cliToolId];
  const allLogFiles: string[] = [];

  for (const toolId of toolIds) {
    await ensureLogDirectory(toolId);
    const logDir = getCliToolLogDir(toolId);

    try {
      const files = await fs.readdir(logDir);
      const logFiles = files
        .filter((file) => file.startsWith(`${worktreeId}-`) && file.endsWith('.md'))
        .map((file) => path.join(logDir, file));

      allLogFiles.push(...logFiles);
    } catch {
      // Directory doesn't exist or is not accessible, skip
    }
  }

  return allLogFiles.sort().reverse(); // Most recent first
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
  const toolIds = ['claude', 'codex', 'gemini'];
  let totalDeletedCount = 0;

  const now = new Date();
  const cutoffDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  for (const toolId of toolIds) {
    await ensureLogDirectory(toolId);
    const logDir = getCliToolLogDir(toolId);

    try {
      const files = await fs.readdir(logDir);

      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filePath = path.join(logDir, file);
        const stats = await fs.stat(filePath);

        if (stats.mtime < cutoffDate) {
          await fs.unlink(filePath);
          totalDeletedCount++;
        }
      }
    } catch (error) {
      console.error(`Error cleaning up old logs for ${toolId}:`, error);
    }
  }

  return totalDeletedCount;
}
