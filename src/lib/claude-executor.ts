/**
 * Claude CLI Executor
 * Issue #294: Executes claude -p commands for scheduled executions
 *
 * Security:
 * - Uses execFile (not exec) to prevent shell injection
 * - Sanitizes environment variables via env-sanitizer.ts
 * - Limits output size to prevent memory exhaustion
 * - Enforces execution timeout
 */

import { execFile } from 'child_process';
import { sanitizeEnvForChildProcess } from './env-sanitizer';
import { stripAnsi } from './cli-patterns';

// =============================================================================
// Constants
// =============================================================================

/** Maximum output buffer size for execFile (1MB) */
export const MAX_OUTPUT_SIZE = 1 * 1024 * 1024;

/** Maximum output size stored in DB (100KB) */
export const MAX_STORED_OUTPUT_SIZE = 100 * 1024;

/** Execution timeout in milliseconds (5 minutes) */
export const EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum message length sent to claude -p */
export const MAX_MESSAGE_LENGTH = 10000;

// =============================================================================
// Types
// =============================================================================

/** Result of executing a claude -p command */
export interface ExecutionResult {
  /** stdout output (stripped of ANSI codes, truncated to MAX_STORED_OUTPUT_SIZE) */
  output: string;
  /** Process exit code (null if killed by signal) */
  exitCode: number | null;
  /** Execution status */
  status: 'completed' | 'failed' | 'timeout';
  /** Error message if any */
  error?: string;
}

// =============================================================================
// Executor
// =============================================================================

/**
 * Truncate output to MAX_STORED_OUTPUT_SIZE bytes.
 * Appends a truncation notice if truncated.
 *
 * @param output - Raw output string
 * @returns Truncated output string
 */
export function truncateOutput(output: string): string {
  if (Buffer.byteLength(output, 'utf-8') <= MAX_STORED_OUTPUT_SIZE) {
    return output;
  }

  // Truncate to MAX_STORED_OUTPUT_SIZE bytes
  const buffer = Buffer.from(output, 'utf-8');
  const truncated = buffer.subarray(0, MAX_STORED_OUTPUT_SIZE).toString('utf-8');
  return truncated + '\n\n--- Output truncated (exceeded 100KB limit) ---';
}

/**
 * Execute a claude -p command in a worktree directory.
 *
 * @param message - Prompt message to send to claude
 * @param cwd - Working directory (worktree path from DB)
 * @param cliToolId - CLI tool to use (default: 'claude')
 * @returns Execution result with output and status
 */
export async function executeClaudeCommand(
  message: string,
  cwd: string,
  cliToolId: string = 'claude'
): Promise<ExecutionResult> {
  // Validate message length
  const truncatedMessage = message.length > MAX_MESSAGE_LENGTH
    ? message.substring(0, MAX_MESSAGE_LENGTH)
    : message;

  const args = ['-p', truncatedMessage];

  return new Promise<ExecutionResult>((resolve) => {
    const child = execFile(
      cliToolId,
      args,
      {
        cwd,
        env: sanitizeEnvForChildProcess(),
        maxBuffer: MAX_OUTPUT_SIZE,
        timeout: EXECUTION_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          const isTimeout = error.killed || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
          const rawOutput = stripAnsi(stdout || stderr || error.message);
          const output = truncateOutput(rawOutput);

          resolve({
            output,
            exitCode: error.code ? parseInt(String(error.code), 10) || null : null,
            status: isTimeout ? 'timeout' : 'failed',
            error: error.message,
          });
          return;
        }

        const rawOutput = stripAnsi(stdout || '');
        const output = truncateOutput(rawOutput);

        resolve({
          output,
          exitCode: 0,
          status: 'completed',
        });
      }
    );

    // Return the child process PID for tracking
    if (child.pid) {
      // Store PID in global active processes for cleanup on shutdown
      const activeProcesses = getActiveProcesses();
      activeProcesses.set(child.pid, child);

      child.on('exit', () => {
        activeProcesses.delete(child.pid!);
      });
    }
  });
}

// =============================================================================
// Process Tracking (globalThis for hot reload persistence)
// =============================================================================

declare global {
  // eslint-disable-next-line no-var
  var __scheduleActiveProcesses: Map<number, import('child_process').ChildProcess> | undefined;
}

/**
 * Get the global active processes map.
 * Uses globalThis for hot reload persistence.
 */
export function getActiveProcesses(): Map<number, import('child_process').ChildProcess> {
  if (!globalThis.__scheduleActiveProcesses) {
    globalThis.__scheduleActiveProcesses = new Map();
  }
  return globalThis.__scheduleActiveProcesses;
}
