/**
 * CLI Common Type Definitions
 * Issue #96: npm install CLI support
 */

/**
 * Exit codes for CLI commands
 * NTH-4: DRY - centralized exit code definitions
 */
export enum ExitCode {
  SUCCESS = 0,
  DEPENDENCY_ERROR = 1,
  CONFIG_ERROR = 2,
  START_FAILED = 3,
  STOP_FAILED = 4,
  UNEXPECTED_ERROR = 99,
}

/**
 * Options for init command
 */
export interface InitOptions {
  /** Use default values (non-interactive) */
  defaults?: boolean;
  /** Overwrite existing configuration */
  force?: boolean;
}

/**
 * Options for start command
 * Issue #136: Added issue and autoPort for worktree support
 */
export interface StartOptions {
  /** Start in development mode */
  dev?: boolean;
  /** Run in background */
  daemon?: boolean;
  /** Override port number */
  port?: number;
  /** Issue number for worktree-specific server (Issue #136) */
  issue?: number;
  /** Automatically allocate an available port (Issue #136) */
  autoPort?: boolean;
  /** Override database path for worktree server (Issue #136) */
  dbPath?: string;
}

/**
 * Options for stop command
 * Issue #136: Added issue for worktree support
 */
export interface StopOptions {
  /** Force stop (SIGKILL) */
  force?: boolean;
  /** Issue number for worktree-specific server (Issue #136) */
  issue?: number;
}

/**
 * Options for status command
 * Issue #136: New interface for worktree support
 */
export interface StatusOptions {
  /** Issue number for worktree-specific status (Issue #136) */
  issue?: number;
  /** Show status for all running servers (Issue #136) */
  all?: boolean;
}

/**
 * Daemon process status
 */
export interface DaemonStatus {
  /** Whether the daemon is running */
  running: boolean;
  /** Process ID (if running) */
  pid?: number;
  /** Port number (if running) */
  port?: number;
  /** Uptime in seconds (if running) */
  uptime?: number;
  /** URL to access the server (if running) */
  url?: string;
}

/**
 * System dependency definition
 * SF-2: OCP - external configuration for extensibility
 */
export interface DependencyCheck {
  /** Display name */
  name: string;
  /** Command to check */
  command: string;
  /** Argument to get version */
  versionArg: string;
  /** Whether this dependency is required */
  required: boolean;
  /** Minimum version (optional) */
  minVersion?: string;
}

/**
 * Result of a single dependency check
 */
export interface DependencyStatus {
  /** Dependency name */
  name: string;
  /** Check status */
  status: 'ok' | 'missing' | 'version_mismatch';
  /** Detected version (if available) */
  version?: string;
}

/**
 * Result of preflight checks
 */
export interface PreflightResult {
  /** Whether all required dependencies are satisfied */
  success: boolean;
  /** Individual dependency results */
  results: DependencyStatus[];
}

/**
 * Environment configuration for CLI
 * Used by env-setup.ts for .env file generation
 */
export interface EnvConfig {
  CM_ROOT_DIR: string;
  CM_PORT: number;
  CM_BIND: string;
  CM_DB_PATH: string;
  CM_LOG_LEVEL: string;
  CM_LOG_FORMAT: string;
}

/**
 * Options for env file creation
 */
export interface EnvSetupOptions {
  /** Force overwrite existing file */
  force?: boolean;
  /** Path to .env file (defaults to .env in cwd) */
  envPath?: string;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Options for prompt function
 * Issue #119: Interactive init support
 */
export interface PromptOptions {
  /** Default value if user presses Enter */
  default?: string;
  /** Validation function - returns error message or true if valid */
  validate?: (input: string) => string | true;
}

/**
 * Options for confirm function
 * Issue #119: Interactive init support
 */
export interface ConfirmOptions {
  /** Default value if user presses Enter (true = Y, false = N) */
  default?: boolean;
}

/**
 * Extract error message from unknown error
 * Issue #125: DRY - centralized error message extraction
 *
 * @param error - Unknown error object
 * @returns Error message string
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
