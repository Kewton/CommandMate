/**
 * The agent-health report (Issue #2878).
 *
 * `scripts/agent-health/run.ts` starts each agent CLI once in a private tmux
 * server, drives a few fixed turns and writes what it saw into this shape. The
 * shape is the interface: the scheduled AI of #2879 reads only this file, and
 * the watchdog of #2880 reads only `completedAt`. Adding a field is fine;
 * renaming or removing one breaks both.
 */

/** The six agent CLIs the daily check launches and drives, in report order. */
export const AGENT_HEALTH_TOOLS = [
  'claude',
  'codex',
  'antigravity',
  'opencode',
  'command-code',
  'opencode-v2',
] as const;

export type AgentHealthTool = (typeof AGENT_HEALTH_TOOLS)[number];

/**
 * CLIs CommandMate supports that the probe does not drive (Issue #3313). They
 * are still rows of the report: `version` is read every morning, and every
 * other check is a `skip` whose kind says why (`tool-table.ts`
 * `LIMITED_TOOL_SPECS`), so "35 pass" is never read as "every tool is fine".
 */
export const AGENT_HEALTH_LIMITED_TOOLS = ['gemini', 'vibe-local', 'copilot'] as const;

export type AgentHealthLimitedTool = (typeof AGENT_HEALTH_LIMITED_TOOLS)[number];

/** Every row of the report's tool × check table, in report order (Issue #3313). */
export const AGENT_HEALTH_REPORT_TOOLS = [...AGENT_HEALTH_TOOLS, ...AGENT_HEALTH_LIMITED_TOOLS] as const;

export type AgentHealthReportTool = (typeof AGENT_HEALTH_REPORT_TOOLS)[number];

/**
 * Every check, in the order a tool's checks appear in the report.
 *
 * For opencode-v2, which fires no hooks, `hook-correlation` checks its own
 * server's SSE instead (`./server-events`, Issue #2937).
 *
 * `screen-picker` opens the tool's pickers (`/model`, `/effort`) and closes
 * them with Esc; tools with none defined in `tool-table.ts` skip it (Issue #3053).
 */
export const AGENT_HEALTH_CHECK_IDS = [
  'version',
  'hook-correlation',
  'screen-idle',
  'screen-picker',
  'screen-running',
  'screen-approval',
  'screen-quoted-dialog',
] as const;

export type AgentHealthCheckId = (typeof AGENT_HEALTH_CHECK_IDS)[number];

export type AgentHealthCheckStatus = 'pass' | 'fail' | 'skip';

/**
 * Why a check was not done (Issue #3313). Set where the skip is produced —
 * never guessed afterwards from `skipReason`'s wording.
 *
 * - `no-definition`: the probe has no definition of this check for the tool
 *   (no picker in `tool-table.ts`; opencode's events come from its own HTTP
 *   server, which `hook-correlation` does not read)
 * - `not-shown`: the tool does not show that screen (no approval dialog by default)
 * - `signed-out`: the tool cannot sign in
 * - `unsupported`: the probe does not drive the tool (yet), or the tool lacks the feature
 * - `timeout`: the run budget ran out before the tool's turn
 * - `prerequisite-failed`: added — `version` failed, so nothing was launched
 * - `not-selected`: added, table only — left out by `--tools` / `--only`
 * - `not-recorded`: added, table only — selected, but the run recorded nothing
 *   for it (a script error); kept visible instead of read as fine
 */
export const AGENT_HEALTH_SKIP_KINDS = [
  'no-definition',
  'not-shown',
  'signed-out',
  'unsupported',
  'timeout',
  'prerequisite-failed',
  'not-selected',
  'not-recorded',
] as const;

export type AgentHealthSkipKind = (typeof AGENT_HEALTH_SKIP_KINDS)[number];

/** The words the summary uses for each kind. */
export const AGENT_HEALTH_SKIP_KIND_LABELS: Record<AgentHealthSkipKind, string> = {
  'no-definition': '検査の定義が無い',
  'not-shown': 'このツールは、その画面を出さない',
  'signed-out': 'サインインできない',
  unsupported: 'ツールが未対応',
  timeout: '時間切れ',
  'prerequisite-failed': 'version が取れず未実施',
  'not-selected': '今回の実行の対象外',
  'not-recorded': '結果が記録されなかった',
};

