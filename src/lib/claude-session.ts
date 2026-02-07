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
  sendMessageWithEnter,
} from './tmux';
import {
  CLAUDE_PROMPT_PATTERN,
  CLAUDE_SEPARATOR_PATTERN,
  stripAnsi,
} from './cli-patterns';
import { getErrorMessage } from './utils';
import { getSessionNameUtil } from './session-name';
import { sendSpecialKey } from './tmux';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ----- Timeout and Polling Constants (OCP-001) -----
// These constants are exported to allow configuration and testing.
// Changing these values affects Claude CLI session startup behavior.

/**
 * Claude CLI initialization max wait time (milliseconds)
 *
 * This timeout allows sufficient time for Claude CLI to:
 * - Load and initialize its internal state
 * - Authenticate with Anthropic servers (if needed)
 * - Display the interactive prompt
 *
 * 15 seconds provides headroom for slower networks or cold starts.
 */
export const CLAUDE_INIT_TIMEOUT = 15000;

/**
 * Initialization polling interval (milliseconds)
 *
 * How frequently we check if Claude CLI has finished initializing.
 * 300ms balances responsiveness with avoiding excessive polling overhead.
 */
export const CLAUDE_INIT_POLL_INTERVAL = 300;

/**
 * Stability delay after prompt detection (milliseconds)
 *
 * This delay is necessary because Claude CLI renders its UI progressively:
 * 1. The prompt character (> or U+276F) appears first
 * 2. Additional UI elements (tips, suggestions) may render afterward
 * 3. Sending input too quickly can interrupt this rendering process
 *
 * The 500ms value was empirically determined to provide sufficient buffer
 * for Claude CLI to complete its initialization rendering while maintaining
 * responsive user experience. (DOC-001)
 *
 * @see Issue #152 - First message not being sent after session start
 */
export const CLAUDE_POST_PROMPT_DELAY = 500;

/**
 * Prompt wait timeout before message send (milliseconds)
 *
 * When sending a message, we first verify Claude is at a prompt state.
 * This timeout limits how long we wait for Claude to return to prompt
 * if it's still processing a previous request.
 */
export const CLAUDE_PROMPT_WAIT_TIMEOUT = 5000;

/**
 * Prompt wait polling interval (milliseconds)
 *
 * How frequently we check for prompt state before sending messages.
 * 200ms provides quick response while minimizing CPU usage.
 */
export const CLAUDE_PROMPT_POLL_INTERVAL = 200;

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
/**
 * @deprecated Use getSessionNameUtil(worktreeId, 'claude') from '@/lib/session-name' instead
 */
export function getSessionName(worktreeId: string): string {
  return getSessionNameUtil(worktreeId, 'claude');
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
 * Wait for session to be at prompt state
 * Polls for prompt detection using CLAUDE_PROMPT_PATTERN (DRY-001)
 *
 * @param sessionName - tmux session name
 * @param timeout - Timeout in milliseconds (default: CLAUDE_PROMPT_WAIT_TIMEOUT)
 * @throws {Error} If prompt is not detected within timeout
 *
 * @example
 * ```typescript
 * await waitForPrompt('mcbd-claude-feature-foo');
 * // Session is now ready to receive input
 * ```
 */
export async function waitForPrompt(
  sessionName: string,
  timeout: number = CLAUDE_PROMPT_WAIT_TIMEOUT
): Promise<void> {
  const startTime = Date.now();
  const pollInterval = CLAUDE_PROMPT_POLL_INTERVAL;

  while (Date.now() - startTime < timeout) {
    // Use -50 lines to capture more context including status bars
    const output = await capturePane(sessionName, { startLine: -50 });
    // DRY-001: Use CLAUDE_PROMPT_PATTERN from cli-patterns.ts
    // Strip ANSI escape sequences before pattern matching (Issue #152)
    if (CLAUDE_PROMPT_PATTERN.test(stripAnsi(output))) {
      return; // Prompt detected
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Prompt detection timeout (${timeout}ms)`);
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

    // Wait for Claude to initialize with dynamic detection (OCP-001)
    // Use constants instead of hardcoded values
    const maxWaitTime = CLAUDE_INIT_TIMEOUT;
    const pollInterval = CLAUDE_INIT_POLL_INTERVAL;
    const startTime = Date.now();

    let initialized = false;
    while (Date.now() - startTime < maxWaitTime) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      try {
        const output = await capturePane(sessionName, { startLine: -50 });
        // Claude is ready when we see the prompt or separator line (DRY-001, DRY-002)
        // Use patterns from cli-patterns.ts for consistency
        // Strip ANSI escape sequences before pattern matching (Issue #152)
        const cleanOutput = stripAnsi(output);
        if (CLAUDE_PROMPT_PATTERN.test(cleanOutput) || CLAUDE_SEPARATOR_PATTERN.test(cleanOutput)) {
          // Wait for stability after prompt detection (CONS-007, DOC-001)
          await new Promise((resolve) => setTimeout(resolve, CLAUDE_POST_PROMPT_DELAY));
          console.log(`Claude initialized in ${Date.now() - startTime}ms`);
          initialized = true;
          break;
        }
      } catch {
        // Ignore capture errors during initialization
      }
    }

    // Throw error on timeout instead of silently continuing (CONS-005, IMP-001)
    if (!initialized) {
      throw new Error(`Claude initialization timeout (${CLAUDE_INIT_TIMEOUT}ms)`);
    }

    console.log(`Started Claude session: ${sessionName}`);
  } catch (error: unknown) {
    throw new Error(`Failed to start Claude session: ${getErrorMessage(error)}`);
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

  // Verify prompt state before sending (CONS-006, DRY-001)
  // Use -50 lines to ensure we capture the prompt even with status bars
  const output = await capturePane(sessionName, { startLine: -50 });
  // Strip ANSI escape sequences before pattern matching (Issue #152)
  if (!CLAUDE_PROMPT_PATTERN.test(stripAnsi(output))) {
    // Wait for prompt if not at prompt state
    // Use longer timeout (10s) to handle slow responses
    try {
      await waitForPrompt(sessionName, 10000);
    } catch {
      // Log warning but don't block - Claude might be in a special state
      console.warn(`[sendMessageToClaude] Prompt not detected, sending anyway`);
    }
  }

  // Send message using unified pattern (Task-PRE-003, CONS-001)
  await sendMessageWithEnter(sessionName, message, 100);

  console.log(`Sent message to Claude session: ${sessionName}`);
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
    throw new Error(`Failed to capture Claude output: ${getErrorMessage(error)}`);
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
      // Send Ctrl+D via sendSpecialKey (Task-PRE-001)
      await sendSpecialKey(sessionName, 'C-d');

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
    console.error(`Error stopping Claude session: ${getErrorMessage(error)}`);
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
