/**
 * Claude CLI session management
 * Manages Claude CLI sessions within tmux for each worktree
 */

import {
  hasSession,
  createSession,
  sendKeys,
  capturePane,
  killSession,
} from './tmux';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Cached Claude CLI path
 */
let cachedClaudePath: string | null = null;

/**
 * Get Claude CLI path dynamically
 * Uses CLAUDE_PATH environment variable if set, otherwise finds via 'which'
 */
async function getClaudePath(): Promise<string> {
  // Return cached path if available
  if (cachedClaudePath) {
    return cachedClaudePath;
  }

  // Check environment variable first
  if (process.env.CLAUDE_PATH) {
    cachedClaudePath = process.env.CLAUDE_PATH;
    return cachedClaudePath;
  }

  // Find claude via 'which' command
  try {
    const { stdout } = await execAsync('which claude', { timeout: 5000 });
    cachedClaudePath = stdout.trim();
    return cachedClaudePath;
  } catch {
    // Fallback to common paths
    const fallbackPaths = [
      '/opt/homebrew/bin/claude',  // macOS Homebrew (Apple Silicon)
      '/usr/local/bin/claude',     // macOS Homebrew (Intel) / Linux
      '/usr/bin/claude',           // Linux system install
    ];

    for (const path of fallbackPaths) {
      try {
        await execAsync(`test -x "${path}"`, { timeout: 1000 });
        cachedClaudePath = path;
        return cachedClaudePath;
      } catch {
        // Path not found, try next
      }
    }

    throw new Error('Claude CLI not found. Set CLAUDE_PATH environment variable or install Claude CLI.');
  }
}

/**
 * Options for starting a Claude session
 */
export interface ClaudeSessionOptions {
  worktreeId: string;
  worktreePath: string;
}

/**
 * Claude session state
 */
export interface ClaudeSessionState {
  sessionName: string;
  isRunning: boolean;
  lastActivity: Date;
}

/**
 * Get tmux session name for a worktree
 *
 * @param worktreeId - Worktree ID
 * @returns tmux session name
 *
 * @example
 * ```typescript
 * getSessionName('feature-foo') // => 'mcbd-claude-feature-foo'
 * ```
 */
export function getSessionName(worktreeId: string): string {
  return `mcbd-claude-${worktreeId}`;
}

/**
 * Check if Claude is installed and available
 *
 * @returns True if Claude CLI is available
 */
