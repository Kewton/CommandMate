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
  /**
   * ISO timestamp the daemon was launched at, straight from the state file (Issue #2113).
   *
   * `status` uses it to date-stamp records the SERVER leaves behind — the PID cannot do
   * that job: the state file records the PID of the `npm run start` wrapper, not of the
   * `node dist/server/server.js` child that actually binds the port (measured 2026-08-27:
   * state file 58882 = `npm run start`, listener 58937 = its child).
   */
  startedAt?: string;
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
  /**
   * Issue #1517: extra absolute directories (comma-separated) the web UI may
   * browse and register repositories from. CM_ROOT_DIR is always allowed, so
   * this stays undefined unless the operator adds locations outside it.
   */
  CM_BROWSE_ROOTS?: string;
  CM_PORT: number;
  CM_BIND: string;
  CM_DB_PATH: string;
  CM_LOG_LEVEL: string;
  CM_LOG_FORMAT: string;
  /**
   * Web Push application-server key pair and contact (Issue #2123).
   *
   * Written as a set or not at all: a public key without its private half
   * disables push exactly as no keys do, so a half-written trio would only make
   * `commandmate status` report a "partial" configuration nobody asked for.
   * `CM_VAPID_SUBJECT` is emitted alongside them so the operator can see and
   * edit the `sub` claim without having to learn that it exists (Issue #2124).
   */
  CM_VAPID_PUBLIC_KEY?: string;
  CM_VAPID_PRIVATE_KEY?: string;
  CM_VAPID_SUBJECT?: string;
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
  /**
   * `--fail-on-upstream-fault`: the agent came back to its composer with an
   * upstream (model API) failure on the frame (Issue #1839).
   *
   * Its own code rather than SUCCESS because the two mean opposite things to a
   * caller: SUCCESS says "the turn ran, judge the result", this says "the turn
   * never ran, send it again". Measured on 2026-08-20 against a stub upstream
   * answering 529, Claude 2.1.236 returns to the composer ~3 s after the send
   * having executed nothing, and `wait --verify` reports 21 (no work evidence) —
   * which reads as "the agent worked and produced nothing" and is why #1834 saw
   * twelve retries burned on a session that only needed to be re-sent later.
   *
   * Its own code rather than riding PROMPT_DETECTED (10) because nothing is
   * waiting to be answered: `respond` has nothing to send here.
   *
   * 11 is deliberately shared with {@link SkillExitCode.BLOCKED}: the two
   * commands' codes are separate namespaces, and 11 is the first value free of
   * PROMPT_DETECTED.
   */
  UPSTREAM_FAULT: 11,
  TIMEOUT: 124,
} as const;
export type WaitExitCode = typeof WaitExitCode[keyof typeof WaitExitCode];

/**
 * verify command exit codes (Issue #1544).
 *
 * Follows the WaitExitCode precedent: infrastructure failures keep using
 * {@link ExitCode}, while these name verdicts a caller must be able to branch
 * on. `error` and `cancelled` runs produce no verdict at all and therefore map
 * to ExitCode.UNEXPECTED_ERROR rather than to VERIFY_FAILED — "we could not
 * judge" must not read as "we judged it and it failed".
 */
export const VerifyExitCode = {
  SUCCESS: 0,
  /** At least one gate failed, timed out, or errored. */
  VERIFY_FAILED: 20,
  /** The work-evidence gate failed: no commits and no uncommitted changes. */
  NOT_STARTED: 21,
  TIMEOUT: 124,
} as const;
export type VerifyExitCode = typeof VerifyExitCode[keyof typeof VerifyExitCode];

/**
 * Non-zero exit codes ordered by which one wins when several worktrees produce
 * different verdicts in one `wait` invocation (Issue #1544). Codes absent from
 * this list (infrastructure failures such as 1/2/99) rank after every listed
 * code, and among themselves the first one observed wins.
 */
