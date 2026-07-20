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
  [key: string]: unknown;
}

// Mirrors: src/app/api/worktrees/[id]/prompt-response/route.ts response shape
// [DR2-06] prompt-response API response
export interface PromptResponseResult {
  success: boolean;
  answer: string;
  reason?: string; // e.g. 'prompt_no_longer_active'
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
    files?: Array<{ path: string }>;
  } | null;
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
