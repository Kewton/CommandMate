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

/**
 * Mirrors: src/lib/polling/auto-yes-resolver.ts AutoYesSuppressionReason
 * (Issue #1843) — every value `autoYes.lastSuppression.reason` can carry.
 *
 * Copied rather than imported: tsconfig.cli.json sets `"paths": {}`, and the
 * server module that declares the union imports `@/config/auto-yes-config`, so
 * even a type-only import of it fails `npm run build:cli`. The copy is held to
 * the original by a bidirectional assignability assertion in
 * tests/unit/cli/config/cross-validation.test.ts, which fails `tsc --noEmit`
 * the moment a reason is added server-side.
 *
 * The first four are verdicts of a contract's `autoYes` block. `agent-launch-dialog`
 * is NOT: Issue #1829 records a CLI-lifecycle dialog the poller deliberately
 * leaves to the tool's own launch sequence, through the same channel. Anything
 * that phrases a suppression for a human has to tell the two apart — see
 * SUPPRESSION_CAUSE in src/cli/commands/wait.ts.
 */
export type AutoYesSuppressionReason =
  | 'mode-off'
  | 'deny-pattern'
  | 'deny-pattern-unusable'
  | 'type-not-allowed'
  | 'agent-launch-dialog';

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
      /**
       * Normally an {@link AutoYesSuppressionReason}, but deliberately typed as
       * the wire's `string`: this is a server response, and a server newer than
       * the CLI can name a reason this build has never heard of. Consumers
       * narrow it themselves and must stay truthful about the miss (Issue #1843).
       */
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
  /**
   * The frame is interactive but the detection layer could not classify it
   * (Issue #1497). The server has published this since #1120; until Issue #1708
   * the CLI never read it, so a dialog the scraper failed to parse was treated
   * as "nothing is happening" and `wait` polled it until --timeout.
   *
   * Momentary by nature — a repaint mid-capture can raise it for a single poll —
   * so it is only a stop reason after it has persisted; see
   * UNCLASSIFIED_DWELL_MS in wait.ts.
   */
  isUnclassifiedActive?: boolean;
  lastServerResponseTimestamp: number | null;
  serverPollerActive: boolean;
  /**
   * Issue #520: session status from `detectSessionStatus()` — or, since Issue
   * #1723, from the agent's own lifecycle events when they are available and
   * the scraper is not reporting a prompt. `sessionStatusReason` says which.
   */
  sessionStatus?: 'idle' | 'ready' | 'running' | 'waiting';
  /**
   * Issue #520: reason string from `detectSessionStatus()`, or
   * `session_not_running`.
   *
   * Issue #1723 adds a second family, distinguishable by its `hook_` prefix
   * (`hook_stop`, `hook_prompt_submit`, …; see
   * `src/lib/session/status-mapping.ts` HOOK_STATUS_REASON). A `hook_` reason
   * means `sessionStatus` came from an event the agent reported rather than
   * from reading its terminal, so it is exact rather than inferred — the
   * distinction matters when triaging why `wait` did or did not stop.
   */
  sessionStatusReason?: string;
  /**
   * Issue #1549: epoch ms of the last structured stop event, or null when the
   * agent has posted none.
   */
  lastStopEventAt?: number | null;
  /**
   * Issue #1722: the last lifecycle event the agent's injected hooks reported.
   * Diagnostic — it tells an operator whether hooks are arriving and for which
   * instance. No CLI verdict reads it; that is Issue #1723.
   *
   * Mirrors: src/lib/session/current-output-builder.ts StructuredEventsPayload
   */
  structuredEvents?: {
    lastEventType: string | null;
    lastEventAt: number | null;
    lastEventDetail: string | null;
    /**
     * Epoch ms the structured layer first learned a dialog was open, or null
     * (Issue #1725). Non-null together with `isPromptWaiting` is how a caller
     * tells "the agent told us" from "the screen told us".
     */
    promptWaitingSince?: number | null;
    /** `notification` / `permission-request`, or null (Issue #1725). */
    promptWaitingSource?: string | null;
  };
  /**
   * Issue #1785: the model the session is running, or null when nothing knows.
   *
   * Mirrors: src/lib/session/current-output-builder.ts CurrentOutputPayload.model
   *
   * Optional *here* although the server always sends it, and the two are not in
   * conflict: this mirror also describes what an older daemon answers, and the
   * CLI is routinely newer than the server it dials (`npm i -g` does not restart
   * the running daemon). `undefined` therefore means "this server predates the
   * field", which the commands normalise to null — the same thing they print for
   * a tool that publishes no model.
   */
  model?: string | null;
  /**
   * Issue #1785: reasoning effort, or null when nothing knows.
   *
   * Mirrors: src/lib/session/current-output-builder.ts
   * CurrentOutputPayload.reasoningEffort — including the part where it is null
   * for every session until Issue #1784's extraction layer lands.
   */
  reasoningEffort?: string | null;
  /**
   * Issue #1695: prompts the content-hash dedup guard suppressed for this
   * session, and when it last did.
   *
   * Mirrors: src/lib/polling/prompt-dedup-state.ts PromptDedupSkips
   *
   * The field an operator reads when a prompt was on screen but no prompt
   * message exists: a non-zero `skippedCount` with a recent `lastSkippedAt`
   * means `isDuplicatePrompt` dropped it, and a zero means the detection layer
   * never classified the frame at all (Issue #1676) — two causes with the same
   * symptom that nothing in this payload could previously separate.
   *
   * `skippedCount` is cumulative for the life of the server process, not
   * per-turn, so `lastSkippedAt` is what dates the evidence.
   *
   * Optional here for the same reason `model` is: this mirror also describes
   * what an older daemon answers, and `undefined` means "this server predates
   * the field" rather than "nothing was skipped".
   */
  promptDedup?: {
    skippedCount: number;
    lastSkippedAt: number | null;
  };
}