export async function isClaudeInstalled(): Promise<boolean> {
  try {
    await execAsync('which claude', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Claude session is running
 *
 * @param worktreeId - Worktree ID
 * @returns True if Claude session exists and is running
 *
 * @example
 * ```typescript
 * const running = await isClaudeRunning('feature-foo');
 * if (running) {
 *   console.log('Claude is ready');
 * }
 * ```
 */
export async function isClaudeRunning(worktreeId: string): Promise<boolean> {
  const sessionName = getSessionName(worktreeId);
  return await hasSession(sessionName);
}

/**
 * Get Claude session state
 *
 * @param worktreeId - Worktree ID
 * @returns Session state information
 */
export async function getClaudeSessionState(
  worktreeId: string
): Promise<ClaudeSessionState> {
  const sessionName = getSessionName(worktreeId);
  const isRunning = await hasSession(sessionName);

  return {
    sessionName,
    isRunning,
    lastActivity: new Date(),
  };
}

/**
 * Start a Claude CLI session in tmux
 *
 * @param options - Session options
 * @throws {Error} If Claude CLI is not installed or session creation fails
 *
 * @example
 * ```typescript
 * await startClaudeSession({
 *   worktreeId: 'feature-foo',
 *   worktreePath: '/path/to/worktree',
 *   baseUrl: 'http://localhost:3000',
 * });
 * ```
 */
export async function startClaudeSession(
  options: ClaudeSessionOptions
): Promise<void> {
  const { worktreeId, worktreePath } = options;

  // Check if Claude is installed
  const claudeAvailable = await isClaudeInstalled();
  if (!claudeAvailable) {
    throw new Error('Claude CLI is not installed or not in PATH');
  }

  const sessionName = getSessionName(worktreeId);

  // Check if session already exists
  const exists = await hasSession(sessionName);
  if (exists) {
    console.log(`Claude session ${sessionName} already exists`);
    return;
  }

  try {
    // Create tmux session with large history buffer for Claude output
    await createSession({
      sessionName,
      workingDirectory: worktreePath,
      historyLimit: 50000,
    });

    // Get Claude CLI path dynamically
    const claudePath = await getClaudePath();

    // Start Claude CLI in interactive mode using dynamically resolved path
    await sendKeys(sessionName, claudePath, true);

    // Wait for Claude to initialize with dynamic detection
    // Check for Claude prompt instead of fixed delay
    const maxWaitTime = 10000; // 10 seconds max
    const pollInterval = 500;  // Check every 500ms
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      try {
        const output = await capturePane(sessionName, { startLine: -50 });
        // Claude is ready when we see the prompt (> ) or separator line
        if (/^>\s*$/m.test(output) || /^─{10,}$/m.test(output)) {
          console.log(`✓ Claude initialized in ${Date.now() - startTime}ms`);
          break;
        }
      } catch {
        // Ignore capture errors during initialization
      }
    }

    console.log(`✓ Started Claude session: ${sessionName}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to start Claude session: ${errorMessage}`);
  }
}

/**
 * Send a message to Claude CLI
 *
 * @param worktreeId - Worktree ID
 * @param message - Message content to send
 * @throws {Error} If session doesn't exist
 *
 * @example
 * ```typescript
 * await sendMessageToClaude('feature-foo', 'Explain this code');
 * ```
 */
export async function sendMessageToClaude(
  worktreeId: string,
  message: string
): Promise<void> {
  const sessionName = getSessionName(worktreeId);

  // Check if session exists
  const exists = await hasSession(sessionName);
  if (!exists) {
    throw new Error(
      `Claude session ${sessionName} does not exist. Start the session first.`
    );
  }

  try {
    // Send message to Claude (without Enter)
    await sendKeys(sessionName, message, false);

    // Wait a moment for the text to be typed
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Send Enter key to submit (single Enter submits in Claude Code CLI)
    await execAsync(`tmux send-keys -t "${sessionName}" C-m`);

    // Wait a moment for the message to be processed
    await new Promise((resolve) => setTimeout(resolve, 200));

    console.log(`✓ Sent message to Claude session: ${sessionName}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to send message to Claude: ${errorMessage}`);
  }
}

/**
 * Capture Claude session output
 *
 * @param worktreeId - Worktree ID
 * @param lines - Number of lines to capture (default: 1000)
 * @returns Captured output
 *
 * @example
 * ```typescript
 * const output = await captureClaudeOutput('feature-foo');
 * console.log(output);
 * ```
 */
export async function captureClaudeOutput(
  worktreeId: string,
  lines: number = 1000
): Promise<string> {
  const sessionName = getSessionName(worktreeId);

  // Check if session exists
  const exists = await hasSession(sessionName);
  if (!exists) {
    throw new Error(`Claude session ${sessionName} does not exist`);
  }

  try {
    return await capturePane(sessionName, { startLine: -lines });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to capture Claude output: ${errorMessage}`);
  }
}

/**
 * Stop a Claude session
 *
 * @param worktreeId - Worktree ID
 * @returns True if session was stopped, false if it didn't exist
 *
 * @example
 * ```typescript
 * await stopClaudeSession('feature-foo');
 * ```
 */
export async function stopClaudeSession(worktreeId: string): Promise<boolean> {
  const sessionName = getSessionName(worktreeId);

  try {
    // Send Ctrl+D to exit Claude gracefully
    const exists = await hasSession(sessionName);
    if (exists) {
      await sendKeys(sessionName, '', false);
      // Send Ctrl+D (ASCII 4)
      await execAsync(`tmux send-keys -t "${sessionName}" C-d`);

      // Wait a moment for Claude to exit
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Kill the tmux session
    const killed = await killSession(sessionName);

    if (killed) {
      console.log(`✓ Stopped Claude session: ${sessionName}`);
    }

    return killed;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error stopping Claude session: ${errorMessage}`);
    return false;
  }
}

/**
 * Restart a Claude session
 *
 * @param options - Session options
 *
 * @example
 * ```typescript
 * await restartClaudeSession({
 *   worktreeId: 'feature-foo',
 *   worktreePath: '/path/to/worktree',
 *   baseUrl: 'http://localhost:3000',
 * });
 * ```
 */
export async function restartClaudeSession(
  options: ClaudeSessionOptions
): Promise<void> {
  const { worktreeId } = options;

  // Stop existing session
  await stopClaudeSession(worktreeId);

  // Wait a moment before restarting
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Start new session
  await startClaudeSession(options);
}
