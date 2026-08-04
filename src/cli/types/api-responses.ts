/**
 * CLI-side API Response Type Definitions
 * Issue #518: [DR1-06] All types include Mirrors comments for server-side traceability
 *
 * These types mirror server-side response shapes. Phase 2 will migrate to
 * shared types in src/types/api-contracts.ts.
 */

// Mirrors: src/types/models.ts Worktree + src/app/api/worktrees/route.ts response shape
export interface WorktreeListResponse {
  worktrees: WorktreeItem[];
  repositories: unknown[]; // CLI does not use this
}

// Mirrors: src/types/models.ts Worktree (subset)
// [DR2-08] `name` is the display name / id-derived slug; `branch` (Issue #1003)
// is the real git branch. They usually coincide for sync-generated worktrees
// but can diverge, so `ls --branch` filters on `branch` (falling back to `name`).
export interface WorktreeItem {
  /**
   * Primary worktree identifier: a `<repo>-<branch>` slug (e.g. `anvil-develop`),
   * sanitized/lowercased. This is the prefix users pass to `ls --id` (Issue #1005)
   * and the id accepted by send/capture/wait/respond/instances.
   */
  id: string;
  name: string;
  /**
   * Mirrors: src/types/models.ts Worktree.branch (Issue #1003).
   * Git branch captured at sync time — a distinct concept from
   * gitStatus.currentBranch (live) and initialBranch (session start); it lags a
   * checkout until the next sync. Undefined for rows synced before Issue #1003
   * or written by non-sync paths; consumers fall back to {@link name}.
   */
  branch?: string;
  cliToolId?: string;
  isSessionRunning?: boolean;
  isWaitingForResponse?: boolean;
  isProcessing?: boolean;
  // [DR2-09] Per-CLI-tool session status for agent filtering
  sessionStatusByCli?: Partial<Record<string, {
    isRunning: boolean;
    isWaitingForResponse: boolean;
    isProcessing: boolean;
  }>>;
  // Mirrors: src/lib/cli-tools/types.ts AgentInstance[] (Issue #869/#1000).
  // Present on both GET /api/worktrees and GET /api/worktrees/[id].
  agentInstances?: AgentInstance[];
}

// Mirrors: src/app/api/repositories/sync/route.ts POST response (Issue #1680)
export interface RepositorySyncResponse {
  success: boolean;
  message: string;
  worktreeCount: number;
  repositoryCount: number;
  repositories: string[];
  deletedCount: number;
  /** Sanitized, generic warnings only (SEC-MF-001); details stay in server logs. */
  cleanupWarnings: string[];
}

// Mirrors: src/lib/cli-tools/types.ts AgentInstance (Issue #868/#1000)
export interface AgentInstance {
  id: string;
  cliTool: string;
  alias: string;
  order: number;
}

// Mirrors: src/app/api/worktrees/[id]/route.ts GET response shape (subset used
// by the CLI `instances` command; omits gitStatus/session fields not needed here)
export interface WorktreeDetailResponse extends WorktreeItem {
  agentInstances: AgentInstance[];
}

// Mirrors: src/app/api/worktrees/[id]/current-output/route.ts response shape
// [DR2-03] All server-side fields included
export interface CurrentOutputResponse {
  isRunning: boolean;
  isComplete: boolean;
  isPromptWaiting: boolean;
  isGenerating: boolean;
  content: string;
  fullOutput: string;
  realtimeSnippet: string;
  lineCount: number;
  lastCapturedLine: number;
  promptData: PromptData | null;
  autoYes: {
    enabled: boolean;
    expiresAt: number | null;
    stopReason?: string;
    // Mirrors: src/lib/polling/auto-yes-suppression-state.ts AutoYesPolicySuppression
    // (Issue #1684). Non-null once the contract's autoYes policy withheld an
    // answer; `at` is refreshed every poll while the suppressed prompt remains.
    lastSuppression?: {
      reason: string;
      mode: string | null;
      promptType: string;
      pattern?: string;
      at: number;
    } | null;
  };
  thinking: boolean;
  thinkingMessage: string | null;
  cliToolId?: string;
  isSelectionListActive: boolean;
  /** Issue #1017: Codex pager/edit-previous mode (subset of isSelectionListActive). */
  isPagerActive?: boolean;
  lastServerResponseTimestamp: number | null;
  serverPollerActive: boolean;
  /** Issue #520: Session status from detectSessionStatus() */
  sessionStatus?: 'idle' | 'ready' | 'running' | 'waiting';
  /** Issue #520: Reason string from detectSessionStatus() or 'session_not_running' */
  sessionStatusReason?: string;
}