// Mirrors: src/types/models.ts BasePromptData (subset for CLI output)
//
// Issue #1738: this mirror is deliberately LOOSER than the server union and
// must stay that way. `type` is `string`, not `PromptType`, and `options` is
// `unknown[]`, which is what already lets the degraded payloads through
// unchanged: #1725's `StructuredPromptWaitingData` on `current-output`, and
// #1708 / #1725's audit rows on `messages?messageType=prompt`. Both carry
// `type: 'unclassified'` and an empty option list, and `capture` / `wait`
// already branch on that literal (see UNCLASSIFIED_PROMPT_TYPE in
// cli/commands/wait.ts). Tightening `type` into the server's `PromptData` union
// would reintroduce exactly the gap #1738 closed, on the CLI side.
export interface PromptData {
  type: string;
  question: string;
  /**
   * Mirrors src/types/models.ts MultipleChoiceOption. Since Issue #1726 an
   * option may also carry `description` — the second line the AskUserQuestion
   * picker renders — when the agent's own `PreToolUse` payload supplied it.
   */
  options?: unknown[];
  status?: string;
  answer?: string;
  answeredAt?: string;
  /** Mirrors: src/types/models.ts PromptAnsweredBy (Issue #1685) */
  answeredBy?: string;
  /** Human-facing context block preceding the prompt (Issue #235). */
  instructionText?: string;
  /**
   * What this prompt asks approval for — the surface `autoYes.denyPatterns` are
   * judged against (Issue #1699). Narrower than `instructionText` on purpose:
   * the latter is a pane window and carries finished turns.
   */
  approvalTarget?: string;
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
  /**
   * e.g. `prompt_no_longer_active`, `unresolvable_answer`, and since Issue
   * #1726 `answer_out_of_range` — the option number is outside the list the
   * agent's own `AskUserQuestion` payload declared, so nothing was sent.
   */
  reason?: string;
  /** Issue #1681: detail accompanying a reason that refused to send. */
  message?: string;
  /**
   * Issue #1681: how a semantic yes/no or --default answer was resolved.
   *
   * Issue #1726 also reports `via: 'semantic'` here when an option LABEL was
   * matched against the agent's structured options (`respond <id> Blue` → 1).
   */
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
  /**
   * What the prompt asks approval for, when the detector could attribute a block
   * to it (Issue #1699). Present so a caller that reads only this payload can
   * see what a `deny-pattern` verdict below was actually judged against.
   */
  approvalTarget?: string;
  /**
   * Set when the contract's autoYes policy withheld an answer for this session
   * (Issue #1699). Without it, a prompt an operator has to answer by hand is
   * indistinguishable on stdout from one nobody configured Auto-Yes for — which
   * is why the #1699 suppression loop went unnoticed for an hour.
   */
  autoYesSuppression?: {
    reason: string;
    mode: string | null;
    promptType: string;
    pattern?: string;
    ageSeconds: number;
  };
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

/**
 * Mirrors: src/app/api/worktrees/[id]/skills/[skillId]/update/route.ts POST
 * response [Issue #1244]. `update` is null when a replay finds no index row;
 * `reload` and `rollback` are absent from the narrower replay body.
 */
export interface SkillUpdateResponse {
  operation: SkillOperationResult;
  update: {
    skillId: string;
    fromVersion?: string;
    toVersion?: string;
    /** Present on the replay body instead of fromVersion/toVersion. */
    version?: string;
    installRoot: string;
    installRoots?: string[];
    pendingRoots?: string[];
  } | null;
  reload?: {
    skillId: string;
    version: string;
    installRoot: string;
    agents: Array<{ agent: string; support: string; messageKey: string }>;
  };
  rollback?: {
    available: boolean;
    backup: { backupId: string; fromVersion: string; fileCount: number; verified: boolean };
    messageKey: string;
  };
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

/**
 * Mirrors: src/lib/db/verification-db.ts VerificationGateSource (Issue #1791).
 *
 * `null` on gate rows written before migration v56, and absent entirely on
 * responses from a server older than #1791 — so a consumer must treat "no
 * source" as "unrecorded", never as "the repository declared it".
 */
export type VerificationGateSource = 'builtin' | 'verify.yaml' | 'contract';

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
   * Where the gate was declared (Issue #1791): the repository's verify.yaml,
   * this delegation's execution contract, or the runner's own built-ins.
   */
  source?: VerificationGateSource | null;
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
  /** Where the gate was declared (Issue #1791). */
  source?: VerificationGateSource | null;
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
  verify: {
    gates: string[] | null;
    /**
     * Gates this contract declares for itself (Issue #1791). Absent on
     * responses from a server older than #1791, and on tasks recorded before
     * it — `contract_json` is replayed verbatim, never re-validated.
     */
    gateDefinitions?: Array<{ id: string; command: string; timeoutSec: number }>;
  };
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
