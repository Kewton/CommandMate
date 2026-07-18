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
  /** Update failed (npm install / version verification / registry query) - Issue #1194 (D-1) */
  UPDATE_FAILED = 5,
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
 * Issue #331: Added auth, authExpire, https, cert, key, allowHttp for token auth and HTTPS
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
  /** Enable token authentication (Issue #331) */
  auth?: boolean;
  /** Token expiration duration (e.g., "24h", "7d") (Issue #331) */
  authExpire?: string;
  /** Enable HTTPS (Issue #331) */
  https?: boolean;
  /** Path to TLS certificate file (Issue #331) */
  cert?: string;
  /** Path to TLS private key file (Issue #331) */
  key?: string;
  /** Suppress HTTPS warning when using --auth without certificates (Issue #331) */
  allowHttp?: boolean;
  /** Issue #332: Allowed IP addresses/CIDR ranges (comma-separated) */
  allowedIps?: string;
  /** Issue #332: Trust X-Forwarded-For header from reverse proxy */
  trustProxy?: boolean;
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
 * Options for update command
 * Issue #1194: commandmate update
 */
export interface UpdateOptions {
  /** Only query the registry and report versions (no stop / install / start) */
  check?: boolean;
  /** Skip the confirmation prompt (required for non-interactive execution, D-2) */
  yes?: boolean;
  /**
   * Hidden flag (Issue #1395): under npx, stop the current daemon and relaunch it
   * from a freshly-fetched `npx commandmate@latest` cache instead of the no-op
   * guidance. Set only by the GUI update route; the bare user-facing
   * `commandmate update` under npx stays a no-op (§6).
   */
  relaunchNpx?: boolean;
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
  /** Package version the running daemon was started with (Issue #1354) */
  version?: string;
  /** Protocol the running server speaks (Issue #1355) */
  protocol?: 'http' | 'https';
  /** Whether the running server has token authentication enabled (Issue #1355) */
  auth?: boolean;
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
 * Wait command exit codes
 * Issue #518: [DR2-01] ERROR: 1 removed (conflicts with ExitCode.DEPENDENCY_ERROR).
 * Infrastructure errors use ExitCode; wait-specific results use WaitExitCode.
 */
export const WaitExitCode = {
  SUCCESS: 0,
  PROMPT_DETECTED: 10,
  TIMEOUT: 124,
} as const;
export type WaitExitCode = typeof WaitExitCode[keyof typeof WaitExitCode];

/** ls command options [Issue #518] */
export interface LsOptions {
  json?: boolean;
  quiet?: boolean;
  branch?: string;
  /** Issue #1005: filter by worktree id prefix (front-match, AND-combined with branch) */
  id?: string;
  token?: string;
}

/** send command options [Issue #518, #576] */
export interface SendOptions {
  agent?: string;
  autoYes?: boolean;
  duration?: string;
  stopPattern?: string;
  token?: string;
  /** Issue #576: AI model name for Copilot agent */
  model?: string;
  /** Issue #868: agent instance ID or alias (defaults to the agent's primary instance) */
  instance?: string;
  /** Issue #1000: register the ad-hoc --instance session into the roster after sending */
  register?: boolean;
}

/** wait command options [Issue #518] */
export interface WaitOptions {
  timeout?: number;
  onPrompt?: 'agent' | 'human';
  stallTimeout?: number;
  token?: string;
  /** Issue #868: agent instance ID or alias (defaults to the agent's primary instance) */
  instance?: string;
}

/** respond command options [Issue #518] */
export interface RespondOptions {
  agent?: string;
  token?: string;
  /** Issue #868: agent instance ID or alias (defaults to the agent's primary instance) */
  instance?: string;
}

/** capture command options [Issue #518] */
export interface CaptureOptions {
  json?: boolean;
  agent?: string;
  token?: string;
  /** Issue #868: agent instance ID or alias (defaults to the agent's primary instance) */
  instance?: string;
}

/** auto-yes command options [Issue #518] */
export interface AutoYesOptions {
  enable?: boolean;
  disable?: boolean;
  duration?: string;
  stopPattern?: string;
  agent?: string;
  /** Issue #896: agent instance ID (defaults to the agent's primary instance) */
  instance?: string;
  token?: string;
}

/** instances command options [Issue #1000] */
export interface InstancesOptions {
  json?: boolean;
  /** add action: CLI tool backing the new instance */
  agent?: string;
  /** add/alias actions: display alias */
  alias?: string;
  /** add action: explicit instance ID (default: auto-generated, e.g. claude-2) */
  id?: string;
  /** remove action: also kill the running session */
  kill?: boolean;
  token?: string;
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
 * Options for issue create subcommand
 * Issue #264: gh CLI integration
 * [MF-001 YAGNI] IssueOptions interface is NOT defined.
 * Only IssueCreateOptions and DocsOptions are added.
 */
export interface IssueCreateOptions {
  bug?: boolean;
  feature?: boolean;
  question?: boolean;
  title?: string;
  body?: string;
  labels?: string;
}

/**
 * Options for docs command
 * Issue #264: Documentation retrieval
 */
export interface DocsOptions {
  section?: string;
  search?: string;
  all?: boolean;
}

/** report command options [Issue #636] */
export interface ReportGenerateOptions {
  date?: string;
  tool?: string;
  model?: string;
  template?: string;
  instruction?: string;
  token?: string;
}

/** report show options [Issue #636] */
export interface ReportShowOptions {
  date?: string;
  json?: boolean;
  token?: string;
}

/** report list options [Issue #636] */
export interface ReportListOptions {
  days?: number;
  json?: boolean;
  token?: string;
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