// Mirrors: src/types/models.ts BasePromptData (subset for CLI output)
export interface PromptData {
  type: string;
  question: string;
  options?: unknown[];
  status?: string;
  answer?: string;
  answeredAt?: string;
  /** Mirrors: src/types/models.ts PromptAnsweredBy (Issue #1685) */
  answeredBy?: string;
  [key: string]: unknown;
}

// Mirrors: src/types/models.ts ChatMessage (subset), as serialized by
// GET /api/worktrees/[id]/messages?messageType=prompt (Issue #1685).
// `timestamp` is an ISO string on the wire (Date is JSON-serialized).
export interface PromptMessageResponse {
  id: string;
  worktreeId: string;
  role: string;
  content: string;
  timestamp: string;
  messageType: string;
  promptData?: PromptData;
  cliToolId?: string;
  instanceId?: string;
  archived: boolean;
}

// Mirrors: src/app/api/worktrees/[id]/prompt-response/route.ts response shape
// [DR2-06] prompt-response API response
export interface PromptResponseResult {
  success: boolean;
  answer: string;
  reason?: string; // e.g. 'prompt_no_longer_active', 'unresolvable_answer'
  /** Issue #1681: detail accompanying reason 'unresolvable_answer' */
  message?: string;
  /** Issue #1681: how a semantic yes/no or --default answer was resolved */
  resolved?: {
    via: 'semantic' | 'default';
    optionNumber?: number;
    optionLabel: string;
  };
}

/** wait exit 10 CLI extended output type */
export interface WaitPromptOutput {
  worktreeId: string;
  cliToolId: string;
  type: string;
  question: string;
  options: unknown[];
  status: string;
  [key: string]: unknown;
}

// Mirrors: src/app/api/daily-summary/route.ts GET response [Issue #636]
export interface DailySummaryGetResponse {
  report: SerializedReport | null;
  messageCount: number;
}

// Mirrors: src/app/api/daily-summary/route.ts POST response [Issue #636]
export interface DailySummaryGenerateResponse {
  report: SerializedReport;
  generated: boolean;
}