export const WAIT_EXIT_CODE_PRIORITY: readonly number[] = [
  WaitExitCode.PROMPT_DETECTED,
  // Issue #1839: below PROMPT_DETECTED because a prompt is actionable right now
  // and an upstream fault is not, and above the verify verdicts because a turn
  // that never ran makes those verdicts meaningless — reporting VERIFY_FAILED
  // for a worktree whose agent never executed is the misattribution #1839 exists
  // to end.
  WaitExitCode.UPSTREAM_FAULT,
  VerifyExitCode.VERIFY_FAILED,
  VerifyExitCode.NOT_STARTED,
  WaitExitCode.TIMEOUT,
];

/** verify command options [Issue #1544] */
export interface VerifyOptions {
  /** Agent instance the run is attributed to. */
  instance?: string;
  /** Comma-separated gate ids; omitted means work-evidence plus every declared gate. */
  gates?: string;
  json?: boolean;
  /** Seconds to wait for the run to reach a terminal status before exiting 124. */
  timeout?: number;
  token?: string;
}

/** verify history subcommand options [Issue #1593] */
export interface VerifyHistoryOptions {
  /** Restrict to one worktree; omitted means every worktree. */
  worktree?: string;
  /** Look back this many days; omitted means no lower bound. */
  days?: number;
  limit?: number;
  json?: boolean;
  token?: string;
}

/** verify show subcommand options [Issue #1593] */
export interface VerifyShowOptions {
  json?: boolean;
  token?: string;
}

/** verify init subcommand options [Issue #2061] */
export interface VerifyInitOptions {
  /** Repository to draft for; defaults to the current directory. */
  cwd?: string;
  /** Print the proposal on stdout and write nothing. */
  dryRun?: boolean;
  json?: boolean;
}

/** ls command options [Issue #518] */
export interface LsOptions {
  json?: boolean;
  quiet?: boolean;
  branch?: string;
  /** Issue #1005: filter by worktree id prefix (front-match, AND-combined with branch) */
  id?: string;
  token?: string;
}

/** sync command options [Issue #1680] */
export interface SyncOptions {
  json?: boolean;
  token?: string;
}

/**
 * remote command options [Issue #1937 R9]
 *
 * No `token` field, and no Auto-Yes field, in either case deliberately:
 * `remote` mints its own token (§5.1) and offers no way to turn Auto-Yes on
 * (§5.5). See the header of `src/cli/commands/remote.ts`.
 */
export interface RemoteOptions {
  /** Force a provider: `tailscale` or `cloudflare` */
  provider?: string;
  /** Remote session TTL, 1h-30d (default 8h) */
  expires?: string;
  /** Pairing code TTL, 1m-24h (default 10m) */
  pairingExpires?: string;
  /** Port for the server that gets exposed; delegated to start */
  port?: number;
  /** Approve creating a public tunnel without prompting */
  yes?: boolean;
  json?: boolean;
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
  /**
   * Issue #1545: path to an execution contract, relative to the worktree root
   * (e.g. `.commandmate/tasks/my-task.yaml`). The contract's goal replaces the
   * message argument, so the two are mutually exclusive.
   */
  contract?: string;
  /**
   * Issue #1737: send even if only the agent's structured events report an open
   * dialog. The way out of a hook-reported dialog nothing released; a prompt the
   * terminal scraper can see is still refused.
   */
  ignoreStructuredPrompt?: boolean;
}

/** task list command options [Issue #1545] */
export interface TaskListOptions {
  json?: boolean;
  /** Maximum tasks to list, newest first. */
  limit?: number;
  token?: string;
}

/** task show command options [Issue #1545] */
export interface TaskShowOptions {
  json?: boolean;
  token?: string;
}

