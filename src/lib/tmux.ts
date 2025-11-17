/**
 * tmux session management
 * Provides functions to manage tmux sessions for Claude CLI integration
 */

import { exec } from 'child_process';
import { promisify } from 'util';

/**
 * Check if a tmux session exists
 *
 * @param sessionName - Name of the tmux session
 * @returns True if session exists, false otherwise
 *
 * @example
 * ```typescript
 * const exists = await hasSession('my-session');
 * if (exists) {
 *   console.log('Session is running');
 * }
 * ```
 */
export async function hasSession(sessionName: string): Promise<boolean> {
  const execAsync = promisify(exec);

  try {
    await execAsync(`tmux has-session -t ${sessionName}`);
    return true;
  } catch (error) {
    // tmux has-session returns non-zero exit code if session doesn't exist
    return false;
  }
}

/**
 * Create a new tmux session
 *
 * @param sessionName - Name for the new session
 * @param cwd - Working directory for the session
 *
 * @throws {Error} If session creation fails
 *
 * @example
 * ```typescript
 * await createSession('my-session', '/path/to/project');
 * ```
 */
export async function createSession(
  sessionName: string,
  cwd: string
): Promise<void> {
  const execAsync = promisify(exec);

  try {
    await execAsync(
      `tmux new-session -d -s ${sessionName} -c ${cwd}`
    );
  } catch (error) {
    throw error;
  }
}

/**
 * Send keys to a tmux session
 *
 * @param sessionName - Target session name
 * @param keys - Keys to send (command text)
 * @param sendEnter - Whether to send Enter key after the command (default: true)
 *
 * @example
 * ```typescript
 * await sendKeys('my-session', 'echo hello');
 * await sendKeys('my-session', 'ls -la', true);
 * await sendKeys('my-session', 'incomplete command', false);
 * ```
 */
export async function sendKeys(
  sessionName: string,
  keys: string,
  sendEnter: boolean = true
): Promise<void> {
  const execAsync = promisify(exec);

  // Escape single quotes in the keys
  const escapedKeys = keys.replace(/'/g, "'\\''");

  const command = sendEnter
    ? `tmux send-keys -t ${sessionName} '${escapedKeys}' Enter`
    : `tmux send-keys -t ${sessionName} '${escapedKeys}'`;

  await execAsync(command);
}

/**
 * Capture pane output from a tmux session
 *
 * @param sessionName - Target session name
 * @param lines - Number of lines to capture from history (default: 1000)
 * @returns Captured output as string
 *
 * @example
 * ```typescript
 * const output = await capturePane('my-session');
 * console.log(output);
 *
 * // Capture last 100 lines
 * const recent = await capturePane('my-session', 100);
 * ```
 */
export async function capturePane(
  sessionName: string,
  lines: number = 1000
): Promise<string> {
  const execAsync = promisify(exec);

  try {
    const { stdout } = await execAsync(
      `tmux capture-pane -t ${sessionName} -p -S -${lines}`
    );
    return stdout;
  } catch (error) {
    // Return empty string if capture fails (e.g., session doesn't exist)
    return '';
  }
}

/**
 * Kill a tmux session
 *
 * @param sessionName - Session name to kill
 *
 * @example
 * ```typescript
 * await killSession('my-session');
 * ```
 */
export async function killSession(sessionName: string): Promise<void> {
  const execAsync = promisify(exec);

  try {
    await execAsync(`tmux kill-session -t ${sessionName}`);
  } catch (error) {
    // Ignore errors (session might not exist)
  }
}

/**
 * Ensure a tmux session exists, creating it if necessary
 *
 * @param sessionName - Session name
 * @param cwd - Working directory for the session
 *
 * @example
 * ```typescript
 * // Will create session if it doesn't exist
 * await ensureSession('my-session', '/path/to/project');
 *
 * // Safe to call multiple times
 * await ensureSession('my-session', '/path/to/project');
 * ```
 */
export async function ensureSession(
  sessionName: string,
  cwd: string
): Promise<void> {
  const exists = await hasSession(sessionName);

  if (!exists) {
    await createSession(sessionName, cwd);
  }
}
