/**
 * tmux session management
 * Provides functions to manage tmux sessions for Claude CLI integration
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Default timeout for tmux commands (5 seconds)
 */
const DEFAULT_TIMEOUT = 5000;

/**
 * tmux session information
 */
export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
}

/**
 * Options for creating a tmux session
 */
export interface CreateSessionOptions {
  sessionName: string;
  workingDirectory: string;
  historyLimit?: number;  // scrollback バッファサイズ（デフォルト: 50000）
}

/**
 * Options for capturing pane output
 */
export interface CapturePaneOptions {
  startLine?: number;  // -S オプション（デフォルト: -10000）
  endLine?: number;    // -E オプション（デフォルト: -）
}

/**
 * Check if tmux is installed and available
 */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    await execAsync('tmux -V', { timeout: DEFAULT_TIMEOUT });
    return true;
  } catch (error) {
    return false;
  }
}

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
  try {
    await execAsync(`tmux has-session -t "${sessionName}"`, { timeout: DEFAULT_TIMEOUT });
    return true;
  } catch (error) {
    // tmux has-session returns non-zero exit code if session doesn't exist
    return false;
  }
}

/**
 * List all tmux sessions
 *
 * @returns Array of tmux session information
 *
 * @example
 * ```typescript
 * const sessions = await listSessions();
 * sessions.forEach(s => console.log(`${s.name}: ${s.windows} windows`));
 * ```
 */
export async function listSessions(): Promise<TmuxSession[]> {
  try {
    const { stdout } = await execAsync(
      'tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}"',
      { timeout: DEFAULT_TIMEOUT }
    );

    if (!stdout || stdout.trim() === '') {
      return [];
    }

    return stdout
      .trim()
      .split('\n')
      .map(line => {
        const [name, windows, attached] = line.split('|');
        return {
          name,
          windows: parseInt(windows, 10) || 0,
          attached: attached === '1',
        };
      });
  } catch (error) {
    // No sessions exist or tmux not running
    return [];
  }
}

/**
 * Create a new tmux session (legacy signature)
 */
export async function createSession(
  sessionName: string,
  cwd: string
): Promise<void>;

/**
 * Create a new tmux session with options
 */
export async function createSession(
  options: CreateSessionOptions
): Promise<void>;

/**
 * Create a new tmux session
 *
 * @param sessionNameOrOptions - Session name or options object
 * @param cwd - Working directory (when using legacy signature)
 *
 * @throws {Error} If session creation fails
 *
 * @example
 * ```typescript
 * // Legacy usage
 * await createSession('my-session', '/path/to/project');
 *
 * // New usage with options
 * await createSession({
 *   sessionName: 'my-session',
 *   workingDirectory: '/path/to/project',
 *   historyLimit: 50000,
 * });
 * ```
 */
export async function createSession(
  sessionNameOrOptions: string | CreateSessionOptions,
  cwd?: string
): Promise<void> {
  let sessionName: string;
  let workingDirectory: string;
  let historyLimit: number;

  if (typeof sessionNameOrOptions === 'string') {
    // Legacy signature
    sessionName = sessionNameOrOptions;
    workingDirectory = cwd!;
    historyLimit = 50000;
  } else {
    // New signature with options
    sessionName = sessionNameOrOptions.sessionName;
    workingDirectory = sessionNameOrOptions.workingDirectory;
    historyLimit = sessionNameOrOptions.historyLimit || 50000;
  }

  try {
    // Create session
    await execAsync(
      `tmux new-session -d -s "${sessionName}" -c "${workingDirectory}"`,
      { timeout: DEFAULT_TIMEOUT }
    );

    // Set history limit
    await execAsync(
      `tmux set-option -t "${sessionName}" history-limit ${historyLimit}`,
      { timeout: DEFAULT_TIMEOUT }
    );
  } catch (error: any) {
    throw new Error(`Failed to create tmux session: ${error.message}`);
  }
}

/**
 * Send keys to a tmux session
 *
 * @param sessionName - Target session name
 * @param keys - Keys to send (command text)
 * @param sendEnter - Whether to send Enter key after the command (default: true)
 *
 * @throws {Error} If session doesn't exist or command fails
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
  // Escape single quotes in the keys
  const escapedKeys = keys.replace(/'/g, "'\\''");

  const command = sendEnter
    ? `tmux send-keys -t "${sessionName}" '${escapedKeys}' C-m`
    : `tmux send-keys -t "${sessionName}" '${escapedKeys}'`;

  try {
    await execAsync(command, { timeout: DEFAULT_TIMEOUT });
  } catch (error: any) {
    throw new Error(`Failed to send keys to tmux session: ${error.message}`);
  }
}

/**
 * Capture pane output from a tmux session (legacy signature)
 */
export async function capturePane(
  sessionName: string,
  lines?: number
): Promise<string>;

/**
 * Capture pane output from a tmux session with options
 */
export async function capturePane(
  sessionName: string,
  options?: CapturePaneOptions
): Promise<string>;

/**
 * Capture pane output from a tmux session
 *
 * @param sessionName - Target session name
 * @param linesOrOptions - Number of lines or options object
 * @returns Captured output as string
 *
 * @example
 * ```typescript
 * // Legacy usage
 * const output = await capturePane('my-session');
 * const recent = await capturePane('my-session', 100);
 *
 * // New usage with options
 * const full = await capturePane('my-session', {
 *   startLine: -10000,
 *   endLine: -1,
 * });
 * ```
 */
export async function capturePane(
  sessionName: string,
  linesOrOptions?: number | CapturePaneOptions
): Promise<string> {
  let startLine: number;
  let endLine: number | string;

  if (typeof linesOrOptions === 'number') {
    // Legacy signature
    startLine = -linesOrOptions;
    endLine = '-';
  } else if (linesOrOptions) {
    // New signature with options
    startLine = linesOrOptions.startLine ?? -10000;
    endLine = linesOrOptions.endLine ?? '-';
  } else {
    // Default
    startLine = -1000;
    endLine = '-';
  }

  try {
    const { stdout } = await execAsync(
      `tmux capture-pane -t "${sessionName}" -p -S ${startLine} -E ${endLine}`,
      {
        timeout: DEFAULT_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024  // 10MB buffer for large Claude outputs
      }
    );
    return stdout;
  } catch (error: any) {
    throw new Error(`Failed to capture pane: ${error.message}`);
  }
}

/**
 * Kill a tmux session
 *
 * @param sessionName - Session name to kill
 * @returns True if session was killed, false if session didn't exist
 *
 * @example
 * ```typescript
 * const killed = await killSession('my-session');
 * if (killed) {
 *   console.log('Session terminated');
 * }
 * ```
 */
export async function killSession(sessionName: string): Promise<boolean> {
  try {
    await execAsync(`tmux kill-session -t "${sessionName}"`, {
      timeout: DEFAULT_TIMEOUT,
    });
    return true;
  } catch (error: any) {
    // Session doesn't exist or already killed
    if (
      error.message?.includes('no server running') ||
      error.message?.includes("can't find session")
    ) {
      return false;
    }
    // Re-throw unexpected errors
    throw new Error(`Failed to kill tmux session: ${error.message}`);
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