// Mirrors: serializeReport() in daily-summary route.ts [Issue #636]
export interface SerializedReport {
  date: string;
  content: string;
  generatedByTool: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

// Mirrors: src/lib/metrics/vibe-metrics.ts VibeMetrics [Issue #1551]
// Restated rather than imported: tsconfig.cli.json compiles src/cli alone with
// no `@/` paths, so the CLI cannot reach src/lib.
export interface VibeMetrics {
  periodDays: number;
  tasks: {
    total: number;
    succeeded: number;
    failed: number;
    notStarted: number;
    cancelled: number;
    /** 0..1 fraction; null when no tasks were created in the window. */
    successRate: number | null;
    /** null when nothing failed in the window. */
    avgRetryLoops: number | null;
  };
  verification: {
    runs: number;
    passed: number;
    failed: number;
    notStarted: number;
    /** 0..1 fraction; null when no runs started in the window. */
    passRate: number | null;
    gateFailBreakdown: Array<{ gateId: string; failCount: number }>;
  };
  intervention: {
    humanResponds: number;
    autoAnswered: number;
    /** Always null in v1: the policy suppression log is not persisted. */
    suppressedByPolicy: number | null;
  };
}

// Mirrors: src/app/api/metrics/vibe/route.ts GET response [Issue #1551]
export interface VibeMetricsResponse {
  metrics: VibeMetrics;
}

// Mirrors: src/app/api/templates/[id]/route.ts GET response [Issue #636]
export interface TemplateResponse {
  id: string;
  name: string;
  content: string;
}

// Mirrors: src/app/api/daily-summary/status/route.ts GET response [Issue #638]
export interface DailySummaryStatusResponse {
  generating: boolean;
  date?: string;
  tool?: string;
  startedAt?: string;
}

// Mirrors: src/types/models.ts ChatMessage (subset for send response)
export interface ChatMessage {
  id?: number;
  worktreeId: string;
  role: string;
  content: string;
  cliToolId?: string;
  createdAt?: string;
}

// =============================================================================
// Skill management [Issue #1237]
//
// Mirrors: src/lib/api/skills-api.ts (Catalog), src/lib/skills/install-plan.ts,
// src/lib/skills/uninstall-plan.ts and the four skill route modules.
//
// Only the fields the CLI reads are declared. `--json` prints the server body
// verbatim rather than a re-serialization of these types, so the JSON contract
// is the API's and cannot drift from what these declarations happen to cover.
// =============================================================================

/** Mirrors: src/lib/skills/compatibility.ts SkillCompatibilityStatus. */
export type SkillCompatibilityStatus = 'compatible' | 'incompatible' | 'unknown';

/** Mirrors: src/lib/skills/compatibility.ts SkillCommandMateCompatibility (subset). */
export interface SkillCompatibilityView {
  status: SkillCompatibilityStatus;
  /** English fallback message built server-side from code, range and host version. */
  message: string;
  requiredRange: string;
}

/** Mirrors: src/lib/api/skills-api.ts SkillCatalogMetaDto (subset). */
export interface SkillCatalogMeta {
  stale: boolean;
  offline: boolean;
  state: string;
  /** Why the served Catalog is stale, or null when it was confirmed current. */
  staleReason: string | null;
  fetchedAt: string;
  revalidatedAt: string;
  source: { repository: string; ref: string; revision: string | null };
}

/** Mirrors: src/lib/api/skills-api.ts SkillVersionDto (subset; artifact.url is never served). */
export interface SkillCatalogVersionSummary {
  version: string;
  declaredRisk: string;
  prerelease: boolean;
  publishedAt: string;
  compatibility: { commandmate: SkillCompatibilityView };
}

/** Mirrors: src/lib/api/skills-api.ts SkillDto (subset). */
export interface SkillCatalogSummary {
  id: string;
  name: string;
  summary: string;
  provider: { name: string };
  license: string;
  homepage: string | null;
  latest: string;
  recommendedVersion: string | null;
  recommendedReason: string;
  compatibility: SkillCompatibilityView | null;
  versions: SkillCatalogVersionSummary[];
}

/** Mirrors: src/app/api/skills/route.ts GET response. */
export interface SkillListResponse {
  catalog: SkillCatalogMeta;
  skills: SkillCatalogSummary[];
}

/** Mirrors: src/app/api/skills/[id]/route.ts GET response. */
export interface SkillDetailResponse {
  catalog: SkillCatalogMeta;
  skill: SkillCatalogSummary;
}

/** A typed reason an operation is refused, with the repository-relative path responsible. */
export interface SkillPlanBlocker {
  code: string;
  path: string | null;
}

/** Mirrors: src/lib/skills/install-plan.ts SkillInstallPlanDto (subset). */
export interface SkillInstallPlan {
  /** Single-use token the apply step presents unchanged. The CLI never inspects it. */
  token: string;
  expiresAt: string;
  installable: boolean;
  requiresRiskAcknowledgement: boolean;
  riskAcknowledged: boolean;
  blockers: SkillPlanBlocker[];
  warnings: string[];
  target: {
    worktreeId: string;
    worktreeName: string;
    repositoryName: string;
    branch: string | null;
    headState: string;
    workingTreeDirty: boolean;
    /** Repository-relative; the server never serves a machine-absolute path. */
    installRoot: string;
    /** Every root the package is placed into, primary first (#1460). */
    installRoots?: string[];
    existingInstall: { version: string; receiptDigest: string } | null;
  };
  skill: {
    id: string;
    name: string;
    version: string;
    summary: string;
    license: string;
    declaredPermissions: string[];
    effectiveRisk: string;
    riskRationale: string;
    scriptPaths: string[];
    executablePaths: string[];
    requirements: {
      commands: Array<{ name: string; versionRange: string | null }>;
      networkHosts: string[];
    };
    compatibility: {
      commandmate: SkillCompatibilityView;
      agents: Array<{ agent: string; support: string }>;
    };
  };
  stats: {
    added: number;
    modified: number;
    unchanged: number;
    conflicted: number;
    unmanaged: number;
  };
}

/** Mirrors: src/app/api/worktrees/[id]/skills/[skillId]/plan/route.ts POST response. */
export interface SkillInstallPlanResponse {
  plan: SkillInstallPlan;
}

/**
 * Mirrors: SkillInstallOperationDto / SkillUninstallOperationDto (subset).
 * `committed_reconciling` means the worktree already changed — never reported as a failure.
 */
export interface SkillOperationResult {
  operationId: string;
  state: string;
  result: 'succeeded' | 'committed_reconciling';
  committed: boolean;
  reconcilePending: boolean;
  nextActionKey: string;
  replayed: boolean;
}

/**
 * Mirrors: src/app/api/worktrees/[id]/skills/[skillId]/install/route.ts POST response.
 * `files` is absent from the narrower replay body, and `install` is null when a
 * replay finds no index row.
 */
export interface SkillInstallResponse {
  operation: SkillOperationResult;
  install: {
    skillId: string;
    version: string;
    installRoot: string;
    installRoots?: string[];
    files?: Array<{ path: string }>;
  } | null;
}

/** Mirrors: api/worktrees/[id]/skills/[skillId]/git-workflow prepare response (Issue #1247). */
export interface SkillGitWorkflowPrepareResponse {
  workflowToken: string;
  target: {
    mode: string;
    branch: string;
    baseBranch: string | null;
    headCommit: string;
    branchCreated: boolean;
    remote: string;
  };
}

/** Mirrors: api/worktrees/[id]/skills/[skillId]/git-workflow apply response (Issue #1247). */
export interface SkillGitWorkflowApplyResponse {
  result: {
    branch: string;
    baseBranch: string | null;
    changedPaths: string[];
    committed: boolean;
    commitSha: string;
    pushed: boolean;
    pullRequestUrl: string | null;
    pullRequestExisted: boolean;
  };
}

/** Mirrors: src/lib/skills/uninstall-plan.ts SkillUninstallPlanDto (subset). */
export interface SkillUninstallPlan {
  token: string;
  expiresAt: string;
  removable: boolean;
  blockers: SkillPlanBlocker[];
  nextActionKey: string;
  target: {
    worktreeId: string;
    worktreeName: string;
    repositoryName: string;
    branch: string | null;
    workingTreeDirty: boolean;
    installRoot: string;
  };
  skill: { id: string; version: string; effectiveRisk: string };
  removals: Array<{ path: string }>;
  retained: Array<{ path: string; reason: string }>;
  stats: {
    removable: number;
    modified: number;
    missing: number;
    unknown: number;
    irregular: number;
  };
}

/** Mirrors: src/app/api/worktrees/[id]/skills/[skillId]/uninstall-plan/route.ts POST response. */
export interface SkillUninstallPlanResponse {
  plan: SkillUninstallPlan;
}

/** A typed reason an update is refused (Issue #1243). Paths are repository-relative. */
export interface SkillUpdateBlocker {
  code: string;
  path: string | null;
  /** Underlying per-path finding, when one exists (e.g. a local modification). */
  detail: string | null;
}

/** Mirrors: src/lib/skills/update-plan.ts SkillUpdatePlanDto (subset) [Issue #1243]. */
export interface SkillUpdatePlan {
  /** Single-use token apply (#1244) will present unchanged. The CLI never inspects it. */
  token: string;
  expiresAt: string;
  updatable: boolean;
  blockers: SkillUpdateBlocker[];
  nextActionKey: string;
  requiresRiskAcknowledgement: boolean;
  riskIncreased: boolean;
  update: {
    fromVersion: string;
    toVersion: string;
    latestVersion: string | null;
    reasonCode: string;
    prerelease: boolean;
  };
  target: {
    worktreeId: string;
    worktreeName: string;
    repositoryName: string;
    branch: string | null;
    headState: string;
    workingTreeDirty: boolean;
    /** Repository-relative; the server never serves a machine-absolute path. */
    installRoot: string;
    /** Every recorded root the update rewrites, primary first (#1460). */
    installRoots: string[];
  };
  skill: {
    id: string;
    name: string;
    version: string;
    effectiveRisk: string;
    riskRationale: string;
    declaredPermissions: string[];
    scriptPaths: string[];
    compatibility: { commandmate: SkillCompatibilityView };
  };
  securityDiff: {
    risk: {
      from: { effective: string };
      to: { effective: string };
      increased: boolean;
    };
    permissions: { added: string[]; removed: string[] };
    executables: { added: string[]; removed: string[] };
    scripts: { added: string[]; removed: string[] };
    changelogs: Array<{ version: string; changelog: string }>;
  };
  files: Array<{ path: string; change: string }>;
  stats: {
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
    localModified: number;
    localMissing: number;
    localUnknown: number;
    irregular: number;
  };
  warnings: string[];
}

/** Mirrors: src/app/api/worktrees/[id]/skills/[skillId]/update-plan/route.ts POST response. */
export interface SkillUpdatePlanResponse {
  plan: SkillUpdatePlan;
}

/** Mirrors: src/app/api/worktrees/[id]/skills/[skillId]/uninstall/route.ts POST response. */
export interface SkillUninstallResponse {
  operation: SkillOperationResult;
  uninstall: {
    skillId: string;
    version: string | null;
    installRoot?: string;
    removedFiles?: Array<{ path: string }>;
    retained?: Array<{ path: string; reason: string }>;
    fullyRemoved?: boolean;
  } | null;
}

/** Mirrors: src/app/api/skills/reindex/route.ts POST response [Issue #1248]. */
export interface SkillReindexResult {
  scannedWorktrees: number;
  indexed: number;
  removed: number;
  skipped: Array<{
    worktreeId: string;
    skillId: string;
    /** Repository-relative root the directory was found at. */
    root: string;
    reason: string;
  }>;
  /** Registered worktrees whose directory is gone; their rows were left untouched. */
  unreadableWorktreeIds: string[];
}

// =============================================================================
// Verification (Issue #1544)
// =============================================================================

/** Mirrors: src/app/api/worktrees/[id]/verify/route.ts POST 202 response. */
export interface VerifyStartResponse {
  runId: number;
}

/**
 * Mirrors: src/lib/db/verification-db.ts VerificationRunStatus.
 * Declared here rather than imported so the CLI bundle stays free of the
 * server's better-sqlite3 dependency graph.
 */
export type VerificationRunStatus =
  | 'running'
  | 'passed'
  | 'failed'
  | 'not_started'
  | 'error'
  | 'cancelled';

/** Mirrors: src/lib/db/verification-db.ts VerificationGateStatus. */
export type VerificationGateStatus =
  | 'running'
  | 'passed'
  | 'failed'
  | 'timeout'
  | 'skipped'
  | 'error';

/**
 * Mirrors: src/lib/db/verification-db.ts VerificationGateResult.
 * Dates arrive as ISO strings because the route serializes them through JSON.
 */
export interface VerificationGateResultView {
  id: number;
  runId: number;
  gateId: string;
  command: string;
  status: VerificationGateStatus;
  exitCode: number | null;
  durationMs: number | null;
  logTail: string | null;
  startedAt: string;
  finishedAt: string | null;
  /**
   * Whether `startedAt`/`finishedAt` bracket the execution `durationMs` counted
   * (Issue #1625).
   *
   * Rows written before #1625 stamped both at write time, and history is never
   * rewritten, so a consumer reading old runs must check this before treating
   * the timestamps as timing. `durationMs` was always correct and needs no such
   * check. Absent on responses from a server older than #1625.
   */
  timingsMeasured?: boolean;
}

/** Mirrors: src/lib/db/verification-db.ts VerificationRunWithGates. */
export interface VerificationRunView {
  id: number;
  worktreeId: string;
  instanceId: string | null;
  taskId: string | null;
  trigger: string;
  status: VerificationRunStatus;
  baseRef: string | null;
  startedAt: string;
  finishedAt: string | null;
  gates: VerificationGateResultView[];
}

/** Mirrors: src/app/api/worktrees/[id]/verify/runs/[runId]/route.ts GET response. */
export interface VerifyRunResponse {
  run: VerificationRunView;
}

/**
 * Mirrors: src/lib/db/verification-db.ts VerificationGateSummary (Issue #1593).
 * No `logTail` — the history listing does not carry log bodies, and declaring
 * one here would let `history` code read a field the server never sends.
 */
export interface VerificationGateSummaryView {
  gateId: string;
  status: VerificationGateStatus;
  exitCode: number | null;
  durationMs: number | null;
}

/** Mirrors: src/lib/db/verification-db.ts VerificationRunWithGateSummaries. */
export interface VerificationRunSummaryView {
  id: number;
  worktreeId: string;
  instanceId: string | null;
  taskId: string | null;
  trigger: string;
  status: VerificationRunStatus;
  baseRef: string | null;
  startedAt: string;
  finishedAt: string | null;
  gates: VerificationGateSummaryView[];
}

/** Mirrors: src/app/api/verification/runs/route.ts GET response. */
export interface VerificationRunHistoryResponse {
  runs: VerificationRunSummaryView[];
}

// =============================================================================
// Task contracts (Issue #1545)
// =============================================================================

/** Mirrors: src/lib/db/tasks-db.ts TaskStatus. */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_input'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'not_started'
  | 'cancelled';

/**
 * Mirrors: src/lib/tasks/contract-parser.ts TaskContract.
 * The snapshot taken at send time, as stored in `tasks.contract_json`.
 */
export interface TaskContractView {
  version: number;
  title: string;
  goal: string;
  scope: { allow: string[]; deny: string[] };
  verify: { gates: string[] | null };
  autoYes: { mode: string | null; allowPromptTypes: string[]; denyPatterns: string[] };
  success: { requireWorkEvidence: boolean; requireScopeClean: boolean };
}

/**
 * Mirrors: src/lib/db/tasks-db.ts Task.
 * Dates arrive as ISO strings because the route serializes them through JSON.
 */
export interface TaskView {
  id: string;
  worktreeId: string;
  cliToolId: string;
  instanceId: string | null;
  title: string;
  goal: string;
  contractPath: string | null;
  contract: TaskContractView;
  status: TaskStatus;
  lastVerificationRunId: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Mirrors: src/app/api/worktrees/[id]/tasks/route.ts POST response. */
export interface TaskCreateResponse {
  task: TaskView;
  /** Contract preamble + goal, composed server-side; this is what gets sent. */
  message: string;
}

/** Mirrors: src/app/api/worktrees/[id]/tasks/route.ts GET response. */
export interface TaskListResponse {
  tasks: TaskView[];
}

/** Mirrors: src/app/api/tasks/[taskId]/route.ts GET response. */
export interface TaskDetailResponse {
  task: TaskView;
  lastVerificationRun: VerificationRunView | null;
}
