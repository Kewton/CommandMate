/**
 * tmux session management
 * Provides functions to manage tmux sessions for Claude CLI integration
 */

import { getErrorMessage, DANGEROUS_CONTROL_CHARS } from './utils';
import { validateSessionName } from './cli-tools/validation';
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
  } catch {
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
  validateSessionName(sessionName);
  try {
    await execAsync(`tmux has-session -t "${sessionName}"`, { timeout: DEFAULT_TIMEOUT });
    return true;
  } catch {
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
  } catch {
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

  validateSessionName(sessionName);

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
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error);
    throw new Error(`Failed to create tmux session: ${errorMessage}`);
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
  validateSessionName(sessionName);
  // Escape single quotes in the keys
  const escapedKeys = keys.replace(/'/g, "'\\''");

  const command = sendEnter
    ? `tmux send-keys -t "${sessionName}" '${escapedKeys}' C-m`
    : `tmux send-keys -t "${sessionName}" '${escapedKeys}'`;

  try {
    await execAsync(command, { timeout: DEFAULT_TIMEOUT });
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error);
    throw new Error(`Failed to send keys to tmux session: ${errorMessage}`);
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

  validateSessionName(sessionName);

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
      `tmux capture-pane -t "${sessionName}" -p -e -S ${startLine} -E ${endLine}`,
      {
        timeout: DEFAULT_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024  // 10MB buffer for large Claude outputs
      }
    );
    return stdout;
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error);
    throw new Error(`Failed to capture pane: ${errorMessage}`);
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
  validateSessionName(sessionName);
  try {
    await execAsync(`tmux kill-session -t "${sessionName}"`, {
      timeout: DEFAULT_TIMEOUT,
    });
    return true;
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error);
    // Session doesn't exist or already killed
    if (
      errorMessage?.includes('no server running') ||
      errorMessage?.includes("can't find session")
    ) {
      return false;
    }
    // Re-throw unexpected errors
    throw new Error(`Failed to kill tmux session: ${errorMessage}`);
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

/**
 * Special key type for tmux send-keys
 */
export type SpecialKey = 'Escape' | 'C-c' | 'C-d' | 'C-m' | 'Down' | 'Enter' | 'Up';

/**
 * Send a special key to a tmux session
 *
 * @param sessionName - Target session name
 * @param key - Special key to send (Escape, C-c, C-d)
 *
 * @throws {Error} If session doesn't exist or command fails
 *
 * @example
 * ```typescript
 * // Send Escape key to interrupt CLI processing
 * await sendSpecialKey('my-session', 'Escape');
 *
 * // Send Ctrl+C for SIGINT
 * await sendSpecialKey('my-session', 'C-c');
 * ```
 */
export async function sendSpecialKey(
  sessionName: string,
  key: SpecialKey
): Promise<void> {
  validateSessionName(sessionName);
  try {
    await execAsync(
      `tmux send-keys -t "${sessionName}" ${key}`,
      { timeout: DEFAULT_TIMEOUT }
    );
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error);
    throw new Error(`Failed to send special key: ${errorMessage}`);
  }
}

/**
 * Send keys to a tmux session using spawn (no shell interpretation)
 * [Issue #163] Task-PRE-001: Spawn-based tmux send-keys for terminal-websocket
 *
 * Unlike sendKeys() which uses exec() (shell interpretation),
 * this function uses spawn() for direct process invocation,
 * preventing shell metacharacter injection.
 *
 * @param sessionName - Target session name
 * @param keys - Keys to send
 * @throws {Error} If session name is invalid or send fails
 */
export async function sendKeysSpawn(
  sessionName: string,
  keys: string
): Promise<void> {
  validateSessionName(sessionName);

  // Size limit (4KB for WebSocket terminal input)
  if (keys.length > 4096) {
    throw new Error('Input too large for sendKeysSpawn (max 4096 bytes)');
  }

  // Reject null bytes
  if (keys.includes('\0')) {
    throw new Error('Input contains null byte');
  }

  const { spawn } = await import('child_process');

  return new Promise<void>((resolve, reject) => {
    const tmuxSend = spawn('tmux', ['send-keys', '-t', sessionName, keys]);

    tmuxSend.on('error', (error) => {
      reject(new Error(`Failed to send keys via spawn: ${getErrorMessage(error)}`));
    });

    tmuxSend.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tmux send-keys exited with code ${code}`));
      }
    });
  });
}

/**
 * Send a message followed by Enter key, with configurable delay
 * [Issue #163] Task-PRE-003: Unified message send pattern
 *
 * Encapsulates the "send content -> wait -> send Enter" protocol.
 * Prompt verification logic is NOT included (SRP - handled by callers like sendMessageToClaude).
 *
 * For multiline messages (containing \n), uses spawn-based `tmux send-keys -l`
 * which sends content literally without shell interpretation, preventing
 * "[Pasted text]" display in Claude CLI's ink TextInput.
 * [Issue #163] Phase 2: Multiline message support
 *
 * @param sessionName - Target session name
 * @param message - Message to send
 * @param delay - Delay in ms between message and Enter (default: 100)
 * @throws {Error} If session name is invalid, message exceeds limits, or send fails
 */
export async function sendMessageWithEnter(
  sessionName: string,
  message: string,
  delay: number = 100
): Promise<void> {
  validateSessionName(sessionName);

  // Size limits: 100KB / 10,000 lines
  const MAX_MESSAGE_SIZE = 100 * 1024;
  const MAX_LINE_COUNT = 10000;

  if (Buffer.byteLength(message, 'utf-8') > MAX_MESSAGE_SIZE) {
    throw new Error(`Message exceeds maximum size of ${MAX_MESSAGE_SIZE} bytes`);
  }

  if (message.includes('\0')) {
    throw new Error('Message contains null byte');
  }

  // Reject dangerous control characters (allow \t, \n, \r)
  if (DANGEROUS_CONTROL_CHARS.test(message)) {
    throw new Error('Message contains prohibited control characters');
  }

  const lineCount = message.split('\n').length;
  if (lineCount > MAX_LINE_COUNT) {
    throw new Error(`Message exceeds maximum line count of ${MAX_LINE_COUNT}`);
  }

  // Multiline messages: use spawn-based tmux send-keys -l for literal content
  // Single-line messages: use existing sendKeys() (backward compatible)
  const isMultiline = message.includes('\n');

  if (isMultiline) {
    await sendMultilineContent(sessionName, message);
  } else {
    // Send message content (without Enter)
    await sendKeys(sessionName, message, false);
  }

  // Wait for input to be processed
  if (delay > 0) {
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  // Send Enter key
  await sendKeys(sessionName, '', true);
}

/**
 * Send multiline content to a tmux session using spawn-based send-keys -l
 * [Issue #163] Phase 2: Literal multiline send
 *
 * Uses spawn() instead of exec() to avoid shell interpretation.
 * The -l flag sends characters literally, so newlines become soft newlines
 * (new line within input) rather than Enter (submit).
 *
 * @param sessionName - Target session name (must be pre-validated)
 * @param content - Multiline content to send
 * @throws {Error} If spawn fails or tmux exits with non-zero code
 */
async function sendMultilineContent(
  sessionName: string,
  content: string
): Promise<void> {
  const { spawn } = await import('child_process');

  return new Promise<void>((resolve, reject) => {
    const tmuxSend = spawn('tmux', ['send-keys', '-l', '-t', sessionName, content]);

    tmuxSend.on('error', (error) => {
      reject(new Error(`Failed to send multiline message: ${getErrorMessage(error)}`));
    });

    tmuxSend.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tmux send-keys -l exited with code ${code}`));
      }
    });
  });
}