/** wait command options [Issue #518] */
export interface WaitOptions {
  timeout?: number;
  onPrompt?: 'agent' | 'human';
  stallTimeout?: number;
  token?: string;
  /** Issue #868: agent instance ID or alias (defaults to the agent's primary instance) */
  instance?: string;
  /**
   * Issue #1544: after completion is detected, run every verification gate and
   * decide the exit code from the verdict instead of from "the agent stopped".
   */
  verify?: boolean;
  /** Issue #1544: run only the work-evidence gate. Subsumed by {@link verify}. */
  requireWork?: boolean;
  /**
   * Issue #1839: when the agent returns to its composer with an upstream fault
   * signature on the frame, exit {@link WaitExitCode.UPSTREAM_FAULT} instead of
   * SUCCESS.
   *
   * Opt-in because `wait`'s exit codes are a published branch table — the skills
   * dispatcher switches on them — and a session that hits a transient 529 mid
   * turn and recovers must keep exiting 0 for every caller that never asked for
   * this.
   */
  failOnUpstreamFault?: boolean;
}

/** respond command options [Issue #518] */
export interface RespondOptions {
  agent?: string;
  token?: string;
  /** Issue #868: agent instance ID or alias (defaults to the agent's primary instance) */
  instance?: string;
  /** Issue #1681: select the prompt's default option instead of passing an answer */
  default?: boolean;
}

/** capture command options [Issue #518] */
export interface CaptureOptions {
  json?: boolean;
  agent?: string;
  token?: string;
  /** Issue #868: agent instance ID or alias (defaults to the agent's primary instance) */
  instance?: string;
  /**
   * Issue #1623: read the raw tmux pane instead of the accumulated response.
   * `capture` without this answers "what is the agent saying right now" and is
   * empty while idle; `--pane` answers "what is on screen", which is what a
   * human wants to read.
   */
  pane?: boolean;
  /**
   * Issue #1623: with `--pane`, keep only the last N lines of the SQUEEZED
   * transcript. Counting after the squeeze is what makes the number useful — on
   * a 1000-row canvas whose transcript ends at row 254, tailing the raw frame
   * would return blank padding.
   */
  tail?: string;
  /** Issue #1623: with `--pane`, print the frame verbatim (no blank-row squeeze). */
  raw?: boolean;
  /**
   * Issue #1685: list the prompt audit trail (question / options / answer /
   * answeredBy) instead of terminal output. Reads resolved prompts from chat
   * history, so it works after Auto-Yes already cleared the prompt from screen.
   */
  prompts?: boolean;
  /** Issue #1685: with `--prompts`, number of most recent prompts to list. */
  limit?: string;
}

