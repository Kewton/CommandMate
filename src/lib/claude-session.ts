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
 * Options for starting a Claude session
 */
export interface ClaudeSessionOptions {
  worktreeId: string;
  worktreePath: string;
  baseUrl: string;  // MCBD server URL for webhooks
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
  } catch (error) {
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
  const { worktreeId, worktreePath, baseUrl } = options;

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

    // Set up CLAUDE_HOOKS_STOP environment variable for the Stop hook
    const hookUrl = `${baseUrl}/api/hooks/claude-done`;
    const hookData = JSON.stringify({ worktreeId });
    await sendKeys(
      sessionName,
      `export CLAUDE_HOOKS_STOP='curl -X POST -H "Content-Type: application/json" -d '"'"'${hookData}'"'"' ${hookUrl}'`,
      true
    );

    // Wait a moment for the export to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Start Claude CLI in interactive mode
    await sendKeys(sessionName, 'claude', true);

    // Wait for Claude to initialize
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log(`✓ Started Claude session: ${sessionName}`);
  } catch (error: any) {
    throw new Error(`Failed to start Claude session: ${error.message}`);
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
    // Send message to Claude
    await sendKeys(sessionName, message, true);

    // Wait a moment for the message to be entered
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Send another Enter to submit the message (Claude CLI uses multi-line input mode)
    await sendKeys(sessionName, '', true);

    console.log(`✓ Sent message to Claude session: ${sessionName}`);
  } catch (error: any) {
    throw new Error(`Failed to send message to Claude: ${error.message}`);
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
  } catch (error: any) {
    throw new Error(`Failed to capture Claude output: ${error.message}`);
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
  } catch (error: any) {
    console.error(`Error stopping Claude session: ${error.message}`);
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