export interface AgentHealthCheck {
  checkId: AgentHealthCheckId;
  status: AgentHealthCheckStatus;
  /** One line: what was expected and what happened. */
  summary: string;
  /** Failure evidence (pane tail, hook JSON). At most {@link MAX_EVIDENCE_CHARS}. */
  evidence?: string;
  skipReason?: string;
  /** Set on every `skip` the run produces (Issue #3313). */
  skipKind?: AgentHealthSkipKind;
  /**
   * The whole frames this check judged, written as captured (Issue #3183,
   * `frame-archive.ts`). Present only when they were written: by default for a
   * failing `screen-*` check, for every one with `CM_AGENT_HEALTH_SAVE_FRAMES=all`.
   */
  framePaths?: string[];
}

export interface AgentHealthToolResult {
  tool: AgentHealthReportTool;
  /** First line of `<cli> --version`, or null when it could not be read. */
  version: string | null;
  /** The version recorded by the previous run (state file), or null. */
  previousVersion: string | null;
  versionChanged: boolean;
  checks: AgentHealthCheck[];
  /**
   * The model the tool was launched on, as the tool itself showed it (Issue
   * #3438, `launched-model.ts`). Absent on a tool that was not launched (a
   * version-only row, `version` failed, the budget ran out) and on a report
   * written before #3438 — readers show both as 不明.
   */
  launchedModel?: AgentHealthLaunchedModel;
}

/**
 * Where {@link AgentHealthLaunchedModel.model} was read.
 *
 * - `screen`: the tool's banner, footer or step row, through the production reader
 * - `screen-footer`: opencode's composer bar; the provider name is part of the value
 * - `hook`: a hook payload's model (claude's `SessionStart`, antigravity's `modelName`)
 */
export type AgentHealthLaunchedModelSource = 'screen' | 'screen-footer' | 'hook';

export interface AgentHealthLaunchedModel {
  /** Verbatim, or null when neither the screen nor a hook showed one (不明). Never guessed. */
  model: string | null;
  /** Set whenever `model` is. */
  source?: AgentHealthLaunchedModelSource;
  /**
   * The model pick the probe copied into the isolated state before launch
   * (`model.json`'s `recent[0]` as `<providerID>/<modelID>`, opencode / opencode-v2).
   * Kept beside `model` to compare, never used in its place.
   */
  seeded?: string;
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
  /** How the runner synced to origin/develop before this run (written by scripts/agent-health/daily.sh). */
  sync?: AgentHealthSync;
  /** Every tool × every check, including what was not done (Issue #3313). Absent on a report that ran nothing. */
  coverage?: AgentHealthCoverage;
  /**
   * What the watcher reads (Issue #3313): line 1 is `pass N・fail N・skip N（<kind> N・…）`,
   * then the table, then why each skip was skipped. Also printed to stdout.
   */
  summary?: string[];
}

export interface AgentHealthCoverageCell {
  status: AgentHealthCheckStatus;
  /** Always set when `status` is `skip`. */
  skipKind?: AgentHealthSkipKind;
}

export interface AgentHealthCoverageRow {
  tool: AgentHealthReportTool;
  /** `probed`: launched and driven. `version-only`: only `--version` is read (Issue #3313). */
  coverage: 'probed' | 'version-only';
  cells: Record<AgentHealthCheckId, AgentHealthCoverageCell>;
}

export interface AgentHealthCoverage {
  checkIds: AgentHealthCheckId[];
  rows: AgentHealthCoverageRow[];
  counts: {
    pass: number;
    fail: number;
    skip: number;
    skipByKind: Partial<Record<AgentHealthSkipKind, number>>;
  };
}

/** `before` / `after`: full commit SHAs. `reason` is set only when `status` is `failed`. */
export interface AgentHealthSync {
  status: 'ok' | 'failed';
  before: string;
  after: string;
  reason?: string;
}

/** `~/.commandmate/agent-health/state.json`. */
export interface AgentHealthState {
  versions: Partial<Record<AgentHealthReportTool, string>>;
}

/** The fixed correlation keys every probe session is launched with. */
export const PROBE_WORKTREE_ID = 'agent-health-probe';

export function probeInstanceId(tool: AgentHealthReportTool): string {
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