/** interrupt command options [Issue #2101] */
export interface InterruptOptions {
  json?: boolean;
  /**
   * Issue #2101: agent instance ID or alias. Omitted, EVERY running session of
   * the worktree is interrupted — that is the route's own behaviour and the
   * reason the flag is worth reaching for on a multi-instance worktree.
   */
  instance?: string;
  token?: string;
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

/**
 * skill command exit codes [Issue #1237]
 *
 * Follows the WaitExitCode precedent: infrastructure and input failures keep
 * using {@link ExitCode}, while these name outcomes a caller must be able to
 * distinguish without parsing stderr. Values start at 11 so they cannot collide
 * with WaitExitCode.PROMPT_DETECTED.
 */
export const SkillExitCode = {
  SUCCESS: 0,
  /**
   * The target worktree refused the operation: an unmanaged or locally modified
   * file, an occupied destination, a concurrent operation, or a plan whose world
   * moved. Distinct from a network/API failure (ExitCode.DEPENDENCY_ERROR) so an
   * automation can retry the latter but must not retry the former blindly.
   */
  BLOCKED: 11,
  /** The write was never confirmed: non-TTY without --yes, missing/mismatched --ack-risk, or a declined prompt. */
  CONFIRMATION_REQUIRED: 12,
  /** The payload reached the worktree but the operation did not finish cleanly (`committed_reconciling`). */
  COMMITTED_RECONCILING: 13,
} as const;
export type SkillExitCode = typeof SkillExitCode[keyof typeof SkillExitCode];

/**
 * interrupt command exit codes (Issue #2101).
 *
 * Follows the WaitExitCode / VerifyExitCode / SkillExitCode precedent:
 * infrastructure and input failures keep using {@link ExitCode}, and only the
 * one outcome a caller has to branch on gets a code of its own.
 *
 * 30 rather than a value already spent by another command. The other three
 * namespaces overlap on purpose — 11 is both {@link WaitExitCode.UPSTREAM_FAULT}
 * and {@link SkillExitCode.BLOCKED} — and that is tolerable there because no
 * script pipes a `wait` verdict into a `skill` handler. `interrupt` is
 * different: the orchestration loop that runs it is the same loop that reads
 * `wait`'s and `verify`'s codes out of one `$?`, so a shared value would make
 * "nothing was generating" indistinguishable from "a gate failed" (20) or "the
 * agent never started" (21) at exactly the point where those three lead to
 * opposite recoveries.
 */
export const InterruptExitCode = {
  SUCCESS: 0,
  /**
   * The worktree exists but no session was running, so nothing was interrupted.
   *
   * Non-zero because the caller asked for a turn to be stopped and no turn was
   * stopped — but deliberately NOT {@link ExitCode.UNEXPECTED_ERROR}, which is
   * where the generic 404 mapping would have put it alongside "that worktree
   * does not exist". Those two need different recoveries: this one means "you
   * are already past the state you wanted", the other means "your id is wrong".
   */
  NO_ACTIVE_SESSIONS: 30,
} as const;
export type InterruptExitCode = typeof InterruptExitCode[keyof typeof InterruptExitCode];

/** Shared by every skill subcommand [Issue #1237] */
export interface SkillCommonOptions {
  json?: boolean;
  token?: string;
}

/** skill list options [Issue #1237] */
export interface SkillListOptions extends SkillCommonOptions {
  prerelease?: boolean;
}

/** skill info options [Issue #1237] */
export interface SkillInfoOptions extends SkillListOptions {
  version?: string;
}

/** skill plan options [Issue #1237] */
export interface SkillPlanOptions extends SkillListOptions {
  worktree?: string;
  version?: string;
}

/** skill update-plan options [Issue #1243] */
export interface SkillUpdatePlanOptions extends SkillPlanOptions {
  /** Range every candidate must satisfy, in the Skill version-range grammar. */
  range?: string;
}

/** skill update (apply) options [Issue #1244] */
export interface SkillUpdateOptions extends SkillUpdatePlanOptions {
  /** Build the plan and stop; never writes. */
  dryRun?: boolean;
  /** Skip the interactive confirmation. Required to write from a non-TTY. */
  yes?: boolean;
  /** Explicit `<skill-id>@<version>` acknowledgement, demanded on top of --yes for high risk. */
  ackRisk?: string;
  /** Separate acknowledgement demanded when the update raises effective risk. */
  ackRiskIncrease?: boolean;
}

/** skill install options [Issue #1237] */
export interface SkillInstallOptions extends SkillPlanOptions {
  /** Build the plan and stop; never writes. */
  dryRun?: boolean;
  /** Skip the interactive confirmation. Required to write from a non-TTY. */
  yes?: boolean;
  /** Explicit `<skill-id>@<version>` acknowledgement, demanded on top of --yes for high risk. */
  ackRisk?: string;
  /** Git side effects to run after the install (Issue #1247). Absent means none. */
  git?: string;
  /** Push the commit to the remote. Only meaningful with --git. */
  push?: boolean;
  /** Open a draft PR for the pushed branch. Implies --push. */
  pr?: boolean;
}

/** skill uninstall options [Issue #1237] */
export interface SkillUninstallOptions extends SkillCommonOptions {
  worktree?: string;
  dryRun?: boolean;
  yes?: boolean;
}

/** skill status options [Issue #1237] */
export interface SkillStatusOptions extends SkillCommonOptions {
  worktree?: string;
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

/** report metrics options [Issue #1551] */
export interface ReportMetricsOptions {
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
