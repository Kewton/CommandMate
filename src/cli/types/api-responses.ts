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
// [DR2-08] Field name is "name" (not "branch") matching server-side Worktree type
export interface WorktreeItem {
  id: string;
  name: string;
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
