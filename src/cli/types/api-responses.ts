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
