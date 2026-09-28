/**
 * The agent-health report (Issue #2878).
 *
 * `scripts/agent-health/run.ts` starts each agent CLI once in a private tmux
 * server, drives a few fixed turns and writes what it saw into this shape. The
 * shape is the interface: the scheduled AI of #2879 reads only this file, and
 * the watchdog of #2880 reads only `completedAt`. Adding a field is fine;
 * renaming or removing one breaks both.
 */

/** The five agent CLIs the daily check covers, in report order. */
export const AGENT_HEALTH_TOOLS = [
  'claude',
  'codex',
  'antigravity',
  'opencode',
  'command-code',
] as const;

export type AgentHealthTool = (typeof AGENT_HEALTH_TOOLS)[number];

/** Every check, in the order a tool's checks appear in the report. */
export const AGENT_HEALTH_CHECK_IDS = [
  'version',
  'hook-correlation',
  'screen-idle',
  'screen-running',
  'screen-approval',
  'screen-quoted-dialog',
] as const;

export type AgentHealthCheckId = (typeof AGENT_HEALTH_CHECK_IDS)[number];

export type AgentHealthCheckStatus = 'pass' | 'fail' | 'skip';

export interface AgentHealthCheck {
  checkId: AgentHealthCheckId;
  status: AgentHealthCheckStatus;
  /** One line: what was expected and what happened. */
  summary: string;
  /** Failure evidence (pane tail, hook JSON). At most {@link MAX_EVIDENCE_CHARS}. */
  evidence?: string;
  skipReason?: string;
}

export interface AgentHealthToolResult {
  tool: AgentHealthTool;
  /** First line of `<cli> --version`, or null when it could not be read. */
  version: string | null;
  /** The version recorded by the previous run (state file), or null. */
  previousVersion: string | null;
  versionChanged: boolean;
  checks: AgentHealthCheck[];
}

/** One machine-singleton file the run had to touch, and whether it is back. */
export interface GlobalConfigRestoreEntry {
  path: string;
  restored: boolean;
  /**
   * `hook-config`: the tool's hook settings (`prepareLaunch` writes it). Not
   * restoring it is a script failure (exit 2).
   * `trust-state`: a file the CLI itself writes when a folder is trusted. It is
   * put back only when the run's own entry is the sole difference.
   */
  kind?: 'hook-config' | 'trust-state';
  /** Why `restored` is false. */
  detail?: string;
}

/** How the production server log was watched for hooks that went astray. */
export interface ProductionLogWatch {
  /** The log that was read, or null when none was found. */
  path: string | null;
  /** Line count when the run started / ended (null when there is no log). */
  linesAtStart: number | null;
  linesAtEnd: number | null;
  /** Lines containing the probe worktree id that appeared during the run. */
  probeLines: number;
}

export interface AgentHealthReport {
  schemaVersion: 1;
  startedAt: string;
  completedAt: string;
  host: { commandmateCommit: string; node: string };
  tools: AgentHealthToolResult[];
  safety: {
    globalConfigRestored: GlobalConfigRestoreEntry[];
    tmuxSocket: string;
    productionLog?: ProductionLogWatch;
  };
  /** Present only when the script itself went wrong (exit 2). */
  scriptErrors?: string[];
}

/** `~/.commandmate/agent-health/state.json`. */
export interface AgentHealthState {
  versions: Partial<Record<AgentHealthTool, string>>;
}

/** The fixed correlation keys every probe session is launched with. */
export const PROBE_WORKTREE_ID = 'agent-health-probe';

export function probeInstanceId(tool: AgentHealthTool): string {
  return `${tool}-probe`;
}

/** Evidence is cut to this many characters (keeps the report readable by an AI). */
export const MAX_EVIDENCE_CHARS = 4000;

/** Pane evidence keeps this many trailing lines. */
export const EVIDENCE_PANE_LINES = 40;

export function isAgentHealthTool(value: string): value is AgentHealthTool {
  return (AGENT_HEALTH_TOOLS as readonly string[]).includes(value);
}

export function isAgentHealthCheckId(value: string): value is AgentHealthCheckId {
  return (AGENT_HEALTH_CHECK_IDS as readonly string[]).includes(value);
}
